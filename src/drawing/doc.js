// A drawing: layers (each a canvas the size of the picture), the selection, and the undo history.
import { newCanvas, compOp } from './engine.js'

export const BLEND_MODES = [
  ['normal', 'Normal'],
  ['multiply', 'Multiply'],
  ['screen', 'Screen'],
  ['overlay', 'Overlay'],
  ['darken', 'Darken'],
  ['lighten', 'Lighten'],
  ['color-dodge', 'Colour dodge'],
  ['color-burn', 'Colour burn'],
  ['hard-light', 'Hard light'],
  ['soft-light', 'Soft light'],
  ['difference', 'Difference'],
  ['exclusion', 'Exclusion'],
  ['hue', 'Hue'],
  ['saturation', 'Saturation'],
  ['color', 'Colour'],
  ['luminosity', 'Luminosity'],
]
const blendOp = (b) => (b === 'normal' ? 'source-over' : b)

const unionRect = (a, b) => {
  if (!a) return b
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}
let idCounter = 1
const nextId = () => 'L' + Date.now().toString(36) + (idCounter++).toString(36)
const MAX_HISTORY = 100

const toBlob = (cv, type = 'image/png', q) => new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the picture'))), type, q))
async function blobToBase64(blob) {
  const u8 = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
  return btoa(s)
}
const loadPng = (b64) =>
  new Promise((res, rej) => {
    const img = new Image()
    img.onload = () => res(img)
    img.onerror = () => rej(new Error('A layer picture inside the project could not be read'))
    img.src = 'data:image/png;base64,' + b64
  })

export class Doc {
  constructor(w, h, bg = '#ffffff') {
    this.w = w
    this.h = h
    this.bg = bg // '#rrggbb' or 'transparent'
    this.layers = [] // bottom first
    this.activeId = null
    this.rev = 0 // goes up with every change: the editor compares it to know what is unsaved
    this.undoStack = []
    this.redoStack = []
    this.selection = null // { mask: canvas, bounds, outline: [[{x,y}...]] }
    this._listeners = new Set()
    this._propBase = null
    this._scratch = null
  }
  static blank(w, h, bg) {
    const d = new Doc(w, h, bg)
    d.addLayer('Layer 1', { silent: true })
    return d
  }
  on(fn) {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }
  changed(pixels = false) {
    this.rev++
    for (const f of this._listeners) f(pixels)
  }
  get active() {
    return this.layers.find((l) => l.id === this.activeId) || this.layers[this.layers.length - 1] || null
  }
  layer(id) {
    return this.layers.find((l) => l.id === id) || null
  }

  // ---- history
  _push(entry) {
    this.undoStack.push(entry)
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift()
    this.redoStack.length = 0
  }
  get canUndo() {
    return this.undoStack.length > 0
  }
  get canRedo() {
    return this.redoStack.length > 0
  }
  undo() {
    const e = this.undoStack.pop()
    if (!e) return false
    e.undo()
    this.redoStack.push(e)
    this.changed(true)
    return true
  }
  redo() {
    const e = this.redoStack.pop()
    if (!e) return false
    e.redo()
    this.undoStack.push(e)
    this.changed(true)
    return true
  }
  _snap() {
    return { activeId: this.activeId, layers: this.layers.map((l) => ({ ...l })) }
  }
  _restore(s) {
    this.layers = s.layers.map((l) => ({ ...l }))
    this.activeId = s.activeId
  }
  // an edit of the list of layers (or their settings): remembered as a whole
  structure(label, fn) {
    const before = this._snap()
    fn()
    const after = this._snap()
    this._push({ label, undo: () => this._restore(before), redo: () => this._restore(after) })
    this.changed(true)
  }
  // paint on a layer was done inside rect: before = a copy of that area as it was
  commitPixels(layer, rect, before, label = 'Paint') {
    const after = newCanvas(rect.w, rect.h)
    after.getContext('2d').drawImage(layer.canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
    const put = (src) => {
      const g = layer.canvas.getContext('2d')
      g.save()
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.globalCompositeOperation = 'source-over'
      g.globalAlpha = 1
      g.clearRect(rect.x, rect.y, rect.w, rect.h)
      g.drawImage(src, rect.x, rect.y)
      g.restore()
    }
    this._push({ label, undo: () => put(before), redo: () => put(after) })
    this.changed(true)
  }
  // a copy of an area of a layer (to hand to commitPixels later)
  grab(layer, rect) {
    const c = newCanvas(rect.w, rect.h)
    c.getContext('2d').drawImage(layer.canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
    return c
  }
  // the box around everything painted on a layer ({x, y, w, h}), or null for an empty layer
  contentBounds(layer) {
    const w = this.w
    const h = this.h
    const d = layer.canvas.getContext('2d').getImageData(0, 0, w, h).data
    let x0 = w
    let y0 = h
    let x1 = -1
    let y1 = -1
    for (let y = 0; y < h; y++) {
      let rowHit = false
      const o = y * w * 4
      for (let x = 0; x < w; x++) {
        if (d[o + x * 4 + 3] > 8) {
          rowHit = true
          if (x < x0) x0 = x
          if (x > x1) x1 = x
        }
      }
      if (rowHit) {
        if (y < y0) y0 = y
        y1 = y
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
  }
  clampRect(r) {
    const x = Math.max(0, Math.floor(r.x))
    const y = Math.max(0, Math.floor(r.y))
    const x1 = Math.min(this.w, Math.ceil(r.x + r.w))
    const y1 = Math.min(this.h, Math.ceil(r.y + r.h))
    return x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : null
  }

  // ---- layers
  addLayer(name, o = {}) {
    const l = { id: nextId(), name: name || `Layer ${this.layers.length + 1}`, visible: true, opacity: 1, blend: 'normal', locked: false, alphaLock: false, canvas: newCanvas(this.w, this.h) }
    if (o.fill) {
      const g = l.canvas.getContext('2d')
      g.fillStyle = o.fill
      g.fillRect(0, 0, this.w, this.h)
    }
    const add = () => {
      const i = o.above ? this.layers.findIndex((x) => x.id === o.above) + 1 : this.layers.length
      this.layers.splice(i, 0, l)
      this.activeId = l.id
    }
    if (o.silent) {
      add()
      this.rev++
    } else this.structure('New layer', add)
    return l
  }
  duplicateLayer(id) {
    const src = this.layer(id)
    if (!src) return
    const l = { ...src, id: nextId(), name: src.name + ' copy', canvas: newCanvas(this.w, this.h) }
    l.canvas.getContext('2d').drawImage(src.canvas, 0, 0)
    this.structure('Duplicate layer', () => {
      this.layers.splice(this.layers.indexOf(src) + 1, 0, l)
      this.activeId = l.id
    })
  }
  removeLayer(id) {
    if (this.layers.length <= 1) {
      // the last layer is only cleared
      const l = this.layers[0]
      this.clearLayer(l.id)
      return
    }
    this.structure('Delete layer', () => {
      const i = this.layers.findIndex((l) => l.id === id)
      if (i < 0) return
      this.layers.splice(i, 1)
      this.activeId = (this.layers[Math.min(i, this.layers.length - 1)] || {}).id
    })
  }
  moveLayer(id, dir) {
    const i = this.layers.findIndex((l) => l.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= this.layers.length) return
    this.structure('Move layer', () => {
      const [l] = this.layers.splice(i, 1)
      this.layers.splice(j, 0, l)
    })
  }
  moveLayerTo(id, index) {
    const i = this.layers.findIndex((l) => l.id === id)
    if (i < 0 || index === i) return
    this.structure('Move layer', () => {
      const [l] = this.layers.splice(i, 1)
      this.layers.splice(Math.max(0, Math.min(this.layers.length, index)), 0, l)
    })
  }
  setActive(id) {
    if (this.activeId === id) return
    this.activeId = id
    this.changed(false)
  }
  // live = a slider is being dragged (remembered once when it ends)
  setLayer(id, patch, live = false) {
    const l = this.layer(id)
    if (!l) return
    if (live) {
      if (!this._propBase) this._propBase = this._snap()
      Object.assign(l, patch)
      this.changed(true)
      return
    }
    const base = this._propBase || this._snap()
    this._propBase = null
    Object.assign(l, patch)
    const after = this._snap()
    this._push({ label: 'Layer settings', undo: () => this._restore(base), redo: () => this._restore(after) })
    this.changed(true)
  }
  endLive() {
    if (!this._propBase) return
    const base = this._propBase
    this._propBase = null
    const after = this._snap()
    this._push({ label: 'Layer settings', undo: () => this._restore(base), redo: () => this._restore(after) })
    this.changed(true)
  }
  mergeDown(id) {
    const i = this.layers.findIndex((l) => l.id === id)
    if (i <= 0) return
    const top = this.layers[i]
    const below = this.layers[i - 1]
    const rect = { x: 0, y: 0, w: this.w, h: this.h }
    const before = this.grab(below, rect)
    const g = below.canvas.getContext('2d')
    g.save()
    g.globalAlpha = top.visible ? top.opacity : 0
    g.globalCompositeOperation = blendOp(top.blend)
    g.drawImage(top.canvas, 0, 0)
    g.restore()
    const after = this.grab(below, rect)
    const snapBefore = this._snap()
    this.layers.splice(i, 1)
    this.activeId = below.id
    const snapAfter = this._snap()
    const put = (src) => {
      const c = below.canvas.getContext('2d')
      c.clearRect(0, 0, this.w, this.h)
      c.drawImage(src, 0, 0)
    }
    this._push({
      label: 'Merge down',
      undo: () => {
        put(before)
        this._restore(snapBefore)
      },
      redo: () => {
        put(after)
        this._restore(snapAfter)
      },
    })
    this.changed(true)
  }
  clearLayer(id, onlySelection = true) {
    const l = this.layer(id)
    if (!l || l.locked) return
    const rect = { x: 0, y: 0, w: this.w, h: this.h }
    const before = this.grab(l, rect)
    const g = l.canvas.getContext('2d')
    if (onlySelection && this.selection) {
      g.save()
      g.globalCompositeOperation = 'destination-out'
      g.drawImage(this.selection.mask, 0, 0)
      g.restore()
    } else g.clearRect(0, 0, this.w, this.h)
    this.commitPixels(l, rect, before, 'Clear')
  }
  fillLayerWith(id, colour) {
    const l = this.layer(id)
    if (!l || l.locked) return
    const rect = { x: 0, y: 0, w: this.w, h: this.h }
    const before = this.grab(l, rect)
    const g = l.canvas.getContext('2d')
    g.save()
    g.fillStyle = colour
    if (this.selection) {
      const t = newCanvas(this.w, this.h)
      const tg = t.getContext('2d')
      tg.fillStyle = colour
      tg.fillRect(0, 0, this.w, this.h)
      tg.globalCompositeOperation = 'destination-in'
      tg.drawImage(this.selection.mask, 0, 0)
      g.drawImage(t, 0, 0)
    } else g.fillRect(0, 0, this.w, this.h)
    g.restore()
    this.commitPixels(l, rect, before, 'Fill')
  }
  flipLayer(id, horizontal) {
    const l = this.layer(id)
    if (!l) return
    const rect = { x: 0, y: 0, w: this.w, h: this.h }
    const before = this.grab(l, rect)
    const g = l.canvas.getContext('2d')
    g.save()
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, this.w, this.h)
    if (horizontal) g.transform(-1, 0, 0, 1, this.w, 0)
    else g.transform(1, 0, 0, -1, 0, this.h)
    g.drawImage(before, 0, 0)
    g.restore()
    this.commitPixels(l, rect, before, 'Flip layer')
  }
  // slides the picture of a layer by (dx, dy) pixels
  shiftLayer(layer, before, dx, dy) {
    const g = layer.canvas.getContext('2d')
    g.save()
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, this.w, this.h)
    g.drawImage(before, Math.round(dx), Math.round(dy))
    g.restore()
  }

  // ---- selection
  setSelection(shape, mode = 'replace') {
    // shape: {type:'rect', x,y,w,h} | {type:'ellipse', x,y,w,h} | {type:'lasso', pts:[{x,y}]} | {type:'all'}
    if (!shape) {
      this.selection = null
      this.changed(false)
      return
    }
    const mask = newCanvas(this.w, this.h)
    const g = mask.getContext('2d')
    const pathOf = (c, s) => {
      c.beginPath()
      if (s.type === 'rect' || s.type === 'all') c.rect(s.x, s.y, s.w, s.h)
      else if (s.type === 'ellipse') c.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.abs(s.w / 2), Math.abs(s.h / 2), 0, 0, Math.PI * 2)
      else {
        s.pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)))
        c.closePath()
      }
    }
    const s = shape.type === 'all' ? { type: 'all', x: 0, y: 0, w: this.w, h: this.h } : shape
    const old = this.selection
    if (old && (mode === 'add' || mode === 'subtract')) g.drawImage(old.mask, 0, 0)
    g.fillStyle = '#000'
    g.globalCompositeOperation = mode === 'subtract' ? 'destination-out' : 'source-over'
    pathOf(g, s)
    g.fill()
    const shapes = old && mode !== 'replace' ? [...old.shapes, s] : [s]
    // the box around the selection (used to lift it, copy it, ...)
    let b
    if (s.type === 'lasso') {
      const xs = s.pts.map((p) => p.x)
      const ys = s.pts.map((p) => p.y)
      b = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
    } else b = { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) }
    this.selection = { mask, shapes, inverted: false, bounds: old && mode !== 'replace' ? unionRect(old.bounds, b) : b }
    this.changed(false)
  }
  // a selection that is any shape at all (a mask picture the size of the drawing): a line that was clicked on, ...
  setSelectionMask(canvas, bounds, mode = 'replace') {
    const mask = newCanvas(this.w, this.h)
    const g = mask.getContext('2d')
    const old = this.selection
    if (old && (mode === 'add' || mode === 'subtract')) g.drawImage(old.mask, 0, 0)
    g.globalCompositeOperation = mode === 'subtract' ? 'destination-out' : 'source-over'
    g.drawImage(canvas, 0, 0)
    const keep = old && mode !== 'replace'
    this.selection = {
      mask,
      shapes: keep ? [...old.shapes, { type: 'mask' }] : [{ type: 'mask' }],
      inverted: false,
      bounds: keep ? unionRect(old.bounds, bounds) : bounds,
    }
    this.changed(false)
  }
  // slide the selection (not what is in it) by (dx, dy)
  shiftSelection(dx, dy) {
    const s = this.selection
    if (!s) return
    const mask = newCanvas(this.w, this.h)
    mask.getContext('2d').drawImage(s.mask, Math.round(dx), Math.round(dy))
    const b = s.bounds || { x: 0, y: 0, w: this.w, h: this.h }
    this.selection = { mask, shapes: [{ type: 'mask' }], inverted: false, bounds: { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h } }
    this.changed(false)
  }
  // is (x, y) inside the selection?
  inSelection(x, y) {
    const s = this.selection
    if (!s || x < 0 || y < 0 || x >= this.w || y >= this.h) return false
    return s.mask.getContext('2d').getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3] > 8
  }
  // The parts needed to lift what is in the selection off a layer: the layer as it was, the layer without the selected part
  // (the same, when copying), and just the selected part.
  liftParts(layer, copy = false) {
    const full = { x: 0, y: 0, w: this.w, h: this.h }
    const before = this.grab(layer, full)
    const base = this.grab(layer, full)
    const lifted = this.grab(layer, full)
    if (!copy) {
      const bg = base.getContext('2d')
      bg.globalCompositeOperation = 'destination-out'
      bg.drawImage(this.selection.mask, 0, 0)
    }
    const lg = lifted.getContext('2d')
    lg.globalCompositeOperation = 'destination-in'
    lg.drawImage(this.selection.mask, 0, 0)
    return { before, base, lifted, full }
  }
  paintMoved(layer, parts, dx, dy) {
    const g = layer.canvas.getContext('2d')
    g.save()
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.globalCompositeOperation = 'source-over'
    g.globalAlpha = 1
    g.clearRect(0, 0, this.w, this.h)
    g.drawImage(parts.base, 0, 0)
    g.drawImage(parts.lifted, Math.round(dx), Math.round(dy))
    g.restore()
  }
  // move (or copy) what is selected by (dx, dy) in one go, as one undo step
  moveSelected(layer, dx, dy, copy = false) {
    if (!this.selection || !layer || layer.locked) return
    const parts = this.liftParts(layer, copy)
    this.paintMoved(layer, parts, dx, dy)
    this.commitPixels(layer, parts.full, parts.before, copy ? 'Copy selection' : 'Move selection')
    this.shiftSelection(dx, dy)
  }
  // the selected pixels as a picture of their own: {canvas, x, y} (null when nothing is selected)
  copySelected(layer) {
    if (!this.selection || !layer) return null
    const r = this.clampRect(this.selection.bounds || { x: 0, y: 0, w: this.w, h: this.h })
    if (!r) return null
    const c = newCanvas(r.w, r.h)
    const g = c.getContext('2d')
    g.drawImage(layer.canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
    g.globalCompositeOperation = 'destination-in'
    g.drawImage(this.selection.mask, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
    return { canvas: c, x: r.x, y: r.y }
  }
  invertSelection() {
    if (!this.selection) return
    const mask = newCanvas(this.w, this.h)
    const g = mask.getContext('2d')
    g.fillStyle = '#000'
    g.fillRect(0, 0, this.w, this.h)
    g.globalCompositeOperation = 'destination-out'
    g.drawImage(this.selection.mask, 0, 0)
    this.selection = { mask, shapes: [{ type: 'all', x: 0, y: 0, w: this.w, h: this.h }, ...this.selection.shapes], inverted: !this.selection.inverted, bounds: { x: 0, y: 0, w: this.w, h: this.h } }
    this.changed(false)
  }

  // ---- drawing it
  // the picture of everything: opts.live = { layerId, buffer, rect, opacity, erase, comp, alphaLock, mask } (a stroke in progress)
  render(g, live = null, opts = {}) {
    g.save()
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.globalAlpha = 1
    g.globalCompositeOperation = 'source-over'
    g.clearRect(0, 0, this.w, this.h)
    if (this.bg !== 'transparent' && !opts.noBg) {
      g.fillStyle = this.bg
      g.fillRect(0, 0, this.w, this.h)
    }
    for (const l of this.layers) {
      if (!l.visible) continue
      g.globalAlpha = l.opacity
      g.globalCompositeOperation = blendOp(l.blend)
      if (live && live.layerId === l.id && live.rect) {
        if (!this._scratch || this._scratch.width !== this.w || this._scratch.height !== this.h) this._scratch = newCanvas(this.w, this.h)
        const s = this._scratch
        const sg = s.getContext('2d')
        sg.globalCompositeOperation = 'source-over'
        sg.globalAlpha = 1
        sg.clearRect(0, 0, this.w, this.h)
        sg.drawImage(l.canvas, 0, 0)
        const r = live.rect
        sg.save()
        sg.globalAlpha = live.opacity
        sg.globalCompositeOperation = live.erase ? 'destination-out' : live.alphaLock ? 'source-atop' : compOp(live.comp)
        if (live.mask) {
          if (!this._scratch2 || this._scratch2.width < r.w || this._scratch2.height < r.h) this._scratch2 = newCanvas(Math.max(r.w, 64), Math.max(r.h, 64))
          const t = this._scratch2
          const tg = t.getContext('2d')
          tg.globalCompositeOperation = 'source-over'
          tg.clearRect(0, 0, t.width, t.height)
          tg.drawImage(live.buffer, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
          tg.globalCompositeOperation = 'destination-in'
          tg.drawImage(live.mask, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
          sg.drawImage(t, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h)
        } else sg.drawImage(live.buffer, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h)
        sg.restore()
        g.drawImage(s, 0, 0)
      } else g.drawImage(l.canvas, 0, 0)
    }
    g.restore()
  }
  flatten(opts = {}) {
    const c = newCanvas(this.w, this.h)
    this.render(c.getContext('2d'), null, opts)
    return c
  }

  // ---- files
  async serialize() {
    const layers = []
    for (const l of this.layers) {
      layers.push({ id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, locked: l.locked, alphaLock: l.alphaLock, png: await blobToBase64(await toBlob(l.canvas)) })
    }
    return JSON.stringify({ kind: 'drawing', version: 1, w: this.w, h: this.h, bg: this.bg, activeId: this.activeId, layers })
  }
  static async fromJson(text) {
    const o = typeof text === 'string' ? JSON.parse(text) : text
    if (o.kind !== 'drawing') throw new Error('This is not a drawing project.')
    const d = new Doc(o.w, o.h, o.bg || '#ffffff')
    for (const l of o.layers || []) {
      const layer = { id: l.id || nextId(), name: l.name || 'Layer', visible: l.visible !== false, opacity: l.opacity == null ? 1 : l.opacity, blend: l.blend || 'normal', locked: !!l.locked, alphaLock: !!l.alphaLock, canvas: newCanvas(o.w, o.h) }
      if (l.png) layer.canvas.getContext('2d').drawImage(await loadPng(l.png), 0, 0)
      d.layers.push(layer)
    }
    if (!d.layers.length) d.addLayer('Layer 1', { silent: true })
    d.activeId = o.activeId && d.layer(o.activeId) ? o.activeId : d.layers[d.layers.length - 1].id
    return d
  }
  // a finished picture as bytes: png / jpg / webp
  async exportBytes({ type = 'image/png', quality = 0.92, scale = 1 } = {}) {
    let cv = this.flatten({})
    if (type === 'image/jpeg' && this.bg === 'transparent') {
      const w = newCanvas(this.w, this.h)
      const g = w.getContext('2d')
      g.fillStyle = '#ffffff'
      g.fillRect(0, 0, this.w, this.h)
      g.drawImage(cv, 0, 0)
      cv = w
    }
    if (scale !== 1) {
      const s = newCanvas(Math.round(this.w * scale), Math.round(this.h * scale))
      const g = s.getContext('2d')
      g.imageSmoothingQuality = 'high'
      g.drawImage(cv, 0, 0, s.width, s.height)
      cv = s
    }
    const blob = await toBlob(cv, type, quality)
    return blob.arrayBuffer()
  }
  async thumbBytes(max = 256) {
    const k = Math.min(1, max / Math.max(this.w, this.h))
    return this.exportBytes({ type: 'image/png', scale: k })
  }
  isEmpty() {
    // true when nothing has been painted on any layer (used for recents text only)
    return this.undoStack.length === 0
  }
}
