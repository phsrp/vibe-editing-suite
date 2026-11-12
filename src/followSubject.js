// "Zoom in and follow that person" for the AI connection. SAM 2 follows the subject through the clip, and the path it took
// becomes normal Position X, Position Y and Scale keyframes, like a camera operator keeping them in frame.
import { aspectRatio, setVideoSrc } from './state.js'
import { evalProp, evalTransform, frameToRect } from './motion.js'
import { startJob } from './mcpJobs.js'

const LOOKS = 15 // looks a second: a camera move needs fewer than a mask outline
const MAX_LOOKS = 900
const SMOOTH = 0.35 // seconds: a steady camera, not one that copies every wobble
const TOLERANCE = 0.25 // % of the frame the keyframes may be off the smooth path, which keeps them few enough to edit
const RAMP = 0.6 // seconds to ease in and out when only a part of the clip is followed
const EDGE_EPS = 0.05

// the middle of an outline by area, so a part with many points does not count for more
export function centreOf(pts) {
  let area = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % pts.length]
    const c = x0 * y1 - x1 * y0
    area += c
    cx += (x0 + x1) * c
    cy += (y0 + y1) * c
  }
  if (Math.abs(area) < 1e-9) return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length]
  return [cx / (3 * area), cy / (3 * area)]
}

// moments without the subject are bridged: straight across a gap, holding still at the ends
function bridge(values) {
  const out = values.slice()
  const seen = out.flatMap((v, i) => (v == null ? [] : [i]))
  for (let i = 0; i < out.length; i++) {
    if (out[i] != null) continue
    const b = seen.find((n) => n > i)
    const a = seen[seen.indexOf(b) - 1]
    if (b == null) out[i] = out[seen[seen.length - 1]]
    else if (a == null) out[i] = out[b]
    else out[i] = out[a] + ((out[b] - out[a]) * (i - a)) / (b - a)
  }
  return out
}
const median = (v, r = 2) =>
  v.map((_, i) => {
    const near = v.slice(Math.max(0, i - r), i + r + 1).sort((a, b) => a - b)
    return near[near.length >> 1]
  })
function blur(v, sigma) {
  if (sigma < 0.01) return v
  const r = Math.ceil(sigma * 3)
  const last = v.length - 1
  // past the ends the path carries on in the same direction, or the camera would lag a moving subject there
  const at = (i) => (i < 0 ? 2 * v[0] - v[Math.min(last, -i)] : i > last ? 2 * v[last] - v[Math.max(0, 2 * last - i)] : v[i])
  return v.map((_, i) => {
    let sum = 0
    let weight = 0
    for (let j = -r; j <= r; j++) {
      const w = Math.exp(-(j * j) / (2 * sigma * sigma))
      sum += at(i + j) * w
      weight += w
    }
    return sum / weight
  })
}
const steady = (values, sigma) => blur(median(bridge(values)), sigma)

// fewer keyframes: a point stays only if leaving it out would move the camera by more than the tolerance
export function thin(list, tol = TOLERANCE) {
  if (list.length < 3) return list
  const keep = new Set([0, list.length - 1])
  const stack = [[0, list.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    let far = -1
    let most = tol
    for (let i = a + 1; i < b; i++) {
      const u = (list[i].t - list[a].t) / (list[b].t - list[a].t)
      const off = Math.max(Math.abs(list[a].x + (list[b].x - list[a].x) * u - list[i].x), Math.abs(list[a].y + (list[b].y - list[a].y) * u - list[i].y))
      if (off > most) {
        most = off
        far = i
      }
    }
    if (far >= 0) {
      keep.add(far)
      stack.push([a, far], [far, b])
    }
  }
  return list.filter((_, i) => keep.has(i))
}

// samples = [{t (source seconds), c: [x, y] in the picture (0..1, y down) or null}], in time order.
// The picture covers exp[n] of the frame: to stay free of black edges it can only slide by the part that sticks out.
export function cameraPath(samples, { rate, scale, letterbox, stretch }) {
  const seen = samples.filter((p) => p.c).length
  if (!seen) return null
  const sigma = SMOOTH * rate
  const us = steady(samples.map((p) => (p.c ? p.c[0] : null)), sigma)
  const vs = steady(samples.map((p) => (p.c ? p.c[1] : null)), sigma)
  const sc = scale / 100
  const exp = [(sc * stretch[0]) / letterbox[0], (sc * stretch[1]) / letterbox[1]]
  const room = exp.map((e) => (Math.max(0, e - 1) / 2) * 100)
  const limit = (v, r) => Math.max(-r, Math.min(r, v))
  let held = 0
  const path = samples.map((p, i) => {
    const wantX = -(us[i] - 0.5) * exp[0] * 100
    const wantY = -(vs[i] - 0.5) * exp[1] * 100
    const x = limit(wantX, room[0])
    const y = limit(wantY, room[1])
    if (Math.abs(x - wantX) > 0.5 || Math.abs(y - wantY) > 0.5) held++
    return { t: p.t, x, y }
  })
  return { path, seen: seen / samples.length, held: held / samples.length }
}

// the keyframes for one value: the path, plus an ease from and back to what was there when the clip goes on either side
function withEases(clip, prop, keys, from, to) {
  const list = keys.map((k) => ({ ...k, ease: 'linear' }))
  if (to < clip.out - EDGE_EPS) {
    const end = Math.min(clip.out, to + RAMP)
    list[list.length - 1].ease = 'easeInOut'
    list.push({ t: end, v: evalProp(clip, prop, end), ease: 'linear' })
  }
  if (from > clip.in + EDGE_EPS) {
    const start = Math.max(clip.in, from - RAMP)
    list.unshift({ t: start, v: evalProp(clip, prop, start), ease: 'easeInOut' })
  }
  return list
}

// box = {left, top, right, bottom} in % of the frame -> a prompt for the model, in picture coordinates (y down)
export function boxPrompt(box, clip, ts, state, media) {
  const ratio = aspectRatio(state)
  const ma = media.width / media.height
  const s = [Math.max(1, ratio / ma), Math.max(1, ma / ratio)]
  const tf = evalTransform(clip, ts)
  const pic = (x, y) => {
    const q = frameToRect([x / 100, 1 - y / 100], s, tf, ratio)
    return [Math.max(0, Math.min(1, q[0])), Math.max(0, Math.min(1, 1 - q[1]))]
  }
  const a = pic(box.left, box.top)
  const b = pic(box.right, box.bottom)
  const x0 = Math.min(a[0], b[0])
  const x1 = Math.max(a[0], b[0])
  const y0 = Math.min(a[1], b[1])
  const y1 = Math.max(a[1], b[1])
  if (x1 - x0 < 0.005 || y1 - y0 < 0.005) return null
  return [{ x: x0, y: y0, label: 2 }, { x: x1, y: y1, label: 3 }, { x: (x0 + x1) / 2, y: (y0 + y1) / 2, label: 1 }]
}

export const openedVideo = (file, t) =>
  new Promise((res, rej) => {
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    v.onerror = () => rej(new Error('The video could not be opened.'))
    v.onloadeddata = () => {
      v.onseeked = () => res(v)
      v.currentTime = t
    }
    setVideoSrc(v, file)
  })

// the outline of what is in `prompt`, in the clip's own picture (0..1, y down), or null
export async function subjectOutline({ el, w, h, prompt, paths }) {
  const { findSubjectPrompt } = await import('./smartMask.js')
  return findSubjectPrompt({ el, w, h, prompt, paths })
}
async function outlineAt(file, ts, prompt, paths) {
  const v = await openedVideo(file, ts)
  try {
    return await subjectOutline({ el: v, w: v.videoWidth, h: v.videoHeight, prompt, paths })
  } finally {
    v.removeAttribute('src')
    v.load()
  }
}
export const videoOutline = outlineAt

// Keeps a subject in frame with Position and Scale keyframes. Runs in the background, as a job.
export function startFollow({ handle, clip, media, ts, from, to, prompt, scale, paths }) {
  const file = media.proxy || media.path
  const len = to - from
  const rate = Math.min(LOOKS, MAX_LOOKS / len)
  const count = (a, b) => Math.max(2, Math.round(Math.abs(b - a) * rate) + 1)
  const span = (a, b) => (Math.abs(b - a) < 0.03 ? [] : Array.from({ length: count(a, b) }, (_, i) => a + ((b - a) * i) / (count(a, b) - 1)))
  const after = span(ts, to)
  const before = span(ts, from)
  const total = after.length + before.length
  const seconds = Math.round(total * 0.25)
  startJob({ title: 'Following the subject', text: 'Finding the subject… (the first time takes a few seconds)', seconds }, async ({ progress, cancelled }) => {
    const { trackOutline } = await import('./smartMask.js')
    const startPts = await outlineAt(file, ts, prompt, paths)
    if (!startPts) throw new Error('Nothing was found inside that box. Make the box fit the subject better and try again.')
    const follow = async (times, doneBefore) => {
      if (!times.length) return []
      const r = await trackOutline({ file, startPts, times, paths, onProgress: (d) => progress(doneBefore + d, total, `Tracking… ${doneBefore + d} of ${total} looks.`), isCancelled: cancelled })
      if (!r) throw new Error('cancelled')
      return r
    }
    const ahead = await follow(after, 0)
    const behind = await follow(before, after.length)
    const samples = [...behind.slice(1).reverse(), ...(ahead.length ? ahead : behind.slice(0, 1))].map((f) => ({ t: f.t, c: f.pts.length >= 3 ? centreOf(f.pts) : null }))
    const state = handle.getState()
    const clipNow = [...state.clips, ...state.overlayClips].find((c) => c.id === clip.id)
    if (!clipNow) throw new Error('That clip is no longer on the timeline.')
    const ratio = aspectRatio(state)
    const ma = media.width / media.height
    const letterbox = [Math.max(1, ratio / ma), Math.max(1, ma / ratio)]
    const stretch = [evalProp(clipNow, 'sx', ts) / 100, evalProp(clipNow, 'sy', ts) / 100]
    const cam = cameraPath(samples, { rate, scale, letterbox, stretch })
    if (!cam) throw new Error('The subject was lost straight away. Try a better box, or another moment.')
    const path = thin(cam.path)
    const a = path[0].t
    const b = path[path.length - 1].t
    const props = {
      x: withEases(clipNow, 'x', path.map((p) => ({ t: p.t, v: p.x })), a, b),
      y: withEases(clipNow, 'y', path.map((p) => ({ t: p.t, v: p.y })), a, b),
      scale: withEases(clipNow, 'scale', [{ t: a, v: scale }, { t: b, v: scale }], a, b),
    }
    handle.dispatch({ type: 'setKeysRange', id: clip.id, props })
    return { keyframes: path.length, inPicturePercent: Math.round(cam.seen * 100), heldAtEdgePercent: Math.round(cam.held * 100), next: 'Look at a few moments with get_preview. If it followed the wrong thing, use undo.' }
  })
  return seconds
}

// A mask follows its subject, as Track in the Inspector does. engine 'ai' = the outline with SAM 2, 'quick' = the movement of the picture.
export function startTrackMask({ handle, clip, media, ts, end, engine, method, quad, paths }) {
  const len = Math.abs(end - ts)
  const n = Math.max(2, Math.min(900, Math.round(len * 30)) + 1)
  const times = Array.from({ length: n }, (_, i) => ts + ((end - ts) * i) / (n - 1))
  const seconds = Math.round(n * (engine === 'quick' ? 0.03 : 0.25))
  startJob({ title: 'Tracking the mask', text: 'Getting ready…', seconds }, async ({ progress, cancelled }) => {
    const onProgress = (d, t) => progress(d, t, `Tracking… ${d} of ${t} moments.`)
    let frames
    let lost
    if (engine === 'quick') {
      const { trackPlanar } = await import('./planarTrack.js')
      const r = await trackPlanar({ file: media.path, startPts: clip.mask.pts, times, method, onProgress, isCancelled: cancelled })
      if (!r) throw new Error('cancelled')
      if (r.frames.length < 2) throw new Error('It could not follow this: ' + (r.lost || 'not enough detail inside the mask') + '.')
      frames = r.frames
      lost = r.lost
    } else {
      const { trackOutline } = await import('./smartMask.js')
      frames = await trackOutline({ file: media.path, startPts: clip.mask.pts, times, paths, quad, onProgress, isCancelled: cancelled })
      if (!frames) throw new Error('cancelled')
    }
    frames.sort((p, q) => p.t - q.t)
    const stop = lost ? frames[frames.length - 1].t : end
    handle.dispatch({ type: 'setMaskOutline', id: clip.id, frames, from: Math.min(ts, stop), to: Math.max(ts, stop) })
    return { moments: frames.length, ...(lost ? { stoppedEarly: 'It ' + lost + '. What was tracked before that was kept.' } : {}) }
  })
  return seconds
}
