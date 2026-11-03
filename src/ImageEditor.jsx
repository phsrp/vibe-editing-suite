import { useEffect, useReducer, useRef, useState } from 'react'
import { reducer, initialState, uid, soleVideoClip, overlayLayout } from './state.js'
import ImagePreview from './ImagePreview.jsx'
import ImageInspector from './ImageInspector.jsx'
import LayersPanel from './LayersPanel.jsx'
import Icon from './Icon.jsx'
import { serializeImage, serializeImageFull, restoreImage, convertDrawingProject, isDrawingProject } from './project.js'
import { exportImage, buildLayers, backgroundOf, makeImageRenderer, freeRenderer, imagesReady } from './imageRender.js'
import { actionFor } from './keybinds.js'
import Tour, { tourSeen, markTourSeen } from './Tour.jsx'
import { IMAGE_STEPS } from './tourSteps.js'
import { usePaintKit, PIXEL_TOOLS } from './paint/usePaintKit.js'
import { makeSelection, invertSelection } from './paint/selection.js'
import { targetClip, deleteSelected, moveSelected, copyPixels, addPixelLayer, commitPixels } from './paint/pixelOps.js'
import { rasterEntry, rasterGrab, rasterFromCanvas } from './paint/raster.js'

const TOOLS = [
  { id: 'move', icon: 'move', label: 'Move and transform (V)', key: 'V' },
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
]
// what was copied or cut with Ctrl+C / Ctrl+X: {canvas, x, y} (shared by all picture editor tabs)
let pixelClip = null
const isMaskMode = (m) => m === 'mask' || m === 'maskdraw' || m === 'maskpoly' || m === 'maskdrawsmart'

// One open image project (a tab). Layers on a canvas: pictures, paint and text, each with transform, mask, effects and colour.
export default function ImageEditor({ tabId, active, initial, binds, onMeta, onNew, onOpen, onOpenPicture, registerHandle }) {
  const [state, dispatch] = useReducer(reducer, { ...initialState, canvas: (initial && initial.canvas) || { w: 1920, h: 1080, bg: '#ffffff' } })
  const stateRef = useRef(state)
  stateRef.current = state
  const activeRef = useRef(active)
  activeRef.current = active
  const [projectPath, setProjectPath] = useState(null)
  const projectRef = useRef(null)
  projectRef.current = projectPath
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const savedJson = useRef(serializeImage(state))
  const autosavedJson = useRef('')
  // "Open picture": a tab that starts from a picture file (its name names the project until it is saved)
  const pictureName = initial && initial.picture && initial.picture.name ? initial.picture.name.replace(/\.[^.]+$/, '') : ''
  const projectName = projectPath ? projectPath.split(/[\\/]/).pop().replace(/\.json$/i, '') : pictureName || 'Untitled'
  const [tool, setToolState] = useState('move')
  const [mode, setMode] = useState('transform')
  const [freeMode, setFreeMode] = useState(false)
  const [sel, setSelState] = useState(null) // the selected area of pixels (see paint/selection.js)
  const selRef = useRef(null)
  const setSel = (s) => {
    selRef.current = s
    setSelState(s)
  }
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [showExport, setShowExport] = useState(false)
  const canvasRef = useRef(null)
  const thumbRef = useRef(null)
  const flag = (key, def = true) => {
    try {
      const v = localStorage.getItem(key)
      return v == null ? def : v !== '0'
    } catch {
      return def
    }
  }
  const [layersOpen, setLayersOpenState] = useState(() => flag('vibe.layersOpen'))
  const [inspOpen, setInspOpenState] = useState(() => flag('vibe.inspOpen'))
  const setLayersOpen = (v) => {
    setLayersOpenState(v)
    try {
      localStorage.setItem('vibe.layersOpen', v ? '1' : '0')
    } catch {}
  }
  const setInspOpen = (v) => {
    setInspOpenState(v)
    try {
      localStorage.setItem('vibe.inspOpen', v ? '1' : '0')
    } catch {}
  }
  const flash = (t) => {
    setNote(t)
    setTimeout(() => setNote((n) => (n === t ? '' : n)), 4000)
  }
  const kit = usePaintKit(flash) // colours, brush, sizes... of the painting tools

  // choosing a tool: painting tools need the handles off; the move tool shows the transform box again
  const setTool = (t) => {
    setToolState(t)
    if (t !== 'move') setMode('none')
    else if (mode === 'none') setMode('transform')
  }
  // starting a mask tool from the inspector switches to the move tool
  useEffect(() => {
    if (isMaskMode(mode) && tool !== 'move') setToolState('move')
  }, [mode])

  const toolRef = useRef(tool)
  toolRef.current = tool

  // ---- selections and layers of pixels
  const selSize = () => {
    const c = targetClip(stateRef.current)
    const s = stateRef.current
    return c ? [c.raster.w, c.raster.h] : [s.canvas.w, s.canvas.h]
  }
  const selActions = {
    all: () => {
      const [w, h] = selSize()
      setSel(makeSelection(w, h, { type: 'all' }, 'replace', null))
    },
    none: () => setSel(null),
    invert: () => {
      if (!selRef.current) return
      const [w, h] = selSize()
      setSel(invertSelection(w, h, selRef.current))
    },
  }
  const layerActions = {
    clear: (clip) => {
      const e = rasterEntry(clip)
      const full = { x: 0, y: 0, w: e.w, h: e.h }
      const before = rasterGrab(e, full)
      e.canvas.getContext('2d').clearRect(0, 0, e.w, e.h)
      commitPixels(clip, dispatch, full, before)
    },
    // a picture / text layer drawn into pixels (with its move, size, mask and effects), so it can be painted on
    rasterize: async (clip) => {
      const s = stateRef.current
      const w = s.canvas.w
      const h = s.canvas.h
      setBusy(true)
      try {
        await imagesReady(s)
        const cv = document.createElement('canvas')
        cv.width = w
        cv.height = h
        const r = makeImageRenderer(cv)
        const one = { ...s, overlayClips: [clip], videoTracks: s.videoTracks.filter((t) => t.id === clip.trackId), rowOrder: ['v:' + clip.trackId], hiddenRows: [], lockedRows: [] }
        r.renderLayers(buildLayers(one, w, h), [0, 0, 0, 0])
        const rid = uid()
        rasterFromCanvas(rid, w, h, cv)
        freeRenderer(cv)
        dispatch({ type: 'imgRasterize', id: clip.id, rasterId: rid, w, h })
        flash('The layer is now pixels: you can paint, smudge and select on it.')
      } catch (e) {
        flash('The layer could not be turned into pixels: ' + String((e && e.message) || e))
      } finally {
        setBusy(false)
      }
    },
  }

  // ---- pictures in
  const addPictures = (items) => {
    if (!items.length) return
    dispatch({ type: 'addMedia', items })
    // the canvas keeps the size it was given: a picture is placed on it, it never resizes it
    items.forEach((it) => it.type === 'image' && dispatch({ type: 'imgAddImage', mediaId: it.id }))
    if (items.some((it) => it.type !== 'image')) flash('Only pictures can be layers here: videos were skipped.')
  }
  // Ctrl+V: a picture from the clipboard (a screenshot, "Copy image" in a browser, or a picture file copied in Explorer) becomes a layer
  useEffect(() => {
    const onPaste = async (e) => {
      if (!activeRef.current) return
      const tag = e.target && e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter((f) => /^image\//.test(f.type))
      if (!files.length) {
        // pixels copied with Ctrl+C / Ctrl+X in the editor: a new pixel layer, in the same place
        if (pixelClip) {
          e.preventDefault()
          addPixelLayer(stateRef.current, dispatch, pixelClip.canvas, pixelClip.x, pixelClip.y, 'Pasted')
          flash('Pasted as a new layer.')
        }
        return
      }
      e.preventDefault()
      setBusy(true)
      try {
        const items = []
        for (const f of files) {
          const real = window.api.pathForFile(f) // a file copied in Explorer has a path; a screenshot does not
          if (real) items.push(...(await window.api.describeFiles([real])))
          else {
            const item = await window.api.savePastedPicture({ data: await f.arrayBuffer(), ext: (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg') })
            if (item) items.push(item)
          }
        }
        addPictures(items)
        if (items.length) flash(items.length === 1 ? 'Picture pasted as a new layer.' : `${items.length} pictures pasted as new layers.`)
      } finally {
        setBusy(false)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])
  const importPictures = async () => {
    setBusy(true)
    try {
      addPictures(await window.api.importMedia('image'))
    } finally {
      setBusy(false)
    }
  }
  const onDropFiles = async (e) => {
    if (!e.dataTransfer.files.length) return
    e.preventDefault()
    setBusy(true)
    try {
      addPictures(await window.api.describeFiles([...e.dataTransfer.files].map((f) => window.api.pathForFile(f))))
    } finally {
      setBusy(false)
    }
  }

  // ---- saving, opening, autosave
  const rememberRecent = async (file, s) => {
    let thumb = thumbRef.current
    try {
      const k = 256 / Math.max(s.canvas.w, s.canvas.h)
      const data = await exportImage(s, { scale: Math.min(1, k), type: 'image/png' })
      thumb = await window.api.saveThumb({ key: file, data, replace: thumbRef.current })
      thumbRef.current = thumb
    } catch {}
    window.api.recentAdd({
      path: file,
      name: file.split(/[\\/]/).pop().replace(/\.json$/i, ''),
      kind: 'image',
      thumb,
      clips: s.overlayClips.length,
      duration: 0,
      size: `${s.canvas.w}×${s.canvas.h}`,
    })
  }
  const loadFromJson = async (json, file) => {
    setBusy(true)
    try {
      // a project of the separate drawing editor of an earlier version: its layers become pixel layers
      if (isDrawingProject(json)) json = convertDrawingProject(json)
      const r = await restoreImage(json)
      dispatch({ type: 'loadImageProject', ...r })
      setProjectPath(file)
      savedJson.current = file ? serializeImage({ ...initialState, ...r }) : serializeImage(initialState)
      autosavedJson.current = ''
      if (file) rememberRecent(file, { ...initialState, ...r })
      flash(r.missing.length ? `Some pictures could not be found: ${r.missing.join(', ')}` : file ? 'Project opened.' : 'Previous session restored.')
    } catch (e) {
      window.alert('Could not open that project:\n' + (e.message || e))
    } finally {
      setBusy(false)
    }
  }
  const saveProject = async (asNew, to) => {
    const s = stateRef.current
    const json = serializeImage(s)
    const file = await window.api.saveProject(to || (asNew ? null : projectRef.current), await serializeImageFull(s), `${projectName === 'Untitled' ? 'My picture' : projectName}.json`)
    if (!file) return false
    setProjectPath(file)
    savedJson.current = json
    setDirty(false)
    window.api.clearAutosave(tabId)
    rememberRecent(file, s)
    flash('Project saved.')
    return true
  }
  useEffect(() => {
    if (initial && initial.json) loadFromJson(initial.json, initial.file)
    // Open picture: the picture is the first layer and the canvas takes its size
    if (initial && initial.picture) {
      dispatch({ type: 'addMedia', items: [initial.picture] })
      dispatch({ type: 'imgAddImage', mediaId: initial.picture.id, fitCanvas: true })
    }
  }, [])
  useEffect(() => {
    registerHandle(tabId, { kind: 'image', save: () => saveProject(false), saveAs: (to) => saveProject(false, to), isDirty: () => dirtyRef.current, getState: () => stateRef.current, dispatch, live: () => liveRef.current })
    return () => registerHandle(tabId, null)
  }, [])
  // what the AI connection works with (fresh on every render)
  const liveRef = useRef(null)
  liveRef.current = {
    kit,
    addPictures,
    layerActions,
    sel: () => selRef.current,
    setSel,
    pixelClip: () => pixelClip,
    setPixelClip: (c) => (pixelClip = c),
  }
  useEffect(() => {
    onMeta(tabId, { title: projectName, path: projectPath, dirty, kind: 'image' })
  }, [projectName, projectPath, dirty])
  useEffect(() => {
    const t = setTimeout(() => setDirty(serializeImage(state) !== savedJson.current), 600)
    return () => clearTimeout(t)
  }, [state.media, state.overlayClips, state.videoTracks, state.rowOrder, state.lockedRows, state.hiddenRows, state.canvas, projectPath])
  useEffect(() => {
    const id = setInterval(async () => {
      const json = serializeImage(stateRef.current)
      if (json === savedJson.current) return
      if (projectRef.current) {
        await window.api.saveProject(projectRef.current, await serializeImageFull(stateRef.current))
        savedJson.current = json
        setDirty(false)
      } else if (json !== autosavedJson.current) {
        await window.api.autosave(tabId, await serializeImageFull(stateRef.current))
        autosavedJson.current = json
      }
    }, 15000)
    return () => clearInterval(id)
  }, [])

  // ---- keyboard
  useEffect(() => {
    const onKey = (e) => {
      if (!activeRef.current) return
      const tag = e.target.tagName
      // sliders, colour boxes and tick boxes keep the focus after a click: shortcuts must still work then
      const typing = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !['range', 'checkbox', 'color', 'radio', 'button'].includes(e.target.type))
      if (typing) return
      const action = actionFor(binds, e)
      const h = {
        save: () => saveProject(false),
        saveAs: () => saveProject(true),
        open: onOpen,
        undo: () => dispatch({ type: 'undo' }),
        redo: () => dispatch({ type: 'redo' }),
        // with an area of pixels selected, Delete rubs those pixels out; otherwise it removes the chosen layers
        delete: () => {
          if (selRef.current && deleteSelected(stateRef.current, dispatch, selRef.current)) return
          stateRef.current.selection.forEach((id) => dispatch({ type: 'imgRemove', id }))
        },
        duplicate: () => stateRef.current.selection.forEach((id) => dispatch({ type: 'imgDuplicate', id })),
      }
      if (action && h[action]) {
        e.preventDefault()
        return h[action]()
      }
      // painting shortcuts
      const k = e.key
      const lower = k.toLowerCase()
      if (e.ctrlKey || e.metaKey) {
        if (lower === 'd') {
          e.preventDefault()
          return setSel(null)
        }
        if (lower === 'a' && PIXEL_TOOLS.includes(toolRef.current)) {
          e.preventDefault()
          return selActions.all()
        }
        if (lower === 'i' && e.shiftKey) {
          e.preventDefault()
          return selActions.invert()
        }
        if ((lower === 'c' || lower === 'x') && selRef.current) {
          const c = copyPixels(stateRef.current, selRef.current)
          if (c) {
            e.preventDefault()
            pixelClip = c
            if (lower === 'x') deleteSelected(stateRef.current, dispatch, selRef.current)
            flash(lower === 'x' ? 'Cut. Paste it with Ctrl+V.' : 'Copied. Paste it with Ctrl+V.')
          }
        }
        return
      }
      if (!e.altKey && PIXEL_TOOLS.includes(toolRef.current)) {
        // arrow keys slide what is selected by one pixel (Shift: ten)
        if (selRef.current && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k)) {
          e.preventDefault()
          const s = e.shiftKey ? 10 : 1
          const next = moveSelected(stateRef.current, dispatch, selRef.current, k === 'ArrowLeft' ? -s : k === 'ArrowRight' ? s : 0, k === 'ArrowUp' ? -s : k === 'ArrowDown' ? s : 0)
          if (next) setSel(next)
          return
        }
        if (k === '[' || k === ']') {
          e.preventDefault()
          const s = kit.optsRef.current.size
          const step = Math.max(1, Math.round(s * 0.12))
          return kit.setOpts({ size: Math.max(1, Math.min(1000, s + (k === ']' ? step : -step))) })
        }
        if (lower === 'x') {
          e.preventDefault()
          return kit.swap()
        }
        if (/^[0-9]$/.test(k)) {
          e.preventDefault()
          return kit.setOpts({ opacity: k === '0' ? 1 : +k / 10 })
        }
        if (k === 'Escape' && selRef.current) return setSel(null)
      }
      // single letters pick a tool (not while Ctrl / Alt is held)
      if (!e.ctrlKey && !e.altKey && !e.metaKey) {
        const t = TOOLS.find((x) => x.key === e.key.toUpperCase())
        if (t) {
          e.preventDefault()
          setTool(t.id)
        } else if (e.key.toUpperCase() === 'T') {
          e.preventDefault()
          dispatch({ type: 'imgAddText' })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [binds, mode])

  if (active) window.__vibe = { dispatch, state, addMedia: (items) => dispatch({ type: 'addMedia', items }) } // used by the developer self-test
  if (active) window.__paint = { kit, builtin: kit.builtin, sel: () => selRef.current, setSel, setTool } // used by the developer self-test

  const sizeLabel = `${state.canvas.w} × ${state.canvas.h}`

  // the tutorial: shown by itself the first time the image editor is opened, and again from the Tutorial button
  const appRef = useRef(null)
  const [tour, setTour] = useState(false)
  useEffect(() => {
    if (!active || tourSeen('image')) return
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
    markTourSeen('image')
    setTour(false)
  }

  return (
    <div className="app" ref={appRef} style={{ display: active ? undefined : 'none' }} onDragOver={(e) => e.preventDefault()} onDrop={onDropFiles}>
      <header className="topbar">
        <span className="tb-group">
          <button onClick={onNew} title="Start another project in a new tab">New</button>
          <button onClick={onOpen} title="Open a project in a new tab">Open…</button>
          <button onClick={onOpenPicture} title="Open a picture from your computer in a new tab, to edit it">Open picture…</button>
        </span>
        <span className="tb-group">
          <button onClick={() => saveProject(false)} title="Save (Ctrl+S)">Save</button>
          <button onClick={() => saveProject(true)}>Save as…</button>
        </span>
        <span className="tb-group">
          <button onClick={() => dispatch({ type: 'undo' })} disabled={!state.past.length} title="Undo (Ctrl+Z)"><Icon name="undo" size={14} /></button>
          <button onClick={() => dispatch({ type: 'redo' })} disabled={!state.future.length} title="Redo (Ctrl+Y)"><Icon name="redo" size={14} /></button>
        </span>
        <span className="proj-name">{projectName}{dirty ? ' •' : ''}</span>
        <span className="canvas-size" title="The size of the canvas, in pixels">{sizeLabel}</span>
        <span className="spacer" />
        <button onClick={() => setTour(true)} title="Tutorial: a short tour of the main features"><Icon name="help" size={15} /></button>
        <button className="primary" onClick={() => setShowExport(true)} disabled={!state.overlayClips.length}>
          <Icon name="upload" /> Export picture…
        </button>
      </header>
      <div className="top">
        <div className="toolbar-v">
          {TOOLS.map((t) => (
            <button key={t.id} className={'tool-btn' + (tool === t.id ? ' on' : '')} title={t.label} onClick={() => setTool(t.id)}>
              <Icon name={t.icon} size={17} />
            </button>
          ))}
          <button className="tool-btn" title="Add text (T)" onClick={() => dispatch({ type: 'imgAddText' })}>
            <Icon name="type" size={17} />
          </button>
        </div>
        <LayersPanel state={state} dispatch={dispatch} open={layersOpen} setOpen={setLayersOpen} onAddPicture={importPictures} busy={busy} />
        <main className="stage">
          <ImagePreview state={state} dispatch={dispatch} mode={mode} setMode={setMode} freeMode={freeMode} tool={tool} kit={kit} sel={sel} setSel={setSel} canvasRef={canvasRef} />
          <div className="note-line">{note}</div>
        </main>
        <ImageInspector state={state} dispatch={dispatch} mode={mode} setMode={setMode} freeMode={freeMode} setFreeMode={setFreeMode} tool={tool} kit={kit} sel={sel} selActions={selActions} layerActions={layerActions} open={inspOpen} setOpen={setInspOpen} />
      </div>
      {tour && active && <Tour steps={IMAGE_STEPS} rootRef={appRef} onClose={closeTour} />}
      {showExport && <ExportPictureDialog state={state} name={projectName === 'Untitled' ? 'My picture' : projectName} onClose={() => setShowExport(false)} flash={flash} />}
    </div>
  )
}

// Export: PNG (keeps see-through parts), JPG (smaller) or WebP; at the canvas size or bigger / smaller
function ExportPictureDialog({ state, name, onClose, flash }) {
  const [fmt, setFmt] = useState('png')
  const [scale, setScale] = useState(1)
  const [quality, setQuality] = useState(92)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const w = Math.round(state.canvas.w * scale)
  const h = Math.round(state.canvas.h * scale)
  const go = async () => {
    setBusy(true)
    setErr('')
    try {
      const type = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[fmt]
      const data = await exportImage(state, { scale, type, quality: quality / 100 })
      const file = await window.api.saveImage({ data, name, ext: fmt })
      if (file) {
        flash('Picture saved.')
        onClose()
      }
    } catch (e) {
      setErr(String((e && e.message) || e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="modal-bg">
      <div className="modal">
        <h3>Export picture</h3>
        <div className="mtop">
          <span className="mlabel">Format</span>
          <select value={fmt} onChange={(e) => setFmt(e.target.value)}>
            <option value="png">PNG (best quality, keeps see-through)</option>
            <option value="jpg">JPG (smaller file)</option>
            <option value="webp">WebP (small, keeps see-through)</option>
          </select>
        </div>
        <div className="mtop">
          <span className="mlabel">Size</span>
          <select value={scale} onChange={(e) => setScale(+e.target.value)}>
            {[0.25, 0.5, 1, 2, 3].map((k) => (
              <option key={k} value={k}>{k === 1 ? 'Original' : `${k * 100}%`}</option>
            ))}
          </select>
          <span className="hint-sm">{w} × {h}</span>
        </div>
        {fmt !== 'png' && (
          <div className="mtop">
            <span className="mlabel">Quality {quality}%</span>
            <input type="range" min="40" max="100" value={quality} onChange={(e) => setQuality(+e.target.value)} />
          </div>
        )}
        {fmt === 'jpg' && state.canvas.bg === 'transparent' && <p className="hint-sm">JPG cannot be see-through: the transparent parts become white.</p>}
        {err && <p className="hint-sm" style={{ color: 'var(--love, #eb6f92)' }}>{err}</p>}
        <div className="btn-row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={go} disabled={busy}>{busy ? 'Working…' : 'Save picture…'}</button>
        </div>
      </div>
    </div>
  )
}
