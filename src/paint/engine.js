// The brush engine of the painting tools of the picture editor.
//
// A BrushDef (see kritaBrush.js, builtinBrushes.js) is turned into "dabs": one tip picture stamped again and again along the
// path of the pen. The dabs are stamped into a stroke buffer (a transparent canvas the size of the picture); while the stroke
// lasts the buffer is shown on top of the layer, and at the end it is merged into the layer with the stroke opacity.
// That is what makes "opacity" a limit for the whole stroke while "flow" builds up with every dab.

const TAU = Math.PI * 2
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v)

// ------------------------------------------------------------------------------------------------ curves
// A curve is [[x, y], ...] with x and y between 0 and 1. It is smoothed (monotone cubic) and turned into a 256 step table.
const lutCache = new WeakMap()
function curveLut(pts) {
  let lut = lutCache.get(pts)
  if (lut) return lut
  lut = new Float32Array(256)
  const p = pts.slice().sort((a, b) => a[0] - b[0])
  const n = p.length
  if (n < 2) {
    for (let i = 0; i < 256; i++) lut[i] = i / 255
  } else {
    const d = []
    const m = new Array(n).fill(0)
    for (let i = 0; i < n - 1; i++) d.push((p[i + 1][1] - p[i][1]) / Math.max(1e-6, p[i + 1][0] - p[i][0]))
    m[0] = d[0]
    m[n - 1] = d[n - 2]
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) {
        m[i] = 0
        m[i + 1] = 0
      } else {
        const a = m[i] / d[i]
        const b = m[i + 1] / d[i]
        const s = a * a + b * b
        if (s > 9) {
          const t = 3 / Math.sqrt(s)
          m[i] = t * a * d[i]
          m[i + 1] = t * b * d[i]
        }
      }
    }
    let seg = 0
    for (let k = 0; k < 256; k++) {
      const x = k / 255
      if (x <= p[0][0]) lut[k] = p[0][1]
      else if (x >= p[n - 1][0]) lut[k] = p[n - 1][1]
      else {
        while (seg < n - 2 && x > p[seg + 1][0]) seg++
        const h = p[seg + 1][0] - p[seg][0]
        const t = (x - p[seg][0]) / h
        const t2 = t * t
        const t3 = t2 * t
        lut[k] = (2 * t3 - 3 * t2 + 1) * p[seg][1] + (t3 - 2 * t2 + t) * h * m[seg] + (-2 * t3 + 3 * t2) * p[seg + 1][1] + (t3 - t2) * h * m[seg + 1]
      }
    }
  }
  lutCache.set(pts, lut)
  return lut
}
export const curveAt = (pts, x) => {
  if (!pts || pts.length < 2) return clamp(x)
  const lut = curveLut(pts)
  const f = clamp(x) * 255
  const i = Math.floor(f)
  const v = i >= 255 ? lut[255] : lut[i] + (lut[i + 1] - lut[i]) * (f - i)
  return clamp(v)
}

// ------------------------------------------------------------------------------------------------ tips
const mk = (w, h) => {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}
export const newCanvas = mk

// the round / square soft tip: alpha = 1 inside the hard core, fading out to the edge
function autoMask(tip) {
  if (tip._mask) return tip._mask
  const S = 256
  const cv = mk(S, S)
  const g = cv.getContext('2d')
  const im = g.createImageData(S, S)
  const d = im.data
  const hard = clamp(tip.hfade == null ? 0.5 : tip.hfade)
  const gauss = tip.mode === 'gauss'
  const rect = tip.shape === 'rect'
  const curve = tip.curve && tip.curve.length > 1 ? tip.curve : null
  let cmax = 1
  if (curve) {
    cmax = 0.0001
    for (let i = 0; i <= 20; i++) cmax = Math.max(cmax, curveAt(curve, i / 20))
  }
  const c = (S - 1) / 2
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const nx = (x - c) / (S / 2)
      const ny = (y - c) / (S / 2)
      const r = rect ? Math.max(Math.abs(nx), Math.abs(ny)) : Math.sqrt(nx * nx + ny * ny)
      let a
      if (r >= 1) a = 0
      else if (curve) a = clamp(curveAt(curve, r) / cmax)
      else if (gauss) a = Math.exp(-Math.pow(r / (0.15 + 0.5 * hard), 2) * 2) * (1 - r * r * 0.1)
      else if (r <= hard) a = 1
      else {
        const t = (r - hard) / Math.max(0.001, 1 - hard)
        a = 1 - t * t * (3 - 2 * t)
      }
      // a thin anti-aliased edge for hard tips
      if (r > 0.985 && r < 1) a *= (1 - r) / 0.015
      const o = (y * S + x) * 4
      d[o + 3] = Math.round(a * 255)
    }
  }
  g.putImageData(im, 0, 0)
  tip._mask = cv
  return cv
}

// the picture(s) of a tip: one canvas (or several for animated / "random pick" tips), as alpha masks or full colour
function tipCells(tip) {
  if (tip.kind === 'image') return tip.cells
  return [autoMask(tip)]
}
// a mask tinted with one colour
function tinted(tip, cellIdx, colour) {
  const cells = tipCells(tip)
  const cell = cells[cellIdx % cells.length]
  if (tip.kind === 'image' && tip.colour) return cell
  if (!tip._tint) tip._tint = new Map()
  const key = cellIdx + '|' + colour
  let t = tip._tint.get(key)
  if (t) return t
  if (tip._tint.size > 24) tip._tint.clear()
  t = mk(cell.width, cell.height)
  const g = t.getContext('2d')
  g.fillStyle = colour
  g.fillRect(0, 0, t.width, t.height)
  g.globalCompositeOperation = 'destination-in'
  g.drawImage(cell, 0, 0)
  tip._tint.set(key, t)
  return t
}

// ------------------------------------------------------------------------------------------------ textures
// A pattern that makes the paint grainy: white lets all the paint through, dark parts hold it back.
function textureMap(tex) {
  const key = [tex.scale, tex.strength, tex.brightness, tex.contrast, tex.invert].join('|')
  if (tex._map && tex._key === key) return tex._map
  const src = tex.canvas
  const k = clamp(tex.scale || 1, 0.1, 8)
  const w = Math.max(2, Math.min(1024, Math.round(src.width * k)))
  const h = Math.max(2, Math.min(1024, Math.round(src.height * k)))
  const cv = mk(w, h)
  const g = cv.getContext('2d')
  g.imageSmoothingQuality = 'high'
  g.drawImage(src, 0, 0, w, h)
  const im = g.getImageData(0, 0, w, h)
  const d = im.data
  const bright = tex.brightness || 0
  const contrast = tex.contrast == null ? 1 : tex.contrast
  const strength = clamp(tex.strength == null ? 1 : tex.strength)
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255
    let lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255
    lum = lum * a + (1 - a) // see-through = white
    let v = (lum - 0.5) * contrast + 0.5 + bright
    if (tex.invert) v = 1 - v
    v = clamp(v)
    const out = 1 - strength * (1 - v)
    d[i] = d[i + 1] = d[i + 2] = 0
    d[i + 3] = Math.round(out * 255)
  }
  g.putImageData(im, 0, 0)
  tex._map = cv
  tex._key = key
  tex._pattern = null
  return cv
}

// ------------------------------------------------------------------------------------------------ dynamics
// sensor ids as Krita names them
function sensorValue(id, c) {
  switch (id) {
    case 'pressure':
    case 'pressurein':
      return c.pressure
    case 'speed':
      return c.speed
    case 'xtilt':
      return clamp((c.tiltX + 60) / 120)
    case 'ytilt':
      return clamp((c.tiltY + 60) / 120)
    case 'tiltdirection':
      return c.tiltAmount < 0.02 ? 0 : clamp((Math.atan2(c.tiltY, c.tiltX) / TAU + 1) % 1)
    case 'tiltelevation':
      return clamp(1 - c.tiltAmount)
    case 'drawingangle':
      return clamp(((c.angle / TAU) % 1 + 1) % 1)
    case 'distance':
      return clamp(c.distance / 1000)
    case 'fade':
      return clamp(c.distance / 1000)
    case 'time':
      return clamp(c.time / 3)
    case 'fuzzy':
      return c.rnd
    case 'fuzzystroke':
      return c.strokeRnd
    case 'perspective':
      return 1
    case 'rotation':
      return 0
    default:
      return c.pressure
  }
}
// the value of one dynamic (null when the brush does not have it): sensors multiply
function dyn(d, c) {
  if (!d) return null
  if (!d.sensors || !d.sensors.length) return d.useCurve === false ? d.value : 1
  let v = 1
  for (const s of d.sensors) v *= curveAt(s.curve && s.curve.length > 1 ? s.curve : null, sensorValue(s.id, c))
  return v
}

// ------------------------------------------------------------------------------------------------ the stroke
// params: { brush, size, opacity, flow, colour, smoothing, mirrorX, mirrorY, w, h, buffer }
export class Stroke {
  constructor(p) {
    this.p = p
    this.brush = p.brush
    this.buffer = p.buffer
    this.g = this.buffer.getContext('2d')
    this.w = p.w
    this.h = p.h
    this.dirty = null
    this.reset()
  }
  reset() {
    this.started = false
    this.rem = 0
    this.distance = 0
    this.t0 = 0
    this.strokeRnd = Math.random()
    this.last = null // last emitted input (smoothed)
    this.prevPos = null
    this.angle = 0
    this.frame = 0
  }
  clearBuffer() {
    if (this.dirty) {
      const r = this.dirty
      this.g.clearRect(r.x, r.y, r.w, r.h)
      this.dirty = null
    }
  }
  // the biggest brush size a dab can have: used for the area to redraw
  _grow(x, y, r) {
    const x0 = Math.floor(x - r) - 2
    const y0 = Math.floor(y - r) - 2
    const x1 = Math.ceil(x + r) + 2
    const y1 = Math.ceil(y + r) + 2
    const d = this.dirty
    if (!d) this.dirty = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    else {
      const nx = Math.min(d.x, x0)
      const ny = Math.min(d.y, y0)
      const mx = Math.max(d.x + d.w, x1)
      const my = Math.max(d.y + d.h, y1)
      this.dirty = { x: nx, y: ny, w: mx - nx, h: my - ny }
    }
  }
  begin(pt) {
    this.started = true
    this.t0 = pt.t || 0
    this.sm = { x: pt.x, y: pt.y, pressure: pt.pressure, tiltX: pt.tiltX || 0, tiltY: pt.tiltY || 0, t: pt.t || 0 }
    this.last = { ...this.sm }
    this.speed = 0
    this._dab(this.sm, 0)
    this.rem = this._step(this.sm)
    return true
  }
  move(pt) {
    if (!this.started) return this.begin(pt)
    const k = 1 - 0.93 * clamp(this.p.smoothing || 0) // 1 = follows the pen exactly
    const s = this.sm
    const nx = s.x + (pt.x - s.x) * k
    const ny = s.y + (pt.y - s.y) * k
    const np = { x: nx, y: ny, pressure: s.pressure + (pt.pressure - s.pressure) * Math.max(k, 0.35), tiltX: pt.tiltX || 0, tiltY: pt.tiltY || 0, t: pt.t || s.t }
    this._segment(this.last, np)
    this.last = np
    this.sm = np
    this.pendingTarget = pt
  }
  // at the end of the stroke the smoothed point catches up with the pen
  finish() {
    if (!this.started || !this.pendingTarget || !(this.p.smoothing > 0)) return
    const t = this.pendingTarget
    for (let i = 0; i < 40; i++) {
      const dx = t.x - this.sm.x
      const dy = t.y - this.sm.y
      if (dx * dx + dy * dy < 0.25) break
      this.move({ ...t })
    }
  }
  _step(c) {
    const size = this._size(c)
    const sp = this.brush.spacing == null ? 0.1 : this.brush.spacing
    const ratio = this.brush.autoSpacing ? Math.max(0.05, (this.brush.autoSpacingCoeff || 1) * 0.1) : sp
    const spd = dyn(this.brush.dyn && this.brush.dyn.spacing, this._ctx(c, 0))
    let step = size * ratio * (spd == null ? 1 : Math.max(0.1, spd * 2)) * (this.p.spacingMul || 1)
    return Math.max(0.4, step)
  }
  _ctx(c, rnd) {
    const ta = Math.min(1, Math.sqrt(c.tiltX * c.tiltX + c.tiltY * c.tiltY) / 90)
    return {
      pressure: clamp(c.pressure),
      speed: this.speed,
      tiltX: c.tiltX || 0,
      tiltY: c.tiltY || 0,
      tiltAmount: ta,
      angle: this.angle,
      distance: this.distance,
      time: ((c.t || 0) - this.t0) / 1000,
      rnd: rnd == null ? Math.random() : rnd,
      strokeRnd: this.strokeRnd,
    }
  }
  _size(c) {
    const b = this.brush
    const v = dyn(b.dyn && b.dyn.size, this._ctx(c, 0.5))
    return Math.max(0.5, this.p.size * (v == null ? 1 : Math.max(0.02, v)))
  }
  _segment(a, b) {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    const dt = Math.max(1, (b.t || 0) - (a.t || 0))
    this.speed = this.speed * 0.6 + clamp(len / dt / 4) * 0.4
    if (len < 1e-6) return
    this.angle = Math.atan2(dy, dx)
    let pos = 0
    let rem = this.rem
    while (pos + rem <= len) {
      pos += rem
      const t = pos / len
      const c = {
        x: a.x + dx * t,
        y: a.y + dy * t,
        pressure: a.pressure + (b.pressure - a.pressure) * t,
        tiltX: a.tiltX + (b.tiltX - a.tiltX) * t,
        tiltY: a.tiltY + (b.tiltY - a.tiltY) * t,
        t: (a.t || 0) + ((b.t || 0) - (a.t || 0)) * t,
      }
      this.distance += rem
      this._dab(c, 0)
      rem = this._step(c)
    }
    this.rem = rem - (len - pos)
    this.distance += len - pos
  }
  // one dab, with its mirrored copies
  _dab(c) {
    const b = this.brush
    const ctx = this._ctx(c)
    if (b.density != null && b.density < 1 && Math.random() > b.density) return
    const size = this._size(c)
    const tip = b.tip
    let flow = (b.flow == null ? 1 : b.flow) * (this.p.flow == null ? 1 : this.p.flow)
    const fd = dyn(b.dyn && b.dyn.flow, ctx)
    if (fd != null) flow *= fd
    const od = dyn(b.dyn && b.dyn.opacity, ctx)
    if (od != null) flow *= od
    flow = clamp(flow)
    if (flow <= 0.002) return
    let ratio = tip.kind === 'auto' ? tip.ratio || 1 : 1
    const rd = dyn(b.dyn && b.dyn.ratio, ctx)
    if (rd != null) ratio = clamp(ratio * (0.1 + 0.9 * rd), 0.05, 1)
    let angle = ((b.angle || 0) * Math.PI) / 180
    const ad = dyn(b.dyn && b.dyn.rotation, ctx)
    if (ad != null) angle += ad * TAU
    // scatter
    let sx = 0
    let sy = 0
    if (b.scatter && b.scatter.amount > 0) {
      let amt = b.scatter.amount
      const sd = dyn(b.dyn && b.dyn.scatter, ctx)
      if (sd != null) amt *= sd
      const r = size * amt * 0.5
      if (b.scatter.x !== false) sx = (Math.random() * 2 - 1) * r
      if (b.scatter.y !== false) sy = (Math.random() * 2 - 1) * r
    }
    // which picture of an animated tip
    let cell = 0
    if (tip.kind === 'image' && tip.cells.length > 1) {
      cell = tip.mode === 'incremental' ? this.frame++ : Math.floor(Math.random() * tip.cells.length)
    }
    const img = tinted(tip, cell, this.p.colour)
    const iw = img.width
    const ih = img.height
    const k = size / Math.max(iw, ih)
    const spots = [[c.x + sx, c.y + sy, angle, 1, 1]]
    if (this.p.mirrorX) spots.push([this.w - c.x - sx, c.y + sy, Math.PI - angle, -1, 1])
    if (this.p.mirrorY) spots.push([c.x + sx, this.h - c.y - sy, -angle, 1, -1])
    if (this.p.mirrorX && this.p.mirrorY) spots.push([this.w - c.x - sx, this.h - c.y - sy, angle + Math.PI, -1, -1])
    const g = this.g
    const tex = b.texture && b.texture.canvas ? b.texture : null
    const reach = (size * Math.max(1, 1 / Math.max(ratio, 0.05)) * 0.75) | 0
    for (const [x, y, a] of spots) {
      const cs = Math.cos(a)
      const sn = Math.sin(a)
      if (!tex) {
        g.setTransform(cs * k, sn * k, -sn * k * ratio, cs * k * ratio, x, y)
        g.globalAlpha = flow
        g.drawImage(img, -iw / 2, -ih / 2)
      } else {
        this._texturedDab(img, x, y, cs * k, sn * k, -sn * k * ratio, cs * k * ratio, flow, tex, size)
      }
      this._grow(x, y, Math.min(reach + Math.abs(size) * 0.25, 2000))
    }
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.globalAlpha = 1
  }
  _texturedDab(img, x, y, a, bb, c, d, flow, tex, size) {
    const side = Math.ceil(size * 1.6) + 4
    if (!this._tmp || this._tmp.width < side) this._tmp = mk(Math.min(2400, Math.max(side, 64)), Math.min(2400, Math.max(side, 64)))
    const t = this._tmp
    const tg = t.getContext('2d')
    const ox = Math.round(x - side / 2)
    const oy = Math.round(y - side / 2)
    tg.setTransform(1, 0, 0, 1, 0, 0)
    tg.globalCompositeOperation = 'source-over'
    tg.globalAlpha = 1
    tg.clearRect(0, 0, t.width, t.height)
    tg.setTransform(a, bb, c, d, x - ox, y - oy)
    tg.drawImage(img, -img.width / 2, -img.height / 2)
    // multiply with the pattern, which sits fixed on the picture (so strokes grow the same grain)
    const map = textureMap(tex)
    if (!tex._pattern) tex._pattern = tg.createPattern(map, 'repeat')
    tg.setTransform(1, 0, 0, 1, -ox, -oy)
    tg.globalCompositeOperation = 'destination-in'
    tg.fillStyle = tex._pattern
    tg.fillRect(ox, oy, side, side)
    tg.globalCompositeOperation = 'source-over'
    this.g.setTransform(1, 0, 0, 1, 0, 0)
    this.g.globalAlpha = flow
    this.g.drawImage(t, 0, 0, side, side, ox, oy, side, side)
  }
  // draw a polyline (a line, rectangle or ellipse outline) with the brush. Points are {x, y}; pressure 1.
  polyline(points, closed = false) {
    if (points.length < 1) return
    const pt = (q, t) => ({ x: q.x, y: q.y, pressure: 1, tiltX: 0, tiltY: 0, t })
    this.reset()
    this.started = true
    this.t0 = 0
    this.strokeRnd = Math.random()
    this.sm = pt(points[0], 0)
    this.last = { ...this.sm }
    this.speed = 0.3
    this._dab(this.sm)
    this.rem = this._step(this.sm)
    const list = closed ? points.concat([points[0]]) : points
    for (let i = 1; i < list.length; i++) {
      const b = pt(list[i], i * 8)
      this._segment(this.last, b)
      this.last = b
    }
  }
}

// ------------------------------------------------------------------------------------------------ shapes as point lists
export function ellipsePoints(cx, cy, rx, ry, rot = 0) {
  const n = Math.max(24, Math.min(360, Math.round((Math.abs(rx) + Math.abs(ry)) * 0.9)))
  const pts = []
  const cs = Math.cos(rot)
  const sn = Math.sin(rot)
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU
    const x = Math.cos(a) * rx
    const y = Math.sin(a) * ry
    pts.push({ x: cx + x * cs - y * sn, y: cy + x * sn + y * cs })
  }
  return pts
}
export function rectPoints(x0, y0, x1, y1) {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ]
}

// ------------------------------------------------------------------------------------------------ merging
const COMP = {
  normal: 'source-over',
  erase: 'destination-out',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  color_dodge: 'color-dodge',
  color_burn: 'color-burn',
  hard_light: 'hard-light',
  soft_light: 'soft-light',
  soft_light_svg: 'soft-light',
  soft_light_pegtop_delphi: 'soft-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminize: 'luminosity',
  luminosity: 'luminosity',
  add: 'lighter',
  linear_dodge: 'lighter',
  linear_burn: 'multiply',
  dissolve: 'source-over',
}
export const compOp = (name) => COMP[String(name || 'normal').toLowerCase().replace(/[ -]/g, '_')] || 'source-over'

// put the stroke buffer on a layer canvas
export function mergeBuffer(layerCtx, buffer, rect, o = {}) {
  const g = layerCtx
  g.save()
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.globalAlpha = clamp(o.opacity == null ? 1 : o.opacity)
  const op = o.erase ? 'destination-out' : o.alphaLock ? 'source-atop' : compOp(o.comp)
  g.globalCompositeOperation = op === 'destination-out' || !o.alphaLock ? op : 'source-atop'
  let src = buffer
  if (o.mask) {
    // painting is limited to the selection
    src = mk(rect.w, rect.h)
    const sg = src.getContext('2d')
    sg.drawImage(buffer, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
    sg.globalCompositeOperation = 'destination-in'
    sg.drawImage(o.mask, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
    g.drawImage(src, rect.x, rect.y)
  } else {
    g.drawImage(src, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h)
  }
  g.restore()
}

// ------------------------------------------------------------------------------------------------ smudge
// Pushes the colours of the layer along the stroke: a "carry" picture of what is under the brush is put down again
// a little further, and refreshed with what is there.
export class Smudge {
  constructor({ layer, brush, size, strength, w, h, mask }) {
    this.canvas = layer
    this.g = layer.getContext('2d')
    this.brush = brush
    this.size = size
    this.strength = clamp(strength)
    this.mask = mask
    this.w = w
    this.h = h
    this.carry = null
    this.last = null
    this.rem = 0
    this.dirty = null
    this.tipCanvas = null
  }
  _grow(x, y, r) {
    const d = this.dirty
    const x0 = Math.max(0, Math.floor(x - r))
    const y0 = Math.max(0, Math.floor(y - r))
    const x1 = Math.min(this.w, Math.ceil(x + r))
    const y1 = Math.min(this.h, Math.ceil(y + r))
    if (!d) this.dirty = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    else {
      const nx = Math.min(d.x, x0)
      const ny = Math.min(d.y, y0)
      this.dirty = { x: nx, y: ny, w: Math.max(d.x + d.w, x1) - nx, h: Math.max(d.y + d.h, y1) - ny }
    }
  }
  _tip(size) {
    const t = this.brush.tip
    const cells = tipCells(t)
    const cell = cells[0]
    const s = Math.max(2, Math.round(size))
    const cv = mk(s, s)
    const g = cv.getContext('2d')
    const k = s / Math.max(cell.width, cell.height)
    g.drawImage(cell, (s - cell.width * k) / 2, (s - cell.height * k) / 2, cell.width * k, cell.height * k)
    return cv
  }
  _put(x, y, pressure) {
    const size = Math.max(2, Math.round(this.size * (0.4 + 0.6 * pressure)))
    const half = size / 2
    if (!this.carry || this.carry.width !== size) {
      const old = this.carry
      this.carry = mk(size, size)
      this.carryTip = this._tip(size)
      if (!old) {
        this.carry.getContext('2d').drawImage(this.canvas, Math.round(x - half), Math.round(y - half), size, size, 0, 0, size, size)
        this._first = true
      } else this.carry.getContext('2d').drawImage(old, 0, 0, size, size)
    }
    if (this._first) {
      this._first = false
      return
    }
    // lay the carried colour down through the tip
    const m = mk(size, size)
    const mg = m.getContext('2d')
    mg.drawImage(this.carry, 0, 0)
    mg.globalCompositeOperation = 'destination-in'
    mg.drawImage(this.carryTip, 0, 0)
    this.g.save()
    this.g.globalAlpha = clamp(this.strength * (0.5 + 0.5 * pressure))
    this.g.drawImage(m, Math.round(x - half), Math.round(y - half))
    this.g.restore()
    // pick up what is there now, a bit of it
    const cg = this.carry.getContext('2d')
    cg.globalAlpha = 1 - this.strength * 0.9
    cg.drawImage(this.canvas, Math.round(x - half), Math.round(y - half), size, size, 0, 0, size, size)
    cg.globalAlpha = 1
    this._grow(x, y, half + 2)
  }
  begin(pt) {
    this.last = pt
    this.rem = 0
    this._put(pt.x, pt.y, pt.pressure)
    this.rem = Math.max(1, this.size * 0.12)
  }
  move(pt) {
    const a = this.last
    const dx = pt.x - a.x
    const dy = pt.y - a.y
    const len = Math.hypot(dx, dy)
    let pos = 0
    let rem = this.rem
    while (pos + rem <= len) {
      pos += rem
      const t = pos / len
      this._put(a.x + dx * t, a.y + dy * t, a.pressure + (pt.pressure - a.pressure) * t)
      rem = Math.max(1, this.size * 0.12)
    }
    this.rem = rem - (len - pos)
    this.last = pt
  }
}

// ------------------------------------------------------------------------------------------------ flood fill
// fills the area around (sx, sy) whose colour is close to the colour there. src is the canvas that is looked at;
// returns a {x,y,w,h,mask:Uint8Array} describing the area (mask 255 = filled) or null
export function floodMask(src, sx, sy, tolerance = 0.15, limit = null) {
  const w = src.width
  const h = src.height
  sx = Math.floor(sx)
  sy = Math.floor(sy)
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null
  const id = src.getContext('2d').getImageData(0, 0, w, h)
  const d = id.data
  const o0 = (sy * w + sx) * 4
  const r0 = d[o0]
  const g0 = d[o0 + 1]
  const b0 = d[o0 + 2]
  const a0 = d[o0 + 3]
  const tol = Math.round(clamp(tolerance) * 255 * 2)
  const mask = new Uint8Array(w * h)
  const near = (i) => {
    const o = i * 4
    const da = Math.abs(d[o + 3] - a0)
    if (a0 < 8 && d[o + 3] < 8) return true
    return Math.abs(d[o] - r0) + Math.abs(d[o + 1] - g0) + Math.abs(d[o + 2] - b0) + da * 0.5 <= tol * 2 && da <= tol * 2
  }
  const lim = limit ? limit.getContext('2d').getImageData(0, 0, w, h).data : null
  const allowed = (i) => !lim || lim[i * 4 + 3] > 8
  const stack = [sx, sy]
  let minX = sx
  let maxX = sx
  let minY = sy
  let maxY = sy
  while (stack.length) {
    const y = stack.pop()
    let x = stack.pop()
    let i = y * w + x
    if (mask[i] || !near(i) || !allowed(i)) continue
    while (x > 0 && !mask[i - 1] && near(i - 1) && allowed(i - 1)) {
      x--
      i--
    }
    let up = false
    let down = false
    while (x < w && !mask[i] && near(i) && allowed(i)) {
      mask[i] = 255
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (y > 0) {
        const u = i - w
        if (!mask[u] && near(u) && allowed(u)) {
          if (!up) {
            stack.push(x, y - 1)
            up = true
          }
        } else up = false
      }
      if (y < h - 1) {
        const dn = i + w
        if (!mask[dn] && near(dn) && allowed(dn)) {
          if (!down) {
            stack.push(x, y + 1)
            down = true
          }
        } else down = false
      }
      x++
      i++
    }
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, mask, stride: w }
}

// The line / shape / blob that is under (x, y): every painted pixel that is joined to it (touching, also diagonally).
// If nothing is painted exactly there, the nearest painted pixel within `reach` pixels is used.
// Returns { canvas (picture-size mask), bounds: {x,y,w,h}, hit: {x,y} } or null.
export function objectMask(src, x, y, reach = 6, minAlpha = 12) {
  const w = src.width
  const h = src.height
  const id = src.getContext('2d').getImageData(0, 0, w, h)
  const d = id.data
  const cx = Math.floor(x)
  const cy = Math.floor(y)
  let sx = -1
  let sy = -1
  let best = 1e9
  const r = Math.max(0, Math.ceil(reach))
  for (let yy = Math.max(0, cy - r); yy <= Math.min(h - 1, cy + r); yy++) {
    for (let xx = Math.max(0, cx - r); xx <= Math.min(w - 1, cx + r); xx++) {
      if (d[(yy * w + xx) * 4 + 3] < minAlpha) continue
      const dd = (xx - cx) * (xx - cx) + (yy - cy) * (yy - cy)
      if (dd < best && dd <= r * r) {
        best = dd
        sx = xx
        sy = yy
      }
    }
  }
  if (sx < 0) return null
  const seen = new Uint8Array(w * h)
  const stack = [sy * w + sx]
  seen[sy * w + sx] = 1
  let minX = sx
  let maxX = sx
  let minY = sy
  let maxY = sy
  while (stack.length) {
    const i = stack.pop()
    const px = i % w
    const py = (i - px) / w
    if (px < minX) minX = px
    if (px > maxX) maxX = px
    if (py < minY) minY = py
    if (py > maxY) maxY = py
    for (let oy = -1; oy <= 1; oy++) {
      const qy = py + oy
      if (qy < 0 || qy >= h) continue
      for (let ox = -1; ox <= 1; ox++) {
        const qx = px + ox
        if (qx < 0 || qx >= w || (!ox && !oy)) continue
        const j = qy * w + qx
        if (seen[j] || d[j * 4 + 3] < minAlpha) continue
        seen[j] = 1
        stack.push(j)
      }
    }
  }
  const bw = maxX - minX + 1
  const bh = maxY - minY + 1
  const piece = new ImageData(bw, bh)
  for (let yy = 0; yy < bh; yy++) {
    for (let xx = 0; xx < bw; xx++) {
      if (seen[(minY + yy) * w + minX + xx]) piece.data[(yy * bw + xx) * 4 + 3] = 255
    }
  }
  const cv = mk(w, h)
  cv.getContext('2d').putImageData(piece, minX, minY)
  return { canvas: cv, bounds: { x: minX, y: minY, w: bw, h: bh }, hit: { x: sx, y: sy } }
}

// a filled-in mask as a canvas painted with one colour (grown by one pixel so the edges close up nicely)
export function maskToCanvas(m, colour, grow = 1) {
  const x0 = Math.max(0, m.x - grow)
  const y0 = Math.max(0, m.y - grow)
  const w = m.w + grow * 2
  const h = m.h + grow * 2
  const cv = mk(w, h)
  const g = cv.getContext('2d')
  const im = g.createImageData(w, h)
  const d = im.data
  const col = hexToRgb(colour)
  const H = Math.floor(m.mask.length / m.stride)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x0 + x
      const py = y0 + y
      let on = 0
      if (px >= 0 && py >= 0 && px < m.stride && py < H) {
        for (let dy = -grow; dy <= grow && !on; dy++) {
          for (let dx = -grow; dx <= grow; dx++) {
            const qx = px + dx
            const qy = py + dy
            if (qx >= 0 && qy >= 0 && qx < m.stride && qy < H && m.mask[qy * m.stride + qx]) {
              on = 1
              break
            }
          }
        }
      }
      if (on) {
        const o = (y * w + x) * 4
        d[o] = col[0]
        d[o + 1] = col[1]
        d[o + 2] = col[2]
        d[o + 3] = 255
      }
    }
  }
  g.putImageData(im, 0, 0)
  return { canvas: cv, x: x0, y: y0, w, h }
}

export function hexToRgb(hex) {
  let h = String(hex || '#000000').replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h.slice(0, 6), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
export const rgbToHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
export function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
  }
  return [f(5) * 255, f(3) * 255, f(1) * 255]
}
export function rgbToHsv(r, g, b) {
  r /= 255
  g /= 255
  b /= 255
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const d = mx - mn
  let h = 0
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6
    else if (mx === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return [h, mx ? d / mx : 0, mx]
}
