// Smart select and mask tracking with SAM 2 (Meta's open Segment Anything 2 model, see sam2.js). Draw a loop around a
// subject and the AI finds its outline; tracking follows that outline through the video. It needs a graphics card:
// the model files are downloaded once from Hugging Face (see electron/main.js, 'models:*').
import { toUrl } from './state.js'
import { MAX_POLY } from './masks.js'

// What graphics card does this computer have? ok = a real one is usable (WebGPU); weak = probably too slow for comfort
// (basic integrated graphics or a software stand-in); name = what the computer reports.
let gpuP = null
export function gpuInfo() {
  if (typeof window !== 'undefined' && window.__fakeGpu) return Promise.resolve(window.__fakeGpu) // developer self-test
  if (!gpuP) {
    gpuP = (async () => {
      try {
        if (typeof navigator === 'undefined' || !navigator.gpu) return { ok: false, weak: false, name: '' }
        const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
        if (!a) return { ok: false, weak: false, name: '' }
        const i = a.info || {}
        const name = [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' ')
        const fallback = !!a.isFallbackAdapter
        return { ok: !fallback, weak: fallback || /UHD|HD Graphics|SwiftShader|Basic Render|llvmpipe|Microsoft/i.test(name), name }
      } catch (e) {
        return { ok: false, weak: false, name: '' }
      }
    })()
  }
  return gpuP
}
export const hasGpu = async () => (await gpuInfo()).ok


// polygon helpers (points are [x, y] in 0..1 picture coordinates)
const inside = (p, poly) => {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c
  }
  return c
}

// The outer outline of the biggest blob of a black / white grid, followed with the "Moore" method.
function outline(grid, gw, gh) {
  // biggest connected blob
  const label = new Int32Array(gw * gh)
  let best = 0
  let bestSize = 0
  let next = 1
  const stack = []
  for (let s = 0; s < gw * gh; s++) {
    if (!grid[s] || label[s]) continue
    let size = 0
    stack.push(s)
    label[s] = next
    while (stack.length) {
      const i = stack.pop()
      size++
      const x = i % gw
      const y = (i / gw) | 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue
        const j = ny * gw + nx
        if (grid[j] && !label[j]) {
          label[j] = next
          stack.push(j)
        }
      }
    }
    if (size > bestSize) {
      bestSize = size
      best = next
    }
    next++
  }
  if (!best) return []
  const on = (x, y) => x >= 0 && y >= 0 && x < gw && y < gh && label[y * gw + x] === best
  // start: first blob pixel in reading order
  let sx = -1
  let sy = -1
  for (let i = 0; i < gw * gh && sx < 0; i++) if (label[i] === best) {
    sx = i % gw
    sy = (i / gw) | 0
  }
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
  const pts = [[sx, sy]]
  let cx = sx
  let cy = sy
  let d = 6 // we came from above
  for (let guard = 0; guard < gw * gh * 4; guard++) {
    let found = false
    for (let k = 0; k < 8; k++) {
      const nd = (d + 6 + k) % 8 // start looking just after the way we came
      const nx = cx + dirs[nd][0]
      const ny = cy + dirs[nd][1]
      if (on(nx, ny)) {
        cx = nx
        cy = ny
        d = nd
        found = true
        break
      }
    }
    if (!found) break
    if (cx === sx && cy === sy && pts.length > 2) break
    pts.push([cx, cy])
  }
  return pts
}

function simplify(pts, tol) {
  if (pts.length < 4) return pts
  const keep = new Array(pts.length).fill(false)
  keep[0] = keep[pts.length - 1] = true
  const stack = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    let max = 0
    let idx = -1
    for (let i = a + 1; i < b; i++) {
      const [x1, y1] = pts[a]
      const [x2, y2] = pts[b]
      const dx = x2 - x1
      const dy = y2 - y1
      const len = Math.hypot(dx, dy) || 1e-9
      const dd = Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / len
      if (dd > max) {
        max = dd
        idx = i
      }
    }
    if (max > tol && idx > 0) {
      keep[idx] = true
      stack.push([a, idx], [idx, b])
    }
  }
  return pts.filter((_, i) => keep[i])
}


// the 4 corners that best describe an outline (for plates, screens, signs): the convex hull with its least important
// corners removed until 4 are left
export function fitQuad(pts) {
  const P = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (list) => {
    const h = []
    for (const p of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop()
      h.push(p)
    }
    h.pop()
    return h
  }
  let hull = [...half(P), ...half([...P].reverse())]
  while (hull.length > 4) {
    let best = 0
    let bestA = Infinity
    for (let i = 0; i < hull.length; i++) {
      const a = hull[(i + hull.length - 1) % hull.length]
      const b = hull[i]
      const c = hull[(i + 1) % hull.length]
      const area = Math.abs(cross(a, b, c)) / 2
      if (area < bestA) {
        bestA = area
        best = i
      }
    }
    hull = hull.filter((_, i) => i !== best)
  }
  return hull.length >= 3 ? hull : pts
}

// ---- SAM 2: smart select and outline tracking ----
let sam2P = null
function getSam2(paths) {
  if (!sam2P) {
    sam2P = import('./sam2.js').then((m) => m.loadSam2(paths).then((sam) => ({ sam, m }))).catch((e) => {
      sam2P = null
      throw e
    })
  }
  return sam2P
}

// the object's outline from the model's 256 x 256 logits: smoothed up to 512 x 512, traced, then fewer points
export function maskToPolygon(logits, size = 256) {
  const n = size * 2
  const g = new Uint8Array(n * n)
  for (let y = 0; y < n; y++) {
    const fy = Math.max(0, Math.min(size - 1.001, (y + 0.5) / 2 - 0.5))
    const y0 = Math.floor(fy)
    const ay = fy - y0
    for (let x = 0; x < n; x++) {
      const fx = Math.max(0, Math.min(size - 1.001, (x + 0.5) / 2 - 0.5))
      const x0 = Math.floor(fx)
      const ax = fx - x0
      const v = logits[y0 * size + x0] * (1 - ax) * (1 - ay) + logits[y0 * size + x0 + 1] * ax * (1 - ay) + logits[(y0 + 1) * size + x0] * (1 - ax) * ay + logits[(y0 + 1) * size + x0 + 1] * ax * ay
      g[y * n + x] = v > 0 ? 1 : 0
    }
  }
  const trace = outline(g, n, n)
  if (trace.length < 6) return []
  const norm = trace.map(([x, y]) => [(x + 0.5) / n, (y + 0.5) / n])
  let tol = 0.0007
  let simp = simplify(norm, tol)
  while (simp.length > MAX_POLY && tol < 0.1) {
    tol *= 1.25
    simp = simplify(norm, tol)
  }
  return simp.slice(0, MAX_POLY)
}

// box + a few inside points from a loop (0..1), as the model's prompt
export function promptFromLoop(lasso) {
  const xs = lasso.map((p) => p[0])
  const ys = lasso.map((p) => p[1])
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const y0 = Math.min(...ys)
  const y1 = Math.max(...ys)
  const pos = []
  for (const [a, b] of [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7]]) {
    const p = [x0 + (x1 - x0) * a, y0 + (y1 - y0) * b]
    if (inside(p, lasso)) pos.push(p)
  }
  if (!pos.length) pos.push([(x0 + x1) / 2, (y0 + y1) / 2])
  return [{ x: x0, y: y0, label: 2 }, { x: x1, y: y1, label: 3 }, ...pos.slice(0, 4).map((p) => ({ x: p[0], y: p[1], label: 1 }))]
}

// Smart select with SAM 2: the outline of the subject inside a loop (0..1 picture coordinates), or null.
export async function findSubject({ el, w, h, lasso, paths }) {
  const { sam } = await getSam2(paths)
  const mask = await sam.seed(el, w, h, promptFromLoop(lasso))
  const poly = maskToPolygon(mask.logits)
  return poly.length >= 3 ? poly : null
}

// The same with any prompt ([{x, y, label}] in 0..1: label 1 = on the subject, 0 = not, 2 / 3 = corners of a box): a click
// on the subject, a box around it, or both.
export async function findSubjectPrompt({ el, w, h, prompt, paths }) {
  const { sam } = await getSam2(paths)
  const mask = await sam.seed(el, w, h, prompt)
  const poly = maskToPolygon(mask.logits)
  return poly.length >= 3 ? poly : null
}

// Follows a subject's outline through a video with SAM 2. startPts = its outline at second times[0]; times = the
// seconds to look at in order. Returns [{t, pts}] ([] = the subject is not in the picture), or null if cancelled.
let tracking = 0
export const isTracking = () => tracking > 0
export async function trackOutline(o) {
  tracking++
  try {
    return await follow(o)
  } finally {
    tracking--
  }
}
async function follow({ file, startPts, times, paths, quad, onProgress, isCancelled }) {
  const { sam, m } = await getSam2(paths)
  const v = document.createElement('video')
  v.muted = true
  v.preload = 'auto'
  v.src = toUrl(file)
  await new Promise((res, rej) => {
    v.onloadeddata = res
    v.onerror = () => rej(new Error('The video could not be opened'))
  })
  const w = v.videoWidth
  const h = v.videoHeight
  const seek = (t) =>
    new Promise((res) => {
      const done = () => {
        v.removeEventListener('seeked', done)
        res()
      }
      v.addEventListener('seeked', done)
      v.currentTime = t
      setTimeout(done, 4000)
    })
  const finish = (pts) => (quad && pts.length >= 4 ? fitQuad(pts) : pts)
  const out = [{ t: times[0], pts: finish(startPts) }]
  try {
    await seek(times[0])
    // the first picture is remembered as exactly the outline the user has
    await sam.seed(v, w, h, promptFromLoop(startPts), m.polygonLogits(startPts))
    for (let i = 1; i < times.length; i++) {
      if (isCancelled && isCancelled()) return null
      onProgress && onProgress(i, times.length)
      await seek(times[i])
      const mask = await sam.track(v, w, h, i, times.length)
      const poly = mask.score > 0 ? maskToPolygon(mask.logits) : []
      out.push({ t: times[i], pts: finish(poly) })
    }
  } finally {
    sam.reset()
    v.removeAttribute('src')
    v.load()
  }
  onProgress && onProgress(times.length, times.length)
  return out
}

