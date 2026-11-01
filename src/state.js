import { TEXT_DEFAULTS } from './textRender.js'
import { MASK_DEFAULT, frameIndexAt } from './masks.js'
import { evalTransform, evalProp, evalWarp, hasTransform, keyAt, PROPS, DEFAULTS, DEFAULT_EASE, KEY_EPS, WARP_ZERO } from './motion.js'

export const uid = () => Math.random().toString(36).slice(2, 9)
export const MIN_CLIP = 0.1

export const initialState = {
  media: [],
  // Main video track, played back to back: {id, mediaId, in, out, transition, noAudio, groupId}.
  // A video clip's audio streams are "attached" to it (they follow it around) except the stream
  // numbers listed in noAudio (detached to their own clip, or deleted).
  clips: [],
  // Extra audio clips on their own tracks: {id, mediaId, trackId, in, out, start, groupId,
  // stream?, origin?}. stream = audio stream number when the clip is the detached audio of a
  // video; origin = id of the video clip it was detached from (lets it be grouped back).
  audioClips: [],
  audioTracks: [], // {id, name, kind:'free', volume, mute}
  streamSettings: {}, // volume/mute/name for the attached audio streams: {[n]: {volume, mute, name}}
  // Overlay video: extra video tracks whose clips sit on top of the main video and can start at any
  // time: {id, mediaId, trackId, in, out, start, groupId, tf, anim, warp}. A video clip's own audio
  // is added as grouped detached audio clips when it is dropped there.
  videoTracks: [], // {id, name}
  overlayClips: [],
  mainName: 'Video 1', // name shown on the main video track
  // Vertical order of every row of the timeline (top to bottom): 'main', 'v:<trackId>', 's:<stream>', 'a:<trackId>'.
  // Rows that are not listed yet are placed by rowKeys(). Video rows higher up are drawn on top.
  rowOrder: [],
  aspect: '16:9', // the shape of the video: see ASPECTS
  transcripts: {}, // {[mediaId]: {words: [{text, s, e}]}}: what was said in a video, in seconds of the file (made by Captions)
  markers: [], // {id, t, label}: flags on the timeline ruler
  lockedRows: [], // row keys that cannot be edited
  hiddenRows: [], // row keys that are switched off (video: not shown or exported, audio: silent)
  past: [],
  future: [],
  // Selected items: video clip ids, audio clip ids, or 'sa:<videoClipId>:<stream>' for one attached audio stream.
  selection: [],
  playhead: 0,
  playing: false,
  seekId: 0,
}

// Adds start/dur/ov to every clip. Clips are rippled (no gaps). A clip with `transition`
// overlaps the tail of the previous clip by `ov` seconds (limited by the clips' lengths).
// Speed and reverse. A clip plays its source from `in` to `out` (seconds in the original file). With `speed`
// the clip lasts (out - in) / speed on the timeline; with `reverse` it plays from `out` back to `in`.
export const speedOf = (c) => (c && c.speed > 0 ? c.speed : 1)
// the second of the original file that is on screen at project time t
export function srcAt(c, t) {
  const sp = speedOf(c)
  const rel = Math.max(0, Math.min(t - c.start, (c.out - c.in) / sp)) * sp
  return c.reverse ? c.out - rel : c.in + rel
}
// the project time at which second s of the original file is on screen
export function tlOf(c, s) {
  return c.start + (c.reverse ? c.out - s : s - c.in) / speedOf(c)
}
// how long an item lasts on the timeline
export const lenOf = (c) => (c.out - c.in) / speedOf(c)
// splitting at project time t: which source range each half keeps (first = earlier on the timeline)
function splitRanges(c, t) {
  const s = srcAt(c, t)
  return c.reverse ? { first: { in: s }, second: { out: s } } : { first: { out: s }, second: { in: s } }
}

export function layout(clips) {
  const out = []
  let end = 0
  clips.forEach((c, i) => {
    const dur = (c.out - c.in) / speedOf(c)
    // c.gap = seconds of empty (black) time before this clip; a clip after a gap has no transition into it
    const gap = c.gap > 0.0005 ? c.gap : 0
    let ov = 0
    if (i > 0 && !gap && c.transition && c.transition.name) {
      const prev = out[i - 1]
      ov = Math.min(c.transition.duration, prev.dur - prev.ov, dur)
      if (ov < 0.05) ov = 0
    }
    const start = i === 0 ? gap : end + gap - ov
    out.push({ ...c, dur, ov, start, gap })
    end = start + dur
  })
  return out
}

// Audio that is grouped with main-track clips follows them when the layout changes (a gap opened or closed, clips
// reordered): every group moves by what its first main-track clip moved.
function shiftGroupAudio(audioClips, before, after) {
  const delta = new Map()
  for (const x of after) {
    const b = before.find((y) => y.id === x.id)
    if (x.groupId && b && !delta.has(x.groupId)) delta.set(x.groupId, x.start - b.start)
  }
  if (![...delta.values()].some((d) => Math.abs(d) > 1e-9)) return audioClips
  return audioClips.map((x) => (x.groupId && delta.has(x.groupId) ? { ...x, start: Math.max(0, x.start + delta.get(x.groupId)) } : x))
}

export function totalDuration(clips) {
  const l = layout(clips)
  return l.length ? l[l.length - 1].start + l[l.length - 1].dur : 0
}

export const audioLayout = (audioClips) => audioClips.map((a) => ({ ...a, dur: a.out - a.in }))
export const overlayLayout = (overlayClips) => overlayClips.map((c) => ({ ...c, dur: lenOf(c), ov: 0 }))

// Length of the whole project: the main video, or an overlay clip that runs past it.
export function projectDuration(state) {
  let end = totalDuration(state.clips)
  for (const c of state.overlayClips || []) end = Math.max(end, c.start + lenOf(c))
  return end
}

// Every row of the timeline, top to bottom. Remembers the user's order; new rows go to the top
// (overlay video, so it sits above the main video) or the bottom (audio).
export function rowKeys(state) {
  const have = ['main', ...Array.from({ length: streamCount(state) }, (_, n) => 's:' + n), ...(state.videoTracks || []).map((t) => 'v:' + t.id), ...state.audioTracks.map((t) => 'a:' + t.id)]
  const order = (state.rowOrder || []).filter((k) => have.includes(k))
  const out = [...order]
  for (const k of have) {
    if (out.includes(k)) continue
    if (k.startsWith('v:')) out.unshift(k)
    else out.push(k)
  }
  return out
}
// The shapes a project can have (landscape, vertical, square...). ratio = width / height.
export const ASPECTS = [
  { id: '16:9', label: 'Landscape 16:9', ratio: 16 / 9 },
  { id: '9:16', label: 'Vertical 9:16', ratio: 9 / 16 },
  { id: '1:1', label: 'Square 1:1', ratio: 1 },
  { id: '4:5', label: 'Portrait 4:5', ratio: 4 / 5 },
  { id: '4:3', label: 'Classic 4:3', ratio: 4 / 3 },
  { id: '21:9', label: 'Cinema 21:9', ratio: 21 / 9 },
]
// An image project has its own canvas size (state.canvas = {w, h, bg}); a video project one of the ASPECTS.
export const aspectRatio = (state) => (state.canvas ? state.canvas.w / state.canvas.h : (ASPECTS.find((x) => x.id === state.aspect) || ASPECTS[0]).ratio)
// the size of the preview picture in pixels for a shape (the longest side is about 1280)
export function previewSize(ratio) {
  return ratio >= 1 ? [1280, Math.round(1280 / ratio / 2) * 2] : [Math.round((1280 * ratio) / 2) * 2, 1280]
}

// Which timeline row an item lives on ('main', 'v:<track>', 'a:<track>' or 's:<stream>'), for locking and hiding
export function rowOfItem(state, id) {
  if (id.startsWith('sa:')) return 's:' + id.split(':')[2]
  if (state.clips.some((c) => c.id === id)) return 'main'
  const o = state.overlayClips.find((c) => c.id === id)
  if (o) return 'v:' + o.trackId
  const a = state.audioClips.find((c) => c.id === id)
  if (a) return 'a:' + a.trackId
  return null
}
export const isLocked = (state, id) => (state.lockedRows || []).includes(rowOfItem(state, id))

// The one video clip (main or overlay) that is selected, if there is exactly one. Its grouped audio may
// be selected along with it: that still counts as "one clip" for the Inspector and the warp handles.
export function soleVideoClip(state) {
  const v = state.selection.filter((id) => state.clips.some((c) => c.id === id) || state.overlayClips.some((c) => c.id === id))
  const others = state.selection.filter((id) => !v.includes(id) && !state.audioClips.some((c) => c.id === id))
  return v.length === 1 && !others.length ? v[0] : null
}

// the size of a clip's picture: a text or paint layer is as big as the frame / its own canvas, other clips are their file
export const clipPicture = (state, clip, ratio) =>
  clip.text ? { width: ratio * 1000, height: 1000 } : clip.raster ? { width: clip.raster.w, height: clip.raster.h } : clip.paint ? { width: clip.paint.w, height: clip.paint.h } : state.media.find((m) => m.id === clip.mediaId)

// the video rows, bottom layer first (what gets drawn first)
export const videoRowsBottomUp = (state) => rowKeys(state).filter((k) => k === 'main' || k.startsWith('v:')).reverse()

// The file to play for an audio clip (a detached video stream, or a plain audio file).
export function audioSource(a, media) {
  if (!media) return null
  if (a.stream != null) return (media.audioFiles || [])[a.stream] || null
  return media.path
}

// Is audio stream n of this video clip still attached to it?
export const hasAttached = (c, media, n) =>
  !!media && media.type === 'video' && n < (media.audioStreams || []).length && !(c.noAudio || []).includes(n)

// The volume and mute of ONE clip's sound: attached stream n of a video clip (clip.av[n]), or a detached audio clip
// (its own volume / mute). It sits on top of the lane / track setting, which is 100% unless an older project changed it.
// (clean = the clip's audio clean-up: {nr, rumble, voice}, see electron/audioClean.js)
// env = the volume curve: keyframes [{t (seconds of the file), v (0..2, multiplies the volume)}]; fadeIn / fadeOut = seconds
export const streamAudioOf = (c, n) => {
  const s = (c.av && c.av[n]) || {}
  return { volume: s.volume ?? 1, mute: !!s.mute, clean: s.clean, env: s.env, fadeIn: s.fadeIn || 0, fadeOut: s.fadeOut || 0 }
}
export const audioClipVol = (a) => ({ volume: a.volume ?? 1, mute: !!a.mute, clean: a.clean, env: a.env, fadeIn: a.fadeIn || 0, fadeOut: a.fadeOut || 0 })
// the multiplier of a volume curve at second s of the file (flat before the first and after the last keyframe)
export function envAt(env, s) {
  if (!env || !env.length) return 1
  if (s <= env[0].t) return env[0].v
  for (let i = 1; i < env.length; i++) {
    if (s <= env[i].t) {
      const a = env[i - 1]
      const b = env[i]
      return b.t - a.t < 1e-6 ? b.v : a.v + ((b.v - a.v) * (s - a.t)) / (b.t - a.t)
    }
  }
  return env[env.length - 1].v
}
// the multiplier of the fade handles, rel = seconds since the clip started
export function fadeAt(rel, dur, fadeIn, fadeOut) {
  let g = 1
  if (fadeIn > 0 && rel < fadeIn) g *= Math.max(0, rel / fadeIn)
  if (fadeOut > 0 && rel > dur - fadeOut) g *= Math.max(0, (dur - rel) / fadeOut)
  return g
}
const avFields = (c, n) => {
  const s = streamAudioOf(c, n)
  const o = {}
  if (s.volume !== 1) o.volume = s.volume
  if (s.mute) o.mute = true
  if (s.clean) o.clean = s.clean
  if (s.env && s.env.length) o.env = s.env
  if (s.fadeIn) o.fadeIn = s.fadeIn
  if (s.fadeOut) o.fadeOut = s.fadeOut
  return o
}
// a change of one clip's audio settings; the clean-up part is merged into what is there
const mergeAudio = (cur, patch) => {
  const { clean, ...rest } = patch
  const out = { ...cur, ...rest }
  if (clean) out.clean = { ...(cur.clean || {}), ...clean }
  // an empty curve / no fade is just not stored
  if ('env' in rest && (!rest.env || !rest.env.length)) delete out.env
  for (const k of ['fadeIn', 'fadeOut']) if (k in rest && !(rest[k] > 0)) delete out[k]
  return out
}
// is the clean-up of this clip switched on?
export const cleanActive = (clean) => !!clean && (clean.nr > 0 || !!clean.rumble || !!clean.voice)
// where a clip of length dur starting at s fits on a track (it moves to the end of whatever it would overlap)
const nextFree = (clips, s, dur) => {
  for (const x of [...clips].sort((p, q) => p.start - q.start)) {
    const xe = x.start + (x.out - x.in)
    if (s < xe - 1e-6 && s + dur > x.start + 1e-6) s = xe
  }
  return s
}

// After a clip is cut in two, the fade-out belongs to the end piece only and the fade-in to the first piece only.
const noFade = (c, side) => {
  let out = c
  if (c.av) out = { ...out, av: Object.fromEntries(Object.entries(c.av).map(([n, s]) => [n, Object.fromEntries(Object.entries(s).filter(([k]) => k !== side))])) }
  if (side in out) {
    out = { ...out }
    delete out[side]
  }
  return out
}

// Cut the time range [t0, t1) out of every track and close the gap: the main track, overlay clips, audio clips and
// markers. A clip the range falls into becomes two clips (the part before it and the part after it).
function cutRange(cur, t0, t1) {
  const d = t1 - t0
  const EPS = 0.02
  const part = (c, srcA, srcB) => ({ ...c, in: srcA, out: srcB }) // a piece of a clip: source seconds srcA..srcB
  // main video track (it ripples by itself: its clips follow each other)
  const clips = []
  for (const c of layout(cur.clips)) {
    const orig = cur.clips.find((x) => x.id === c.id)
    const end = c.start + c.dur
    if (end <= t0 + 1e-6 || c.start >= t1 - 1e-6) {
      clips.push(orig)
      continue
    }
    const hasLeft = c.start < t0 - EPS
    const hasRight = end > t1 + EPS
    const a = srcAt(c, t0)
    const b = srcAt(c, t1)
    if (hasLeft) clips.push(noFade(c.reverse ? part(orig, a, orig.out) : part(orig, orig.in, a), hasRight ? 'fadeOut' : ''))
    if (hasRight) {
      const r = c.reverse ? part(orig, orig.in, b) : part(orig, b, orig.out)
      const piece = { ...r, id: hasLeft ? uid() : orig.id, transition: hasLeft ? null : orig.transition, gap: hasLeft ? 0 : orig.gap }
      clips.push(hasLeft ? noFade(piece, 'fadeIn') : piece)
    }
  }
  // items that sit anywhere in time (overlay clips and audio clips): cut, and move left what came after
  const timed = (list, lay) =>
    lay.flatMap((c) => {
      const orig = list.find((x) => x.id === c.id)
      const end = c.start + c.dur
      if (end <= t0 + 1e-6) return [orig]
      if (c.start >= t1 - 1e-6) return [{ ...orig, start: c.start - d }]
      const hasLeft = c.start < t0 - EPS
      const hasRight = end > t1 + EPS
      const a = srcAt(c, t0)
      const b = srcAt(c, t1)
      const out = []
      if (hasLeft) out.push(noFade(c.reverse ? part(orig, a, orig.out) : part(orig, orig.in, a), hasRight ? 'fadeOut' : ''))
      if (hasRight) {
        const r = c.reverse ? part(orig, orig.in, b) : part(orig, b, orig.out)
        const piece = { ...r, id: hasLeft ? uid() : orig.id, start: t0 }
        out.push(hasLeft ? noFade(piece, 'fadeIn') : piece)
      }
      return out
    })
  const overlayClips = timed(cur.overlayClips, overlayLayout(cur.overlayClips))
  const audioClips = timed(cur.audioClips, audioLayout(cur.audioClips))
  const markers = cur.markers.filter((m) => m.t < t0 || m.t >= t1).map((m) => (m.t >= t1 ? { ...m, t: m.t - d } : m))
  return { clips, overlayClips, audioClips, markers }
}

// Split ONLY the selected sound at time t (the picture and the other sounds stay whole).
// A selected attached stream is detached first (it becomes a detached audio clip), then cut.
function splitAudioOnly(state, ids, t) {
  const lay = layout(state.clips)
  const tracks = [...state.audioTracks]
  const detached = []
  for (const id of ids) {
    if (!id.startsWith('sa:')) continue
    const [, cid, ns] = id.split(':')
    const n = +ns
    const c = lay.find((x) => x.id === cid)
    const m = c && state.media.find((x) => x.id === c.mediaId)
    if (!c || !m || !hasAttached(c, m, n) || isLocked(state, id)) continue
    if (!(t > c.start + MIN_CLIP && t < c.start + c.dur - MIN_CLIP)) continue
    if (speedOf(c) !== 1 || c.reverse) continue // the sound of a sped-up or reversed clip cannot be cut on its own
    const tid = 'ug' + n
    if (!tracks.some((x) => x.id === tid)) tracks.push({ id: tid, name: `Video audio ${n + 1} (detached)`, kind: 'free', volume: 1, mute: false })
    detached.push({ cid, n, clip: { id: uid(), mediaId: m.id, stream: n, trackId: tid, in: c.in, out: c.out, start: c.start, origin: c.id, groupId: c.groupId, ...avFields(c, n) } })
  }
  const clips = state.clips.map((c) => {
    const ns = detached.filter((d) => d.cid === c.id).map((d) => d.n)
    return ns.length ? { ...c, noAudio: [...new Set([...(c.noAudio || []), ...ns])] } : c
  })
  const cutIds = new Set([...detached.map((d) => d.clip.id), ...ids.filter((id) => !id.startsWith('sa:'))])
  const select = []
  const audioClips = [...state.audioClips, ...detached.map((d) => d.clip)].flatMap((x) => {
    if (!cutIds.has(x.id) || isLocked(state, x.id) || !(t > x.start + MIN_CLIP && t < x.start + (x.out - x.in) - MIN_CLIP)) return [x]
    const mid = x.in + (t - x.start)
    const right = noFade({ ...x, id: uid(), in: mid, start: t }, 'fadeIn')
    select.push(right.id)
    return [noFade({ ...x, out: mid }, 'fadeOut'), right]
  })
  if (!select.length) return state
  return { ...commit(state, { clips, audioClips }), audioTracks: tracks, selection: select }
}

// How many audio lanes the timeline needs (highest attached stream number + 1).
export function streamCount(state) {
  let n = 0
  for (const c of state.clips) {
    const m = state.media.find((x) => x.id === c.mediaId)
    if (!m || m.type !== 'video') continue
    for (let i = 0; i < (m.audioStreams || []).length; i++) if (hasAttached(c, m, i)) n = Math.max(n, i + 1)
  }
  return n
}

// What undo / redo bring back. An image project (state.canvas) also has its layer order, locks and canvas in there.
const snap = (s) =>
  s.canvas
    ? { clips: s.clips, audioClips: s.audioClips, overlayClips: s.overlayClips, videoTracks: s.videoTracks, rowOrder: s.rowOrder, lockedRows: s.lockedRows, hiddenRows: s.hiddenRows, canvas: s.canvas }
    : { clips: s.clips, audioClips: s.audioClips, overlayClips: s.overlayClips }
const hist = (s) => [...s.past, snap(s)].slice(-100)
function commit(state, patch) {
  return { ...state, ...patch, past: hist(state), future: [] }
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// ---- image layers (see the image project actions in the reducer)
const LAYER_LONG = 36000 // a layer lasts "forever": an image has no timeline
const nextLayerName = (state, base) => `${base} ${state.videoTracks.filter((t) => t.name.startsWith(base)).length + 1}`
function addImageLayer(state, clip, name, extra = {}) {
  const trackId = uid()
  const layer = { ...clip, id: clip.id || uid(), trackId, in: 0, out: LAYER_LONG, start: 0 }
  if (!layer.tf) delete layer.tf
  return {
    ...commit(state, { overlayClips: [...state.overlayClips, layer], ...extra }),
    videoTracks: [...state.videoTracks, { id: trackId, name }],
    rowOrder: ['v:' + trackId, ...rowKeys(state)],
    selection: [layer.id],
  }
}

// After undo/redo, make sure every audio / overlay clip still has a track to live on.
function ensureTracks(state) {
  let out = state
  const tracks = [...state.audioTracks]
  for (const c of state.audioClips) {
    if (tracks.some((t) => t.id === c.trackId)) continue
    const name = c.trackId.startsWith('ug') ? `Video audio ${+c.trackId.slice(2) + 1} (detached)` : 'Audio'
    tracks.push({ id: c.trackId, name, kind: 'free', volume: 1, mute: false })
  }
  if (tracks.length !== state.audioTracks.length) out = { ...out, audioTracks: tracks }
  const vt = [...state.videoTracks]
  for (const c of state.overlayClips) if (!vt.some((t) => t.id === c.trackId)) vt.push({ id: c.trackId, name: nextVideoName(vt) })
  if (vt.length !== state.videoTracks.length) out = { ...out, videoTracks: vt }
  return out
}

// "Video 2", "Video 3"...: the first number not used yet ("Video 1" is the main track)
function nextVideoName(tracks, mainName = 'Video 1') {
  const used = new Set([mainName, ...tracks.map((t) => t.name)])
  let n = 2
  while (used.has(`Video ${n}`)) n++
  return `Video ${n}`
}
const nextAudioName = (tracks) => {
  const used = new Set(tracks.map((t) => t.name))
  let n = 1
  while (used.has(`Audio ${n}`)) n++
  return `Audio ${n}`
}

// apply f to the video clip or overlay clip with this id
const mapClips = (state, f) => ({ clips: state.clips.map(f), overlayClips: state.overlayClips.map(f) })

// ---- groups: every item (video clip, overlay clip or audio clip) may carry a groupId
const itemOf = (state, id) => state.clips.find((x) => x.id === id) || state.overlayClips.find((x) => x.id === id) || state.audioClips.find((x) => x.id === id)

// Clicking any member of a group selects the whole group. (Attached-audio ids are never expanded.)
function expand(state, ids) {
  const gids = new Set()
  for (const id of ids) {
    const it = itemOf(state, id)
    if (it && it.groupId) gids.add(it.groupId)
  }
  if (!gids.size) return ids
  const out = new Set(ids)
  state.clips.forEach((c) => gids.has(c.groupId) && out.add(c.id))
  state.overlayClips.forEach((c) => gids.has(c.groupId) && out.add(c.id))
  state.audioClips.forEach((c) => gids.has(c.groupId) && out.add(c.id))
  return [...out]
}

// a copy of a clip (without its derived start / dur / ov), with some fields changed
const newClip = (c, patch) => {
  const { start, dur, ov, ...rest } = c
  return { ...rest, transition: c.transition || null, noAudio: c.noAudio || [], ...patch }
}

const sortKeys = (list) => [...list].sort((a, b) => a.t - b.t)


// ---- copy / paste / duplicate helpers
let clipboard = null // {main:[], over:[], aud:[]} copies of the clips that were copied
const stripDerived = (c) => {
  const { start, dur, ov, ...rest } = c
  return JSON.parse(JSON.stringify(rest))
}
export function cloneSelection(state, ids) {
  const set = new Set(ids.filter((x) => !x.startsWith('sa:')))
  return {
    main: layout(state.clips).filter((c) => set.has(c.id)).map(stripDerived),
    over: overlayLayout(state.overlayClips).filter((c) => set.has(c.id)).map((c) => ({ ...stripDerived(c), start: c.start })),
    aud: audioLayout(state.audioClips).filter((c) => set.has(c.id)).map((c) => ({ ...stripDerived(c), start: c.start })),
  }
}
// Ctrl+C: returns how many clips were copied
export function copySelection(state) {
  const cb = cloneSelection(state, state.selection)
  const n = cb.main.length + cb.over.length + cb.aud.length
  if (n) clipboard = cb
  return n
}
export const hasClipboard = () => !!clipboard

// Puts copies of the clipboard clips into the project. t = where (seconds), or null to put each copy right after
// the originals (duplicate). New ids, groups are kept as groups.
function pasteItems(state, cb, t) {
  const gmap = new Map()
  const gid = (g) => {
    if (!g) return undefined
    if (!gmap.has(g)) gmap.set(g, uid())
    return gmap.get(g)
  }
  const idmap = new Map()
  const fresh = (c) => {
    const id = uid()
    idmap.set(c.id, id)
    return { ...c, id, groupId: gid(c.groupId) }
  }
  // main track: the copies go after the last original (duplicate) or at the playhead
  const lay = layout(state.clips)
  let at
  if (t == null) {
    const last = Math.max(-1, ...cb.main.map((c) => lay.findIndex((x) => x.id === c.id)))
    at = last + 1
  } else {
    at = lay.filter((c) => c.start + c.dur / 2 < t).length
  }
  const mainCopies = cb.main.map((c, i) => ({ ...fresh(c), transition: i === 0 ? null : c.transition }))
  const clips = [...state.clips.slice(0, at), ...mainCopies, ...state.clips.slice(at)]
  // overlay and audio: same tracks, shifted in time
  const timed = [...cb.over, ...cb.aud]
  let offset = 0
  if (timed.length) {
    const base = Math.min(...timed.map((c) => c.start))
    if (t == null) offset = Math.max(...timed.map((c) => c.start + lenOf(c))) - base
    else offset = t - base
  }
  const overCopies = cb.over.map((c) => ({ ...fresh(c), start: Math.max(0, c.start + offset) }))
  const audCopies = cb.aud.map((c) => {
    const n = fresh(c)
    return { ...n, start: Math.max(0, c.start + offset), origin: c.origin && idmap.has(c.origin) ? idmap.get(c.origin) : undefined }
  })
  const out = {
    ...commit(state, { clips, overlayClips: [...state.overlayClips, ...overCopies], audioClips: [...state.audioClips, ...audCopies] }),
    selection: [...mainCopies, ...overCopies, ...audCopies].map((c) => c.id),
  }
  return ensureTracks(out)
}
export function reducer(state, a) {
  switch (a.type) {
    case 'addMedia': {
      const items = a.items.filter((i) => !state.media.some((m) => m.id === i.id))
      return items.length ? { ...state, media: [...state.media, ...items] } : state
    }

    // take a file out of the project: it leaves the media pool and every clip made from it leaves the timeline.
    // Undo history is cleared (an undo could not bring back clips whose file is gone from the pool).
    case 'removeMedia': {
      const gone = (c) => c.mediaId === a.id
      return {
        ...state,
        media: state.media.filter((m) => m.id !== a.id),
        clips: state.clips.filter((c) => !gone(c)),
        overlayClips: state.overlayClips.filter((c) => !gone(c)),
        audioClips: state.audioClips.filter((c) => !gone(c)),
        selection: [],
        past: [],
        future: [],
      }
    }

    // replace the whole project (open / new)
    case 'loadProject':
      return {
        ...initialState,
        media: a.media || [],
        clips: a.clips || [],
        audioClips: a.audioClips || [],
        audioTracks: a.audioTracks || [],
        streamSettings: a.streamSettings || {},
        transcripts: a.transcripts || {},
        overlayClips: a.overlayClips || [],
        videoTracks: a.videoTracks || [],
        mainName: a.mainName || 'Video 1',
        rowOrder: a.rowOrder || [],
        aspect: a.aspect || '16:9',
        markers: a.markers || [],
        lockedRows: a.lockedRows || [],
        hiddenRows: a.hiddenRows || [],
      }

    case 'updateMedia':
      return { ...state, media: state.media.map((m) => (m.id === a.id ? { ...m, ...a.patch } : m)) }

    case 'addClip': {
      const m = state.media.find((x) => x.id === a.mediaId)
      if (!m || m.type === 'audio') return state
      const clip = { id: uid(), mediaId: m.id, in: 0, out: m.duration, transition: null, noAudio: [] }
      const clips = [...state.clips]
      const idx = a.index == null ? clips.length : clamp(a.index, 0, clips.length)
      clips.splice(idx, 0, clip)
      return { ...commit(state, { clips }), selection: [clip.id] }
    }

    // Move one or more video clips (a selection or a group) so they sit together at toIndex
    // (an index into the clips that are NOT being moved). Grouped audio shifts by the same time.
    case 'moveClips': {
      const ids = new Set(a.ids)
      const moving = state.clips.filter((c) => ids.has(c.id))
      if (!moving.length) return state
      const rest = state.clips.filter((c) => !ids.has(c.id))
      const idx = clamp(a.toIndex, 0, rest.length)
      const clips = [...rest.slice(0, idx), ...moving, ...rest.slice(idx)]
      if (clips.every((x, i) => x.id === state.clips[i].id)) return state
      const before = layout(state.clips)
      const after = layout(clips)
      const delta = new Map() // groupId -> seconds the group's first moved clip shifted
      for (const c of moving) {
        if (!c.groupId || delta.has(c.groupId)) continue
        delta.set(c.groupId, after.find((x) => x.id === c.id).start - before.find((x) => x.id === c.id).start)
      }
      const audioClips = state.audioClips.map((x) => (x.groupId && delta.has(x.groupId) ? { ...x, start: Math.max(0, x.start + delta.get(x.groupId)) } : x))
      return commit(state, { clips, audioClips })
    }

    // Like moveClips, but the first moved clip also gets `a.gap` seconds of empty time in front of it (0 = none), and
    // the sound grouped with any clip follows that clip wherever it ends up. Used when a clip is dragged on the main track.
    case 'moveMainTo': {
      const ids = new Set(a.ids)
      const moving = state.clips.filter((c) => ids.has(c.id))
      if (!moving.length) return state
      const rest = state.clips.filter((c) => !ids.has(c.id))
      const idx = clamp(a.toIndex, 0, rest.length)
      const gap = Math.max(0, a.gap || 0)
      const placed = moving.map((c, i) => ({ ...c, gap: i === 0 ? gap : 0 }))
      const clips = [...rest.slice(0, idx), ...placed, ...rest.slice(idx)]
      const before = layout(state.clips)
      const after = layout(clips)
      if (clips.every((x, i) => x.id === state.clips[i].id && (x.gap || 0) === (state.clips[i].gap || 0))) return state
      const audioClips = shiftGroupAudio(state.audioClips, before, after)
      return commit(state, { clips, audioClips })
    }
    // remove the empty time in front of a main-track clip
    case 'closeGap': {
      const clips = state.clips.map((c) => (c.id === a.id && c.gap ? { ...c, gap: 0 } : c))
      if (clips.every((c, i) => c === state.clips[i])) return state
      const audioClips = shiftGroupAudio(state.audioClips, layout(state.clips), layout(clips))
      return { ...commit(state, { clips, audioClips }), selection: [] }
    }

    // Call once at the start of a drag so the whole drag is a single undo step.
    case 'checkpoint':
      return { ...state, past: hist(state), future: [] }

    case 'trim': {
      const clips = state.clips.map((c) => {
        if (c.id !== a.id) return c
        const m = state.media.find((x) => x.id === c.mediaId)
        const maxOut = m.type === 'video' ? m.duration : 3600
        if (a.side === 'in') return { ...c, in: Math.max(0, Math.min(a.value, c.out - MIN_CLIP)) }
        return { ...c, out: Math.max(c.in + MIN_CLIP, Math.min(a.value, maxOut)) }
      })
      return { ...state, clips }
    }

    case 'split': {
      // only sound selected: cut just that sound, not the picture or the other sounds
      const onlyAudio = state.selection.length > 0 && state.selection.every((id) => id.startsWith('sa:') || state.audioClips.some((x) => x.id === id))
      if (onlyAudio) return splitAudioOnly(state, state.selection, a.t)
      // a selected overlay clip under the playhead is split instead of the main video (its grouped audio too)
      const ol = overlayLayout(state.overlayClips).find((x) => state.selection.includes(x.id) && !isLocked(state, x.id) && a.t > x.start + MIN_CLIP && a.t < x.start + x.dur - MIN_CLIP)
      if (ol) {
        const sr = splitRanges(ol, a.t)
        const left = { ...ol, ...sr.first }
        const rightId = uid()
        const gid = ol.groupId ? uid() : undefined
        const right = { ...ol, ...sr.second, id: rightId, start: a.t, groupId: gid }
        delete left.dur
        delete left.ov
        delete right.dur
        delete right.ov
        const overlayClips = state.overlayClips.flatMap((x) => (x.id === ol.id ? [left, right] : [x]))
        let audioClips = state.audioClips
        if (ol.groupId) {
          audioClips = state.audioClips.flatMap((x) => {
            if (x.groupId !== ol.groupId || !(a.t > x.start + MIN_CLIP && a.t < x.start + (x.out - x.in) - MIN_CLIP)) return [x]
            const c2 = x.in + (a.t - x.start)
            return [noFade({ ...x, out: c2 }, 'fadeOut'), noFade({ ...x, id: uid(), in: c2, start: a.t, groupId: gid }, 'fadeIn')]
          })
        }
        return { ...commit(state, { overlayClips, audioClips }), selection: [rightId] }
      }
      if ((state.lockedRows || []).includes('main')) return state
      const l = layout(state.clips)
      const c = l.find((x) => a.t > x.start + MIN_CLIP && a.t < x.start + x.dur - MIN_CLIP)
      if (!c) return state
      const sr = splitRanges(c, a.t)
      const left = noFade(newClip(c, sr.first), 'fadeOut')
      const right = noFade(newClip(c, { ...sr.second, id: uid(), transition: null, gap: 0 }), 'fadeIn')
      const clips = state.clips.flatMap((x) => (x.id === c.id ? [left, right] : [x]))
      return { ...commit(state, { clips }), selection: [right.id] }
    }

    // Insert a freeze-frame image at time t (splitting the clip there if needed).
    case 'insertFreeze': {
      const l = layout(state.clips)
      const media = state.media.some((m) => m.id === a.item.id) ? state.media : [...state.media, a.item]
      const fc = { id: uid(), mediaId: a.item.id, in: 0, out: a.duration || 2, transition: null, noAudio: [] }
      const hit = l.filter((x) => a.t >= x.start && a.t < x.start + x.dur)
      const c = hit.length ? hit[hit.length - 1] : l[l.length - 1]
      // the frozen picture keeps the look the clip had at that moment
      if (c && hasTransform(c)) {
        const ts = srcAt(c, a.t)
        fc.tf = evalTransform(c, ts)
        const wp = evalWarp(c, ts)
        if (wp) fc.warp = { fixed: wp, keys: [] }
      }
      let clips
      if (!c) clips = [fc]
      else {
        const idx = state.clips.findIndex((x) => x.id === c.id)
        const local = a.t - c.start
        if (local <= MIN_CLIP) {
          clips = [...state.clips.slice(0, idx), fc, ...state.clips.slice(idx)]
        } else if (local >= c.dur - MIN_CLIP) {
          clips = [...state.clips.slice(0, idx + 1), fc, ...state.clips.slice(idx + 1)]
        } else {
          const sr = splitRanges(c, a.t)
          const left = newClip(c, sr.first)
          const right = newClip(c, { ...sr.second, id: uid(), transition: null, gap: 0 })
          clips = [...state.clips.slice(0, idx), left, fc, right, ...state.clips.slice(idx + 1)]
        }
      }
      return { ...commit(state, { clips, media }), selection: [fc.id] }
    }

    // Delete everything selected. Deleting an attached audio stream ('sa:') just silences it.
    case 'deleteSelection': {
      const todo = state.selection.filter((id) => !isLocked(state, id)) // locked rows cannot be edited
      if (!todo.length) return state
      // a selected gap ('gap:<clip id>') is closed
      const gaps = todo.filter((id) => id.startsWith('gap:')).map((id) => id.slice(4))
      if (gaps.length && gaps.length === todo.length) {
        let st = state
        for (const g of gaps) st = reducer(st, { type: 'closeGap', id: g })
        return st === state ? { ...state, selection: [] } : st
      }
      const sel = new Set(todo)
      const gone = new Map() // clipId -> streams deleted
      for (const id of todo) {
        if (!id.startsWith('sa:')) continue
        const [, cid, n] = id.split(':')
        gone.set(cid, [...(gone.get(cid) || []), +n])
      }
      const clips = state.clips
        .filter((c) => !sel.has(c.id))
        .map((c) => (gone.has(c.id) ? { ...c, noAudio: [...new Set([...(c.noAudio || []), ...gone.get(c.id)])] } : c))
      const audioClips = state.audioClips.filter((c) => !sel.has(c.id))
      const overlayClips = state.overlayClips.filter((c) => !sel.has(c.id))
      return { ...commit(state, { clips, audioClips, overlayClips }), selection: [] }
    }

    // ---- keyframes (t = source time in seconds; see motion.js). They work on main and overlay clips.
    // Change a property at time t. With no keyframes it changes the fixed value; with keyframes it
    // edits the keyframe at t, or adds one there. Live: call 'checkpoint' first.
    case 'setProp': {
      const f = (c) => {
        if (c.id !== a.id) return c
        const list = (c.anim && c.anim[a.prop]) || []
        if (!list.length) return { ...c, tf: { ...DEFAULTS, ...c.tf, [a.prop]: a.value } }
        const hit = keyAt(list, a.t)
        const next = hit
          ? list.map((k) => (k === hit ? { ...k, v: a.value } : k))
          : sortKeys([...list, { t: a.t, v: a.value, ease: DEFAULT_EASE }])
        return { ...c, anim: { ...c.anim, [a.prop]: next } }
      }
      return { ...state, ...mapClips(state, f) }
    }

    // add a keyframe at t (with the value the property has there), or remove the one that is there
    case 'toggleKey': {
      const f = (c) => {
        if (c.id !== a.id) return c
        const list = (c.anim && c.anim[a.prop]) || []
        const hit = keyAt(list, a.t)
        if (hit) {
          const rest = list.filter((k) => k !== hit)
          const anim = { ...c.anim }
          if (rest.length) anim[a.prop] = rest
          else delete anim[a.prop]
          // the last keyframe's value becomes the fixed value
          return { ...c, anim, tf: rest.length ? c.tf : { ...DEFAULTS, ...c.tf, [a.prop]: hit.v } }
        }
        const v = evalProp(c, a.prop, a.t)
        return { ...c, anim: { ...c.anim, [a.prop]: sortKeys([...list, { t: a.t, v, ease: DEFAULT_EASE }]) } }
      }
      return commit(state, mapClips(state, f))
    }

    case 'setEase': {
      const f = (c) => {
        if (c.id !== a.id) return c
        const list = (c.anim && c.anim[a.prop]) || []
        const hit = keyAt(list, a.t)
        if (!hit) return c
        return { ...c, anim: { ...c.anim, [a.prop]: list.map((k) => (k === hit ? { ...k, ease: a.ease, bez: a.bez || k.bez } : k)) } }
      }
      return a.live ? { ...state, ...mapClips(state, f) } : commit(state, mapClips(state, f))
    }

    // one keyframe for ALL the motion properties at once (add them all here, or remove those that are here)
    case 'toggleKeyAll': {
      const f = (c) => {
        if (c.id !== a.id) return c
        const props = PROPS.filter((q) => !q.mask || c.mask) // the mask sliders only exist for clips that have a mask
        const anyHere = props.some((p) => keyAt(c.anim && c.anim[p.id], a.t))
        const anim = { ...c.anim }
        let tf = c.tf
        for (const p of props) {
          const list = anim[p.id] || []
          const hit = keyAt(list, a.t)
          if (anyHere) {
            if (!hit) continue
            const rest = list.filter((k) => k !== hit)
            if (rest.length) anim[p.id] = rest
            else {
              delete anim[p.id]
              tf = { ...DEFAULTS, ...tf, [p.id]: hit.v }
            }
          } else {
            anim[p.id] = sortKeys([...list, { t: a.t, v: evalProp(c, p.id, a.t), ease: DEFAULT_EASE }])
          }
        }
        return { ...c, anim, tf }
      }
      return commit(state, mapClips(state, f))
    }
    // easing of every motion keyframe at time t
    case 'setEaseAll': {
      const f = (c) => {
        if (c.id !== a.id || !c.anim) return c
        const anim = {}
        for (const [p, list] of Object.entries(c.anim)) {
          anim[p] = (list || []).map((k) => (Math.abs(k.t - a.t) < KEY_EPS ? { ...k, ease: a.ease, bez: a.bez || k.bez } : k))
        }
        return { ...c, anim }
      }
      return a.live ? { ...state, ...mapClips(state, f) } : commit(state, mapClips(state, f))
    }

    // remove all keyframes of a property and put it back to its default
    case 'clearProp': {
      const f = (c) => {
        if (c.id !== a.id) return c
        const anim = { ...c.anim }
        delete anim[a.prop]
        return { ...c, anim, tf: { ...DEFAULTS, ...c.tf, [a.prop]: DEFAULTS[a.prop] } }
      }
      return commit(state, mapClips(state, f))
    }

    // ---- warp (corner pin). a.c = the 8 corner numbers (see motion.js). Live: call 'checkpoint' first.
    // With no keyframes it sets the fixed warp; with keyframes it edits the one at t or adds one there.
    case 'warpSet': {
      const f = (c) => {
        if (c.id !== a.id) return c
        const w = c.warp || { keys: [] }
        const keys = w.keys || []
        if (!keys.length) return { ...c, warp: { ...w, fixed: a.c, keys: [] } }
        const hit = keyAt(keys, a.t)
        const next = hit ? keys.map((k) => (k === hit ? { ...k, c: a.c } : k)) : sortKeys([...keys, { t: a.t, c: a.c, ease: DEFAULT_EASE }])
        return { ...c, warp: { ...w, keys: next } }
      }
      return { ...state, ...mapClips(state, f) }
    }
    // add a warp keyframe here (keeping the current shape), or remove the one that is here
    case 'warpToggleKey': {
      const f = (c) => {
        if (c.id !== a.id) return c
        const w = c.warp || { keys: [] }
        const keys = w.keys || []
        const hit = keyAt(keys, a.t)
        if (hit) {
          const rest = keys.filter((k) => k !== hit)
          return { ...c, warp: { fixed: rest.length ? w.fixed : hit.c, keys: rest } }
        }
        const cur = evalWarp(c, a.t) || WARP_ZERO
        return { ...c, warp: { ...w, keys: sortKeys([...keys, { t: a.t, c: cur, ease: DEFAULT_EASE }]) } }
      }
      return commit(state, mapClips(state, f))
    }
    case 'warpEase': {
      const f = (c) => {
        if (c.id !== a.id || !c.warp) return c
        const hit = keyAt(c.warp.keys, a.t)
        if (!hit) return c
        return { ...c, warp: { ...c.warp, keys: c.warp.keys.map((k) => (k === hit ? { ...k, ease: a.ease, bez: a.bez || k.bez } : k)) } }
      }
      return a.live ? { ...state, ...mapClips(state, f) } : commit(state, mapClips(state, f))
    }
    case 'warpReset': {
      const f = (c) => {
        if (c.id !== a.id) return c
        const { warp, ...rest } = c
        return rest
      }
      return commit(state, mapClips(state, f))
    }

    // live: retime all keyframes sitting at time `from` to time `to` (call 'checkpoint' first)
    case 'moveKeyframes': {
      const f = (c) => {
        if (c.id !== a.id) return c
        let out = c
        if (c.anim) {
          const anim = {}
          for (const [p, list] of Object.entries(c.anim)) {
            anim[p] = sortKeys((list || []).map((k) => (Math.abs(k.t - a.from) < KEY_EPS ? { ...k, t: a.to } : k)))
          }
          out = { ...out, anim }
        }
        if (c.warp && c.warp.keys && c.warp.keys.length) {
          out = { ...out, warp: { ...c.warp, keys: sortKeys(c.warp.keys.map((k) => (Math.abs(k.t - a.from) < KEY_EPS ? { ...k, t: a.to } : k))) } }
        }
        return out
      }
      return { ...state, ...mapClips(state, f) }
    }    case 'setTransition': {
      const clips = state.clips.map((c) => (c.id === a.id ? { ...c, transition: a.transition } : c))
      return commit(state, { clips })
    }

    // live slider updates (call 'checkpoint' first)
    case 'setTransitionDuration': {
      const clips = state.clips.map((c) =>
        c.id === a.id && c.transition ? { ...c, transition: { ...c.transition, duration: a.duration } } : c
      )
      return { ...state, clips }
    }

    // ---- group / ungroup
    // Group, in two steps:
    //  1. detached audio is attached back to its video (when selected with that video, or alone);
    //     deleted audio of a single selected video clip is restored
    //  2. whatever else is selected (video clips and audio clips, 2 or more) becomes one group
    case 'group': {
      const sel = new Set(state.selection)
      let clips = state.clips
      let audioClips = state.audioClips
      let changed = false

      // attach back: detached audio selected together with its own video, or selected on its own
      const single = state.selection.length === 1
      const back = audioClips.filter((x) => x.origin && sel.has(x.id) && clips.some((c) => c.id === x.origin) && (single || sel.has(x.origin)))
      if (back.length) {
        const ids = new Set(back.map((x) => x.id))
        audioClips = audioClips.filter((x) => !ids.has(x.id))
        clips = clips.map((c) => {
          const ns = back.filter((x) => x.origin === c.id).map((x) => x.stream)
          return ns.length ? { ...c, noAudio: (c.noAudio || []).filter((n) => !ns.includes(n)) } : c
        })
        changed = true
      }
      clips = clips.map((c) => {
        if (!single || !sel.has(c.id) || !(c.noAudio || []).length) return c
        const keep = (c.noAudio || []).filter((n) => audioClips.some((x) => x.origin === c.id && x.stream === n))
        if (keep.length === c.noAudio.length) return c
        changed = true
        return { ...c, noAudio: keep }
      })

      let overlayClips = state.overlayClips
      const memberOf = (id) => clips.find((c) => c.id === id) || overlayClips.find((c) => c.id === id) || audioClips.find((x) => x.id === id)
      const members = [...sel].filter((id) => memberOf(id))
      const gids = new Set(members.map((id) => memberOf(id).groupId))
      const alreadyOne = gids.size === 1 && !gids.has(undefined)
      let selection = members
      if (members.length >= 2 && !alreadyOne) {
        const gid = uid()
        const mset = new Set(members)
        clips = clips.map((c) => (mset.has(c.id) ? { ...c, groupId: gid } : c))
        overlayClips = overlayClips.map((c) => (mset.has(c.id) ? { ...c, groupId: gid } : c))
        audioClips = audioClips.map((x) => (mset.has(x.id) ? { ...x, groupId: gid } : x))
        changed = true
      }
      if (!changed) return state
      // drop detached-audio tracks that ended up empty
      const audioTracks = state.audioTracks.filter((t) => !t.id.startsWith('ug') || audioClips.some((x) => x.trackId === t.id))
      return { ...commit(state, { clips, audioClips, overlayClips }), audioTracks, selection }
    }

    // Ungroup:
    //  - if anything selected is in a group, the group(s) are dissolved
    //  - otherwise attached audio is detached: just the selected streams, or every stream of a
    //    selected video clip. Each stream becomes its own audio clip on its own track.
    case 'ungroup': {
      const sel = new Set(state.selection)
      const gids = new Set()
      for (const id of sel) {
        const it = itemOf(state, id)
        if (it && it.groupId) gids.add(it.groupId)
      }
      if (gids.size) {
        const clips = state.clips.map((c) => (gids.has(c.groupId) ? { ...c, groupId: undefined } : c))
        const audioClips = state.audioClips.map((x) => (gids.has(x.groupId) ? { ...x, groupId: undefined } : x))
        const overlayClips = state.overlayClips.map((c) => (gids.has(c.groupId) ? { ...c, groupId: undefined } : c))
        return commit(state, { clips, audioClips, overlayClips })
      }

      const lay = layout(state.clips)
      const tracks = [...state.audioTracks]
      const added = []
      const detached = new Map() // clipId -> streams detached
      for (const c of lay) {
        const m = state.media.find((x) => x.id === c.mediaId)
        if (!m || m.type !== 'video') continue
        const streams = []
        for (let n = 0; n < (m.audioStreams || []).length; n++) {
          if (!hasAttached(c, m, n)) continue
          if (sel.has(c.id) || sel.has(`sa:${c.id}:${n}`)) streams.push(n)
        }
        for (const n of streams) {
          const tid = 'ug' + n
          if (!tracks.some((t) => t.id === tid)) tracks.push({ id: tid, name: `Video audio ${n + 1} (detached)`, kind: 'free', volume: 1, mute: false })
          added.push({ id: uid(), mediaId: m.id, stream: n, trackId: tid, in: c.in, out: c.out, start: c.start, origin: c.id, groupId: c.groupId, ...avFields(c, n) })
        }
        if (streams.length) detached.set(c.id, streams)
      }
      if (!added.length) return state
      const clips = state.clips.map((c) => (detached.has(c.id) ? { ...c, noAudio: [...new Set([...(c.noAudio || []), ...detached.get(c.id)])] } : c))
      return { ...commit(state, { clips, audioClips: [...state.audioClips, ...added] }), audioTracks: tracks, selection: added.map((x) => x.id) }
    }

    // ---- overlay video tracks & clips
    case 'addVideoTrack': {
      const keys = rowKeys(state)
      return {
        ...state,
        videoTracks: [...state.videoTracks, { id: a.id, name: nextVideoName(state.videoTracks, state.mainName) }],
        rowOrder: ['v:' + a.id, ...keys],
      }
    }
    case 'removeVideoTrack': {
      if (!state.videoTracks.some((x) => x.id === a.id)) return state
      const gone = new Set(state.overlayClips.filter((c) => c.trackId === a.id).map((c) => c.id))
      return {
        ...commit(state, { overlayClips: state.overlayClips.filter((c) => c.trackId !== a.id), audioClips: state.audioClips.filter((c) => !gone.has(c.origin)) }),
        videoTracks: state.videoTracks.filter((x) => x.id !== a.id),
        selection: [],
      }
    }
    // rename any row: key = 'main' | 'v:<id>' | 's:<n>' | 'a:<id>'
    case 'renameRow': {
      const name = String(a.name || '').trim().slice(0, 40)
      if (!name) return state
      if (a.key === 'main') return { ...state, mainName: name }
      if (a.key.startsWith('v:')) return { ...state, videoTracks: state.videoTracks.map((t) => (t.id === a.key.slice(2) ? { ...t, name } : t)) }
      if (a.key.startsWith('a:')) return { ...state, audioTracks: state.audioTracks.map((t) => (t.id === a.key.slice(2) ? { ...t, name } : t)) }
      if (a.key.startsWith('s:')) {
        const n = +a.key.slice(2)
        return { ...state, streamSettings: { ...state.streamSettings, [n]: { volume: 1, mute: false, ...state.streamSettings[n], name } } }
      }
      return state
    }
    // drag a row to a new place: toIndex counts in the list of rows with this one taken out
    case 'moveRow': {
      const keys = rowKeys(state)
      if (!keys.includes(a.key)) return state
      const rest = keys.filter((k) => k !== a.key)
      const idx = clamp(a.toIndex, 0, rest.length)
      const next = [...rest.slice(0, idx), a.key, ...rest.slice(idx)]
      if (next.every((k, i) => k === keys[i])) return state
      return { ...state, rowOrder: next }
    }

    // drop media on an overlay track (the first one, or a new one, if trackId is missing)
    case 'addOverlayClip': {
      const m = state.media.find((x) => x.id === a.mediaId)
      if (!m || m.type === 'audio') return state
      let videoTracks = state.videoTracks
      let rowOrder = state.rowOrder
      let trackId = a.trackId
      if (!trackId) {
        if (videoTracks.length) trackId = videoTracks[0].id
        else {
          trackId = a.newTrackId || uid()
          rowOrder = ['v:' + trackId, ...rowKeys(state)]
          videoTracks = [...videoTracks, { id: trackId, name: nextVideoName(videoTracks, state.mainName) }]
        }
      }
      const gid = m.type === 'video' && (m.audioStreams || []).length ? uid() : undefined
      const clip = { id: uid(), mediaId: m.id, trackId, in: 0, out: m.duration || 3, start: Math.max(0, a.start || 0), groupId: gid }
      if (m.type === 'image') clip.out = 3
      // the video's own sound goes to detached audio clips grouped with it
      const tracks = [...state.audioTracks]
      const added = []
      if (gid) {
        for (let n = 0; n < m.audioStreams.length; n++) {
          const tid = 'ug' + n
          if (!tracks.some((t) => t.id === tid)) tracks.push({ id: tid, name: `Video audio ${n + 1} (detached)`, kind: 'free', volume: 1, mute: false })
          added.push({ id: uid(), mediaId: m.id, stream: n, trackId: tid, in: 0, out: clip.out, start: clip.start, origin: clip.id, groupId: gid })
        }
      }
      return {
        ...commit(state, { overlayClips: [...state.overlayClips, clip], audioClips: [...state.audioClips, ...added] }),
        videoTracks,
        rowOrder,
        audioTracks: tracks,
        selection: [clip.id, ...added.map((x) => x.id)],
      }
    }

    // live drag of overlay and audio clips (call 'checkpoint' first); moves = [{id, start, trackId?}]
    case 'moveItems': {
      const to = new Map(a.moves.map((m) => [m.id, m]))
      return {
        ...state,
        overlayClips: state.overlayClips.map((c) => (to.has(c.id) ? { ...c, start: Math.max(0, to.get(c.id).start), trackId: to.get(c.id).trackId || c.trackId } : c)),
        audioClips: state.audioClips.map((c) => (to.has(c.id) ? { ...c, start: Math.max(0, to.get(c.id).start), trackId: to.get(c.id).trackId || c.trackId } : c)),
      }
    }
    // A clip of the main video track goes onto an overlay track (a.trackId) at time a.start. Its own sound comes along
    // as detached audio clips grouped with it, and the gap it leaves in the main track closes.
    case 'clipToOverlay': {
      const before = layout(state.clips)
      const c = before.find((x) => x.id === a.id)
      const m = c && state.media.find((x) => x.id === c.mediaId)
      if (!c || !m || !state.videoTracks.some((t) => t.id === a.trackId)) return state
      const start = Math.max(0, a.start || 0)
      const streams = (m.audioStreams || []).map((_, n) => n).filter((n) => hasAttached(c, m, n))
      const gid = c.groupId || (streams.length ? uid() : undefined)
      const { dur, ov, transition, noAudio, ...keep } = c
      const clip = { ...keep, trackId: a.trackId, start, groupId: gid }
      const clips = state.clips.filter((x) => x.id !== c.id)
      const tracks = [...state.audioTracks]
      const added = []
      for (const n of streams) {
        const tid = 'ug' + n
        if (!tracks.some((t) => t.id === tid)) tracks.push({ id: tid, name: `Video audio ${n + 1} (detached)`, kind: 'free', volume: 1, mute: false })
        added.push({ id: uid(), mediaId: m.id, stream: n, trackId: tid, in: c.in, out: c.out, start, origin: c.id, groupId: gid, ...avFields(c, n) })
      }
      // audio grouped with the clips that moved up or down the main track follows them
      const after = layout(clips)
      const delta = new Map()
      for (const x of after) {
        const b = before.find((y) => y.id === x.id)
        if (x.groupId && b && !delta.has(x.groupId)) delta.set(x.groupId, x.start - b.start)
      }
      const shifted = state.audioClips.map((x) => {
        if (!x.groupId) return x
        if (x.groupId === c.groupId) return { ...x, start: Math.max(0, x.start + start - c.start) }
        return delta.has(x.groupId) ? { ...x, start: Math.max(0, x.start + delta.get(x.groupId)) } : x
      })
      return { ...commit(state, { clips, overlayClips: [...state.overlayClips, clip], audioClips: [...shifted, ...added] }), audioTracks: tracks, selection: [clip.id] }
    }
    // An overlay clip goes onto the main video track at index a.toIndex. Its sound goes back to being attached.
    case 'overlayToMain': {
      const c = state.overlayClips.find((x) => x.id === a.id)
      const m = c && !c.text && state.media.find((x) => x.id === c.mediaId)
      if (!c || !m) return state
      const before = layout(state.clips)
      const { trackId, start, ...keep } = c
      const own = state.audioClips.filter((x) => x.origin === c.id)
      const gone = new Set(own.map((x) => x.id))
      // the group stays only if something else belongs to it
      const shares = !!c.groupId && [...state.clips, ...state.overlayClips.filter((x) => x.id !== c.id), ...state.audioClips.filter((x) => !gone.has(x.id))].some((x) => x.groupId === c.groupId)
      const clip = { ...keep, transition: null, noAudio: [], groupId: shares ? c.groupId : undefined }
      const idx = clamp(a.toIndex, 0, state.clips.length)
      const clips = [...state.clips.slice(0, idx), clip, ...state.clips.slice(idx)]
      const after = layout(clips)
      const delta = new Map()
      for (const x of after) {
        if (!x.groupId || delta.has(x.groupId)) continue
        const b = x.id === c.id ? { start: c.start } : before.find((y) => y.id === x.id)
        if (b) delta.set(x.groupId, x.start - b.start)
      }
      const audioClips = state.audioClips
        .filter((x) => !gone.has(x.id))
        .map((x) => (x.groupId && delta.has(x.groupId) ? { ...x, start: Math.max(0, x.start + delta.get(x.groupId)) } : x))
      const audioTracks = state.audioTracks.filter((t) => !t.id.startsWith('ug') || audioClips.some((x) => x.trackId === t.id))
      return { ...commit(state, { clips, overlayClips: state.overlayClips.filter((x) => x.id !== c.id), audioClips }), audioTracks, selection: [c.id] }
    }
    // live trim of an overlay clip; value = new absolute in/out (source seconds)
    case 'trimOverlay': {
      const overlayClips = state.overlayClips.map((c) => {
        if (c.id !== a.id) return c
        const m = state.media.find((x) => x.id === c.mediaId)
        const maxOut = m && m.type === 'video' ? m.duration : 3600
        const sp = speedOf(c)
        // the side that is at the left end of the clip on the timeline moves the clip's start
        if (a.side === 'out') {
          const nout = clamp(a.value, c.in + MIN_CLIP, maxOut)
          return { ...c, out: nout, start: c.reverse ? Math.max(0, c.start + (c.out - nout) / sp) : c.start }
        }
        const nin = clamp(a.value, 0, c.out - MIN_CLIP)
        return { ...c, in: nin, start: c.reverse ? c.start : Math.max(0, c.start + (nin - c.in) / sp) }
      })
      return { ...state, overlayClips }
    }

    // ---- titles and text: a clip on a video track whose picture is drawn from text (see textRender.js)
    case 'addText': {
      let videoTracks = state.videoTracks
      let rowOrder = state.rowOrder
      let tr = videoTracks.find((x) => /^Text/.test(x.name))
      if (!tr) {
        tr = { id: a.trackId || uid(), name: 'Text 1' }
        videoTracks = [...videoTracks, tr]
        rowOrder = ['v:' + tr.id, ...rowKeys(state)]
      }
      const text = { ...TEXT_DEFAULTS, ...(a.text || {}) }
      const clip = { id: a.id || uid(), mediaId: null, trackId: tr.id, in: 0, out: a.dur || 3, start: Math.max(0, a.t || 0), text }
      if (a.y) clip.tf = { ...DEFAULTS, y: a.y }
      return { ...commit(state, { overlayClips: [...state.overlayClips, clip] }), videoTracks, rowOrder, selection: [clip.id] }
    }
    // Captions made from speech: one text clip per caption, on a track called "Captions" (made if needed).
    // items = [{start, dur, text}] in timeline seconds; style = one of TEXT_PRESETS ({text, y}); replace = remove the earlier captions first
    case 'addCaptions': {
      let videoTracks = state.videoTracks
      let rowOrder = state.rowOrder
      let tr = videoTracks.find((x) => x.name === 'Captions')
      if (!tr) {
        tr = { id: a.trackId || uid(), name: 'Captions' }
        videoTracks = [...videoTracks, tr]
        rowOrder = ['v:' + tr.id, ...rowKeys(state)]
      }
      const keep = a.replace ? state.overlayClips.filter((c) => !(c.trackId === tr.id && c.caption)) : state.overlayClips
      const style = a.style || {}
      const added = (a.items || [])
        .filter((i) => i.text && i.dur > 0.05)
        .map((i) => ({ id: uid(), mediaId: null, trackId: tr.id, in: 0, out: i.dur, start: Math.max(0, i.start), caption: true, text: { ...TEXT_DEFAULTS, ...(style.text || {}), content: i.text }, tf: { ...DEFAULTS, y: style.y || 0 } }))
      if (!added.length && keep.length === state.overlayClips.length) return state
      return { ...commit(state, { overlayClips: [...keep, ...added] }), videoTracks, rowOrder, selection: added.map((c) => c.id) }
    }
    // change the text of a clip; patch = {content: 'Hi'} / {outline: {on: true}} ...; live = while dragging a slider
    case 'setText': {
      const f = (c) => {
        if (c.id !== a.id || !c.text) return c
        const text = { ...c.text }
        for (const [k, v] of Object.entries(a.patch)) text[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(text[k] || {}), ...v } : v
        return { ...c, text }
      }
      return a.live ? { ...state, overlayClips: state.overlayClips.map(f) } : commit(state, { overlayClips: state.overlayClips.map(f) })
    }
    // a look from TEXT_PRESETS: the text style and the position
    case 'applyTextPreset': {
      const f = (c) => {
        if (c.id !== a.id || !c.text) return c
        const text = { ...TEXT_DEFAULTS, content: c.text.content, ...a.text }
        return { ...c, text, tf: { ...DEFAULTS, ...c.tf, y: a.y || 0 } }
      }
      return commit(state, { overlayClips: state.overlayClips.map(f) })
    }
    // ---- masks (see masks.js). patch = {shape: 'ellipse'} / {feather: 20} / {pts: [...]}; live = while dragging
    case 'setMask': {
      const f = (c) => {
        if (c.id !== a.id) return c
        const base = c.mask || MASK_DEFAULT
        return { ...c, mask: { ...base, ...a.patch } }
      }
      return a.live ? { ...state, ...mapClips(state, f) } : commit(state, mapClips(state, f))
    }
    // result of tracking: the mask lasts from..to (source seconds) and has its own outline for every moment.
    // frames = [{t, pts}] sorted by t
    case 'setMaskOutline': {
      const f = (c) => {
        if (c.id !== a.id || !c.mask) return c
        const anim = { ...(c.anim || {}) }
        for (const k of ['mx', 'my', 'ms']) delete anim[k] // the outlines already hold the movement
        return { ...c, anim, mask: { ...c.mask, from: a.from, to: a.to, frames: a.frames, pts: a.frames[0].pts } }
      }
      return commit(state, mapClips(state, f))
    }
    // correct one moment of a tracked mask: its outline at source second a.t becomes a.pts (live = while dragging)
    case 'setMaskFrame': {
      const f = (c) => {
        if (c.id !== a.id || !c.mask || !c.mask.frames || !c.mask.frames.length) return c
        const frames = c.mask.frames.slice()
        const i = frameIndexAt(frames, a.t)
        frames[i] = { ...frames[i], pts: a.pts }
        return { ...c, mask: { ...c.mask, frames, pts: i === 0 ? a.pts : c.mask.pts } }
      }
      return a.live ? { ...state, ...mapClips(state, f) } : commit(state, mapClips(state, f))
    }
    case 'clearMask': {
      const f = (c) => {
        if (c.id !== a.id || !c.mask) return c
        const { mask, ...rest } = c
        const anim = { ...(c.anim || {}) }
        for (const k of ['mx', 'my', 'ms']) delete anim[k]
        return { ...rest, anim }
      }
      return commit(state, mapClips(state, f))
    }
    // "Subject in front of text": a copy of the clip on a new track at the top, with the same mask, so the masked
    // copy can sit in front of the text that is on the tracks below it
    case 'maskCopyAbove': {
      const c = layout(state.clips).find((x) => x.id === a.id) || overlayLayout(state.overlayClips).find((x) => x.id === a.id)
      if (!c || c.text) return state
      const trackId = uid()
      const { start, dur, ov, transition, noAudio, origin, groupId, ...keep } = c
      const copy = { ...JSON.parse(JSON.stringify(keep)), id: uid(), trackId, start: c.start }
      return {
        ...commit(state, { overlayClips: [...state.overlayClips, copy] }),
        videoTracks: [...state.videoTracks, { id: trackId, name: 'Subject cutout' }],
        rowOrder: ['v:' + trackId, ...rowKeys(state)],
        selection: [copy.id],
      }
    }
    // picture effects: blur, sharpen, vignette, glow, chroma key and colour correction (see effects.js).
    // patch = {blur: 20} / {key: {on: true}} / {cc: {contrast: 120}}; live = a slider is being dragged (checkpoint first)
    case 'setFx': {
      const f = (c) => {
        if (c.id !== a.id) return c
        const fx = { ...(c.fx || {}) }
        for (const [k, v] of Object.entries(a.patch)) fx[k] = k === 'key' || k === 'cc' ? { ...(fx[k] || {}), ...v } : v
        return { ...c, fx }
      }
      return a.live ? { ...state, ...mapClips(state, f) } : commit(state, mapClips(state, f))
    }
    case 'resetFx': {
      const f = (c) => {
        if (c.id !== a.id || !c.fx) return c
        if (a.only === 'cc') return { ...c, fx: { ...c.fx, cc: undefined } }
        const { fx, ...rest } = c
        return a.only === 'effects' && fx.cc ? { ...rest, fx: { cc: fx.cc } } : rest
      }
      return commit(state, mapClips(state, f))
    }
    // speed (1 = normal, 2 = twice as fast, 0.5 = slow motion) and reverse, for main and overlay clips
    case 'setSpeed': {
      const sp = clamp(+a.speed || 1, 0.1, 8)
      const f = (c) => (c.id === a.id ? { ...c, speed: sp === 1 ? undefined : sp } : c)
      return a.live ? { ...state, ...mapClips(state, f) } : commit(state, mapClips(state, f))
    }
    case 'setReverse': {
      const f = (c) => (c.id === a.id ? { ...c, reverse: a.value ? true : undefined } : c)
      return commit(state, mapClips(state, f))
    }

    // ---- audio tracks & clips
    case 'addAudioTrack': {
      return { ...state, audioTracks: [...state.audioTracks, { id: a.id, name: nextAudioName(state.audioTracks), kind: 'free', volume: 1, mute: false }] }
    }
    case 'removeAudioTrack': {
      if (!state.audioTracks.some((x) => x.id === a.id)) return state
      return {
        ...commit(state, { audioClips: state.audioClips.filter((c) => c.trackId !== a.id) }),
        audioTracks: state.audioTracks.filter((x) => x.id !== a.id),
        selection: [],
      }
    }
    case 'setTrack':
      return { ...state, audioTracks: state.audioTracks.map((t) => (t.id === a.id ? { ...t, ...a.patch } : t)) }
    case 'setStream':
      return { ...state, streamSettings: { ...state.streamSettings, [a.n]: { volume: 1, mute: false, ...state.streamSettings[a.n], ...a.patch } } }
    // what was said in a video (from Captions): words [{text, s, e}] in seconds of the file; they replace the words of
    // the part [from, to] of the file that was listened to
    case 'setTranscript': {
      const old = (state.transcripts[a.mediaId] && state.transcripts[a.mediaId].words) || []
      const keep = old.filter((w) => w.s < a.from - 1e-6 || w.s >= a.to - 1e-6)
      const words = [...keep, ...a.words].sort((p, q) => p.s - q.s)
      return { ...state, transcripts: { ...state.transcripts, [a.mediaId]: { words } } }
    }
    // Cut time ranges out of the timeline and close the gaps ("edit by text"): ranges = [[t0, t1], ...] in seconds
    case 'rippleDelete': {
      if ((state.lockedRows || []).includes('main')) return state
      const ranges = (a.ranges || []).filter((r) => r[1] - r[0] > 0.001).sort((p, q) => q[0] - p[0]) // last first, so earlier times stay valid
      if (!ranges.length) return state
      let cur = { clips: state.clips, overlayClips: state.overlayClips, audioClips: state.audioClips, markers: state.markers }
      for (const [t0, t1] of ranges) cur = cutRange(cur, t0, t1)
      return {
        ...commit(state, { clips: cur.clips, overlayClips: cur.overlayClips, audioClips: cur.audioClips }),
        markers: cur.markers,
        selection: [],
        playhead: ranges[ranges.length - 1][0],
      }
    }
    // volume / mute of single audio clips (ids: 'sa:<clip>:<n>' for the sound of a video clip, or audio clip ids).
    // live: while a slider is dragged (call 'checkpoint' first), so the whole drag is one undo step
    case 'setClipAudio': {
      const ids = a.ids || [a.id]
      const idSet = new Set(ids)
      const per = new Map() // video clip id -> its stream numbers
      for (const id of ids) {
        if (!id.startsWith('sa:')) continue
        const [, cid, n] = id.split(':')
        per.set(cid, [...(per.get(cid) || []), +n])
      }
      const clips = state.clips.map((c) => {
        if (!per.has(c.id)) return c
        const av = { ...(c.av || {}) }
        for (const n of per.get(c.id)) av[n] = mergeAudio((c.av && c.av[n]) || {}, a.patch)
        return { ...c, av }
      })
      const audioClips = state.audioClips.map((x) => (idSet.has(x.id) ? mergeAudio(x, a.patch) : x))
      return a.live ? { ...state, clips, audioClips } : commit(state, { clips, audioClips })
    }

    case 'addAudioClip': {
      const m = state.media.find((x) => x.id === a.mediaId)
      if (!m || m.type !== 'audio') return state
      let tracks = state.audioTracks
      let trackId = a.trackId
      const want = Math.max(0, a.start || 0)
      const len = m.duration || 0
      const on = (tid) => state.audioClips.filter((x) => x.trackId === tid)
      let start = want
      if (trackId) {
        // dropped on a track: it goes where it is dropped, or just after what is in the way (a gap that is big enough is used)
        start = nextFree(on(trackId), want, len)
      } else {
        // no track given (double-click, or dropped on a video's sound lane): the first track that has room there, else a new track
        const free = tracks.find((t) => !t.id.startsWith('ug') && nextFree(on(t.id), want, len) === want)
        if (free) trackId = free.id
        else {
          trackId = a.newTrackId || uid()
          tracks = [...tracks, { id: trackId, name: nextAudioName(tracks), kind: 'free', volume: 1, mute: false }]
        }
      }
      const clip = { id: uid(), mediaId: m.id, trackId, in: 0, out: m.duration, start }
      return { ...commit(state, { audioClips: [...state.audioClips, clip] }), audioTracks: tracks, selection: [clip.id] }
    }

    // live drag of one or more audio clips (call 'checkpoint' first); moves = [{id, start}]
    case 'moveAudioBatch': {
      const to = new Map(a.moves.map((m) => [m.id, m.start]))
      return { ...state, audioClips: state.audioClips.map((c) => (to.has(c.id) ? { ...c, start: Math.max(0, to.get(c.id)) } : c)) }
    }

    // live trim; value = new absolute in/out (source seconds). Trimming the left edge keeps the
    // remaining sound where it was on the timeline.
    case 'trimAudio': {
      const audioClips = state.audioClips.map((c) => {
        if (c.id !== a.id) return c
        const m = state.media.find((x) => x.id === c.mediaId)
        if (a.side === 'out') return { ...c, out: clamp(a.value, c.in + MIN_CLIP, m ? m.duration : c.out) }
        const nin = clamp(a.value, 0, c.out - MIN_CLIP)
        const d = nin - c.in
        return { ...c, in: nin, start: Math.max(0, c.start + d) }
      })
      return { ...state, audioClips }
    }

    case 'setAspect':
      return ASPECTS.some((x) => x.id === a.aspect) ? { ...state, aspect: a.aspect } : state

    // ---- markers, locking, hiding, colour labels
    case 'addMarker': {
      const id = a.id || uid()
      return { ...state, markers: [...state.markers, { id, t: Math.max(0, a.t), label: a.label || '' }].sort((x, y) => x.t - y.t) }
    }
    case 'removeMarker':
      return { ...state, markers: state.markers.filter((m) => m.id !== a.id) }
    case 'renameMarker':
      return { ...state, markers: state.markers.map((m) => (m.id === a.id ? { ...m, label: a.label } : m)) }
    case 'moveMarker':
      return { ...state, markers: state.markers.map((m) => (m.id === a.id ? { ...m, t: Math.max(0, a.t) } : m)).sort((x, y) => x.t - y.t) }
    case 'toggleRowLock': {
      const on = state.lockedRows.includes(a.key)
      return { ...state, lockedRows: on ? state.lockedRows.filter((k) => k !== a.key) : [...state.lockedRows, a.key] }
    }
    case 'toggleRowHide': {
      const on = state.hiddenRows.includes(a.key)
      return { ...state, hiddenRows: on ? state.hiddenRows.filter((k) => k !== a.key) : [...state.hiddenRows, a.key] }
    }
    // colour label on video / overlay / audio clips (color = a name from LABELS, or null to clear)
    case 'setLabel': {
      const ids = new Set(a.ids)
      const f = (c) => (ids.has(c.id) ? { ...c, label: a.color || undefined } : c)
      return commit(state, { clips: state.clips.map(f), overlayClips: state.overlayClips.map(f), audioClips: state.audioClips.map(f) })
    }

    // ---- copy / paste / duplicate
    case 'paste':
      return clipboard ? pasteItems(state, clipboard, a.t) : state
    case 'duplicate': {
      const cb = cloneSelection(state, state.selection)
      return cb.main.length + cb.over.length + cb.aud.length ? pasteItems(state, cb, null) : state
    }
    // ---- selection (selecting a group member selects the whole group)
    case 'select': {
      if (a.id == null) return state.selection.length ? { ...state, selection: [] } : state
      const members = expand(state, [a.id])
      if (a.additive) {
        const has = state.selection.includes(a.id)
        const rest = state.selection.filter((x) => !members.includes(x))
        return { ...state, selection: has ? rest : [...rest, ...members] }
      }
      return { ...state, selection: members }
    }
    case 'selectMany':
      return { ...state, selection: expand(state, a.ids) }

    case 'setPlayhead':
      return {
        ...state,
        playhead: Math.max(0, a.t),
        seekId: a.user ? state.seekId + 1 : state.seekId,
      }

    case 'setPlaying':
      return { ...state, playing: a.value }

    // ===== image projects (the image editor) =====
    // A layer is an overlay clip on a track of its own that is shown from second 0 for a very long time. The layer
    // order is the track order, and hiding / locking use the same row switches as the timeline. Paint layers keep
    // their brush strokes (clip.paint = {w, h, strokes}) so undo and saving work like for everything else.
    case 'imgNew':
      return { ...initialState, canvas: { w: a.w, h: a.h, bg: a.bg || '#ffffff' } }
    case 'loadImageProject':
      return {
        ...initialState,
        canvas: a.canvas,
        media: a.media || [],
        overlayClips: a.overlayClips || [],
        videoTracks: a.videoTracks || [],
        rowOrder: a.rowOrder || [],
        lockedRows: a.lockedRows || [],
        hiddenRows: a.hiddenRows || [],
      }
    case 'setCanvas': {
      const c = { ...state.canvas, ...a.patch }
      c.w = clamp(Math.round(c.w) || 16, 16, 16384)
      c.h = clamp(Math.round(c.h) || 16, 16, 16384)
      return commit(state, { canvas: c })
    }
    case 'imgAddImage': {
      const m = state.media.find((x) => x.id === a.mediaId)
      if (!m || m.type !== 'image') return state
      // the first picture of an empty project decides the size of the canvas
      let canvas = state.canvas
      if (a.fitCanvas && !state.overlayClips.length && m.width && m.height) {
        const k = Math.min(1, 8192 / Math.max(m.width, m.height))
        canvas = { ...canvas, w: Math.round(m.width * k), h: Math.round(m.height * k) }
      }
      return addImageLayer(state, { id: a.id, mediaId: m.id }, m.name.replace(/\.[^.]+$/, ''), { canvas })
    }
    case 'imgAddPaint':
      return addImageLayer(state, { id: a.id, mediaId: null, paint: { w: state.canvas.w, h: state.canvas.h, strokes: [] } }, nextLayerName(state, 'Paint'))
    // a layer of pixels to paint on (see paint/raster.js). The pixels are not in the state; raster.rev counts the changes made to them.
    case 'imgAddRaster':
      return addImageLayer(
        state,
        { id: a.id, mediaId: null, raster: { id: a.rasterId || uid(), rev: 0, w: a.w || state.canvas.w, h: a.h || state.canvas.h } },
        a.name || nextLayerName(state, 'Layer'),
      )
    // how a layer mixes with the layers under it (see BLEND_LIST in glRenderer.js); 'normal' is the plain way
    case 'setBlend': {
      const f = (c) => {
        if (c.id !== a.id) return c
        const n = { ...c, blend: a.blend }
        if (!a.blend || a.blend === 'normal') delete n.blend
        return n
      }
      return commit(state, { overlayClips: state.overlayClips.map(f) })
    }
    // the pixels of this layer were changed: a new step to undo
    case 'rasterCommit': {
      const f = (c) => (c.id === a.id && c.raster ? { ...c, raster: { ...c.raster, rev: a.rev } } : c)
      return commit(state, { overlayClips: state.overlayClips.map(f) })
    }
    // alpha lock and the like
    case 'setRaster': {
      const f = (c) => (c.id === a.id && c.raster ? { ...c, raster: { ...c.raster, ...a.patch } } : c)
      return commit(state, { overlayClips: state.overlayClips.map(f) })
    }
    // a picture / text / old paint layer turned into pixels (they were drawn into raster `rasterId` by the editor, with move, size,
    // mask and effects baked in), so the original look stays and the layer can be painted on
    case 'imgRasterize': {
      const c0 = state.overlayClips.find((x) => x.id === a.id)
      if (!c0) return state
      const clean = { id: c0.id, trackId: c0.trackId, in: c0.in, out: c0.out, start: c0.start, mediaId: null, raster: { id: a.rasterId, rev: 0, w: a.w, h: a.h } }
      return commit(state, { overlayClips: state.overlayClips.map((x) => (x.id === a.id ? clean : x)) })
    }
    case 'imgAddText':
      return addImageLayer(state, { id: a.id, mediaId: null, text: { ...TEXT_DEFAULTS, ...(a.text || {}), animIn: 'none', animOut: 'none' }, tf: a.y ? { ...DEFAULTS, y: a.y } : undefined }, nextLayerName(state, 'Text'))
    case 'imgDuplicate': {
      const c = state.overlayClips.find((x) => x.id === a.id)
      if (!c) return state
      const tr = state.videoTracks.find((t) => t.id === c.trackId)
      const trackId = uid()
      const copy = { ...JSON.parse(JSON.stringify(c)), id: uid(), trackId }
      // a copy of a pixel layer gets pixels of its own, starting as the original's are now
      if (c.raster) copy.raster = { id: uid(), rev: 0, w: c.raster.w, h: c.raster.h, alphaLock: c.raster.alphaLock, from: { id: c.raster.id, rev: c.raster.rev || 0 } }
      const keys = rowKeys(state)
      const at = keys.indexOf('v:' + c.trackId)
      return {
        ...commit(state, { overlayClips: [...state.overlayClips, copy] }),
        videoTracks: [...state.videoTracks, { id: trackId, name: ((tr && tr.name) || 'Layer') + ' copy' }],
        rowOrder: [...keys.slice(0, at), 'v:' + trackId, ...keys.slice(at)],
        selection: [copy.id],
      }
    }
    case 'imgRemove': {
      const c = state.overlayClips.find((x) => x.id === a.id)
      if (!c) return state
      const key = 'v:' + c.trackId
      return {
        ...commit(state, { overlayClips: state.overlayClips.filter((x) => x.id !== a.id) }),
        videoTracks: state.videoTracks.filter((t) => t.id !== c.trackId),
        rowOrder: state.rowOrder.filter((k) => k !== key),
        lockedRows: state.lockedRows.filter((k) => k !== key),
        hiddenRows: state.hiddenRows.filter((k) => k !== key),
        selection: state.selection.filter((x) => x !== a.id),
      }
    }
    // move a layer 'up' / 'down' one place, or to the 'top' / 'bottom'
    case 'imgMove': {
      const c = state.overlayClips.find((x) => x.id === a.id)
      if (!c) return state
      const keys = rowKeys(state)
      const layers = keys.filter((k) => k.startsWith('v:'))
      const key = 'v:' + c.trackId
      const i = layers.indexOf(key)
      const j = a.to === 'top' ? 0 : a.to === 'bottom' ? layers.length - 1 : a.to === 'up' ? i - 1 : i + 1
      if (i < 0 || j < 0 || j >= layers.length || j === i) return state
      const order = layers.filter((k) => k !== key)
      order.splice(j, 0, key)
      let n = 0
      return { ...state, rowOrder: keys.map((k) => (k.startsWith('v:') ? order[n++] : k)) }
    }
    // put a layer at place a.index of the layer list (0 = the top one)
    case 'imgMoveTo': {
      const c = state.overlayClips.find((x) => x.id === a.id)
      if (!c) return state
      const keys = rowKeys(state)
      const key = 'v:' + c.trackId
      const order = keys.filter((k) => k.startsWith('v:') && k !== key)
      order.splice(clamp(a.index, 0, order.length), 0, key)
      let n = 0
      return { ...state, rowOrder: keys.map((k) => (k.startsWith('v:') ? order[n++] : k)) }
    }
    case 'paintStroke': {
      const f = (c) => (c.id === a.id && c.paint ? { ...c, paint: { ...c.paint, strokes: [...c.paint.strokes, a.stroke] } } : c)
      return commit(state, { overlayClips: state.overlayClips.map(f) })
    }
    case 'paintClear': {
      const f = (c) => (c.id === a.id && c.paint ? { ...c, paint: { ...c.paint, strokes: [] } } : c)
      return commit(state, { overlayClips: state.overlayClips.map(f) })
    }

    case 'undo': {
      if (!state.past.length) return state
      const prev = state.past[state.past.length - 1]
      return ensureTracks({ ...state, ...prev, past: state.past.slice(0, -1), future: [snap(state), ...state.future] })
    }
    case 'redo': {
      if (!state.future.length) return state
      const next = state.future[0]
      return ensureTracks({ ...state, ...next, past: [...state.past, snap(state)], future: state.future.slice(1) })
    }
    default:
      return state
  }
}

// Used to enable/disable the toolbar buttons: an action is possible if it would change something.
export const canGroup = (state) => reducer(state, { type: 'group' }) !== state
export const canUngroup = (state) => reducer(state, { type: 'ungroup' }) !== state

export function toUrl(p) {
  return 'file:///' + encodeURI(p.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F')
}

// a clip length for the timeline: 12.3s, then 52m 19s, then 1h 05m 12s
export function fmtDur(t) {
  if (t < 60) return t.toFixed(1) + 's'
  const total = Math.round(t)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
  return `${m}m ${String(s).padStart(2, '0')}s`
}

export function fmtTime(t) {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  const f = Math.floor((t % 1) * 30)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`
}
