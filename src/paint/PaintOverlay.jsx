import { useEffect, useRef } from 'react'
import { soleVideoClip, overlayLayout, clipPicture, isLocked, aspectRatio, uid } from '../state.js'
import { evalTransform, rectToFrame, frameToRect } from '../motion.js'
import { promptFromLoop } from '../smartMask.js'
import { Stroke, Smudge, mergeBuffer, ellipsePoints, rectPoints, floodMask, maskToCanvas, objectMask, newCanvas, rgbToHex } from './engine.js'
import { rasterEntry, rasterGrab, rasterRect, rasterView, setRasterLive } from './raster.js'
import { makeSelection, makeMaskSelection, inSelection, liftParts, paintMoved, shiftSelection } from './selection.js'
import { commitPixels, smudgeResult } from './pixelOps.js'
import { PAINT_TOOLS, SELECT_TOOLS } from './usePaintKit.js'

// The painting layer on top of the picture of the picture editor: the pen / mouse input of the brush, eraser, smudge, shapes,
// fill, eyedropper and the selection tools, working on the pixels of the chosen layer (one is made when none is chosen), and
// the things drawn over the picture: the brush circle, the outline of the selection, the mirror line.
export default function PaintOverlay({ state, dispatch, kit, tool, box, glCanvas, sel, setSel, onLive }) {
  const rootRef = useRef(null)
  const cvRef = useRef(null)
  const stateRef = useRef(state)
  const selRef = useRef(sel)
  const toolRef = useRef(tool)
  const boxRef = useRef(box)
  stateRef.current = state
  selRef.current = sel
  toolRef.current = tool
  boxRef.current = box
  const gesture = useRef(null)
  const bufferRef = useRef(null)
  const hover = useRef(null) // [x, y] in pixels of the picture box
  const draft = useRef(null) // the selection being drawn: {type, x, y, w, h, pts}
  const queued = useRef(false)
  const smartBusy = useRef(false)
  const ratio = aspectRatio(state)

  // ---- coordinates: the picture box (screen) <-> the pixels of a layer, through the layer's own move / scale / turn
  const maps = (clip) => {
    const s = stateRef.current
    const W = clip.raster.w
    const H = clip.raster.h
    const pic = clipPicture(s, clip, ratio)
    const ma = pic.width / pic.height
    const sc = [Math.max(1, ratio / ma), Math.max(1, ma / ratio)]
    const tf = evalTransform(clip, 0)
    const b = boxRef.current
    return {
      W,
      H,
      toLayer: (x, y) => {
        const q = frameToRect([x / b.w, 1 - y / b.h], sc, tf, ratio)
        return [q[0] * W, (1 - q[1]) * H]
      },
      toBox: (lx, ly) => {
        const uv = rectToFrame([lx / W, 1 - ly / H], sc, tf, ratio)
        return [uv[0] * b.w, (1 - uv[1]) * b.h]
      },
      identity: Math.abs(tf.x) < 1e-6 && Math.abs(tf.y) < 1e-6 && Math.abs(tf.scale - 100) < 1e-6 && Math.abs(tf.sx - 100) < 1e-6 && Math.abs(tf.sy - 100) < 1e-6 && Math.abs(tf.rot) < 1e-6,
    }
  }
  const chosenClip = () => {
    const s = stateRef.current
    const id = soleVideoClip(s)
    return id ? overlayLayout(s.overlayClips).find((c) => c.id === id) || null : null
  }
  // the layer of pixels to work on. create = make one when the chosen layer is not a pixel layer
  const target = (create) => {
    const s = stateRef.current
    const c = chosenClip()
    if (c && c.raster) return isLocked(s, c.id) ? { locked: true } : { clip: c }
    if (!create) return null
    const id = uid()
    const rid = uid()
    dispatch({ type: 'imgAddRaster', id, rasterId: rid })
    return { clip: { id, raster: { id: rid, rev: 0, w: s.canvas.w, h: s.canvas.h } }, fresh: true }
  }
  const rootPoint = (e) => {
    const r = rootRef.current.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  const pointOf = (m, ev) => {
    const [px, py] = rootPoint(ev)
    const [x, y] = m.toLayer(px, py)
    let pressure = ev.pointerType === 'pen' ? ev.pressure : kit.optsRef.current.mousePressure
    if (ev.pointerType === 'pen' && pressure === 0) pressure = 0.01
    return { x, y, pressure, tiltX: ev.tiltX || 0, tiltY: ev.tiltY || 0, t: ev.timeStamp }
  }
  const pickAt = (e) => {
    const [x, y] = rootPoint(e)
    const b = boxRef.current
    const src = glCanvas.current
    if (!src) return
    const t = document.createElement('canvas')
    t.width = 1
    t.height = 1
    const g = t.getContext('2d', { willReadFrequently: true })
    g.drawImage(src, Math.floor((x / b.w) * src.width), Math.floor((y / b.h) * src.height), 1, 1, 0, 0, 1, 1)
    const d = g.getImageData(0, 0, 1, 1).data
    if (d[3] > 0) kit.setFg(rgbToHex(d[0], d[1], d[2]))
  }

  // ---- strokes
  const strokeParams = (e, erase) => {
    const o = kit.optsRef.current
    if (!bufferRef.current || bufferRef.current.width !== e.w || bufferRef.current.height !== e.h) bufferRef.current = newCanvas(e.w, e.h)
    const b = kit.brushRef.current
    return { brush: b, size: o.size, flow: o.flow, colour: kit.fgRef.current, smoothing: o.smoothing, spacingMul: o.spacing, mirrorX: o.mirrorX, mirrorY: o.mirrorY, w: e.w, h: e.h, buffer: bufferRef.current, erase: erase || b.comp === 'erase' }
  }
  const publishLive = (g) => {
    const e = g.entry
    const r = g.stroke.dirty && rasterRect(e, g.stroke.dirty)
    setRasterLive({ id: e.id, buffer: g.buffer, rect: r, opacity: g.opacity, erase: g.erase, comp: g.comp, alphaLock: g.alphaLock, mask: selRef.current ? selRef.current.mask : null })
    onLive()
  }
  const finishStroke = (g) => {
    const e = g.entry
    g.stroke.finish()
    const rect = g.stroke.dirty && rasterRect(e, g.stroke.dirty)
    setRasterLive(null)
    if (rect) {
      const before = rasterGrab(e, rect)
      mergeBuffer(e.canvas.getContext('2d'), g.buffer, rect, { opacity: g.opacity, erase: g.erase, comp: g.comp, alphaLock: g.alphaLock, mask: selRef.current ? selRef.current.mask : null })
      commitPixels(g.clip, dispatch, rect, before)
    }
    g.stroke.clearBuffer()
    kit.useColour(kit.fgRef.current)
    onLive()
  }
  const shapePreview = (g, p, ev) => {
    const st = g.stroke
    st.clearBuffer()
    const o = kit.optsRef.current
    const { start, shape } = g
    let x1 = p.x
    let y1 = p.y
    const x0 = start.x
    const y0 = start.y
    let pts
    let closed = false
    if (shape === 'line') {
      if (ev.shiftKey) {
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
      if (ev.shiftKey) {
        const s = Math.max(Math.abs(w), Math.abs(h))
        w = Math.sign(w || 1) * s
        h = Math.sign(h || 1) * s
      }
      let cx = x0 + w / 2
      let cy = y0 + h / 2
      let hw = w / 2
      let hh = h / 2
      if (ev.altKey) {
        cx = x0
        cy = y0
        hw = w
        hh = h
      }
      pts = shape === 'rect' ? rectPoints(cx - hw, cy - hh, cx + hw, cy + hh) : ellipsePoints(cx, cy, Math.abs(hw), Math.abs(hh))
      closed = true
      if (o.shapeFill !== 'none') {
        const gg = st.g
        gg.save()
        gg.setTransform(1, 0, 0, 1, 0, 0)
        gg.globalAlpha = 1
        gg.fillStyle = o.shapeFill === 'bg' ? kit.bgRef.current : kit.fgRef.current
        const fillOne = (ox) => {
          gg.beginPath()
          if (shape === 'rect') gg.rect(ox - hw, cy - hh, hw * 2, hh * 2)
          else gg.ellipse(ox, cy, Math.abs(hw), Math.abs(hh), 0, 0, Math.PI * 2)
          gg.fill()
        }
        fillOne(cx)
        st._grow(cx, cy, Math.hypot(hw, hh) + 4)
        if (o.mirrorX) {
          fillOne(g.entry.w - cx)
          st._grow(g.entry.w - cx, cy, Math.hypot(hw, hh) + 4)
        }
        gg.restore()
      }
    }
    st.polyline(pts, closed)
  }

  // ---- smart select (AI)
  const runSmartSelect = async (prompt, mode, clip, m) => {
    const s = stateRef.current
    if (smartBusy.current) return
    try {
      const st = await window.api.modelsStatus()
      const { gpuInfo, findSubjectPrompt } = await import('../smartMask.js')
      const gpu = await gpuInfo()
      if (!gpu.ok) return kit.flash('Smart select needs a graphics card, and this computer does not seem to have a usable one.')
      if (!st.ready) return kit.flash('Smart select needs its AI model first: use the Download button in the panel on the right.')
      smartBusy.current = true
      kit.flash('Finding the subject… (the first time takes a few seconds)')
      const layerOnly = kit.optsRef.current.smartLayerOnly && clip
      const src = layerOnly ? rasterView(clip) : glCanvas.current
      const w = src.width
      const h = src.height
      const el = newCanvas(w, h)
      const eg = el.getContext('2d')
      eg.fillStyle = '#ffffff'
      eg.fillRect(0, 0, w, h)
      eg.drawImage(src, 0, 0)
      const poly = await findSubjectPrompt({ el, w, h, prompt, paths: st.paths })
      if (!poly) return kit.flash('No subject was found there. Try clicking on it, or draw the box a little bigger.')
      const b = boxRef.current
      const W = clip ? clip.raster.w : s.canvas.w
      const H = clip ? clip.raster.h : s.canvas.h
      const pts = poly.map(([x, y]) => {
        if (layerOnly) return { x: x * W, y: y * H }
        const [lx, ly] = m ? m.toLayer(x * b.w, y * b.h) : [x * W, y * H]
        return { x: lx, y: ly }
      })
      setSel(makeSelection(W, H, { type: 'lasso', pts }, mode, selRef.current))
      kit.flash('Selected. Drag it to move it, or press Delete to remove it.')
    } catch (err) {
      kit.flash('Smart select could not run: ' + String((err && err.message) || err))
    } finally {
      smartBusy.current = false
    }
  }

  // ---- pointer input
  const onPointerDown = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    try {
      cvRef.current.setPointerCapture(e.pointerId)
    } catch {}
    const t = toolRef.current
    const o = kit.optsRef.current
    const c = chosenClip()
    const s = stateRef.current
    // the eyedropper (or Alt with a painting tool) takes the colour of what is on screen
    if (t === 'eyedropper' || (e.altKey && (PAINT_TOOLS.includes(t) || t === 'fill'))) {
      gesture.current = { kind: 'pick' }
      pickAt(e)
      return
    }
    // ---- selections
    if (SELECT_TOOLS.includes(t)) {
      const cm = c && c.raster ? maps(c) : null
      const [px, py] = rootPoint(e)
      const [lx, ly] = cm ? cm.toLayer(px, py) : [(px / boxRef.current.w) * s.canvas.w, (py / boxRef.current.h) * s.canvas.h]
      const p = { x: lx, y: ly }
      const cur = selRef.current
      // dragging something that is selected carries it along (Alt: a copy of it)
      if (cur && !e.shiftKey && inSelection(cur, p.x, p.y)) {
        const tg = target(false)
        if (!tg || tg.locked) return kit.flash(tg && tg.locked ? 'This layer is locked.' : 'Choose a layer of pixels (a paint layer) to move what is selected.')
        const en = rasterEntry(tg.clip)
        gesture.current = { kind: 'selmove', clip: tg.clip, entry: en, parts: liftParts(en, cur, e.altKey), start: p, copy: e.altKey, moved: false, m: maps(tg.clip) }
        return
      }
      const shape = t === 'lasso' ? 'lasso' : t === 'smart' ? (o.smartShape === 'loop' ? 'lasso' : 'rect') : o.selShape
      gesture.current = { kind: 'select', cm, start: p, startScreen: { x: e.clientX, y: e.clientY }, startBox: [px, py], shape, smart: t === 'smart', plain: t !== 'select', pts: [{ x: p.x, y: p.y }], boxPts: [[px, py]], mode: e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace', dragged: false }
      draft.current = { type: shape, x: p.x, y: p.y, w: 0, h: 0, pts: [p] }
      return
    }
    // ---- painting tools: they need a layer of pixels
    const tg = target(true)
    if (tg.locked) return kit.flash('This layer is locked. Unlock it (the padlock in the Layers panel) to paint on it.')
    const clip = tg.clip
    const en = rasterEntry(clip)
    const m = maps(clip)
    const p = pointOf(m, e)
    const alphaLock = !!clip.raster.alphaLock
    if (t === 'fill') {
      let src = en.canvas
      if (o.fillAll && m.identity && glCanvas.current) {
        src = newCanvas(en.w, en.h)
        src.getContext('2d').drawImage(glCanvas.current, 0, 0, en.w, en.h)
      }
      const mk = floodMask(src, p.x, p.y, o.fillTol, selRef.current ? selRef.current.mask : null)
      if (!mk) return
      const piece = maskToCanvas(mk, kit.fgRef.current, 1)
      const r = rasterRect(en, { x: piece.x, y: piece.y, w: piece.w, h: piece.h })
      if (!r) return
      const before = rasterGrab(en, r)
      const g = en.canvas.getContext('2d')
      g.save()
      g.globalCompositeOperation = alphaLock ? 'source-atop' : 'source-over'
      g.drawImage(piece.canvas, piece.x, piece.y)
      g.restore()
      commitPixels(clip, dispatch, r, before)
      kit.useColour(kit.fgRef.current)
      onLive()
      return
    }
    if (t === 'smudge') {
      const full = { x: 0, y: 0, w: en.w, h: en.h }
      const sm = new Smudge({ layer: en.canvas, brush: kit.brushRef.current, size: o.size, strength: o.flow < 1 ? o.flow : 0.7, w: en.w, h: en.h })
      gesture.current = { kind: 'smudge', sm, clip, entry: en, m, before: rasterGrab(en, full) }
      sm.begin(p)
      onLive()
      return
    }
    // brush, eraser and the shapes: a stroke buffer shown on top of the layer, merged into it at the end
    const sp = strokeParams(en, t === 'eraser')
    const stroke = new Stroke(sp)
    const opacity = (o.opacity == null ? 1 : o.opacity) * (sp.brush.opacity == null ? 1 : sp.brush.opacity)
    const g = { stroke, buffer: sp.buffer, entry: en, clip, m, opacity, erase: sp.erase, comp: sp.brush.comp, alphaLock }
    if (t === 'brush' || t === 'eraser') {
      gesture.current = { kind: 'stroke', ...g }
      stroke.begin(p)
      publishLive(g)
    } else gesture.current = { kind: 'shape', ...g, start: p, shape: t }
  }

  const onPointerMove = (e) => {
    hover.current = rootPoint(e)
    const g = gesture.current
    if (!g) return schedule()
    if (g.kind === 'pick') return pickAt(e)
    // coalesced events give every little movement of a fast pen
    const evs = e.nativeEvent.getCoalescedEvents ? e.nativeEvent.getCoalescedEvents() : []
    const list = evs.length ? evs : [e.nativeEvent]
    const [bx, by] = rootPoint(e)
    if (g.kind === 'stroke') {
      for (const ev of list) g.stroke.move(pointOf(g.m, ev))
      publishLive(g)
    } else if (g.kind === 'smudge') {
      for (const ev of list) g.sm.move(pointOf(g.m, ev))
      onLive()
    } else if (g.kind === 'shape') {
      shapePreview(g, pointOf(g.m, e), e)
      publishLive(g)
    } else if (g.kind === 'selmove') {
      const [x, y] = g.m.toLayer(bx, by)
      const dx = Math.round(x - g.start.x)
      const dy = Math.round(y - g.start.y)
      if (!g.moved && Math.abs(dx) + Math.abs(dy) < 2) return
      g.moved = true
      g.dx = dx
      g.dy = dy
      paintMoved(g.entry, g.parts, dx, dy)
      onLive()
    } else if (g.kind === 'select') {
      const [lx, ly] = g.cm ? g.cm.toLayer(bx, by) : [(bx / boxRef.current.w) * stateRef.current.canvas.w, (by / boxRef.current.h) * stateRef.current.canvas.h]
      if (Math.hypot(e.clientX - g.startScreen.x, e.clientY - g.startScreen.y) > 4) g.dragged = true
      if (g.shape === 'lasso') {
        g.pts.push({ x: lx, y: ly })
        g.boxPts.push([bx, by])
        draft.current = { type: 'lasso', pts: g.pts }
      } else {
        let x0 = g.start.x
        let y0 = g.start.y
        let w = lx - x0
        let h = ly - y0
        if (e.shiftKey && g.mode === 'replace') {
          const sq = Math.max(Math.abs(w), Math.abs(h))
          w = Math.sign(w || 1) * sq
          h = Math.sign(h || 1) * sq
        }
        if (w < 0) {
          x0 += w
          w = -w
        }
        if (h < 0) {
          y0 += h
          h = -h
        }
        draft.current = { type: g.shape, x: x0, y: y0, w, h, endBox: [bx, by] }
      }
      schedule()
    }
  }

  const onPointerUp = () => {
    const g = gesture.current
    gesture.current = null
    if (!g) return
    if (g.kind === 'stroke' || g.kind === 'shape') finishStroke(g)
    else if (g.kind === 'smudge') {
      const en = g.entry
      const r = g.sm.dirty && rasterRect(en, g.sm.dirty)
      if (r) commitPixels(g.clip, dispatch, r, smudgeResult(en, r, g.before, selRef.current))
      onLive()
    } else if (g.kind === 'selmove') {
      if (g.moved && (g.dx || g.dy)) {
        commitPixels(g.clip, dispatch, g.parts.full, g.parts.before)
        setSel(shiftSelection(g.entry.w, g.entry.h, selRef.current, g.dx, g.dy))
      } else {
        paintMoved(g.entry, g.parts, 0, 0) // a click: nothing changes
        onLive()
      }
    } else if (g.kind === 'select') endSelect(g)
    draft.current = null
    schedule()
  }

  const endSelect = (g) => {
    const dr = draft.current
    const s = stateRef.current
    const c = chosenClip()
    const cm = g.cm
    const W = c && c.raster ? c.raster.w : s.canvas.w
    const H = c && c.raster ? c.raster.h : s.canvas.h
    let done = false
    if (g.dragged && dr && !g.smart) {
      if (dr.type === 'lasso') {
        if (dr.pts.length > 3) {
          setSel(makeSelection(W, H, { type: 'lasso', pts: dr.pts }, g.mode, selRef.current))
          done = true
        }
      } else if (dr.w > 2 && dr.h > 2) {
        setSel(makeSelection(W, H, { type: dr.type, x: dr.x, y: dr.y, w: dr.w, h: dr.h }, g.mode, selRef.current))
        done = true
      }
    }
    if (g.smart) {
      // the AI finds the exact outline: from a click on the subject, or from a rough box / loop around it
      const b = boxRef.current
      const useLayer = kit.optsRef.current.smartLayerOnly && c && c.raster
      // points of the gesture in the picture the AI looks at (0..1): the layer's own pixels, or the whole picture on screen
      const norm = (bp, lp) => (useLayer ? [lp.x / W, lp.y / H] : [bp[0] / b.w, bp[1] / b.h])
      let prompt
      if (g.dragged && g.shape === 'lasso' && g.pts.length > 3) {
        const step = Math.max(1, Math.floor(g.pts.length / 40))
        prompt = promptFromLoop(g.pts.map((lp, i) => norm(g.boxPts[i], lp)).filter((_, i) => i % step === 0))
      } else if (g.dragged && g.shape !== 'lasso' && dr && dr.endBox && Math.abs(dr.endBox[0] - g.startBox[0]) > 6 && Math.abs(dr.endBox[1] - g.startBox[1]) > 6) {
        const a = norm(g.startBox, g.start)
        const z = norm(dr.endBox, { x: dr.x + dr.w, y: dr.y + dr.h })
        prompt = promptFromLoop([[a[0], a[1]], [z[0], a[1]], [z[0], z[1]], [a[0], z[1]]])
      } else if (!g.dragged) {
        const q = norm(g.startBox, g.start)
        prompt = [{ x: q[0], y: q[1], label: 1 }]
      }
      if (prompt) runSmartSelect(prompt, g.mode, c && c.raster ? c : null, cm)
      done = true
    } else if (g.plain && !g.dragged) {
      // a click with the lasso: nothing to take, so the selection goes away
      if (g.mode === 'replace') setSel(null)
      done = true
    }
    if (!done) {
      // a click: take the line, shape or blob that is under it (on this layer, or else on another pixel layer)
      const reach = Math.max(4, 8)
      const order = []
      if (c && c.raster) order.push(c)
      for (const x of overlayLayout(s.overlayClips).slice().reverse()) if (x.raster && !order.includes(x)) order.push(x)
      let hit = null
      for (const l of order) {
        const m = maps(l)
        const [lx, ly] = m.toLayer(g.startBox[0], g.startBox[1])
        hit = objectMask(rasterEntry(l).canvas, lx, ly, reach)
        if (hit) {
          if (!c || l.id !== c.id) dispatch({ type: 'select', id: l.id })
          break
        }
      }
      if (hit) setSel(makeMaskSelection(W, H, hit.canvas, hit.bounds, g.mode, selRef.current))
      else if (g.mode === 'replace') setSel(null)
    }
  }

  // ---- what is drawn over the picture: the brush circle, the selection, the mirror line
  const schedule = () => {
    if (queued.current) return
    queued.current = true
    requestAnimationFrame(() => {
      queued.current = false
      paintOver()
    })
  }
  const paintOver = () => {
    const cv = cvRef.current
    if (!cv) return
    const b = boxRef.current
    const dpr = window.devicePixelRatio || 1
    if (cv.width !== Math.round(b.w * dpr) || cv.height !== Math.round(b.h * dpr)) {
      cv.width = Math.round(b.w * dpr)
      cv.height = Math.round(b.h * dpr)
    }
    const g = cv.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, b.w, b.h)
    const s = stateRef.current
    const c = chosenClip()
    const cm = c && c.raster ? maps(c) : null
    const o = kit.optsRef.current
    const T = (lx, ly) => (cm ? cm.toBox(lx, ly) : [(lx / s.canvas.w) * b.w, (ly / s.canvas.h) * b.h])
    const trace = (list) => {
      g.beginPath()
      list.forEach((p, i) => {
        const [x, y] = T(p.x, p.y)
        if (i) g.lineTo(x, y)
        else g.moveTo(x, y)
      })
      g.closePath()
    }
    const outline = (sh) => {
      if (sh.type === 'mask') return
      if (sh.type === 'rect' || sh.type === 'all') trace([{ x: sh.x, y: sh.y }, { x: sh.x + sh.w, y: sh.y }, { x: sh.x + sh.w, y: sh.y + sh.h }, { x: sh.x, y: sh.y + sh.h }])
      else if (sh.type === 'ellipse') {
        const pts = []
        for (let i = 0; i < 72; i++) {
          const a = (i / 72) * Math.PI * 2
          pts.push({ x: sh.x + sh.w / 2 + (Math.cos(a) * sh.w) / 2, y: sh.y + sh.h / 2 + (Math.sin(a) * sh.h) / 2 })
        }
        trace(pts)
      } else trace(sh.pts)
    }
    const ants = (shapes) => {
      g.lineWidth = 1
      g.setLineDash([])
      g.strokeStyle = '#000'
      for (const sh of shapes) {
        outline(sh)
        if (sh.type !== 'mask') g.stroke()
      }
      g.setLineDash([5, 5])
      g.strokeStyle = '#fff'
      for (const sh of shapes) {
        outline(sh)
        if (sh.type !== 'mask') g.stroke()
      }
      g.setLineDash([])
    }
    const cur = selRef.current
    if (cur) {
      ants(cur.shapes)
      if (cur.shapes.some((x) => x.type === 'mask') && !cur.inverted) {
        if (cm && cm.identity) {
          if (!cur._tint) {
            const t = newCanvas(cur.mask.width, cur.mask.height)
            const tg = t.getContext('2d')
            tg.fillStyle = '#c4a7e7'
            tg.fillRect(0, 0, t.width, t.height)
            tg.globalCompositeOperation = 'destination-in'
            tg.drawImage(cur.mask, 0, 0)
            cur._tint = t
          }
          g.globalAlpha = 0.45
          g.drawImage(cur._tint, 0, 0, b.w, b.h)
          g.globalAlpha = 1
        }
        const bd = cur.bounds
        if (bd) {
          trace([{ x: bd.x, y: bd.y }, { x: bd.x + bd.w, y: bd.y }, { x: bd.x + bd.w, y: bd.y + bd.h }, { x: bd.x, y: bd.y + bd.h }])
          g.setLineDash([4, 4])
          g.strokeStyle = '#fff'
          g.stroke()
          g.setLineDash([])
        }
      }
    }
    if (draft.current) {
      g.setLineDash([4, 4])
      g.strokeStyle = '#fff'
      g.lineWidth = 1
      const dr = draft.current
      if (dr.type === 'lasso') {
        g.beginPath()
        dr.pts.forEach((p, i) => {
          const [x, y] = T(p.x, p.y)
          if (i) g.lineTo(x, y)
          else g.moveTo(x, y)
        })
        g.stroke()
      } else {
        outline(dr.type === 'ellipse' ? { type: 'ellipse', x: dr.x, y: dr.y, w: dr.w, h: dr.h } : { type: 'rect', x: dr.x, y: dr.y, w: dr.w, h: dr.h })
        g.stroke()
      }
      g.setLineDash([])
    }
    // the mirror line
    if (PAINT_TOOLS.includes(toolRef.current) && cm && (o.mirrorX || o.mirrorY)) {
      g.strokeStyle = 'rgba(196,167,231,.85)'
      g.lineWidth = 1
      g.setLineDash([6, 4])
      if (o.mirrorX) {
        const a = T(cm.W / 2, 0)
        const z = T(cm.W / 2, cm.H)
        g.beginPath()
        g.moveTo(a[0], a[1])
        g.lineTo(z[0], z[1])
        g.stroke()
      }
      if (o.mirrorY) {
        const a = T(0, cm.H / 2)
        const z = T(cm.W, cm.H / 2)
        g.beginPath()
        g.moveTo(a[0], a[1])
        g.lineTo(z[0], z[1])
        g.stroke()
      }
      g.setLineDash([])
    }
    // the brush circle: the size is in pixels of the layer, so it is scaled like the layer
    if (hover.current && ['brush', 'eraser', 'smudge'].includes(toolRef.current)) {
      const sc = cm ? evalTransform(c, 0).scale / 100 : 1
      const r = Math.max(1.5, (o.size * (b.w / s.canvas.w) * sc) / 2)
      const [hx, hy] = hover.current
      g.lineWidth = 2.5
      g.strokeStyle = 'rgba(255,255,255,.9)'
      g.beginPath()
      g.arc(hx, hy, r, 0, Math.PI * 2)
      g.stroke()
      g.lineWidth = 1
      g.strokeStyle = '#000'
      g.beginPath()
      g.arc(hx, hy, r, 0, Math.PI * 2)
      g.stroke()
    }
  }
  useEffect(() => {
    schedule()
  })

  const round = ['brush', 'eraser', 'smudge'].includes(tool)
  return (
    <div className="xf-overlay paint-ov" ref={rootRef}>
      <canvas
        ref={cvRef}
        style={{ width: box.w, height: box.h, display: 'block', touchAction: 'none', cursor: round ? 'none' : tool === 'eyedropper' ? 'copy' : 'crosshair', pointerEvents: 'all' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => {
          hover.current = null
          schedule()
        }}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  )
}
