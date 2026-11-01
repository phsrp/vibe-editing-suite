// The brushes that come with the editor (same shape as the brushes read from Krita packs, see kritaBrush.js).
import { newCanvas } from './engine.js'

const P = (curve = [[0, 0], [1, 1]]) => ({ sensors: [{ id: 'pressure', curve }], useCurve: true, value: 1 })
const LIN = [[0, 0], [1, 1]]
const SOFT = [[0, 0.15], [0.5, 0.6], [1, 1]]
const SENS = [[0, 0.3], [1, 1]]

function auto(hardness, extra = {}) {
  return { kind: 'auto', shape: 'circle', ratio: 1, hfade: hardness, vfade: hardness, mode: 'default', diameter: 24, curve: [], ...extra }
}

// grain pictures made with maths so no files are needed
function noise(size, seed, soft = 1) {
  const cv = newCanvas(size, size)
  const g = cv.getContext('2d')
  const im = g.createImageData(size, size)
  let s = seed
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
  const v = new Float32Array(size * size)
  for (let i = 0; i < v.length; i++) v[i] = rnd()
  // a little blur so the grain has some body
  for (let pass = 0; pass < soft; pass++) {
    const o = v.slice()
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = y * size + x
        v[i] = (o[i] * 2 + o[(y * size + ((x + 1) % size))] + o[(y * size + ((x + size - 1) % size))] + o[(((y + 1) % size) * size + x)] + o[(((y + size - 1) % size) * size + x)]) / 6
      }
  }
  let mn = 1
  let mx = 0
  for (const a of v) {
    if (a < mn) mn = a
    if (a > mx) mx = a
  }
  for (let i = 0; i < v.length; i++) {
    const g8 = Math.round(((v[i] - mn) / (mx - mn || 1)) * 255)
    im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = g8
    im.data[i * 4 + 3] = 255
  }
  g.putImageData(im, 0, 0)
  return cv
}

let grain = null
let paper = null
const grainTex = () => grain || (grain = noise(128, 7, 1))
const paperTex = () => paper || (paper = noise(256, 99, 2))

const B = (o) => ({
  from: 'builtin',
  engine: 'paintbrush',
  approximate: false,
  note: '',
  angle: 0,
  spacing: 0.08,
  autoSpacing: false,
  density: 1,
  scale: 1,
  opacity: 1,
  flow: 1,
  comp: 'normal',
  dyn: {},
  scatter: { amount: 0, x: true, y: true },
  texture: null,
  ...o,
})

let list = null
export function builtinBrushes() {
  return list || (list = make())
}
function make() {
  return [
    B({ id: 'b:pencil', name: 'Pencil', size: 4, spacing: 0.1, tip: auto(0.55), dyn: { size: P(SENS), opacity: P([[0, 0.25], [1, 1]]) }, texture: { get canvas() { return grainTex() }, scale: 1, strength: 0.9, brightness: 0.1, contrast: 1.5, invert: false } }),
    B({ id: 'b:pen', name: 'Ink pen', size: 8, spacing: 0.05, tip: auto(0.95), dyn: { size: P([[0, 0.12], [0.5, 0.7], [1, 1]]) } }),
    B({ id: 'b:fineliner', name: 'Fine liner', size: 3, spacing: 0.06, tip: auto(1) }),
    B({ id: 'b:hard', name: 'Hard round', size: 30, spacing: 0.06, tip: auto(1), dyn: { size: P(SENS) } }),
    B({ id: 'b:soft', name: 'Soft round', size: 60, spacing: 0.08, tip: auto(0.25), dyn: { size: P(SENS), opacity: P(SOFT) } }),
    B({ id: 'b:airbrush', name: 'Airbrush', size: 120, spacing: 0.04, flow: 0.18, tip: auto(0.02), dyn: { flow: P(LIN) } }),
    B({ id: 'b:marker', name: 'Marker', size: 28, spacing: 0.05, opacity: 1, tip: auto(0.9), comp: 'normal', dyn: {} }),
    B({ id: 'b:paint', name: 'Paint brush', size: 40, spacing: 0.06, tip: auto(0.7), dyn: { size: P([[0, 0.2], [0.6, 0.85], [1, 1]]), opacity: P([[0, 0.5], [1, 1]]) } }),
    B({
      id: 'b:chalk',
      name: 'Chalk',
      size: 36,
      spacing: 0.12,
      tip: auto(0.7),
      scatter: { amount: 0.25, x: true, y: true },
      dyn: { size: P(SENS), opacity: P([[0, 0.3], [1, 1]]) },
      texture: { get canvas() { return paperTex() }, scale: 1.2, strength: 1, brightness: 0, contrast: 1.8, invert: false },
    }),
    B({
      id: 'b:charcoal',
      name: 'Charcoal',
      size: 50,
      spacing: 0.1,
      tip: auto(0.5),
      angle: 0,
      dyn: { size: P(SENS), opacity: P([[0, 0.2], [1, 0.9]]), rotation: { sensors: [{ id: 'fuzzy', curve: LIN }], useCurve: true, value: 1 } },
      texture: { get canvas() { return paperTex() }, scale: 1.6, strength: 1, brightness: -0.05, contrast: 2.2, invert: false },
    }),
    B({ id: 'b:spray', name: 'Spray', size: 70, spacing: 0.25, density: 0.8, tip: auto(1, { diameter: 3 }), scatter: { amount: 1.6, x: true, y: true }, flow: 0.7, dyn: { size: { sensors: [{ id: 'fuzzy', curve: [[0, 0.25], [1, 0.9]] }], useCurve: true, value: 1 } } }),
    B({ id: 'b:calligraphy', name: 'Calligraphy', size: 18, spacing: 0.04, angle: -45, tip: auto(1, { ratio: 0.22 }), dyn: {} }),
    B({ id: 'b:eraser', name: 'Eraser', size: 40, spacing: 0.06, tip: auto(0.9), comp: 'erase', dyn: { size: P(SENS) } }),
    B({ id: 'b:eraser-soft', name: 'Soft eraser', size: 70, spacing: 0.08, tip: auto(0.2), comp: 'erase', dyn: { opacity: P(SOFT) } }),
  ]
}

export const defaultBrush = () => builtinBrushes()[0]
export const byId = (id) => builtinBrushes().find((b) => b.id === id) || null

// a small picture of what the brush draws (an S curve), for the brush list
export function brushPreview(brush, StrokeClass, w = 120, h = 38) {
  const cv = newCanvas(w, h)
  const buf = newCanvas(w, h)
  const size = Math.max(2, Math.min(h * 0.42, brush.size || 20))
  const st = new StrokeClass({ brush, size, opacity: 1, flow: 1, colour: '#e0def4', smoothing: 0, w, h, buffer: buf })
  const n = 40
  const pts = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    pts.push({ x: 8 + t * (w - 16), y: h / 2 + Math.sin(t * Math.PI * 2) * h * 0.22, pressure: Math.sin(t * Math.PI) * 0.85 + 0.12, tiltX: 0, tiltY: 0, t: i * 12 })
  }
  st.begin(pts[0])
  for (let i = 1; i < pts.length; i++) st.move(pts[i])
  cv.getContext('2d').drawImage(buf, 0, 0)
  return cv
}
