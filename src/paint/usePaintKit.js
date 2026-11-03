// The settings of the painting tools of the picture editor: colours, brush, sizes, options, the brush packs and the AI model
// state for smart select. One of these lives in each picture editor tab; the settings are remembered between sessions.
import { useEffect, useRef, useState } from 'react'
import { builtinBrushes } from './builtinBrushes.js'
import * as kritaBrush from './kritaBrush.js'

if (typeof window !== 'undefined') window.__krita = kritaBrush // developer self-test

export const PAINT_TOOLS = ['brush', 'eraser', 'smudge', 'line', 'rect', 'ellipse']
export const SELECT_TOOLS = ['select', 'lasso', 'smart']
// the tools that work on the pixels of a layer
export const PIXEL_TOOLS = [...PAINT_TOOLS, 'fill', ...SELECT_TOOLS]

export const load = (k, d) => {
  try {
    const v = localStorage.getItem(k)
    return v == null ? d : JSON.parse(v)
  } catch {
    return d
  }
}
export const save = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {}
}

// the brush packs read so far (shared by all tabs)
const packCache = new Map()
export async function loadPacks() {
  const files = (await window.api.brushesList()) || []
  const out = []
  for (const f of files) {
    const name = typeof f === 'string' ? f : f.name
    if (!packCache.has(name)) {
      try {
        const bytes = await window.api.brushesRead(name)
        const r = await kritaBrush.loadKritaPack(new Uint8Array(bytes), name.replace(/\.(bundle|kpp|zip)$/i, ''))
        packCache.set(name, { file: name, title: r.title, brushes: r.brushes, skipped: r.skipped })
      } catch (e) {
        packCache.set(name, { file: name, title: name + ' (could not be read)', brushes: [], skipped: [], error: String((e && e.message) || e) })
      }
    }
    out.push(packCache.get(name))
  }
  return out
}

export function usePaintKit(flash) {
  const [fg, setFgState] = useState(() => load('vibe.draw.fg', '#000000'))
  const [bg, setBgState] = useState(() => load('vibe.draw.bg', '#ffffff'))
  const [recent, setRecent] = useState(() => load('vibe.draw.recent', []))
  const [opts, setOptsState] = useState(() => ({
    size: 12,
    opacity: 1,
    flow: 1,
    smoothing: 0.15,
    spacing: 1,
    mirrorX: false,
    mirrorY: false,
    mousePressure: 0.75,
    shapeFill: 'none',
    fillTol: 0.12,
    fillAll: false,
    selShape: 'rect',
    smartShape: 'box',
    smartLayerOnly: false,
    ...load('vibe.draw.opts', {}),
  }))
  const fgRef = useRef(fg)
  const bgRef = useRef(bg)
  const optsRef = useRef(opts)
  fgRef.current = fg
  bgRef.current = bg
  optsRef.current = opts

  const setOpts = (p) => {
    const n = { ...optsRef.current, ...p }
    optsRef.current = n
    setOptsState(n)
    save('vibe.draw.opts', n)
  }
  const setFg = (c) => {
    fgRef.current = c
    setFgState(c)
    save('vibe.draw.fg', c)
  }
  const setBg = (c) => {
    bgRef.current = c
    setBgState(c)
    save('vibe.draw.bg', c)
  }
  const swap = () => {
    const a = fgRef.current
    setFg(bgRef.current)
    setBg(a)
  }
  const useColour = (c) =>
    setRecent((r) => {
      const n = [c, ...r.filter((x) => x.toLowerCase() !== c.toLowerCase())].slice(0, 12)
      save('vibe.draw.recent', n)
      return n
    })

  // ---- brushes
  const builtin = builtinBrushes()
  const [packs, setPacks] = useState([])
  const [brush, setBrushState] = useState(() => builtin.find((b) => b.id === load('vibe.draw.brush', 'b:pencil')) || builtin[0])
  const brushRef = useRef(brush)
  brushRef.current = brush
  const pickBrush = (b, keepTool) => {
    brushRef.current = b
    setBrushState(b)
    save('vibe.draw.brush', b.id)
    setOpts({ size: Math.max(1, Math.round(b.size || 20)) })
    return keepTool
  }
  useEffect(() => {
    loadPacks().then(setPacks).catch(() => {})
  }, [])
  useEffect(() => {
    // the brush used last time, if it came from a pack
    const id = load('vibe.draw.brush', '')
    if (id.startsWith('k:')) {
      for (const p of packs) {
        const b = p.brushes.find((x) => x.id === id)
        if (b) {
          brushRef.current = b
          setBrushState(b)
          break
        }
      }
    }
  }, [packs.length])
  const [busy, setBusy] = useState(false)
  const importPacks = async (paths) => {
    setBusy(true)
    try {
      await window.api.brushesImport(Array.isArray(paths) ? paths : undefined)
      setPacks(await loadPacks())
    } finally {
      setBusy(false)
    }
  }
  const removePack = async (p, sure) => {
    if (!sure && !window.confirm(`Remove "${p.title || p.file}" from the editor? (your original file is not touched)`)) return
    await window.api.brushesDelete(p.file)
    packCache.delete(p.file)
    setPacks(await loadPacks())
  }

  // ---- smart select (AI, SAM 2): the model is downloaded once, on request
  const [models, setModels] = useState(null) // {ready, totalBytes, paths}
  const [gpu, setGpu] = useState(null) // {ok, weak, name}
  const [dl, setDl] = useState(null) // {received, total} while downloading
  const [dlErr, setDlErr] = useState('')
  useEffect(() => {
    window.api.modelsStatus().then(setModels).catch(() => {})
    import('../smartMask.js').then((m) => m.gpuInfo()).then(setGpu).catch(() => {})
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

  return {
    fg, bg, recent, setFg, setBg, swap, useColour, fgRef, bgRef,
    opts, setOpts, optsRef,
    builtin, packs, brush, brushRef, pickBrush, importPacks, removePack, busy,
    models, gpu, dl, dlErr, downloadModel,
    flash,
  }
}
