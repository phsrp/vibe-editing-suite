import { useEffect, useReducer, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import { actionFor } from './keybinds.js'
import { Doc } from './drawing/doc.js'
import { promptFromLoop } from './smartMask.js'
import { toUrl } from './state.js'
import { Stroke, Smudge, mergeBuffer, ellipsePoints, rectPoints, floodMask, maskToCanvas, objectMask, newCanvas, hexToRgb, rgbToHex } from './drawing/engine.js'
import { builtinBrushes } from './drawing/builtinBrushes.js'
import * as kritaBrush from './drawing/kritaBrush.js'
const { loadKritaPack } = kritaBrush
if (typeof window !== 'undefined') window.__krita = kritaBrush // developer self-test
import { ColourPicker, BrushList, LayersPanel, ExportDrawingDialog } from './drawing/DrawingPanels.jsx'
import Tour, { tourSeen, markTourSeen } from './Tour.jsx'
import { DRAWING_STEPS } from './tourSteps.js'

const TOOLS = [
  { id: 'brush', icon: 'brush', label: 'Brush (B)', key: 'B' },
  { id: 'eraser', icon: 'eraser', label: 'Eraser (E)', key: 'E' },
  { id: 'smudge', icon: 'smudge', label: 'Smudge: push the colours around (S)', key: 'S' },
  { id: 'line', icon: 'line', label: 'Line (L)', key: 'L' },
  { id: 'rect', icon: 'square', label: 'Rectangle (U)', key: 'U' },
  { id: 'ellipse', icon: 'circle', label: 'Ellipse and circle (O)', key: 'O' },
  { id: 'fill', icon: 'bucket', label: 'Fill with colour (G)', key: 'G' },
  { id: 'eyedropper', icon: 'pipette', label: 'Eyedropper: pick a colour (I)', key: 'I' },
  { id: 'select', icon: 'select', label: 'Select: click a line or shape, or drag a box (M)', key: 'M' },
  { id: 'lasso', icon: 'lasso', label: 'Lasso: draw around what to select (Q)', key: 'Q' },
  { id: 'smart', icon: 'star', label: 'Smart select (AI): click the subject or draw a rough box around it (W)', key: 'W' },
  { id: 'move', icon: 'move', label: 'Move the layer (V)', key: 'V' },
  { id: 'hand', icon: 'hand', label: 'Hand: move the view (H, or hold Space)', key: 'H' },
]
const PAINT_TOOLS = ['brush', 'eraser', 'smudge', 'line', 'rect', 'ellipse']

const load = (k, d) => {
  try {
    const v = localStorage.getItem(k)
    return v == null ? d : JSON.parse(v)
  } catch {
    return d
  }
}
const save = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {}
}

// what was copied or cut with Ctrl+C / Ctrl+X: {canvas, x, y} (shared by all drawing tabs)
let drawClip = null

// the brush packs read so far (shared by all drawing tabs)
const packCache = new Map()
async function loadPacks() {
  const files = (await window.api.brushesList()) || []
  const out = []
  for (const f of files) {
    const name = typeof f === 'string' ? f : f.name
    if (!packCache.has(name)) {
      try {
        const bytes = await window.api.brushesRead(name)
        const r = await loadKritaPack(new Uint8Array(bytes), name.replace(/\.(bundle|kpp|zip)$/i, ''))
        packCache.set(name, { file: name, title: r.title, brushes: r.brushes, skipped: r.skipped })
      } catch (e) {
        packCache.set(name, { file: name, title: name + ' (could not be read)', brushes: [], skipped: [], error: String((e && e.message) || e) })
      }
    }
    out.push(packCache.get(name))
  }
  return out
}

// One open drawing (a tab): layers of pixels, brushes with pen pressure, shapes, fill and selections.
export default function DrawingEditor({ tabId, active, initial, binds, onMeta, onNew, onOpen, registerHandle }) {
  const [doc, setDocState] = useState(() => {
    const c = (initial && initial.canvas) || { w: 1920, h: 1080, bg: '#ffffff' }
    return Doc.blank(c.w, c.h, c.bg)
  })
  const docRef = useRef(doc)
  docRef.current = doc
  const [rev, bump] = useReducer((x) => x + 1, 0)
  useEffect(() => doc.on(() => bump()), [doc])
  const activeRef = useRef(active)
  activeRef.current = active

  const [projectPath, setProjectPath] = useState(null)
  const projectRef = useRef(null)
  projectRef.current = projectPath
  const projectName = projectPath ? projectPath.split(/[\\/]/).pop().replace(/\.json$/i, '') : 'Untitled'
  const savedRev = useRef(doc.rev)
  const autoRev = useRef(-1)
  const thumbRef = useRef(null)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  useEffect(() => {
    setDirty(doc.rev !== savedRev.current)
  }, [rev, doc])

  // ---- tools and options
  const [tool, setToolState] = useState('brush')
  const toolRef = useRef('brush')
  const setTool = (t) => {
    toolRef.current = t
    setToolState(t)
  }
  const [fg, setFgState] = useState(() => load('vibe.draw.fg', '#000000'))
  const [bg, setBg] = useState(() => load('vibe.draw.bg', '#ffffff'))
  const [recent, setRecent] = useState(() => load('vibe.draw.recent', []))
  const [opts, setOptsState] = useState(() => ({ size: 12, opacity: 1, flow: 1, smoothing: 0.15, spacing: 1, mirrorX: false, mirrorY: false, mousePressure: 0.75, shapeFill: 'none', fillTol: 0.12, fillAll: false, selShape: 'rect', smartShape: 'box', smartLayerOnly: false, ...load('vibe.draw.opts', {}) }))
  const optsRef = useRef(opts)
  optsRef.current = opts
  const setOpts = (p) => {
    const n = { ...optsRef.current, ...p }
    optsRef.current = n
    setOptsState(n)
    save('vibe.draw.opts', n)
  }
  const fgRef = useRef(fg)
  fgRef.current = fg
  const bgRef = useRef(bg)
  bgRef.current = bg
  const setFg = (c) => {
    fgRef.current = c
    setFgState(c)
    save('vibe.draw.fg', c)
  }
  const setBackground = (c) => {
    bgRef.current = c
    setBg(c)
    save('vibe.draw.bg', c)
  }
  const swapColours = () => {
    const a = fgRef.current
    setFg(bgRef.current)
    setBackground(a)
  }
  const useColour = (c) => {
    setRecent((r) => {
      const n = [c, ...r.filter((x) => x.toLowerCase() !== c.toLowerCase())].slice(0, 12)
      save('vibe.draw.recent', n)
      return n
    })
  }

  // ---- brushes
  const builtin = builtinBrushes()
  const [packs, setPacks] = useState([])
  const [brush, setBrushState] = useState(() => builtin.find((b) => b.id === load('vibe.draw.brush', 'b:pencil')) || builtin[0])
  const brushRef = useRef(brush)
  brushRef.current = brush
  const pickBrush = (b) => {
    brushRef.current = b
    setBrushState(b)
    save('vibe.draw.brush', b.id)
    setOpts({ size: Math.max(1, Math.round(b.size || 20)) })
    if (toolRef.current !== 'brush' && toolRef.current !== 'eraser' && toolRef.current !== 'smudge' && !PAINT_TOOLS.includes(toolRef.current)) setTool('brush')
  }
  useEffect(() => {
    loadPacks().then(setPacks).catch(() => {})
  }, [])
  useEffect(() => {
    // the brush used last time, from a pack
    const id = load('vibe.draw.brush', '')
    if (id.startsWith('k:')) {
      for (const p of packs) {
        const b = p.brushes.find((x) => x.id === id)
        if (b) {
          setBrushState(b)
          break
        }
      }
    }
  }, [packs.length])
  const [busy, setBusy] = useState(false)
  const importPacks = async () => {
    setBusy(true)
    try {
      await window.api.brushesImport()
      setPacks(await loadPacks())
    } finally {
      setBusy(false)
    }
  }
  const removePack = async (p) => {
    if (!window.confirm(`Remove "${p.title || p.file}" from the editor? (your original file is not touched)`)) return
    await window.api.brushesDelete(p.file)
    packCache.delete(p.file)
    setPacks(await loadPacks())
  }

  // ---- messages, panels
  const [note, setNote] = useState('')
  const flash = (t) => {
    setNote(t)
    setTimeout(() => setNote((n) => (n === t ? '' : n)), 4000)
  }
  const flag = (k, d = true) => load(k, d)
  const [layersOpen, setLayersOpenState] = useState(() => flag('vibe.layersOpen'))
  const [inspOpen, setInspOpenState] = useState(() => flag('vibe.inspOpen'))
  const setLayersOpen = (v) => (setLayersOpenState(v), save('vibe.layersOpen', v ? 1 : 0))
  const setInspOpen = (v) => (setInspOpenState(v), save('vibe.inspOpen', v ? 1 : 0))
  const [showExport, setShowExport] = useState(false)

  // ---- the view (zoom, position, rotation, mirror)
  const stageRef = useRef(null)
  const canvasRef = useRef(null)
  const compRef = useRef(null)
  const viewRef = useRef({ zoom: 1, x: 0, y: 0, rot: 0, flip: false })
  const [zoomLabel, setZoomLabel] = useState(100)
  const sizeRef = useRef({ w: 800, h: 600 })
  const liveRef = useRef(null) // the stroke in progress, for drawing
  const cursorRef = useRef(null) // {x, y} in screen pixels of the canvas element
  const drawQueued = useRef(false)
  const pattern = useRef(null)

  // the box around a layer's content, looked up again only when the picture changed
  const boundsCache = useRef({ layerId: null, rev: -2, b: null })
  const layerBounds = (layer) => {
    const c = boundsCache.current
    const d = docRef.current
    if (c.layerId === layer.id && c.rev === d.rev) return c.b
    if (c.layerId === layer.id && c.rev === -1) {
      boundsCache.current = { layerId: layer.id, rev: d.rev, b: c.b } // set live while resizing
      return c.b
    }
    const b = d.contentBounds(layer)
    boundsCache.current = { layerId: layer.id, rev: d.rev, b }
    return b
  }

  const matrix = () => {
    const v = viewRef.current
    const d = docRef.current
    const { w: W, h: H } = sizeRef.current
    const r = (v.rot * Math.PI) / 180
    const zx = v.zoom * (v.flip ? -1 : 1)
    const zy = v.zoom
    const a = Math.cos(r) * zx
    const b = Math.sin(r) * zx
    const c = -Math.sin(r) * zy
    const dd = Math.cos(r) * zy
    return { a, b, c, d: dd, e: W / 2 + v.x - (a * d.w / 2 + c * d.h / 2), f: H / 2 + v.y - (b * d.w / 2 + dd * d.h / 2) }
  }
  const toDoc = (sx, sy) => {
    const m = matrix()
    const det = m.a * m.d - m.b * m.c
    return { x: (m.d * (sx - m.e) - m.c * (sy - m.f)) / det, y: (-m.b * (sx - m.e) + m.a * (sy - m.f)) / det }
  }
  const toScreen = (x, y) => {
    const m = matrix()
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }
  }
  const fit = () => {
    const d = docRef.current
    const { w: W, h: H } = sizeRef.current
    const v = viewRef.current
    v.rot = 0
    v.flip = false
    v.x = 0
    v.y = 0
    v.zoom = Math.max(0.02, Math.min(8, Math.min((W - 60) / d.w, (H - 60) / d.h)))
    setZoomLabel(Math.round(v.zoom * 100))
    redraw()
  }
  const setZoomAt = (z, sx, sy) => {
    const v = viewRef.current
    const { w: W, h: H } = sizeRef.current
    const cx = sx == null ? W / 2 : sx
    const cy = sy == null ? H / 2 : sy
    const p = toDoc(cx, cy)
    v.zoom = Math.max(0.02, Math.min(64, z))
    const q = toScreen(p.x, p.y)
    v.x += cx - q.x
    v.y += cy - q.y
    setZoomLabel(Math.round(v.zoom * 100))
    redraw()
  }
  const redraw = () => {
    if (drawQueued.current) return
    drawQueued.current = true
    requestAnimationFrame(() => {
      drawQueued.current = false
      draw()
    })
  }
  const draw = () => {
    const cv = canvasRef.current
    const d = docRef.current
    if (!cv || !d) return
    const dpr = window.devicePixelRatio || 1
    const { w: W, h: H } = sizeRef.current
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr)
      cv.height = Math.round(H * dpr)
    }
    const g = cv.getContext('2d')
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, cv.width, cv.height)
    const m = matrix()
    const v = viewRef.current
    if (!compRef.current || compRef.current.width !== d.w || compRef.current.height !== d.h) compRef.current = newCanvas(d.w, d.h)
    const live = liveRef.current
    let liveArg = null
    if (live && live.stroke && live.stroke.dirty) {
      const r = d.clampRect(live.stroke.dirty)
      if (r) liveArg = { layerId: live.layerId, buffer: live.buffer, rect: r, opacity: live.opacity, erase: live.erase, comp: live.comp, alphaLock: live.alphaLock, mask: d.selection ? d.selection.mask : null }
    }
    d.render(compRef.current.getContext('2d'), liveArg)
    // the paper: a shadow, and a checkerboard under see-through pictures
    g.setTransform(dpr * m.a, dpr * m.b, dpr * m.c, dpr * m.d, dpr * m.e, dpr * m.f)
    g.save()
    g.shadowColor = 'rgba(0,0,0,.35)'
    g.shadowBlur = 18
    g.fillStyle = '#fff'
    g.fillRect(0, 0, d.w, d.h)
    g.restore()
    if (d.bg === 'transparent') {
      g.save()
      g.beginPath()
      g.rect(0, 0, d.w, d.h)
      g.clip()
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (!pattern.current) {
        const p = newCanvas(16, 16)
        const pg = p.getContext('2d')
        pg.fillStyle = '#d9d9d9'
        pg.fillRect(0, 0, 16, 16)
        pg.fillStyle = '#b8b8b8'
        pg.fillRect(0, 0, 8, 8)
        pg.fillRect(8, 8, 8, 8)
        pattern.current = g.createPattern(p, 'repeat')
      }
      g.fillStyle = pattern.current
      g.fillRect(0, 0, W, H)
      g.restore()
    }
    g.imageSmoothingEnabled = v.zoom < 2
    g.imageSmoothingQuality = 'high'
    g.drawImage(compRef.current, 0, 0)
    // the overlays, in screen pixels
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    const S = (x, y) => toScreen(x, y)
    // the selection
    const sel = d.selection
    if (sel) {
      const path = (c) => {
        c.beginPath()
        for (const s of sel.shapes) {
          if (s.type === 'mask') continue
          if (s.type === 'rect' || s.type === 'all') {
            const p = [S(s.x, s.y), S(s.x + s.w, s.y), S(s.x + s.w, s.y + s.h), S(s.x, s.y + s.h)]
            c.moveTo(p[0].x, p[0].y)
            p.slice(1).forEach((q) => c.lineTo(q.x, q.y))
            c.closePath()
          } else if (s.type === 'ellipse') {
            const n = 72
            for (let i = 0; i <= n; i++) {
              const a = (i / n) * Math.PI * 2
              const q = S(s.x + s.w / 2 + (Math.cos(a) * s.w) / 2, s.y + s.h / 2 + (Math.sin(a) * s.h) / 2)
              if (i) c.lineTo(q.x, q.y)
              else c.moveTo(q.x, q.y)
            }
            c.closePath()
          } else {
            s.pts.forEach((p, i) => {
              const q = S(p.x, p.y)
              if (i) c.lineTo(q.x, q.y)
              else c.moveTo(q.x, q.y)
            })
            c.closePath()
          }
        }
      }
      g.lineWidth = 1
      g.setLineDash([])
      g.strokeStyle = '#000'
      path(g)
      g.stroke()
      g.setLineDash([5, 5])
      g.strokeStyle = '#fff'
      path(g)
      g.stroke()
      g.setLineDash([])
      // a selection of any shape (a line that was clicked on, something that was moved): tinted, with its box dashed
      if (sel.shapes.some((s) => s.type === 'mask') && !sel.inverted) {
        if (!sel._tint) {
          const t = newCanvas(d.w, d.h)
          const tg = t.getContext('2d')
          tg.fillStyle = '#c4a7e7'
          tg.fillRect(0, 0, d.w, d.h)
          tg.globalCompositeOperation = 'destination-in'
          tg.drawImage(sel.mask, 0, 0)
          sel._tint = t
        }
        g.save()
        g.setTransform(dpr * m.a, dpr * m.b, dpr * m.c, dpr * m.d, dpr * m.e, dpr * m.f)
        g.globalAlpha = 0.45
        g.drawImage(sel._tint, 0, 0)
        g.restore()
        const b = sel.bounds
        if (b) {
          const p = [S(b.x, b.y), S(b.x + b.w, b.y), S(b.x + b.w, b.y + b.h), S(b.x, b.y + b.h)]
          g.beginPath()
          g.moveTo(p[0].x, p[0].y)
          p.slice(1).forEach((q) => g.lineTo(q.x, q.y))
          g.closePath()
          g.setLineDash([4, 4])
          g.strokeStyle = '#000'
          g.stroke()
          g.lineDashOffset = 4
          g.strokeStyle = '#fff'
          g.stroke()
          g.lineDashOffset = 0
          g.setLineDash([])
        }
      }
    }
    const pre = liveRef.current && liveRef.current.selDraft
    if (pre) {
      g.setLineDash([4, 4])
      g.strokeStyle = '#fff'
      g.lineWidth = 1
      g.beginPath()
      if (pre.type === 'lasso') pre.pts.forEach((p, i) => (i ? g.lineTo(S(p.x, p.y).x, S(p.x, p.y).y) : g.moveTo(S(p.x, p.y).x, S(p.x, p.y).y)))
      else if (pre.type === 'rect') {
        const p = [S(pre.x, pre.y), S(pre.x + pre.w, pre.y), S(pre.x + pre.w, pre.y + pre.h), S(pre.x, pre.y + pre.h)]
        g.moveTo(p[0].x, p[0].y)
        p.slice(1).forEach((q) => g.lineTo(q.x, q.y))
        g.closePath()
      } else {
        for (let i = 0; i <= 60; i++) {
          const a = (i / 60) * Math.PI * 2
          const q = S(pre.x + pre.w / 2 + (Math.cos(a) * pre.w) / 2, pre.y + pre.h / 2 + (Math.sin(a) * pre.h) / 2)
          if (i) g.lineTo(q.x, q.y)
          else g.moveTo(q.x, q.y)
        }
      }
      g.stroke()
      g.setLineDash([])
    }
    // the Move tool: the box around what is on the layer, with corner handles to resize it
    if (toolRef.current === 'move' && d.active && d.active.visible) {
      const lb = layerBounds(d.active)
      if (lb) {
        const p = [S(lb.x, lb.y), S(lb.x + lb.w, lb.y), S(lb.x + lb.w, lb.y + lb.h), S(lb.x, lb.y + lb.h)]
        g.beginPath()
        g.moveTo(p[0].x, p[0].y)
        p.slice(1).forEach((q) => g.lineTo(q.x, q.y))
        g.closePath()
        g.lineWidth = 1.5
        g.strokeStyle = '#c4a7e7'
        g.setLineDash([])
        g.stroke()
        for (const q of p) {
          g.fillStyle = '#fff'
          g.fillRect(q.x - 5, q.y - 5, 10, 10)
          g.strokeStyle = '#26233a'
          g.strokeRect(q.x - 5, q.y - 5, 10, 10)
        }
      }
    }
    // mirror guides
    const o = optsRef.current
    g.strokeStyle = 'rgba(196,167,231,.8)'
    g.lineWidth = 1
    g.setLineDash([6, 4])
    if (o.mirrorX) {
      const a = S(d.w / 2, 0)
      const b = S(d.w / 2, d.h)
      g.beginPath()
      g.moveTo(a.x, a.y)
      g.lineTo(b.x, b.y)
      g.stroke()
    }
    if (o.mirrorY) {
      const a = S(0, d.h / 2)
      const b = S(d.w, d.h / 2)
      g.beginPath()
      g.moveTo(a.x, a.y)
      g.lineTo(b.x, b.y)
      g.stroke()
    }
    g.setLineDash([])
    // the brush ring
    const cu = cursorRef.current
    const t = toolRef.current
    if (cu && ['brush', 'eraser', 'smudge'].includes(t)) {
      const r = Math.max(1.5, (o.size * v.zoom) / 2)
      g.lineWidth = 1
      g.strokeStyle = 'rgba(0,0,0,.85)'
      g.beginPath()
      g.arc(cu.x, cu.y, r, 0, Math.PI * 2)
      g.stroke()
      g.strokeStyle = 'rgba(255,255,255,.9)'
      g.beginPath()
      g.arc(cu.x, cu.y, r + 1, 0, Math.PI * 2)
      g.stroke()
    }
  }
  // keep the canvas as big as its box
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) return
      const first = sizeRef.current.w === 800 && sizeRef.current.h === 600 && !sizeRef.current.set
      sizeRef.current = { w: Math.round(r.width), h: Math.round(r.height), set: true }
      if (first || !viewRef.current.fitted) {
        viewRef.current.fitted = true
        fit()
      } else redraw()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    redraw()
  }, [rev, active, doc, opts.mirrorX, opts.mirrorY, opts.size, tool])
  useEffect(() => {
    if (active) setTimeout(() => stageRef.current && stageRef.current.getBoundingClientRect() && redraw(), 30)
  }, [active])

  // ---- pointer input
  const bufferRef = useRef(null)
  const spaceDown = useRef(false)
  const gesture = useRef(null)

  const sampleColour = (x, y) => {
    const d = docRef.current
    if (x < 0 || y < 0 || x >= d.w || y >= d.h) return null
    const c = compRef.current
    if (!c) return null
    const px = c.getContext('2d').getImageData(Math.floor(x), Math.floor(y), 1, 1).data
    if (px[3] === 0) return d.bg === 'transparent' ? null : d.bg
    return rgbToHex(px[0], px[1], px[2])
  }
  const point = (e, rect) => {
    const p = toDoc(e.clientX - rect.left, e.clientY - rect.top)
    let pressure = e.pointerType === 'pen' ? e.pressure : optsRef.current.mousePressure
    if (e.pointerType === 'pen' && pressure === 0) pressure = 0.01
    return { x: p.x, y: p.y, pressure, tiltX: e.tiltX || 0, tiltY: e.tiltY || 0, t: e.timeStamp }
  }
  const strokeParams = (erase) => {
    const d = docRef.current
    const o = optsRef.current
    if (!bufferRef.current || bufferRef.current.width !== d.w || bufferRef.current.height !== d.h) bufferRef.current = newCanvas(d.w, d.h)
    const b = brushRef.current
    const isErase = erase || b.comp === 'erase'
    return {
      brush: b,
      size: o.size,
      flow: o.flow,
      colour: fgRef.current,
      smoothing: o.smoothing,
      spacingMul: o.spacing,
      mirrorX: o.mirrorX,
      mirrorY: o.mirrorY,
      w: d.w,
      h: d.h,
      buffer: bufferRef.current,
      erase: isErase,
    }
  }
  const finishStroke = (lv) => {
    const d = docRef.current
    const layer = d.layer(lv.layerId)
    liveRef.current = null
    if (!layer) return
    lv.stroke.finish()
    const rect = d.clampRect(lv.stroke.dirty || { x: 0, y: 0, w: 0, h: 0 })
    if (rect) {
      const before = d.grab(layer, rect)
      mergeBuffer(layer.canvas.getContext('2d'), lv.buffer, rect, { opacity: lv.opacity, erase: lv.erase, comp: lv.comp, alphaLock: lv.alphaLock, mask: d.selection ? d.selection.mask : null })
      d.commitPixels(layer, rect, before, 'Paint')
    }
    lv.stroke.clearBuffer()
    useColour(fgRef.current)
  }

  const onPointerDown = (e) => {
    const cv = canvasRef.current
    if (!cv) return
    if (e.button === 2) return
    const rect = cv.getBoundingClientRect()
    const d = docRef.current
    try {
      cv.setPointerCapture(e.pointerId)
    } catch {}
    const t = toolRef.current
    const panning = e.button === 1 || spaceDown.current || t === 'hand' || e.pointerType === 'touch'
    if (panning) {
      const v = viewRef.current
      gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y }
      return
    }
    const p = point(e, rect)
    // Alt: pick a colour with any painting tool
    if ((e.altKey && ['brush', 'eraser', 'smudge', 'line', 'rect', 'ellipse', 'fill'].includes(t)) || t === 'eyedropper') {
      gesture.current = { kind: 'pick' }
      const c = sampleColour(p.x, p.y)
      if (c) setFg(c)
      return
    }
    const layer = d.active
    const needsLayer = t !== 'select'
    if (needsLayer) {
      if (!layer) return
      if (layer.locked) return flash('This layer is locked. Unlock it (the padlock in the Layers panel) to paint on it.')
      if (!layer.visible) return flash('This layer is hidden. Show it (the eye in the Layers panel) to paint on it.')
    }
    const o = optsRef.current
    if (t === 'fill') {
      const src = o.fillAll ? compRef.current : layer.canvas
      const m = floodMask(src, p.x, p.y, o.fillTol, d.selection ? d.selection.mask : null)
      if (!m) return
      const piece = maskToCanvas(m, fgRef.current, 1)
      const r = d.clampRect({ x: piece.x, y: piece.y, w: piece.w, h: piece.h })
      if (!r) return
      const before = d.grab(layer, r)
      const g = layer.canvas.getContext('2d')
      g.save()
      g.globalCompositeOperation = layer.alphaLock ? 'source-atop' : 'source-over'
      g.drawImage(piece.canvas, piece.x, piece.y)
      g.restore()
      d.commitPixels(layer, r, before, 'Fill')
      useColour(fgRef.current)
      return
    }
    if (t === 'select' || t === 'lasso' || t === 'smart') {
      // dragging something that is selected carries it along (Alt: a copy of it)
      if (d.selection && !e.shiftKey && d.inSelection(p.x, p.y)) {
        if (!layer || layer.locked || !layer.visible) return flash('Choose an unlocked, visible layer to move what is selected.')
        const parts = d.liftParts(layer, e.altKey)
        gesture.current = { kind: 'selmove', layer, parts, start: p, copy: e.altKey, moved: false }
        return
      }
      const shape = t === 'lasso' ? 'lasso' : t === 'smart' ? (o.smartShape === 'loop' ? 'lasso' : 'rect') : o.selShape
      gesture.current = { kind: 'select', start: p, startScreen: { x: e.clientX, y: e.clientY }, shape, smart: t === 'smart', plain: t !== 'select', pts: [{ x: p.x, y: p.y }], mode: e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace', dragged: false }
      liveRef.current = { selDraft: { type: shape, x: p.x, y: p.y, w: 0, h: 0, pts: [p] } }
      return
    }
    if (t === 'move') {
      // a corner of the box around the layer's content resizes it (keeping its proportions); anywhere else moves it
      const b = layerBounds(layer)
      const full = { x: 0, y: 0, w: d.w, h: d.h }
      if (b) {
        const cs = [[b.x, b.y, 'tl'], [b.x + b.w, b.y, 'tr'], [b.x + b.w, b.y + b.h, 'br'], [b.x, b.y + b.h, 'bl']]
        const hit = cs.find((c) => {
          const s = toScreen(c[0], c[1])
          return Math.hypot(s.x - (e.clientX - rect.left), s.y - (e.clientY - rect.top)) < 12
        })
        if (hit) {
          gesture.current = { kind: 'layerscale', layer, corner: hit[2], orig: b, before: d.grab(layer, full) }
          return
        }
      }
      gesture.current = { kind: 'move', start: p, before: d.grab(layer, full), layer }
      return
    }
    if (t === 'smudge') {
      const rectAll = { x: 0, y: 0, w: d.w, h: d.h }
      const sm = new Smudge({ layer: layer.canvas, brush: brushRef.current, size: o.size, strength: o.flow < 1 ? o.flow : 0.7, w: d.w, h: d.h })
      gesture.current = { kind: 'smudge', sm, layer, before: d.grab(layer, rectAll) }
      sm.begin(p)
      redraw()
      return
    }
    if (t === 'brush' || t === 'eraser') {
      const sp = strokeParams(t === 'eraser')
      const stroke = new Stroke(sp)
      const opacity = (o.opacity == null ? 1 : o.opacity) * (sp.brush.opacity == null ? 1 : sp.brush.opacity)
      const lv = { stroke, buffer: sp.buffer, layerId: layer.id, opacity, erase: sp.erase, comp: sp.brush.comp, alphaLock: layer.alphaLock }
      liveRef.current = lv
      gesture.current = { kind: 'stroke', lv }
      stroke.begin(p)
      redraw()
      return
    }
    // shapes
    const sp = strokeParams(false)
    const stroke = new Stroke(sp)
    const opacity = (o.opacity == null ? 1 : o.opacity) * (sp.brush.opacity == null ? 1 : sp.brush.opacity)
    const lv = { stroke, buffer: sp.buffer, layerId: layer.id, opacity, erase: sp.erase, comp: sp.brush.comp, alphaLock: layer.alphaLock }
    liveRef.current = lv
    gesture.current = { kind: 'shape', lv, start: p, shape: t }
  }

  const shapePreview = (gst, p, e) => {
    const { lv, start, shape } = gst
    const st = lv.stroke
    st.clearBuffer()
    let x1 = p.x
    let y1 = p.y
    let x0 = start.x
    let y0 = start.y
    const fillMode = optsRef.current.shapeFill
    let pts
    let closed = false
    if (shape === 'line') {
      if (e.shiftKey) {
        const a = Math.atan2(y1 - y0, x1 - x0)
        const snap = Math.round(a / (Math.PI / 12)) * (Math.PI / 12)
        const len = Math.hypot(x1 - x0, y1 - y0)
        x1 = x0 + Math.cos(snap) * len
        y1 = y0 + Math.sin(snap) * len
      }
      pts = [{ x: x0, y: y0 }, { x: x1, y: y1 }]
    } else {
      let w = x1 - x0
      let h = y1 - y0
      if (e.shiftKey) {
        const s = Math.max(Math.abs(w), Math.abs(h))
        w = Math.sign(w || 1) * s
        h = Math.sign(h || 1) * s
      }
      let cx = x0 + w / 2
      let cy = y0 + h / 2
      let hw = w / 2
      let hh = h / 2
      if (e.altKey) {
        cx = x0
        cy = y0
        hw = w
        hh = h
      }
      if (shape === 'rect') pts = rectPoints(cx - hw, cy - hh, cx + hw, cy + hh)
      else pts = ellipsePoints(cx, cy, Math.abs(hw), Math.abs(hh))
      closed = true
      if (fillMode !== 'none') {
        const g = st.g
        g.save()
        g.setTransform(1, 0, 0, 1, 0, 0)
        g.globalAlpha = 1
        g.fillStyle = fillMode === 'bg' ? bgRef.current : fgRef.current
        g.beginPath()
        if (shape === 'rect') g.rect(cx - hw, cy - hh, hw * 2, hh * 2)
        else g.ellipse(cx, cy, Math.abs(hw), Math.abs(hh), 0, 0, Math.PI * 2)
        g.fill()
        if (optsRef.current.mirrorX) {
          g.beginPath()
          if (shape === 'rect') g.rect(docRef.current.w - cx - hw, cy - hh, hw * 2, hh * 2)
          else g.ellipse(docRef.current.w - cx, cy, Math.abs(hw), Math.abs(hh), 0, 0, Math.PI * 2)
          g.fill()
        }
        g.restore()
        st._grow(cx, cy, Math.hypot(hw, hh) + 4)
        if (optsRef.current.mirrorX) st._grow(docRef.current.w - cx, cy, Math.hypot(hw, hh) + 4)
      }
    }
    st.polyline(pts, closed)
  }

  const onPointerMove = (e) => {
    const cv = canvasRef.current
    if (!cv) return
    const rect = cv.getBoundingClientRect()
    cursorRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const gst = gesture.current
    if (!gst) {
      if (['brush', 'eraser', 'smudge'].includes(toolRef.current)) redraw()
      return
    }
    if (gst.kind === 'pan') {
      const v = viewRef.current
      v.x = gst.vx + (e.clientX - gst.sx)
      v.y = gst.vy + (e.clientY - gst.sy)
      redraw()
      return
    }
    if (gst.kind === 'pick') {
      const p = point(e, rect)
      const c = sampleColour(p.x, p.y)
      if (c) setFg(c)
      return
    }
    // coalesced events give every little movement of a fast pen
    const evs = e.nativeEvent.getCoalescedEvents ? e.nativeEvent.getCoalescedEvents() : []
    const list = evs.length ? evs : [e.nativeEvent]
    if (gst.kind === 'stroke') {
      for (const ev of list) {
        const p = point({ clientX: ev.clientX, clientY: ev.clientY, pointerType: ev.pointerType, pressure: ev.pressure, tiltX: ev.tiltX, tiltY: ev.tiltY, timeStamp: ev.timeStamp }, rect)
        gst.lv.stroke.move(p)
      }
      redraw()
    } else if (gst.kind === 'smudge') {
      for (const ev of list) {
        const p = point({ clientX: ev.clientX, clientY: ev.clientY, pointerType: ev.pointerType, pressure: ev.pressure, tiltX: ev.tiltX, tiltY: ev.tiltY, timeStamp: ev.timeStamp }, rect)
        gst.sm.move(p)
      }
      docRef.current.changed(true)
    } else if (gst.kind === 'shape') {
      shapePreview(gst, point(e, rect), e)
      redraw()
    } else if (gst.kind === 'move') {
      const p = point(e, rect)
      docRef.current.shiftLayer(gst.layer, gst.before, p.x - gst.start.x, p.y - gst.start.y)
      docRef.current.changed(true)
    } else if (gst.kind === 'layerscale') {
      // the opposite corner stays where it is; the content is redrawn from the original each time (no blur from repeats)
      const p = point(e, rect)
      const o = gst.orig
      const ratio = o.w / o.h
      const ax = gst.corner === 'tl' || gst.corner === 'bl' ? o.x + o.w : o.x
      const ay = gst.corner === 'tl' || gst.corner === 'tr' ? o.y + o.h : o.y
      let w = Math.max(8, Math.abs(p.x - ax))
      let h = w / ratio
      if (Math.abs(p.y - ay) > h) {
        h = Math.abs(p.y - ay)
        w = h * ratio
      }
      const x = gst.corner === 'tl' || gst.corner === 'bl' ? ax - w : ax
      const y = gst.corner === 'tl' || gst.corner === 'tr' ? ay - h : ay
      const g = gst.layer.canvas.getContext('2d')
      g.save()
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.globalCompositeOperation = 'source-over'
      g.globalAlpha = 1
      g.clearRect(0, 0, docRef.current.w, docRef.current.h)
      g.imageSmoothingEnabled = true
      g.imageSmoothingQuality = 'high'
      g.drawImage(gst.before, o.x, o.y, o.w, o.h, x, y, w, h)
      g.restore()
      boundsCache.current = { layerId: gst.layer.id, rev: -1, b: { x, y, w, h } }
      gst.now = { x, y, w, h }
      docRef.current.changed(true)
    } else if (gst.kind === 'selmove') {
      const p = point(e, rect)
      const dx = Math.round(p.x - gst.start.x)
      const dy = Math.round(p.y - gst.start.y)
      if (!gst.moved && Math.abs(dx) + Math.abs(dy) < 2) return
      gst.moved = true
      gst.dx = dx
      gst.dy = dy
      docRef.current.paintMoved(gst.layer, gst.parts, dx, dy)
      docRef.current.changed(true)
    } else if (gst.kind === 'select') {
      const p = point(e, rect)
      if (Math.hypot(e.clientX - gst.startScreen.x, e.clientY - gst.startScreen.y) > 4) gst.dragged = true
      if (gst.shape === 'lasso') {
        gst.pts.push({ x: p.x, y: p.y })
        liveRef.current = { selDraft: { type: 'lasso', pts: gst.pts } }
      } else {
        let x0 = gst.start.x
        let y0 = gst.start.y
        let w = p.x - x0
        let h = p.y - y0
        if (e.shiftKey && gst.mode === 'replace') {
          const s = Math.max(Math.abs(w), Math.abs(h))
          w = Math.sign(w || 1) * s
          h = Math.sign(h || 1) * s
        }
        if (w < 0) {
          x0 += w
          w = -w
        }
        if (h < 0) {
          y0 += h
          h = -h
        }
        liveRef.current = { selDraft: { type: gst.shape, x: x0, y: y0, w, h } }
      }
      redraw()
    }
  }
  const onPointerUp = (e) => {
    const gst = gesture.current
    gesture.current = null
    if (!gst) return
    const d = docRef.current
    if (gst.kind === 'stroke' || gst.kind === 'shape') {
      finishStroke(gst.lv)
    } else if (gst.kind === 'smudge') {
      const r = d.clampRect(gst.sm.dirty || { x: 0, y: 0, w: 0, h: 0 })
      if (r) {
        const layer = gst.layer
        const crop = newCanvas(r.w, r.h)
        crop.getContext('2d').drawImage(gst.before, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
        // with a selection only the selected part keeps the smudge
        if (d.selection) {
          const after = d.grab(layer, r)
          const ag = after.getContext('2d')
          ag.globalCompositeOperation = 'destination-in'
          ag.drawImage(d.selection.mask, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
          const lg = layer.canvas.getContext('2d')
          lg.clearRect(r.x, r.y, r.w, r.h)
          lg.drawImage(gst.before, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h)
          // the old picture loses the selected part, which gets the smudged picture instead
          lg.save()
          lg.globalCompositeOperation = 'destination-out'
          lg.drawImage(d.selection.mask, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h)
          lg.restore()
          lg.drawImage(after, r.x, r.y)
        }
        d.commitPixels(layer, r, crop, 'Smudge')
      }
    } else if (gst.kind === 'move') {
      const r = { x: 0, y: 0, w: d.w, h: d.h }
      d.commitPixels(gst.layer, r, gst.before, 'Move layer')
    } else if (gst.kind === 'layerscale') {
      if (gst.now) d.commitPixels(gst.layer, { x: 0, y: 0, w: d.w, h: d.h }, gst.before, 'Resize layer')
    } else if (gst.kind === 'selmove') {
      if (gst.moved && (gst.dx || gst.dy)) {
        d.commitPixels(gst.layer, gst.parts.full, gst.parts.before, gst.copy ? 'Copy selection' : 'Move selection')
        d.shiftSelection(gst.dx, gst.dy)
      } else d.paintMoved(gst.layer, gst.parts, 0, 0) // a click: nothing changes
      if (!gst.moved || (!gst.dx && !gst.dy)) d.changed(true)
    } else if (gst.kind === 'select') {
      const dr = liveRef.current && liveRef.current.selDraft
      liveRef.current = null
      let done = false
      if (gst.dragged && dr && !gst.smart) {
        if (dr.type === 'lasso') {
          if (dr.pts.length > 3) {
            d.setSelection({ type: 'lasso', pts: dr.pts }, gst.mode)
            done = true
          }
        } else if (dr.w > 2 && dr.h > 2) {
          d.setSelection({ type: dr.type, x: dr.x, y: dr.y, w: dr.w, h: dr.h }, gst.mode)
          done = true
        }
      }
      if (gst.smart) {
        // the AI finds the exact outline: from a click on the subject, or from a rough box / loop around it
        let prompt
        const W = d.w
        const H = d.h
        if (gst.dragged && dr && dr.type === 'lasso' && dr.pts.length > 3) {
          const step = Math.max(1, Math.floor(dr.pts.length / 40))
          prompt = promptFromLoop(dr.pts.filter((_, i) => i % step === 0).map((q) => [q.x / W, q.y / H]))
        } else if (gst.dragged && dr && dr.type !== 'lasso' && dr.w > 6 && dr.h > 6) {
          prompt = promptFromLoop([[dr.x / W, dr.y / H], [(dr.x + dr.w) / W, dr.y / H], [(dr.x + dr.w) / W, (dr.y + dr.h) / H], [dr.x / W, (dr.y + dr.h) / H]])
        } else if (!gst.dragged) prompt = [{ x: gst.start.x / W, y: gst.start.y / H, label: 1 }]
        if (prompt) runSmartSelect(prompt, gst.mode)
        done = true
      } else if (gst.plain && !gst.dragged) {
        // a click with the lasso: nothing to take, so the selection goes away
        if (gst.mode === 'replace') d.setSelection(null)
        done = true
      }
      if (!done) {
        // a click: take the line, shape or blob that is under it (on this layer, or else on a layer above or below)
        const reach = Math.max(4, 8 / viewRef.current.zoom)
        const order = [d.active, ...d.layers.slice().reverse().filter((l) => l !== d.active)].filter((l) => l && l.visible)
        let hit = null
        for (const l of order) {
          hit = objectMask(l.canvas, gst.start.x, gst.start.y, reach)
          if (hit) {
            if (l !== d.active) d.setActive(l.id)
            break
          }
        }
        if (hit) d.setSelectionMask(hit.canvas, hit.bounds, gst.mode)
        else if (gst.mode === 'replace') d.setSelection(null)
      }
    }
    liveRef.current = null
    redraw()
  }
  const onWheel = (e) => {
    e.preventDefault()
    const cv = canvasRef.current
    const rect = cv.getBoundingClientRect()
    const k = Math.exp(-e.deltaY * 0.0015)
    setZoomAt(viewRef.current.zoom * k, e.clientX - rect.left, e.clientY - rect.top)
  }
  useEffect(() => {
    // React makes wheel listeners passive: the zoom needs to stop the page from scrolling
    const cv = canvasRef.current
    if (!cv) return
    const h = (e) => onWheelRef.current(e)
    cv.addEventListener('wheel', h, { passive: false })
    return () => cv.removeEventListener('wheel', h)
  }, [])
  const onWheelRef = useRef(onWheel)
  onWheelRef.current = onWheel

  // ---- pictures as layers (references, photos to paint over, ...)
  // The picture goes on a new layer above the chosen one, a bit smaller than the canvas, in the middle. The Move tool then
  // moves it, and its corner handles resize it.
  const addPictureLayer = (img, name) => {
    const d = docRef.current
    const iw = img.naturalWidth || img.width
    const ih = img.naturalHeight || img.height
    const k = Math.min(1, (d.w * 0.6) / iw, (d.h * 0.6) / ih)
    const w = Math.max(1, iw * k)
    const h = Math.max(1, ih * k)
    const l = d.addLayer(name || 'Picture', { above: d.activeId })
    const g = l.canvas.getContext('2d')
    g.imageSmoothingQuality = 'high'
    g.drawImage(img, (d.w - w) / 2, (d.h - h) / 2, w, h)
    d.changed(true)
    setTool('move')
    return l
  }
  const loadPictureUrl = (url, name) =>
    new Promise((resolve) => {
      const img = new Image()
      img.onload = () => resolve(addPictureLayer(img, name))
      img.onerror = () => {
        flash('That picture could not be opened.')
        resolve(null)
      }
      img.src = url
    })
  const importPictures = async () => {
    setBusy(true)
    try {
      const items = await window.api.importMedia('image')
      for (const it of items || []) if (it.type === 'image') await loadPictureUrl(toUrl(it.path), it.name.replace(/\.[^.]+$/, ''))
      if (items && items.length) flash('Picture added as a new layer. Drag it to move it, drag a corner to resize it.')
    } finally {
      setBusy(false)
    }
  }
  // pictures dropped onto the window become layers
  const onDropFiles = async (e) => {
    const files = [...e.dataTransfer.files].filter((f) => /^image\//.test(f.type))
    if (!files.length) return
    e.preventDefault()
    for (const f of files) await loadPictureUrl(URL.createObjectURL(f), f.name.replace(/\.[^.]+$/, ''))
    flash('Added as a new layer. Drag it to move it, drag a corner to resize it.')
  }

  // ---- smart select (AI, SAM 2): the model is downloaded once on request
  const [models, setModels] = useState(null) // {ready, totalBytes, paths}
  const [gpu, setGpu] = useState(null) // {ok, weak, name}
  const [dl, setDl] = useState(null) // {received, total} while downloading
  const [dlErr, setDlErr] = useState('')
  useEffect(() => {
    window.api.modelsStatus().then(setModels).catch(() => {})
    import('./smartMask.js').then((m) => m.gpuInfo()).then(setGpu).catch(() => {})
    return window.api.onModelsProgress(setDl)
  }, [])
  const downloadModel = async () => {
    setDlErr('')
    setDl({ received: 0, total: models ? models.totalBytes : 1 })
    const r = await window.api.modelsDownload()
    setDl(null)
    setModels(r)
    if (r.error) setDlErr(r.error)
  }
  const smartBusy = useRef(false)
  const runSmartSelect = async (prompt, mode) => {
    const d = docRef.current
    if (smartBusy.current) return
    try {
      const st = await window.api.modelsStatus()
      const { gpuInfo, findSubjectPrompt } = await import('./smartMask.js')
      const g = await gpuInfo()
      if (!g.ok) return flash('Smart select needs a graphics card, and this computer does not seem to have a usable one.')
      if (!st.ready) return flash('Smart select needs its AI model first: use the Download button in the panel on the right.')
      smartBusy.current = true
      flash('Finding the subject… (the first time takes a few seconds)')
      // what the AI looks at: the whole picture, or only the chosen layer, on white paper
      const el = newCanvas(d.w, d.h)
      const eg = el.getContext('2d')
      eg.fillStyle = '#ffffff'
      eg.fillRect(0, 0, d.w, d.h)
      if (optsRef.current.smartLayerOnly && d.active) eg.drawImage(d.active.canvas, 0, 0)
      else eg.drawImage(d.flatten(), 0, 0)
      const poly = await findSubjectPrompt({ el, w: d.w, h: d.h, prompt, paths: st.paths })
      if (!poly) return flash('No subject was found there. Try clicking on it, or draw the box a little bigger.')
      d.setSelection({ type: 'lasso', pts: poly.map(([x, y]) => ({ x: x * d.w, y: y * d.h })) }, mode)
      flash('Selected. Drag it to move it, or press Delete to remove it.')
    } catch (err) {
      flash('Smart select could not run: ' + String((err && err.message) || err))
    } finally {
      smartBusy.current = false
    }
  }

  // ---- saving, opening, autosave
  const rememberRecent = async (file, d) => {
    let thumb = thumbRef.current
    try {
      const data = await d.thumbBytes(256)
      thumb = await window.api.saveThumb({ key: file, data, replace: thumbRef.current })
      thumbRef.current = thumb
    } catch {}
    window.api.recentAdd({ path: file, name: file.split(/[\\/]/).pop().replace(/\.json$/i, ''), kind: 'drawing', thumb, clips: d.layers.length, duration: 0, size: `${d.w}×${d.h}` })
  }
  const saveProject = async (asNew) => {
    const d = docRef.current
    const json = await d.serialize()
    const rv = d.rev
    const file = await window.api.saveProject(asNew ? null : projectRef.current, json, `${projectName === 'Untitled' ? 'My drawing' : projectName}.json`)
    if (!file) return false
    setProjectPath(file)
    savedRev.current = rv
    autoRev.current = rv
    setDirty(d.rev !== rv)
    window.api.clearAutosave(tabId)
    rememberRecent(file, d)
    flash('Project saved.')
    return true
  }
  const loadFromJson = async (json, file) => {
    setBusy(true)
    try {
      const nd = await Doc.fromJson(json)
      docRef.current = nd
      setDocState(nd)
      setProjectPath(file)
      savedRev.current = nd.rev
      autoRev.current = nd.rev
      viewRef.current.fitted = false
      setTimeout(fit, 30)
      if (file) rememberRecent(file, nd)
      flash(file ? 'Project opened.' : 'Previous session restored.')
    } catch (e) {
      window.alert('Could not open that project:\n' + (e.message || e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (initial && initial.json) loadFromJson(initial.json, initial.file)
  }, [])
  useEffect(() => {
    registerHandle(tabId, { save: () => saveProject(false), isDirty: () => dirtyRef.current, getState: () => ({ drawing: true, doc: docRef.current }), dispatch: () => {} })
    return () => registerHandle(tabId, null)
  }, [])
  useEffect(() => {
    onMeta(tabId, { title: projectName, path: projectPath, dirty, kind: 'drawing' })
  }, [projectName, projectPath, dirty])
  useEffect(() => {
    const id = setInterval(async () => {
      const d = docRef.current
      if (d.rev === savedRev.current || d.rev === autoRev.current || gesture.current) return
      const rv = d.rev
      const json = await d.serialize()
      if (projectRef.current) {
        await window.api.saveProject(projectRef.current, json)
        savedRev.current = rv
        setDirty(d.rev !== rv)
      } else await window.api.autosave(tabId, json)
      autoRev.current = rv
    }, 15000)
    return () => clearInterval(id)
  }, [])

  // ---- keyboard
  useEffect(() => {
    const onKeyUp = (e) => {
      if (e.code === 'Space') spaceDown.current = false
    }
    const onKey = (e) => {
      if (!activeRef.current) return
      const tag = e.target.tagName
      const typing = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !['range', 'checkbox', 'color', 'radio', 'button'].includes(e.target.type))
      if (typing) return
      const d = docRef.current
      if (e.code === 'Space') {
        spaceDown.current = true
        e.preventDefault()
        return
      }
      const action = actionFor(binds, e)
      const h = {
        save: () => saveProject(false),
        saveAs: () => saveProject(true),
        open: onOpen,
        undo: () => d.undo(),
        redo: () => d.redo(),
        delete: () => d.active && d.clearLayer(d.active.id),
        duplicate: () => d.active && d.duplicateLayer(d.active.id),
      }
      if (action && h[action]) {
        e.preventDefault()
        return h[action]()
      }
      const k = e.key
      if (e.ctrlKey || e.metaKey) {
        if (k.toLowerCase() === 'd') {
          e.preventDefault()
          d.setSelection(null)
        } else if (k.toLowerCase() === 'a') {
          e.preventDefault()
          d.setSelection({ type: 'all' })
        } else if (k.toLowerCase() === 'i' && e.shiftKey) {
          e.preventDefault()
          d.invertSelection()
        } else if ((k.toLowerCase() === 'c' || k.toLowerCase() === 'x') && d.selection && d.active) {
          e.preventDefault()
          const c = d.copySelected(d.active)
          if (c) {
            drawClip = c
            if (k.toLowerCase() === 'x') d.clearLayer(d.active.id)
            flash(k.toLowerCase() === 'x' ? 'Cut. Paste it with Ctrl+V.' : 'Copied. Paste it with Ctrl+V.')
          }
        }
        return
      }
      if (e.altKey) return
      // arrow keys slide what is selected by one pixel (Shift: ten)
      if (d.selection && d.active && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k)) {
        e.preventDefault()
        const s = e.shiftKey ? 10 : 1
        d.moveSelected(d.active, k === 'ArrowLeft' ? -s : k === 'ArrowRight' ? s : 0, k === 'ArrowUp' ? -s : k === 'ArrowDown' ? s : 0)
        return
      }
      if (k === '[' || k === ']') {
        e.preventDefault()
        const s = optsRef.current.size
        const step = Math.max(1, Math.round(s * 0.12))
        setOpts({ size: Math.max(1, Math.min(1000, s + (k === ']' ? step : -step))) })
        return
      }
      if (k.toLowerCase() === 'x') {
        e.preventDefault()
        return swapColours()
      }
      if (/^[0-9]$/.test(k)) {
        e.preventDefault()
        return setOpts({ opacity: k === '0' ? 1 : +k / 10 })
      }
      if (k === 'Delete' || k === 'Backspace') {
        e.preventDefault()
        return d.active && d.clearLayer(d.active.id)
      }
      if (k === 'Escape') return d.setSelection(null)
      const t = TOOLS.find((x) => x.key === k.toUpperCase())
      if (t) {
        e.preventDefault()
        setTool(t.id)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [binds])

  // Ctrl+V: a picture from outside (screenshot, copied image) or what was copied here becomes a new layer
  useEffect(() => {
    const onPaste = async (e) => {
      if (!activeRef.current) return
      const tag = e.target && e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const d = docRef.current
      const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter((f) => /^image\//.test(f.type))
      if (files.length) {
        e.preventDefault()
        try {
          addPictureLayer(await createImageBitmap(files[0]), 'Pasted picture')
          flash('Picture pasted as a new layer. Drag it to move it, drag a corner to resize it.')
        } catch {
          flash('That picture could not be pasted.')
        }
        return
      }
      if (drawClip) {
        e.preventDefault()
        const l = d.addLayer('Pasted')
        l.canvas.getContext('2d').drawImage(drawClip.canvas, drawClip.x, drawClip.y)
        d.changed(true)
        flash('Pasted as a new layer. Use the Move tool to place it.')
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  // developer self-test hooks
  if (active) window.__draw = { doc, get brush() { return brushRef.current }, setBrush: pickBrush, setOpts, setFg, setTool, opts: optsRef, view: viewRef, toScreen, toDoc, fit, packs, builtin, flash, loadPictureUrl }

  // ---- the tutorial
  const appRef = useRef(null)
  const [tour, setTour] = useState(false)
  useEffect(() => {
    if (!active || tourSeen('drawing')) return
    let dead = false
    const t = setTimeout(async () => {
      if (dead || (await window.api.isTest())) return
      setTour(true)
    }, 900)
    return () => {
      dead = true
      clearTimeout(t)
    }
  }, [active])
  const closeTour = () => {
    markTourSeen('drawing')
    setTour(false)
  }

  const cursor = tool === 'hand' ? 'grab' : ['brush', 'eraser', 'smudge'].includes(tool) ? 'none' : tool === 'eyedropper' ? 'copy' : 'crosshair'
  const showSize = ['brush', 'eraser', 'smudge', 'line', 'rect', 'ellipse'].includes(tool)
  const shapeTool = ['line', 'rect', 'ellipse'].includes(tool)

  return (
    <div className="app" ref={appRef} style={{ display: active ? undefined : 'none' }} onDragOver={(e) => e.preventDefault()} onDrop={onDropFiles}>
      <header className="topbar">
        <button onClick={onNew} title="Start another project in a new tab">New</button>
        <button onClick={onOpen} title="Open a project in a new tab">Open…</button>
        <button onClick={() => saveProject(false)}>Save</button>
        <button onClick={() => saveProject(true)}>Save as…</button>
        <button onClick={() => doc.undo()} disabled={!doc.canUndo} title="Undo (Ctrl+Z)"><Icon name="undo" size={14} /></button>
        <button onClick={() => doc.redo()} disabled={!doc.canRedo} title="Redo (Ctrl+Y)"><Icon name="redo" size={14} /></button>
        <span className="proj-name">{projectName}{dirty ? ' •' : ''}</span>
        <span className="canvas-size" title="The size of the canvas, in pixels">{doc.w} × {doc.h}</span>
        <span className="spacer" />
        <button onClick={() => setTour(true)} title="A short tour of the main features"><Icon name="help" size={14} /> Tutorial</button>
        <button className="primary" onClick={() => setShowExport(true)}>
          <Icon name="upload" /> Export picture…
        </button>
      </header>
      <div className="top">
        <div className="toolbar-v">
          {TOOLS.map((t) => (
            <button key={t.id} data-tool={t.id} className={'tool-btn' + (tool === t.id ? ' on' : '')} title={t.label} onClick={() => setTool(t.id)}>
              <Icon name={t.icon} size={17} />
            </button>
          ))}
          <span className="tool-sep" />
          <button className="tool-btn" title="Mirror the view left to right" onClick={() => ((viewRef.current.flip = !viewRef.current.flip), redraw())}>
            <Icon name="flip" size={17} />
          </button>
          <button className="tool-btn" title="Turn the view 15° (hold Shift to turn back)" onClick={(e) => ((viewRef.current.rot = (viewRef.current.rot + (e.shiftKey ? -15 : 15)) % 360), redraw())}>
            <Icon name="rotate" size={17} />
          </button>
        </div>
        <LayersPanel doc={doc} rev={rev} open={layersOpen} setOpen={setLayersOpen} onAddPicture={importPictures} busy={busy} />
        <main className="stage">
          <div className="dr-view" ref={stageRef}>
            <canvas
              ref={canvasRef}
              className="dr-canvas"
              style={{ cursor }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onPointerLeave={() => {
                cursorRef.current = null
                redraw()
              }}
              onContextMenu={(e) => e.preventDefault()}
            />
            <div className="zoom-bar">
              <button className="mini" onClick={() => setZoomAt(viewRef.current.zoom / 1.25)} title="Zoom out">−</button>
              <span>{zoomLabel}%</span>
              <button className="mini" onClick={() => setZoomAt(viewRef.current.zoom * 1.25)} title="Zoom in">+</button>
              <button className="mini" onClick={() => setZoomAt(1)} title="Show at 100%">1:1</button>
              <button className="mini" onClick={fit} title="Fit the picture in the window">Fit</button>
            </div>
          </div>
          <div className="note-line">{note}</div>
        </main>
        <aside className={'inspector dr-insp' + (inspOpen ? '' : ' collapsed')}>
          {!inspOpen && (
            <button className="collapse-strip" onClick={() => setInspOpen(true)} title="Show the brush panel">
              <Icon name="left" size={14} />
              <span>Brush</span>
            </button>
          )}
          <div className="panel-title">
            <span className="title-left">
              <button className="mini" onClick={() => setInspOpen(false)} title="Hide this panel"><Icon name="right" size={12} /></button>
              {TOOLS.find((t) => t.id === tool).label.replace(/\s*\(.*$/, '').replace(/:.*$/, '')}
            </span>
          </div>
          <div className="insp-body">
            <ColourPicker fg={fg} bg={bg} setFg={setFg} setBg={setBackground} swap={swapColours} recent={recent} />
            {showSize && (
              <div className="dr-opts">
                <Slider label="Size" value={opts.size} min={1} max={1000} unit=" px" onChange={(v) => setOpts({ size: v })} log />
                {tool !== 'smudge' && <Slider label="Opacity" value={Math.round(opts.opacity * 100)} min={1} max={100} unit="%" onChange={(v) => setOpts({ opacity: v / 100 })} />}
                {tool === 'smudge' ? (
                  <Slider label="Strength" value={Math.round(opts.flow * 100)} min={5} max={100} unit="%" onChange={(v) => setOpts({ flow: v / 100 })} />
                ) : (
                  <Slider label="Flow" value={Math.round(opts.flow * 100)} min={1} max={100} unit="%" onChange={(v) => setOpts({ flow: v / 100 })} />
                )}
                {tool !== 'smudge' && !shapeTool && <Slider label="Smoothing" value={Math.round(opts.smoothing * 100)} min={0} max={100} unit="%" onChange={(v) => setOpts({ smoothing: v / 100 })} />}
                {tool !== 'smudge' && <Slider label="Spacing" value={Math.round(opts.spacing * 100)} min={25} max={400} unit="%" onChange={(v) => setOpts({ spacing: v / 100 })} />}
                <div className="mtop">
                  <label className="chk"><input type="checkbox" checked={opts.mirrorX} onChange={(e) => setOpts({ mirrorX: e.target.checked })} /> Mirror left–right</label>
                </div>
                <div className="mtop">
                  <label className="chk"><input type="checkbox" checked={opts.mirrorY} onChange={(e) => setOpts({ mirrorY: e.target.checked })} /> Mirror up–down</label>
                </div>
              </div>
            )}
            {(tool === 'rect' || tool === 'ellipse') && (
              <div className="mtop">
                <span className="mlabel">Fill</span>
                <select value={opts.shapeFill} onChange={(e) => setOpts({ shapeFill: e.target.value })}>
                  <option value="none">Outline only</option>
                  <option value="fg">Fill with the brush colour</option>
                  <option value="bg">Fill with the background colour</option>
                </select>
              </div>
            )}
            {shapeTool && <div className="hint-sm">Drag to draw. Shift = straight / square / circle. Alt = from the centre (rectangle, ellipse).</div>}
            {tool === 'fill' && (
              <div className="dr-opts">
                <Slider label="Tolerance" value={Math.round(opts.fillTol * 100)} min={0} max={100} unit="%" onChange={(v) => setOpts({ fillTol: v / 100 })} />
                <div className="mtop">
                  <label className="chk"><input type="checkbox" checked={opts.fillAll} onChange={(e) => setOpts({ fillAll: e.target.checked })} /> Look at all layers</label>
                </div>
                <div className="hint-sm">Fills the area you click, up to the lines on the layer (or on all layers).</div>
              </div>
            )}
            {tool === 'select' && (
              <div className="dr-opts">
                <div className="mtop">
                  <span className="mlabel">Shape</span>
                  <select value={opts.selShape} onChange={(e) => setOpts({ selShape: e.target.value })}>
                    <option value="rect">Rectangle</option>
                    <option value="ellipse">Ellipse</option>
                    <option value="lasso">Freehand</option>
                  </select>
                </div>
                <div className="btn-row" style={{ flexWrap: 'wrap' }}>
                  <button className="mini" onClick={() => doc.setSelection({ type: 'all' })}>Select all</button>
                  <button className="mini" onClick={() => doc.setSelection(null)} disabled={!doc.selection}>Deselect</button>
                  <button className="mini" onClick={() => doc.invertSelection()} disabled={!doc.selection}>Invert</button>
                </div>
                <div className="hint-sm">
                  <b>Click a line or shape</b> to select it. Drag in empty space to select an area. Then drag the selection to <b>move</b> what is in it (hold Alt to move a copy), or use the arrow keys.
                  Ctrl+C / Ctrl+X / Ctrl+V copy, cut and paste. Painting and fills stay inside the selection. Shift adds to it, Alt takes away.
                </div>
              </div>
            )}
            {tool === 'lasso' && (
              <div className="dr-opts">
                <div className="hint-sm">Draw around what you want and let go. Then drag inside the selection to <b>move those pixels</b> (hold Alt to move a copy). Shift adds another area, Alt takes one away.</div>
                <div className="btn-row" style={{ flexWrap: 'wrap' }}>
                  <button className="mini" onClick={() => doc.setSelection({ type: 'all' })}>Select all</button>
                  <button className="mini" onClick={() => doc.setSelection(null)} disabled={!doc.selection}>Deselect</button>
                  <button className="mini" onClick={() => doc.invertSelection()} disabled={!doc.selection}>Invert</button>
                </div>
              </div>
            )}
            {tool === 'smart' && (
              <div className="dr-opts">
                <div className="hint-sm">Click the thing you want, or draw a <b>rough</b> box (or loop) around it: the AI finds its exact edge. Then drag it to move it. Shift adds, Alt takes away.</div>
                <div className="mtop">
                  <span className="mlabel">Drag draws</span>
                  <select value={opts.smartShape} onChange={(e) => setOpts({ smartShape: e.target.value })}>
                    <option value="box">A box</option>
                    <option value="loop">A loose loop</option>
                  </select>
                </div>
                <div className="mtop">
                  <label className="chk"><input type="checkbox" checked={!!opts.smartLayerOnly} onChange={(e) => setOpts({ smartLayerOnly: e.target.checked })} /> Look at this layer only</label>
                </div>
                {gpu && !gpu.ok && <div className="hint warn">This computer does not seem to have a usable graphics card, so smart select cannot run here. The lasso and the select tool still work.</div>}
                {gpu && gpu.ok && gpu.weak && <div className="hint warn">This computer’s graphics ({gpu.name || 'basic integrated graphics'}) look basic: smart select will run, but slowly.</div>}
                {gpu && gpu.ok && !(models && models.ready) && (
                  <>
                    <div className="hint-sm">Smart select uses an AI model (about {models ? Math.round(models.totalBytes / 1e6) : 112} MB). It is downloaded once from the internet and then works without it.</div>
                    {dl ? (
                      <>
                        <div className="bar"><div className="bar-fill" style={{ width: Math.min(100, (dl.received / Math.max(1, dl.total)) * 100) + '%' }} /></div>
                        <div className="hint-sm">Downloading… {Math.round((dl.received / Math.max(1, dl.total)) * 100)}%</div>
                      </>
                    ) : (
                      <button className="mini wide" onClick={downloadModel}><Icon name="download" size={13} /> Download the AI model</button>
                    )}
                    {dlErr && <div className="hint warn">{dlErr}</div>}
                  </>
                )}
                {gpu && gpu.ok && models && models.ready && <div className="hint-sm">The AI model is ready.</div>}
              </div>
            )}
            {tool === 'move' && <div className="hint-sm">Drag to slide everything on the chosen layer. Drag a corner of the box to make it bigger or smaller. Add a picture (a reference, a photo) with <b>+ Picture</b> in the Layers panel, or drop it onto the window.</div>}
            {tool === 'eyedropper' && <div className="hint-sm">Click to take a colour from the picture. With any brush, hold Alt and click to do the same.</div>}
            <div className="dr-sec">Brushes</div>
            <BrushList builtin={builtin} packs={packs} current={brush} onPick={pickBrush} onImport={importPacks} onRemovePack={removePack} busy={busy} />
            <div className="dr-sec">Pen</div>
            <Slider label="Mouse pressure" value={Math.round(opts.mousePressure * 100)} min={10} max={100} unit="%" onChange={(v) => setOpts({ mousePressure: v / 100 })} />
            <div className="hint-sm">A pen tablet gives real pressure and tilt. A mouse has none, so this is the pressure used instead.</div>
          </div>
        </aside>
      </div>
      {tour && active && <Tour steps={DRAWING_STEPS} rootRef={appRef} onClose={closeTour} />}
      {showExport && <ExportDrawingDialog doc={doc} name={projectName === 'Untitled' ? 'My drawing' : projectName} onClose={() => setShowExport(false)} flash={flash} />}
    </div>
  )
}

// a labelled slider; log = the middle of the slider is a small value (for sizes)
function Slider({ label, value, min, max, unit = '', onChange, log = false }) {
  const toPos = (v) => (log ? Math.round((Math.log(v / min) / Math.log(max / min)) * 1000) : v)
  const fromPos = (p) => (log ? Math.max(min, Math.min(max, Math.round(min * Math.pow(max / min, p / 1000)))) : p)
  return (
    <div className="mtop dr-slider">
      <span className="mlabel">{label} <b>{value}{unit}</b></span>
      <input type="range" min={log ? 0 : min} max={log ? 1000 : max} value={toPos(value)} onChange={(e) => onChange(fromPos(+e.target.value))} />
    </div>
  )
}
