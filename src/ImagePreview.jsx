import { useEffect, useRef, useState } from 'react'
import TransformOverlay from './TransformOverlay.jsx'
import WarpOverlay from './WarpOverlay.jsx'
import MaskOverlay from './MaskOverlay.jsx'
import { aspectRatio, soleVideoClip, overlayLayout, clipPicture, uid, isLocked } from './state.js'
import { evalTransform, rectToFrame, frameToRect } from './motion.js'
import { buildLayers, backgroundOf, makeImageRenderer, imageFor } from './imageRender.js'
import PaintOverlay from './paint/PaintOverlay.jsx'
import { PIXEL_TOOLS } from './paint/usePaintKit.js'
import { rasterEntry } from './paint/raster.js'


// The picture of the image editor: the layers drawn with WebGL, zoomable (Ctrl + mouse wheel, or the buttons) and
// scrollable (middle mouse button drags it), with the transform / warp / mask handles and the painting tools on top.
export default function ImagePreview({ state, dispatch, mode, setMode, freeMode, tool, kit, sel, setSel, canvasRef }) {
  const areaRef = useRef(null)
  const wrapRef = useRef(null)
  const innerRef = useRef(null)
  const glRef = useRef(null)
  const ratio = aspectRatio(state)
  const [zoom, setZoomState] = useState(1)
  const zoomRef = useRef(1)
  const [fitBox, setFitBox] = useState({ w: 640, h: 360 })
  const [tick, setTick] = useState(0) // bumps when a picture finishes loading
  const cap = Math.min(1, 4096 / Math.max(state.canvas.w, state.canvas.h))
  const cw = Math.max(1, Math.round(state.canvas.w * cap))
  const ch = Math.max(1, Math.round(state.canvas.h * cap))
  const box = { w: fitBox.w * zoom, h: fitBox.h * zoom }

  useEffect(() => {
    const el = areaRef.current
    const fit = () => {
      const pad = 28
      const w = Math.max(1, Math.min(el.clientWidth - pad, (el.clientHeight - pad) * ratio))
      setFitBox({ w, h: w / ratio })
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ratio])

  // zoom keeping the point under (px, py) (pixels inside the scroll area) where it is
  const setZoom = (z, px, py) => {
    const wrap = wrapRef.current
    const nz = Math.min(32, Math.max(0.1, z))
    const old = zoomRef.current
    if (nz === old) return
    const cx = px == null ? wrap.clientWidth / 2 : px
    const cy = py == null ? wrap.clientHeight / 2 : py
    const fx = (wrap.scrollLeft + cx) / old
    const fy = (wrap.scrollTop + cy) / old
    zoomRef.current = nz
    setZoomState(nz)
    requestAnimationFrame(() => {
      wrap.scrollLeft = fx * nz - cx
      wrap.scrollTop = fy * nz - cy
    })
  }
  const onWheel = (e) => {
    if (!e.ctrlKey) return
    e.preventDefault()
    const r = wrapRef.current.getBoundingClientRect()
    setZoom(zoomRef.current * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX - r.left, e.clientY - r.top)
  }
  const onPan = (e) => {
    if (e.button !== 1) return
    e.preventDefault()
    const wrap = wrapRef.current
    const [x0, y0, sl, st] = [e.clientX, e.clientY, wrap.scrollLeft, wrap.scrollTop]
    const move = (ev) => {
      wrap.scrollLeft = sl - (ev.clientX - x0)
      wrap.scrollTop = st - (ev.clientY - y0)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // the renderer (made once, when the canvas exists)
  useEffect(() => {
    const cv = innerRef.current
    glRef.current = makeImageRenderer(cv)
    if (canvasRef) canvasRef.current = cv
    return () => {
      glRef.current = null
    }
  }, [])

  // draw whenever anything that shows changes
  useEffect(() => {
    const r = glRef.current
    if (!r) return
    r.renderLayers(buildLayers(state, cw, ch, null, () => setTick((t) => t + 1)), backgroundOf(state))
  }, [state.overlayClips, state.media, state.videoTracks, state.rowOrder, state.hiddenRows, state.canvas, cw, ch, tick])

  // ---- painting: the pen, brush and selection tools work on the pixels of a layer (see paint/PaintOverlay.jsx)
  const sel0 = soleVideoClip(state)
  const layer = sel0 && overlayLayout(state.overlayClips).find((c) => c.id === sel0)
  const pixelTool = PIXEL_TOOLS.includes(tool) || tool === 'eyedropper'
  const lockedLayer = !!layer && isLocked(state, layer.id) // a locked layer cannot be changed
  const maskMode =mode === 'mask' || mode === 'maskdraw' || mode === 'maskpoly' || mode === 'maskdrawsmart'
  const getFrame = (id) => {
    const c = overlayLayout(state.overlayClips).find((x) => x.id === id)
    if (!c) return null
    if (c.paint || c.text) return { el: innerRef.current, w: cw, h: ch } // (the whole picture, for those)
    if (c.raster) {
      const en = rasterEntry(c)
      return { el: en.canvas, w: en.w, h: en.h }
    }
    const m = state.media.find((x) => x.id === c.mediaId)
    const e = m && imageFor(m.path)
    return e && e.ready ? { el: e.img, w: e.img.naturalWidth, h: e.img.naturalHeight } : null
  }

  return (
    <div className="preview-area" ref={areaRef}>
      <div className="preview-wrap" ref={wrapRef} onWheel={onWheel} onPointerDown={onPan} onAuxClick={(e) => e.preventDefault()}>
        <div className={'preview-box' + (state.canvas.bg === 'transparent' ? ' checker' : '')} style={{ width: box.w, height: box.h }}>
          <canvas ref={innerRef} width={cw} height={ch} className="preview-canvas" />
          {tool === 'move' && !lockedLayer && mode === 'warp' && <WarpOverlay state={state} dispatch={dispatch} />}
          {tool === 'move' && !lockedLayer && mode === 'transform' && <TransformOverlay state={state} dispatch={dispatch} free={freeMode} box={box} />}
          {tool === 'move' && !lockedLayer && maskMode && <MaskOverlay state={state} dispatch={dispatch} mode={mode} setMode={setMode} box={box} getFrame={getFrame} noTrack />}
          {pixelTool && <PaintOverlay state={state} dispatch={dispatch} kit={kit} tool={tool} box={box} glCanvas={innerRef} sel={sel} setSel={setSel} onLive={() => setTick((t) => t + 1)} />}
        </div>
      </div>
      <div className="zoom-bar">
        <button className="mini" onClick={() => setZoom(zoomRef.current / 1.5)} title="Zoom out">−</button>
        <span title="Ctrl + mouse wheel zooms towards the pointer; drag with the middle mouse button to move around">{Math.round(zoom * 100)}%</span>
        <button className="mini" onClick={() => setZoom(zoomRef.current * 1.5)} title="Zoom in">+</button>
        <button className="mini" onClick={() => setZoom(1)} title="Fit the picture in the window">Fit</button>
      </div>
    </div>
  )
}
