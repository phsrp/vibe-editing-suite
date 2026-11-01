// Selections on a pixel layer: an area (a mask the size of the layer) that painting, fills and smudges stay inside, and whose
// pixels can be moved, copied, cut and deleted. A selection is { mask (canvas), shapes (for drawing its outline), inverted, bounds }.
import { newCanvas } from './engine.js'

const unionRect = (a, b) => {
  if (!a) return b
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

const pathOf = (c, s) => {
  c.beginPath()
  if (s.type === 'rect' || s.type === 'all') c.rect(s.x, s.y, s.w, s.h)
  else if (s.type === 'ellipse') c.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.abs(s.w / 2), Math.abs(s.h / 2), 0, 0, Math.PI * 2)
  else {
    s.pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)))
    c.closePath()
  }
}

// shape: {type:'rect'|'ellipse', x,y,w,h} | {type:'lasso', pts:[{x,y}]} | {type:'all'}; mode: 'replace' | 'add' | 'subtract'
export function makeSelection(w, h, shape, mode = 'replace', old = null) {
  const mask = newCanvas(w, h)
  const g = mask.getContext('2d')
  const s = shape.type === 'all' ? { type: 'all', x: 0, y: 0, w, h } : shape
  if (old && (mode === 'add' || mode === 'subtract')) g.drawImage(old.mask, 0, 0)
  g.fillStyle = '#000'
  g.globalCompositeOperation = mode === 'subtract' ? 'destination-out' : 'source-over'
  pathOf(g, s)
  g.fill()
  let b
  if (s.type === 'lasso') {
    const xs = s.pts.map((p) => p.x)
    const ys = s.pts.map((p) => p.y)
    b = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
  } else b = { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) }
  const keep = old && mode !== 'replace'
  return { mask, shapes: keep ? [...old.shapes, s] : [s], inverted: false, bounds: keep ? unionRect(old.bounds, b) : b }
}

// a selection of any shape (the line / blob that was clicked, an AI cut-out): `canvas` is a mask the size of the layer
export function makeMaskSelection(w, h, canvas, bounds, mode = 'replace', old = null) {
  const mask = newCanvas(w, h)
  const g = mask.getContext('2d')
  if (old && (mode === 'add' || mode === 'subtract')) g.drawImage(old.mask, 0, 0)
  g.globalCompositeOperation = mode === 'subtract' ? 'destination-out' : 'source-over'
  g.drawImage(canvas, 0, 0)
  const keep = old && mode !== 'replace'
  return { mask, shapes: keep ? [...old.shapes, { type: 'mask' }] : [{ type: 'mask' }], inverted: false, bounds: keep ? unionRect(old.bounds, bounds) : bounds }
}

export function invertSelection(w, h, sel) {
  const mask = newCanvas(w, h)
  const g = mask.getContext('2d')
  g.fillStyle = '#000'
  g.fillRect(0, 0, w, h)
  g.globalCompositeOperation = 'destination-out'
  g.drawImage(sel.mask, 0, 0)
  return { mask, shapes: [{ type: 'all', x: 0, y: 0, w, h }, ...sel.shapes], inverted: !sel.inverted, bounds: { x: 0, y: 0, w, h } }
}

// slide the selection (not what is in it)
export function shiftSelection(w, h, sel, dx, dy) {
  const mask = newCanvas(w, h)
  mask.getContext('2d').drawImage(sel.mask, Math.round(dx), Math.round(dy))
  const b = sel.bounds || { x: 0, y: 0, w, h }
  return { mask, shapes: [{ type: 'mask' }], inverted: false, bounds: { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h } }
}

export function inSelection(sel, x, y) {
  if (!sel || x < 0 || y < 0 || x >= sel.mask.width || y >= sel.mask.height) return false
  return sel.mask.getContext('2d').getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3] > 8
}

// ---- the pixels inside a selection (e = a layer of raster.js)
// the parts needed to lift what is selected off a layer: the layer as it was (`before`), the layer without the selected part
// (the same when copying: `base`) and just the selected part (`lifted`)
export function liftParts(e, sel, copy = false) {
  const full = { x: 0, y: 0, w: e.w, h: e.h }
  const mk = () => {
    const c = newCanvas(e.w, e.h)
    c.getContext('2d').drawImage(e.canvas, 0, 0)
    return c
  }
  const before = mk()
  const base = mk()
  const lifted = mk()
  if (!copy) {
    const bg = base.getContext('2d')
    bg.globalCompositeOperation = 'destination-out'
    bg.drawImage(sel.mask, 0, 0)
  }
  const lg = lifted.getContext('2d')
  lg.globalCompositeOperation = 'destination-in'
  lg.drawImage(sel.mask, 0, 0)
  return { before, base, lifted, full }
}
export function paintMoved(e, parts, dx, dy) {
  const g = e.canvas.getContext('2d')
  g.save()
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.globalCompositeOperation = 'source-over'
  g.globalAlpha = 1
  g.clearRect(0, 0, e.w, e.h)
  g.drawImage(parts.base, 0, 0)
  g.drawImage(parts.lifted, Math.round(dx), Math.round(dy))
  g.restore()
}
// the selected pixels as a picture of their own: {canvas, x, y}
export function copySelected(e, sel) {
  const b = sel.bounds || { x: 0, y: 0, w: e.w, h: e.h }
  const x = Math.max(0, Math.floor(b.x))
  const y = Math.max(0, Math.floor(b.y))
  const w = Math.min(e.w, Math.ceil(b.x + b.w)) - x
  const h = Math.min(e.h, Math.ceil(b.y + b.h)) - y
  if (w < 1 || h < 1) return null
  const c = newCanvas(w, h)
  const g = c.getContext('2d')
  g.drawImage(e.canvas, x, y, w, h, 0, 0, w, h)
  g.globalCompositeOperation = 'destination-in'
  g.drawImage(sel.mask, x, y, w, h, 0, 0, w, h)
  return { canvas: c, x, y }
}
// rub out what is selected
export function clearSelected(e, sel) {
  const g = e.canvas.getContext('2d')
  g.save()
  g.globalCompositeOperation = 'destination-out'
  g.drawImage(sel.mask, 0, 0)
  g.restore()
}
