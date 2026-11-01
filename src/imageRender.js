// Draws an image project (its layers, bottom to top) with the same WebGL renderer the video editor uses, so transform,
// funny warp, effects and masks look the same. Used by the editing view and by the export.
import { createRenderer, BLEND_IDS } from './glRenderer.js'
import { videoRowsBottomUp, overlayLayout, toUrl } from './state.js'
import { evalTransform, evalWarp } from './motion.js'
import { maskAt } from './masks.js'
import { drawText } from './textRender.js'
import { paintCanvas } from './paint.js'
import { rasterView } from './paint/raster.js'

const images = new Map() // file path -> { img, ready }
const loaders = new Map() // file path -> promise
export function imageFor(path, onLoad) {
  let e = images.get(path)
  if (!e) {
    const img = new Image()
    e = { img, ready: false }
    images.set(path, e)
    loaders.set(
      path,
      new Promise((res) => {
        img.onload = () => {
          e.ready = true
          res()
          onLoad && onLoad()
        }
        img.onerror = () => res()
        img.src = toUrl(path)
      }),
    )
  } else if (!e.ready && onLoad) loaders.get(path).then(onLoad)
  return e
}
// resolves when every picture of the project is loaded
export const imagesReady = (state) => Promise.all(state.media.filter((m) => m.type === 'image' && !m.missing).map((m) => (imageFor(m.path), loaders.get(m.path))))

const textCanvases = new Map()
const textCanvas = (id, w, h) => {
  let c = textCanvases.get(id)
  if (!c) {
    c = document.createElement('canvas')
    textCanvases.set(id, c)
  }
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  }
  return c
}

// The background as the renderer wants it ([r, g, b, a], premultiplied)
export function backgroundOf(state, forJpeg) {
  const bg = state.canvas.bg
  if (bg === 'transparent') return forJpeg ? [1, 1, 1, 1] : [0, 0, 0, 0]
  const n = parseInt(bg.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1]
}

// the layers that are shown, bottom first, as the renderer takes them. `live` = {id, stroke}: a brush stroke being drawn.
export function buildLayers(state, w, h, live, onLoad) {
  const hid = new Set(state.hiddenRows || [])
  const clips = overlayLayout(state.overlayClips)
  const out = []
  for (const key of videoRowsBottomUp(state)) {
    if (key === 'main' || hid.has(key)) continue
    const c = clips.filter((x) => 'v:' + x.trackId === key).pop()
    if (!c) continue
    let el
    let ew
    let eh
    if (c.text) {
      el = textCanvas(c.id, w, h)
      drawText(el, { ...c.text, animIn: 'none', animOut: 'none' }, 50, 100)
      ew = w
      eh = h
    } else if (c.raster) {
      el = rasterView(c) // (the canvas of pixels, with the stroke in progress on top while one is being drawn)
      ew = c.raster.w
      eh = c.raster.h
    } else if (c.paint) {
      el = paintCanvas(c, live && live.id === c.id ? live.stroke : null)
      ew = c.paint.w
      eh = c.paint.h
    } else {
      const m = state.media.find((x) => x.id === c.mediaId)
      if (!m || m.missing) continue
      const e = imageFor(m.path, onLoad)
      if (!e.ready) continue
      el = e.img
      ew = e.img.naturalWidth
      eh = e.img.naturalHeight
    }
    // ver: a picture that has a version number (a pixel layer's canvas, or a loaded picture file) is kept as a texture on the graphics card
    const ver = c.raster ? el.__ver : c.text || c.paint ? undefined : 1
    out.push({ A: { el, w: ew, h: eh, ver, tf: evalTransform(c, 0), warp: evalWarp(c, 0), fx: c.fx, mask: maskAt(c, 0) }, blend: BLEND_IDS[c.blend] || 0 })
  }
  return out
}

export function makeImageRenderer(canvas) {
  return createRenderer(canvas)
}

// Renders the whole project at its own size (times `scale`) and returns the picture as a file's bytes.
// type: 'image/png' | 'image/jpeg' | 'image/webp'
export async function exportImage(state, { scale = 1, type = 'image/png', quality = 0.92 } = {}) {
  await imagesReady(state)
  const w = Math.max(1, Math.round(state.canvas.w * scale))
  const h = Math.max(1, Math.round(state.canvas.h * scale))
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const r = createRenderer(cv)
  r.renderLayers(buildLayers(state, w, h), backgroundOf(state, type === 'image/jpeg'))
  const blob = await new Promise((res) => cv.toBlob(res, type, quality))
  if (!blob) throw new Error('The picture could not be made (it may be too big for this computer).')
  return blob.arrayBuffer()
}
