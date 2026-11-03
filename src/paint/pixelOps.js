// Things done to the pixels of a layer, as one undo step each: used by the painting overlay and by the keyboard shortcuts.
import { uid, soleVideoClip, overlayLayout, isLocked } from '../state.js'
import { newCanvas } from './engine.js'
import { rasterEntry, rasterCommit, rasterGrab, rasterRect, rasterFromCanvas } from './raster.js'
import { liftParts, paintMoved, shiftSelection, copySelected, clearSelected } from './selection.js'

// the chosen layer, if it is a layer of pixels that may be changed (else null)
export function targetClip(state) {
  const id = soleVideoClip(state)
  const c = id && overlayLayout(state.overlayClips).find((x) => x.id === id)
  return c && c.raster && !isLocked(state, c.id) ? c : null
}

// the pixels inside `rect` of the clip's layer were changed (`before` = a copy of that area as it was)
export function commitPixels(clip, dispatch, rect, before) {
  const rev = rasterCommit(clip, rect, before)
  dispatch({ type: 'rasterCommit', id: clip.id, rev })
}

// rub out what is selected (Delete)
export function deleteSelected(state, dispatch, sel) {
  const clip = targetClip(state)
  if (!clip || !sel) return false
  const e = rasterEntry(clip)
  const full = { x: 0, y: 0, w: e.w, h: e.h }
  const before = rasterGrab(e, full)
  clearSelected(e, sel)
  commitPixels(clip, dispatch, full, before)
  return true
}

// move what is selected by (dx, dy) pixels in one go (the arrow keys)
export function moveSelected(state, dispatch, sel, dx, dy, copy = false) {
  const clip = targetClip(state)
  if (!clip || !sel) return null
  const e = rasterEntry(clip)
  const parts = liftParts(e, sel, copy)
  paintMoved(e, parts, dx, dy)
  commitPixels(clip, dispatch, parts.full, parts.before)
  return shiftSelection(e.w, e.h, sel, dx, dy)
}

// after a smudge: `before` = the whole layer as it was. Returns the part of it to undo with; with a selection only the selected part keeps the smudge.
export function smudgeResult(en, r, before, sel) {
  const crop = newCanvas(r.w, r.h)
  crop.getContext('2d').drawImage(before, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
  if (sel) {
    const after = rasterGrab(en, r)
    const ag = after.getContext('2d')
    ag.globalCompositeOperation = 'destination-in'
    ag.drawImage(sel.mask, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
    const lg = en.canvas.getContext('2d')
    lg.clearRect(r.x, r.y, r.w, r.h)
    lg.drawImage(before, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h)
    lg.save()
    lg.globalCompositeOperation = 'destination-out'
    lg.drawImage(sel.mask, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h)
    lg.restore()
    lg.drawImage(after, r.x, r.y)
  }
  return crop
}

// the selected pixels as a picture of their own
export function copyPixels(state, sel) {
  const id = soleVideoClip(state)
  const c = id && overlayLayout(state.overlayClips).find((x) => x.id === id)
  if (!c || !c.raster || !sel) return null
  return copySelected(rasterEntry(c), sel)
}

// a picture (copied pixels, a pasted screenshot...) as a new layer of pixels, placed at (x, y) of the canvas
export function addPixelLayer(state, dispatch, source, x, y, name) {
  const w = state.canvas.w
  const h = state.canvas.h
  const id = uid()
  const rasterId = uid()
  const cv = newCanvas(w, h)
  cv.getContext('2d').drawImage(source, x, y)
  rasterFromCanvas(rasterId, w, h, cv)
  dispatch({ type: 'imgAddRaster', id, rasterId, w, h, name })
  return id
}

export { rasterRect }
