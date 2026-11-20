// LUTs: colour "looks" from .cube files (the format Premiere, Resolve and most LUT packs use), plus a few built in.
// A clip stores fx.lut = {file, mix}: file = the name of a .cube in the LUT folder (userData/luts) or 'builtin:<id>',
// mix = 0..100 (how strong). The table is used by the shader (glRenderer.js), as a 2D texture of N slices side by side.

const SIZE_BUILTIN = 33

// ---- built-in looks, made here from simple colour maths (no files) ----
const clamp01 = (v) => Math.max(0, Math.min(1, v))
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b
const sCurve = (v, k) => clamp01(0.5 + (v - 0.5) * k - 0.5 * (k - 1) * (v - 0.5) * Math.abs(v - 0.5) * 2)
const BUILTIN = {
  'teal-orange': {
    name: 'Teal and orange',
    fn: (r, g, b) => {
      const l = luma(r, g, b)
      // shadows lean teal, skin tones and highlights lean orange
      const w = l
      let R = r + (w - 0.5) * 0.16
      let G = g + (0.5 - Math.abs(w - 0.5)) * 0.02
      let B = b - (w - 0.5) * 0.2
      R = sCurve(R, 1.12)
      G = sCurve(G, 1.12)
      B = sCurve(B, 1.12)
      return [R, G, B]
    },
  },
  'warm-film': {
    name: 'Warm film',
    fn: (r, g, b) => {
      const lift = 0.05
      const f = (v) => clamp01(lift + v * (0.93 - lift))
      return [sCurve(f(r * 1.05), 1.08), sCurve(f(g * 1.0), 1.06), sCurve(f(b * 0.88), 1.04)]
    },
  },
  'cool-night': {
    name: 'Cool night',
    fn: (r, g, b) => {
      const l = luma(r, g, b)
      const m = (v, t) => clamp01(v * 0.75 + t * 0.25)
      return [m(r * 0.85, l * 0.8), m(g * 0.95, l * 0.95), m(b * 1.15, l * 1.15)].map((v) => sCurve(v * 0.92, 1.1))
    },
  },
  'bleach': {
    name: 'Bleach bypass',
    fn: (r, g, b) => {
      const l = luma(r, g, b)
      const mix = (v) => sCurve(v * 0.55 + l * 0.45, 1.35)
      return [mix(r), mix(g), mix(b)]
    },
  },
  'mono-contrast': {
    name: 'Black and white, punchy',
    fn: (r, g, b) => {
      const l = sCurve(luma(r, g, b), 1.3)
      return [l, l, l]
    },
  },
  'faded': {
    name: 'Faded',
    fn: (r, g, b) => {
      const f = (v) => clamp01(0.08 + v * 0.84)
      const l = luma(r, g, b)
      return [f(r * 0.9 + l * 0.1), f(g * 0.9 + l * 0.1), f(b * 0.9 + l * 0.1 + 0.02)]
    },
  },
}
export const BUILTIN_LUTS = Object.entries(BUILTIN).map(([id, v]) => ({ file: 'builtin:' + id, name: v.name, builtin: true }))

function build3d(n, fn) {
  const data = new Float32Array(n * n * n * 3)
  let i = 0
  for (let bi = 0; bi < n; bi++)
    for (let gi = 0; gi < n; gi++)
      for (let ri = 0; ri < n; ri++) {
        const c = fn(ri / (n - 1), gi / (n - 1), bi / (n - 1))
        data[i++] = clamp01(c[0])
        data[i++] = clamp01(c[1])
        data[i++] = clamp01(c[2])
      }
  return { n, data }
}

// ---- .cube files ----
// 3D: "LUT_3D_SIZE N" then N^3 lines "r g b" with red changing fastest. 1D: "LUT_1D_SIZE N" then N lines (a curve per
// channel), turned into a 3D table here. DOMAIN_MIN / DOMAIN_MAX (the input range) are honoured.
export function parseCube(text) {
  let n3 = 0
  let n1 = 0
  let dmin = [0, 0, 0]
  let dmax = [1, 1, 1]
  const vals = []
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line[0] === '#') continue
    const parts = line.split(/\s+/)
    const kw = parts[0].toUpperCase()
    if (kw === 'LUT_3D_SIZE') n3 = parseInt(parts[1], 10)
    else if (kw === 'LUT_1D_SIZE') n1 = parseInt(parts[1], 10)
    else if (kw === 'DOMAIN_MIN') dmin = parts.slice(1, 4).map(Number)
    else if (kw === 'DOMAIN_MAX') dmax = parts.slice(1, 4).map(Number)
    else if (/^[-+.\deE]/.test(parts[0]) && parts.length >= 3) vals.push(+parts[0], +parts[1], +parts[2])
  }
  const span = [0, 1, 2].map((k) => dmax[k] - dmin[k] || 1)
  const norm = (v, k) => clamp01((v - dmin[k]) / span[k])
  if (n3 >= 2) {
    if (n3 > 129) throw new Error(`This LUT is too big (${n3} points per side; up to 129 work).`)
    if (vals.length < n3 * n3 * n3 * 3) throw new Error(`This .cube file is cut short: it says ${n3}³ colours but has ${Math.floor(vals.length / 3)}.`)
    const data = new Float32Array(n3 * n3 * n3 * 3)
    for (let i = 0; i < data.length; i++) data[i] = clamp01(vals[i])
    // a different input range: resample to 0..1 by looking the table up at the scaled points
    if (dmin.some((v) => v !== 0) || dmax.some((v) => v !== 1)) {
      const t = { n: n3, data }
      return build3d(n3, (r, g, b) => lookup(t, [norm(r, 0), norm(g, 1), norm(b, 2)]))
    }
    return { n: n3, data }
  }
  if (n1 >= 2) {
    if (vals.length < n1 * 3) throw new Error('This .cube file is cut short.')
    const curve = (v, k) => {
      const p = norm(v, k) * (n1 - 1)
      const i = Math.min(n1 - 2, Math.floor(p))
      const f = p - i
      return vals[i * 3 + k] * (1 - f) + vals[(i + 1) * 3 + k] * f
    }
    return build3d(SIZE_BUILTIN, (r, g, b) => [curve(r, 0), curve(g, 1), curve(b, 2)])
  }
  throw new Error('This is not a .cube LUT (no LUT_3D_SIZE or LUT_1D_SIZE line).')
}

// trilinear look-up in a parsed table (used for resampling and by the self-test)
export function lookup(t, [r, g, b]) {
  const n = t.n
  const f = (v) => {
    const p = clamp01(v) * (n - 1)
    const i = Math.min(n - 2, Math.floor(p))
    return [i, p - i]
  }
  const [ri, rf] = f(r)
  const [gi, gf] = f(g)
  const [bi, bf] = f(b)
  const at = (R, G, B, k) => t.data[((B * n + G) * n + R) * 3 + k]
  const out = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    const c00 = at(ri, gi, bi, k) * (1 - rf) + at(ri + 1, gi, bi, k) * rf
    const c10 = at(ri, gi + 1, bi, k) * (1 - rf) + at(ri + 1, gi + 1, bi, k) * rf
    const c01 = at(ri, gi, bi + 1, k) * (1 - rf) + at(ri + 1, gi, bi + 1, k) * rf
    const c11 = at(ri, gi + 1, bi + 1, k) * (1 - rf) + at(ri + 1, gi + 1, bi + 1, k) * rf
    out[k] = (c00 * (1 - gf) + c10 * gf) * (1 - bf) + (c01 * (1 - gf) + c11 * gf) * bf
  }
  return out
}

// ---- loaded tables, by file name ----
const cache = new Map() // file -> {n, data, ver} | {error} | 'loading'
let ver = 0
const listeners = new Set()
export const onLutLoaded = (fn) => (listeners.add(fn), () => listeners.delete(fn))

export async function loadLut(file) {
  const c = cache.get(file)
  if (c && c !== 'loading') return c
  if (file.startsWith('builtin:')) {
    const b = BUILTIN[file.slice(8)]
    const t = b ? { ...build3d(SIZE_BUILTIN, b.fn), ver: ++ver } : { error: 'There is no built-in look called ' + file.slice(8) }
    cache.set(file, t)
    return t
  }
  cache.set(file, 'loading')
  let t
  try {
    const text = await window.api.readLut(file)
    t = { ...parseCube(text), ver: ++ver }
  } catch (e) {
    t = { error: String((e && e.message) || e) }
  }
  cache.set(file, t)
  for (const fn of listeners) fn(file)
  return t
}
// the table if it is ready (it starts loading otherwise, and a moment later the preview has it)
export function lutNow(file) {
  if (!file) return null
  const c = cache.get(file)
  if (c === undefined) {
    if (file.startsWith('builtin:')) return loadSyncBuiltin(file)
    loadLut(file)
    return null
  }
  return c === 'loading' || c.error ? null : c
}
function loadSyncBuiltin(file) {
  const b = BUILTIN[file.slice(8)]
  if (!b) return null
  const t = { ...build3d(SIZE_BUILTIN, b.fn), ver: ++ver }
  cache.set(file, t)
  return t
}
export const lutError = (file) => {
  const c = cache.get(file)
  return c && c !== 'loading' && c.error ? c.error : null
}
// a file was replaced (imported again under the same name): read it again next time
export const forgetLut = (file) => cache.delete(file)
// every LUT the clips of a project use, loaded (the export waits for this, so no frame is drawn without its look)
export async function ensureLuts(state) {
  const files = new Set()
  for (const c of [...(state.clips || []), ...(state.overlayClips || [])]) if (c.fx && c.fx.lut && c.fx.lut.file && (c.fx.lut.mix ?? 100) > 0) files.add(c.fx.lut.file)
  await Promise.all([...files].map(loadLut))
}
// the table as the bytes of an RGBA texture N*N wide and N high (slice b at x offset b*N)
export function lutPixels(t) {
  const n = t.n
  const px = new Uint8Array(n * n * n * 4)
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++) {
        const s = ((b * n + g) * n + r) * 3
        const d = (g * n * n + b * n + r) * 4
        px[d] = Math.round(t.data[s] * 255)
        px[d + 1] = Math.round(t.data[s + 1] * 255)
        px[d + 2] = Math.round(t.data[s + 2] * 255)
        px[d + 3] = 255
      }
  return px
}
if (typeof window !== 'undefined') window.__luts = { parseCube, lookup, lutNow, loadLut, BUILTIN_LUTS }
