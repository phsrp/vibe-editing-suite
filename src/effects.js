// Per-clip effects: blur, sharpen, vignette, glow, chroma key (green screen) and colour correction.
// A clip stores fx = { blur, sharpen, vignette, glow, key: {on, color, sim, smooth, spill}, cc: {...} }, each value
// as the slider shows it (see the arrays below). The picture is changed inside the shader (glRenderer.js).

import { lutNow } from './luts.js'

// the sliders: id, label, unit, default, min, max, step
export const FX_SLIDERS = [
  { id: 'blur', label: 'Blur', def: 0, min: 0, max: 100, step: 1 },
  { id: 'sharpen', label: 'Sharpen', def: 0, min: 0, max: 100, step: 1 },
  { id: 'vignette', label: 'Vignette (dark edges)', def: 0, min: 0, max: 100, step: 1 },
  { id: 'glow', label: 'Glow', def: 0, min: 0, max: 100, step: 1 },
]
export const CC_SLIDERS = [
  { id: 'exposure', label: 'Exposure', def: 0, min: -100, max: 100, step: 1 },
  { id: 'brightness', label: 'Brightness', def: 0, min: -100, max: 100, step: 1 },
  { id: 'contrast', label: 'Contrast', def: 100, min: 0, max: 200, step: 1 },
  { id: 'saturation', label: 'Saturation', def: 100, min: 0, max: 200, step: 1 },
  { id: 'temperature', label: 'Temperature (cool / warm)', def: 0, min: -100, max: 100, step: 1 },
  { id: 'tint', label: 'Tint (green / magenta)', def: 0, min: -100, max: 100, step: 1 },
  { id: 'highlights', label: 'Highlights', def: 0, min: -100, max: 100, step: 1 },
  { id: 'shadows', label: 'Shadows', def: 0, min: -100, max: 100, step: 1 },
]
export const KEY_DEFAULTS = { on: false, color: '#00ff00', sim: 35, smooth: 10, spill: 50 }
export const CC_DEFAULTS = Object.fromEntries(CC_SLIDERS.map((s) => [s.id, s.def]))

const num = (v, d) => (typeof v === 'number' && !Number.isNaN(v) ? v : d)

export const hasCc = (cc) => !!cc && CC_SLIDERS.some((s) => num(cc[s.id], s.def) !== s.def)
export function hasFx(clip) {
  const fx = clip && clip.fx
  if (!fx) return false
  if (FX_SLIDERS.some((s) => num(fx[s.id], 0) !== 0)) return true
  if (fx.key && fx.key.on) return true
  if (fx.lut && fx.lut.file && (fx.lut.mix ?? 100) > 0) return true
  return hasCc(fx.cc)
}

const hex = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h || '')
  const n = m ? parseInt(m[1], 16) : 0x00ff00
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

// fx -> the numbers the shader wants (all neutral when there is no effect)
export function fxUniforms(fx) {
  const f = fx || {}
  const cc = f.cc || {}
  const key = f.key || {}
  return {
    f: [num(f.blur, 0) / 100, num(f.sharpen, 0) / 100, num(f.vignette, 0) / 100, num(f.glow, 0) / 100],
    c1: [num(cc.brightness, 0) / 100, num(cc.contrast, 100) / 100, num(cc.saturation, 100) / 100, num(cc.temperature, 0) / 100],
    c2: [num(cc.tint, 0) / 100, num(cc.exposure, 0) / 100, num(cc.highlights, 0) / 100, num(cc.shadows, 0) / 100],
    k: [num(key.sim, 35) / 100, num(key.smooth, 10) / 100, num(key.spill, 50) / 100, key.on ? 1 : 0],
    kc: hex(key.color),
    lu: lutUniform(f.lut),
  }
}
// the LUT: [table size, strength 0..1], or none while it is not loaded
function lutUniform(lut) {
  if (!lut || !lut.file) return [2, 0]
  const mix = num(lut.mix, 100) / 100
  const t = mix > 0 ? lutNow(lut.file) : null
  return t ? [t.n, mix] : [2, 0]
}
// ready-made looks for the Colour tab (they only set the sliders; you can adjust them afterwards)
export const CC_PRESETS = [
  { name: 'Original', cc: {} },
  { name: 'Warm', cc: { temperature: 35, saturation: 110 } },
  { name: 'Cool', cc: { temperature: -35, tint: 5 } },
  { name: 'Black and white', cc: { saturation: 0, contrast: 115 } },
  { name: 'Vivid', cc: { saturation: 150, contrast: 115 } },
  { name: 'Faded', cc: { contrast: 82, brightness: 8, saturation: 80 } },
  { name: 'Moody', cc: { exposure: -15, contrast: 125, saturation: 90, shadows: -25, temperature: -10 } },
  { name: 'Bright', cc: { exposure: 18, brightness: 4, highlights: 10, shadows: 15 } },
]