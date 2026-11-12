// Quick mask tracking: follows the MOVEMENT of the picture inside a mask (no AI model, no graphics card needed).
//
// The mask moves the way its picture moves: the outline keeps its shape and only moves / turns / grows.
// (For something that changes shape, the AI tracking follows the real outline instead.)
//
// The method is the classic one, implemented here from the papers:
//  1. features: Shi-Tomasi "good features to track" (Shi & Tomasi, CVPR 1994): corner-like points inside the mask
//  2. tracking: pyramidal Lucas-Kanade (Bouguet 2000, after Lucas & Kanade 1981), each point tracked forward and then
//     backward; it is kept only when the way back ends where it started (forward-backward error, Kalal et al. 2010)
//  3. fit: RANSAC (Fischler & Bolles 1981) over the points, then a least-squares refit of the good ones:
//     Position (a shift), Position & Rotation (rigid), or Position, Scale & Rotation (similarity; Umeyama 1991)

import { setVideoSrc } from './state.js'

export const METHODS = [
  { id: 'position', label: 'Position', hint: 'It only moves' },
  { id: 'rotation', label: 'Position & rotation', hint: 'It moves and turns' },
  { id: 'similarity', label: 'Position, scale & rotation', hint: 'It moves, turns and gets bigger or smaller' },
]

const LEVELS = 4
const WIN = 7 // half-size of the Lucas-Kanade window (15 x 15)
const MAX_FEATURES = 160
const FB_MAX = 0.6 // pixels
const INLIER = 1.2 // pixels

// ---- images: float luma, pyramids
function grayOf(data, w, h) {
  const g = new Float32Array(w * h)
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2]) / 255
  return g
}
function halve(g, w, h) {
  const nw = Math.max(1, w >> 1)
  const nh = Math.max(1, h >> 1)
  const o = new Float32Array(nw * nh)
  const at = (x, y) => g[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      // a light blur (1 2 1) before throwing every second pixel away
      let s = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += at(2 * x + dx, 2 * y + dy) * (2 - Math.abs(dx)) * (2 - Math.abs(dy))
      o[y * nw + x] = s / 16
    }
  }
  return { g: o, w: nw, h: nh }
}
export function pyramid(g, w, h) {
  const levels = [{ g, w, h }]
  for (let l = 1; l < LEVELS; l++) {
    const p = levels[l - 1]
    if (p.w < 24 || p.h < 24) break
    levels.push(halve(p.g, p.w, p.h))
  }
  return levels
}
const sample = (im, x, y) => {
  const { g, w, h } = im
  x = Math.min(w - 1.001, Math.max(0, x))
  y = Math.min(h - 1.001, Math.max(0, y))
  const x0 = x | 0
  const y0 = y | 0
  const fx = x - x0
  const fy = y - y0
  const i = y0 * w + x0
  return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy
}

// ---- the mask as a picture: 1 inside the polygon (pts in pixels)
function insideMask(poly, w, h) {
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const c = cv.getContext('2d', { willReadFrequently: true })
  c.fillStyle = '#fff'
  c.beginPath()
  poly.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])))
  c.closePath()
  c.fill()
  const d = c.getImageData(0, 0, w, h).data
  const m = new Uint8Array(w * h)
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4] > 127 ? 1 : 0
  return m
}

// ---- 1. features inside the mask
export function goodFeatures(im, mask, max = MAX_FEATURES) {
  const { g, w, h } = im
  const R = 3 // structure tensor window radius (7 x 7)
  const ix = new Float32Array(w * h)
  const iy = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      ix[i] = (g[i + 1] - g[i - 1]) * 0.5
      iy[i] = (g[i + w] - g[i - w]) * 0.5
    }
  }
  // integral images of ix², iy², ix·iy give every window sum in constant time
  const W1 = w + 1
  const sxx = new Float64Array(W1 * (h + 1))
  const syy = new Float64Array(W1 * (h + 1))
  const sxy = new Float64Array(W1 * (h + 1))
  for (let y = 0; y < h; y++) {
    let rx = 0
    let ry = 0
    let rxy = 0
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      rx += ix[i] * ix[i]
      ry += iy[i] * iy[i]
      rxy += ix[i] * iy[i]
      const j = (y + 1) * W1 + x + 1
      sxx[j] = sxx[j - W1] + rx
      syy[j] = syy[j - W1] + ry
      sxy[j] = sxy[j - W1] + rxy
    }
  }
  const box = (s, x0, y0, x1, y1) => s[(y1 + 1) * W1 + x1 + 1] - s[y0 * W1 + x1 + 1] - s[(y1 + 1) * W1 + x0] + s[y0 * W1 + x0]
  const cand = []
  let best = 0
  for (let y = R + WIN; y < h - R - WIN; y += 1) {
    for (let x = R + WIN; x < w - R - WIN; x += 1) {
      if (!mask[y * w + x]) continue
      // the whole tracking window has to be inside the mask too (the picture beyond its edge moves differently)
      if (!mask[(y - 3) * w + x] || !mask[(y + 3) * w + x] || !mask[y * w + x - 3] || !mask[y * w + x + 3]) continue
      const a = box(sxx, x - R, y - R, x + R, y + R)
      const b = box(sxy, x - R, y - R, x + R, y + R)
      const c = box(syy, x - R, y - R, x + R, y + R)
      const lam = (a + c - Math.sqrt((a - c) * (a - c) + 4 * b * b)) / 2 // the smaller eigenvalue
      if (lam > best) best = lam
      cand.push([x, y, lam])
    }
  }
  if (!cand.length || best <= 0) return []
  const keep = cand.filter((c) => c[2] > best * 0.02).sort((p, q) => q[2] - p[2])
  // non-maximum suppression: points at least `gap` apart
  const gap = Math.max(5, Math.sqrt((w * h) / 6000))
  const cell = gap
  const grid = new Map()
  const out = []
  for (const c of keep) {
    const gx = Math.floor(c[0] / cell)
    const gy = Math.floor(c[1] / cell)
    let ok = true
    for (let dy = -1; dy <= 1 && ok; dy++) {
      for (let dx = -1; dx <= 1 && ok; dx++) {
        const list = grid.get((gy + dy) * 100000 + gx + dx)
        if (list) for (const q of list) if (Math.hypot(q[0] - c[0], q[1] - c[1]) < gap) ok = false
      }
    }
    if (!ok) continue
    const key = gy * 100000 + gx
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key).push(c)
    out.push([c[0], c[1]])
    if (out.length >= max) break
  }
  return out
}

// ---- 2. pyramidal Lucas-Kanade: where does the point p of picture A end up in picture B?
function lk(pa, pb, p) {
  const top = Math.min(pa.length, pb.length) - 1
  let gx = 0
  let gy = 0
  for (let L = top; L >= 0; L--) {
    const A = pa[L]
    const B = pb[L]
    const s = 1 / (1 << L)
    const px = p[0] * s
    const py = p[1] * s
    // gradients and the 2x2 matrix of picture A over the window
    const n = (2 * WIN + 1) * (2 * WIN + 1)
    const tpl = new Float32Array(n)
    const gxs = new Float32Array(n)
    const gys = new Float32Array(n)
    let a = 0
    let b = 0
    let c = 0
    let k = 0
    for (let y = -WIN; y <= WIN; y++) {
      for (let x = -WIN; x <= WIN; x++, k++) {
        const X = px + x
        const Y = py + y
        tpl[k] = sample(A, X, Y)
        const dx = (sample(A, X + 1, Y) - sample(A, X - 1, Y)) * 0.5
        const dy = (sample(A, X, Y + 1) - sample(A, X, Y - 1)) * 0.5
        gxs[k] = dx
        gys[k] = dy
        a += dx * dx
        b += dx * dy
        c += dy * dy
      }
    }
    const det = a * c - b * b
    if (det < 1e-6) {
      gx *= 2
      gy *= 2
      continue
    }
    let dx = 0
    let dy = 0
    for (let it = 0; it < 12; it++) {
      let ex = 0
      let ey = 0
      k = 0
      for (let y = -WIN; y <= WIN; y++) {
        for (let x = -WIN; x <= WIN; x++, k++) {
          const diff = tpl[k] - sample(B, px + x + gx + dx, py + y + gy + dy)
          ex += diff * gxs[k]
          ey += diff * gys[k]
        }
      }
      const ux = (c * ex - b * ey) / det
      const uy = (a * ey - b * ex) / det
      dx += ux
      dy += uy
      if (ux * ux + uy * uy < 0.0009) break
    }
    gx += dx
    gy += dy
    if (L > 0) {
      gx *= 2
      gy *= 2
    }
  }
  return [p[0] + gx, p[1] + gy]
}

// ---- 3. fit the motion: x' = a x - b y + tx, y' = b x + a y + ty
export const apply = (m, p) => [m.a * p[0] - m.b * p[1] + m.tx, m.b * p[0] + m.a * p[1] + m.ty]

function fit(method, src, dst) {
  const n = src.length
  let cx = 0
  let cy = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    cx += src[i][0]
    cy += src[i][1]
    dx += dst[i][0]
    dy += dst[i][1]
  }
  cx /= n
  cy /= n
  dx /= n
  dy /= n
  if (method === 'position') return { a: 1, b: 0, tx: dx - cx, ty: dy - cy }
  // similarity / rigid: the closed form (rotation and scale as one complex number a + bi)
  let num1 = 0
  let num2 = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - cx
    const sy = src[i][1] - cy
    const tx = dst[i][0] - dx
    const ty = dst[i][1] - dy
    num1 += sx * tx + sy * ty
    num2 += sx * ty - sy * tx
    den += sx * sx + sy * sy
  }
  if (den < 1e-9) return { a: 1, b: 0, tx: dx - cx, ty: dy - cy }
  let a = num1 / den
  let b = num2 / den
  if (method === 'rotation') {
    const l = Math.hypot(a, b) || 1
    a /= l
    b /= l
  }
  return { a, b, tx: dx - (a * cx - b * cy), ty: dy - (b * cx + a * cy) }
}

// a small fixed-seed random generator: the same input always gives the same track
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}
function ransac(method, src, dst) {
  const n = src.length
  const need = method === 'position' ? 1 : 2
  if (n < need + 1) return null
  const rnd = rng(12345)
  let best = null
  let bestCount = -1
  const iters = Math.min(300, n * n)
  for (let it = 0; it < iters; it++) {
    const i = Math.floor(rnd() * n)
    let j = Math.floor(rnd() * n)
    if (need === 2) {
      if (j === i) j = (j + 1) % n
      if (Math.hypot(src[i][0] - src[j][0], src[i][1] - src[j][1]) < 6) continue // two points too close together say little
    }
    const m = fit(method, need === 2 ? [src[i], src[j]] : [src[i]], need === 2 ? [dst[i], dst[j]] : [dst[i]])
    let count = 0
    for (let k = 0; k < n; k++) {
      const q = apply(m, src[k])
      if (Math.hypot(q[0] - dst[k][0], q[1] - dst[k][1]) < INLIER) count++
    }
    if (count > bestCount) {
      bestCount = count
      best = m
    }
  }
  if (!best) return null
  const inl = []
  for (let k = 0; k < n; k++) {
    const q = apply(best, src[k])
    if (Math.hypot(q[0] - dst[k][0], q[1] - dst[k][1]) < INLIER) inl.push(k)
  }
  if (inl.length < Math.max(3, need + 1)) return null
  const m = fit(method, inl.map((k) => src[k]), inl.map((k) => dst[k]))
  return { m, inliers: inl.length }
}

// one step: how did the picture inside `poly` (pixels) move from picture A to picture B?
export function trackStep(pa, pb, poly, method) {
  const A = pa[0]
  const mask = insideMask(poly, A.w, A.h)
  const feats = goodFeatures(A, mask)
  if (feats.length < 4) return null
  const src = []
  const dst = []
  for (const p of feats) {
    const q = lk(pa, pb, p)
    const back = lk(pb, pa, q)
    if (Math.hypot(back[0] - p[0], back[1] - p[1]) > FB_MAX) continue // not reliable: the way back does not return
    if (q[0] < 0 || q[1] < 0 || q[0] > A.w - 1 || q[1] > A.h - 1) continue
    src.push(p)
    dst.push(q)
  }
  return ransac(method, src, dst)
}

// ---- follow a mask through a video
// startPts = the outline at second times[0], as [[x, y], ...] in 0..1 of the picture. times = the seconds to look at, in order.
// Returns {frames: [{t, pts}], lost: null | 'text'}, or null when cancelled.
export async function trackPlanar({ file, startPts, times, method = 'position', onProgress, isCancelled }) {
  const v = document.createElement('video')
  v.muted = true
  v.preload = 'auto'
  setVideoSrc(v, file)
  await new Promise((res, rej) => {
    v.onloadeddata = res
    v.onerror = () => rej(new Error('The video could not be opened'))
  })
  const scale = Math.min(1, 960 / Math.max(1, v.videoWidth))
  const W = Math.max(16, Math.round(v.videoWidth * scale))
  const H = Math.max(16, Math.round(v.videoHeight * scale))
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  // Seek, then wait until the picture of that moment is really the one on show ("seeked" can come while the old
  // picture is still there): requestVideoFrameCallback reports which moment of the video was presented.
  const seek = (t) =>
    new Promise((res) => {
      let finished = false
      const done = () => {
        if (finished) return
        finished = true
        v.removeEventListener('seeked', onSeeked)
        res()
      }
      const wait = () => {
        if (!v.requestVideoFrameCallback) return setTimeout(done, 80)
        v.requestVideoFrameCallback((_now, meta) => {
          if (Math.abs((meta && meta.mediaTime != null ? meta.mediaTime : t) - t) < 0.06) done()
          else wait()
        })
      }
      const onSeeked = () => wait()
      v.addEventListener('seeked', onSeeked)
      if (Math.abs(v.currentTime - t) < 0.001) {
        // already there (the very first picture): nothing will be presented again
        setTimeout(done, 60)
      } else v.currentTime = t
      setTimeout(done, 2500) // never wait for ever
    })
  const grab = async (t) => {
    await seek(t)
    ctx.drawImage(v, 0, 0, W, H)
    return pyramid(grayOf(ctx.getImageData(0, 0, W, H).data, W, H), W, H)
  }
  const toPx = (pts) => pts.map((p) => [p[0] * W, p[1] * H])
  const toUnit = (pts) => pts.map((p) => [p[0] / W, p[1] / H])
  let poly = toPx(startPts)
  const frames = [{ t: times[0], pts: toUnit(poly) }]
  let lost = null
  const forward = times[times.length - 1] > times[0]
  const lostMsg = (t) => `lost the track after ${Math.abs(t - times[0]).toFixed(1)} s: not enough detail inside the mask`
  try {
    let prev = await grab(times[0])
    if (forward && v.requestVideoFrameCallback && times.length > 6) {
      // forwards in time: let the video play and take the pictures as they come (much faster than seeking to each one)
      const queue = [] // {t, g} waiting to be tracked
      let want = 1 // index in times of the next moment we want
      let finished = false
      const pump = () => {
        if (finished) return
        v.requestVideoFrameCallback((_now, meta) => {
          const m = meta && meta.mediaTime != null ? meta.mediaTime : v.currentTime
          if (want < times.length && m >= times[want] - 0.004) {
            ctx.drawImage(v, 0, 0, W, H)
            queue.push({ t: m, img: ctx.getImageData(0, 0, W, H).data })
            while (want < times.length && times[want] <= m + 0.004) want++
          }
          if (want >= times.length || m >= times[times.length - 1]) finished = true
          // do not run far ahead of the tracking
          if (queue.length >= 8) v.pause()
          pump()
        })
      }
      v.playbackRate = 2
      pump()
      await v.play()
      let doneCount = 0
      while (true) {
        if (isCancelled && isCancelled()) {
          v.pause()
          return null
        }
        if (!queue.length) {
          if (finished || v.ended) break
          if (v.paused && !finished) v.play().catch(() => {})
          await new Promise((r) => setTimeout(r, 8))
          continue
        }
        const it = queue.shift()
        if (v.paused && queue.length < 4 && !finished) v.play().catch(() => {})
        const next = pyramid(grayOf(it.img, W, H), W, H)
        const st = trackStep(prev, next, poly, method)
        if (!st) {
          lost = lostMsg(frames[frames.length - 1].t)
          break
        }
        poly = poly.map((p) => apply(st.m, p))
        frames.push({ t: it.t, pts: toUnit(poly) })
        prev = next
        doneCount++
        onProgress && onProgress(Math.min(times.length - 1, want - 1), times.length)
      }
      v.pause()
    } else {
      for (let i = 1; i < times.length; i++) {
        if (isCancelled && isCancelled()) return null
        onProgress && onProgress(i, times.length)
        const next = await grab(times[i])
        const st = trackStep(prev, next, poly, method)
        if (!st) {
          lost = lostMsg(times[i - 1])
          break
        }
        poly = poly.map((p) => apply(st.m, p))
        frames.push({ t: times[i], pts: toUnit(poly) })
        prev = next
      }
    }
  } finally {
    v.pause()
    v.removeAttribute('src')
    v.load()
  }
  onProgress && onProgress(times.length, times.length)
  return { frames, lost }
}
