// Pixel layers of the picture editor.
//
// A raster layer is an overlay clip (like every layer of the picture editor, so it can be moved, scaled, turned, masked and
// given effects) whose picture is a canvas of pixels: clip.raster = { id, rev, w, h, alphaLock, from? }.
// The canvases live here, outside the project state. Every change to the pixels (a brush stroke, a fill, a smudge, a moved
// selection...) is kept as a "patch" (the changed rectangle, before and after) and bumps clip.raster.rev through the
// 'rasterCommit' action, which gives it an undo step like everything else. When undo / redo bring back an older or newer
// state, the pixels follow because `sync` applies or takes back the patches until the layer is at the state's rev.
import { newCanvas, compOp } from './engine.js'

const store = new Map() // raster id -> { id, canvas, w, h, patches: [], base, applied, view }
const MAX_PATCHES = 80 // older steps than that cannot be undone any more (keeps memory in check)
// Every layer's canvas carries a version number (canvas.__ver) that changes whenever its pixels change, so the renderer can keep
// a texture of it on the graphics card and only send the pixels again when the version is new.
let stamp = 0
export const rasterTouch = (e) => {
  e.canvas.__ver = ++stamp
}

const paste = (cv, rect, src) => {
  const g = cv.getContext('2d')
  g.save()
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.globalCompositeOperation = 'source-over'
  g.globalAlpha = 1
  g.clearRect(rect.x, rect.y, rect.w, rect.h)
  g.drawImage(src, rect.x, rect.y)
  g.restore()
}

function entryOf(r) {
  let e = store.get(r.id)
  if (e) return e
  e = { id: r.id, canvas: newCanvas(r.w, r.h), w: r.w, h: r.h, patches: [], base: 0, applied: 0, view: null }
  rasterTouch(e)
  store.set(r.id, e)
  // a copy of another layer: starts as that layer was at that moment
  if (r.from) {
    const src = store.get(r.from.id)
    if (src) {
      syncEntry(src, r.from.rev)
      e.canvas.getContext('2d').drawImage(src.canvas, 0, 0)
      rasterTouch(e)
    }
  }
  return e
}

function syncEntry(e, rev) {
  const was = e.applied
  while (e.applied > rev && e.applied > e.base) {
    const p = e.patches[e.applied - 1 - e.base]
    paste(e.canvas, p.rect, p.before)
    e.applied--
  }
  while (e.applied < rev && e.applied - e.base < e.patches.length) {
    const p = e.patches[e.applied - e.base]
    paste(e.canvas, p.rect, p.after)
    e.applied++
  }
  if (e.applied !== was) rasterTouch(e)
}

// the layer's pixels as the state wants them (undo / redo applied)
export function rasterEntry(clip) {
  const e = entryOf(clip.raster)
  syncEntry(e, clip.raster.rev || 0)
  return e
}

// a copy of an area of a layer (kept to undo with)
export function rasterGrab(e, rect) {
  const c = newCanvas(rect.w, rect.h)
  c.getContext('2d').drawImage(e.canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
  return c
}
export const rasterRect = (e, r) => {
  const x = Math.max(0, Math.floor(r.x))
  const y = Math.max(0, Math.floor(r.y))
  const x1 = Math.min(e.w, Math.ceil(r.x + r.w))
  const y1 = Math.min(e.h, Math.ceil(r.y + r.h))
  return x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : null
}

// The pixels inside `rect` were changed (`before` = a copy of that area as it was). Returns the layer's new rev: put it in the
// state with dispatch({type: 'rasterCommit', id: clip.id, rev}).
export function rasterCommit(clip, rect, before) {
  const e = rasterEntry(clip)
  e.patches.length = Math.max(0, e.applied - e.base) // (what could have been redone is gone)
  e.patches.push({ rect, before, after: rasterGrab(e, rect) })
  e.applied++
  rasterTouch(e)
  if (e.patches.length > MAX_PATCHES) {
    e.patches.shift()
    e.base++
  }
  return e.applied
}

// ---- a stroke in progress is shown on top of the layer without being in it yet
let live = null // { id (raster id), buffer, rect, opacity, erase, comp, alphaLock, mask }
export function setRasterLive(l) {
  live = l
}
export const getRasterLive = () => live

// the canvas the renderer should show for this layer (with the stroke in progress, if it is this layer's)
export function rasterView(clip) {
  const e = rasterEntry(clip)
  if (!live || live.id !== e.id || !live.rect) return e.canvas
  if (!e.view) e.view = newCanvas(e.w, e.h)
  const g = e.view.getContext('2d')
  g.globalCompositeOperation = 'source-over'
  g.globalAlpha = 1
  g.clearRect(0, 0, e.w, e.h)
  g.drawImage(e.canvas, 0, 0)
  const r = live.rect
  g.save()
  g.globalAlpha = live.opacity
  g.globalCompositeOperation = live.erase ? 'destination-out' : live.alphaLock ? 'source-atop' : compOp(live.comp)
  if (live.mask) {
    const t = newCanvas(r.w, r.h)
    const tg = t.getContext('2d')
    tg.drawImage(live.buffer, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
    tg.globalCompositeOperation = 'destination-in'
    tg.drawImage(live.mask, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
    g.drawImage(t, r.x, r.y)
  } else g.drawImage(live.buffer, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h)
  g.restore()
  e.view.__ver = ++stamp // (changes each time: a stroke in progress)
  return e.view
}

// ---- saving and opening
const toBlob = (cv) => new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('A layer could not be saved'))), 'image/png'))
export async function rasterDataUrl(clip) {
  const e = rasterEntry(clip)
  const u8 = new Uint8Array(await (await toBlob(e.canvas)).arrayBuffer())
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
  return 'data:image/png;base64,' + btoa(s)
}
// a layer that comes from a saved project: its pixels are in `img` (an Image) or none (empty)
export function rasterRestore(r, img) {
  store.delete(r.id)
  const e = entryOf({ id: r.id, w: r.w, h: r.h })
  if (img) e.canvas.getContext('2d').drawImage(img, 0, 0, r.w, r.h)
  rasterTouch(e)
}
export const loadImageUrl = (url) =>
  new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('A layer picture inside the project could not be read'))
    img.src = url
  })
// a layer whose first pixels are the given canvas / image (a pasted picture, a rasterized layer)
export function rasterFromCanvas(id, w, h, src) {
  store.delete(id)
  const e = entryOf({ id, w, h })
  if (src) e.canvas.getContext('2d').drawImage(src, 0, 0, w, h)
  rasterTouch(e)
  return e
}
export const rasterForget = (id) => store.delete(id)

if (typeof window !== 'undefined') window.__raster = { store, rasterEntry }
