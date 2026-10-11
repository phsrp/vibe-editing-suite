// Video export, renderer side. See electron/exporter.js for the overall approach.
import { drawText, loadFont } from './textRender.js'
import { aspectRatio } from './state.js'
import { speedOf, srcAt, layout, overlayLayout, totalDuration, projectDuration, videoRowsBottomUp, hasAttached, streamCount, toUrl, streamAudioOf, audioClipVol, cleanActive } from './state.js'
import { createRenderer } from './glRenderer.js'
import { evalTransform, evalWarp, hasTransform } from './motion.js'
import { maskAt } from './masks.js'

export const RESOLUTIONS = { '720p': [1280, 720], '1080p': [1920, 1080], '2K': [2560, 1440], '4K': [3840, 2160] }
// the size of the exported picture: the short side is 1080 / 1440 / 2160 and the long side follows the project's shape
export function frameSize(res, state) {
  const short = RESOLUTIONS[res][1]
  const r = aspectRatio(state)
  const even = (v) => Math.round(v / 2) * 2
  return r >= 1 ? [even(short * r), short] : [short, even(short / r)]
}
export const DEFAULT_BITRATE = { '720p': 6, '1080p': 12, '2K': 24, '4K': 50 }
export const PRESETS = { fast: 'veryfast', balanced: 'medium', best: 'slow' }

export const defaultSettings = { res: '1080p', fps: 30, codec: 'h264', bitrate: 12, speed: 'balanced', audioMode: 'mix', container: 'mp4', audioKbps: 192, encoder: 'cpu', outputKind: 'video', audioFormat: 'mp3', loudness: 'off', preset: 'custom' }

// Cut the timeline into pieces: plain clip pieces (read by FFmpeg) and transition pieces (rendered here),
// and work out the audio tracks. Frame counts come from rounding the piece boundaries, so the
// pieces always add up to the exact length of the timeline.
export function buildPlan(state, s) {
  const [w, h] = frameSize(s.res, state)
  const fps = s.fps
  const audioOnly = s.outputKind === 'audio' // render just the sound (MP3 / M4A / WAV)
  const lay = layout(state.clips)
  const hid = new Set(state.hiddenRows || []) // hidden rows are not exported
  const mainHidden = hid.has('main')
  const ovl = overlayLayout(state.overlayClips).filter((c) => !hid.has('v:' + c.trackId))
  if (!lay.length && !ovl.length) throw new Error('The timeline is empty.')
  const mediaOf = (id) => state.media.find((m) => m.id === id)
  const mainTotal = totalDuration(state.clips)
  const total = projectDuration(state)

  for (const c of [...lay, ...ovl]) {
    if (c.text) continue
    const m = mediaOf(c.mediaId)
    if (!m || m.missing) throw new Error(`A source file is missing: ${m ? m.name : 'unknown'}. Reconnect it by re-importing, then try again.`)
  }

  // Where a clip's picture comes from for the project time span u0..u1: the file (a reversed clip uses a reversed
  // copy of its range, made before the export starts), where in that file to start, and the speed.
  const sideFor = (c, u0, u1) => {
    if (c.text) return { text: c.text, isText: true, file: 'text', start: 0, speed: 1, tl0: u0, clip: c } // drawn, not read from a file
    const m = mediaOf(c.mediaId)
    const sp = speedOf(c)
    const rel = (u0 - c.start) * sp
    const isImage = m.type === 'image'
    if (c.reverse && !isImage) return { file: null, proxy: { file: m.path, from: c.in, to: c.out }, isImage, start: rel, speed: sp, tl0: u0, clip: c }
    return { file: m.path, isImage, start: c.in + rel, speed: sp, tl0: u0, clip: c }
  }

  // main video, cut into pieces (a transition, a clip, or a clip with motion / warp)
  const raw = []
  if (!mainHidden) lay.forEach((c, i) => {
    const next = lay[i + 1]
    const nextOv = next ? next.ov : 0
    // empty time before this clip (a gap the user left): black, with overlays on top
    if (c.gap > 0) {
      const g0 = i === 0 ? 0 : lay[i - 1].start + lay[i - 1].dur
      if (c.start - g0 > 1e-6) raw.push({ kind: 'none', t0: g0, t1: c.start })
    }
    if (c.ov > 0) raw.push({ kind: 'trans', t0: c.start, t1: c.start + c.ov, a: lay[i - 1], b: c, name: c.transition.name })
    const t0 = c.start + c.ov
    const t1 = c.start + c.dur - nextOv
    if (t1 - t0 > 1e-6) {
      // a clip with motion (position / scale / rotation / opacity), warp or effects must go through the effects renderer
      if (hasTransform(c)) raw.push({ kind: 'solo', t0, t1, clip: c })
      else raw.push({ kind: 'clip', t0, t1, clip: c })
    }
  })
  // nothing on the main track (before the first / after the last clip): black, with overlays on top
  const mainEnd = mainHidden ? 0 : mainTotal
  if (total - mainEnd > 1e-6) raw.push({ kind: 'none', t0: mainEnd, t1: total })

  // Overlay clips start and end anywhere: cut the pieces there too. Wherever an overlay is showing, the
  // piece is rendered with the effects renderer, with all the layers stacked.
  const cuts = new Set()
  for (const c of ovl) {
    cuts.add(c.start)
    cuts.add(c.start + c.dur)
  }
  const subs = []
  for (const r of raw) {
    const pts = [r.t0, ...[...cuts].filter((x) => x > r.t0 + 1e-6 && x < r.t1 - 1e-6).sort((p, q) => p - q), r.t1]
    for (let i = 0; i < pts.length - 1; i++) {
      const mid = (pts[i] + pts[i + 1]) / 2
      subs.push({ r, u0: pts[i], u1: pts[i + 1], over: ovl.filter((c) => c.start <= mid && mid < c.start + c.dur) })
    }
  }

  const segments = []
  let k = 0
  for (const { r, u0, u1, over } of subs) {
    const frames = Math.round(u1 * fps) - Math.round(u0 * fps)
    if (frames <= 0) continue
    const shift = u0 - r.t0
    const dur = u1 - u0
    // the main video's layer for this piece
    let main = null
    if (r.kind === 'trans') {
      const span = r.t1 - r.t0
      main = { a: sideFor(r.a, u0, u1), b: sideFor(r.b, u0, u1), name: r.name, p0: shift / span, p1: (shift + dur) / span }
    } else if (r.kind === 'solo' || (r.kind === 'clip' && over.length)) {
      main = { a: sideFor(r.clip, u0, u1), b: null, name: null, p0: 0, p1: 1 }
    }
    if (r.kind === 'clip' && !over.length) {
      const sd = sideFor(r.clip, u0, u1)
      segments.push({ kind: 'clip', file: sd.file, proxy: sd.proxy, isImage: sd.isImage, srcStart: sd.start, srcDur: dur * sd.speed, speed: sd.speed, frames })
      continue
    }
    // layers, bottom first (the order of the rows on the timeline)
    const layers = []
    for (const key of videoRowsBottomUp(state)) {
      if (key === 'main') {
        if (main) layers.push(main)
      } else {
        const c = over.filter((x) => x.trackId === key.slice(2)).pop()
        if (c) layers.push({ a: sideFor(c, u0, u1), b: null, name: null, p0: 0, p1: 1 })
      }
    }
    segments.push({ kind: 'gl', k: k++, frames, dur, layers })
  }  if (audioOnly) segments.length = 0
  const totalFrames = audioOnly ? Math.round(total * fps) : segments.reduce((a, x) => a + x.frames, 0)
  // ---- audio tracks (muted tracks are left out)
  const audio = []
  for (let n = 0; n < streamCount(state); n++) {
    const st = { volume: 1, mute: false, ...state.streamSettings[n] }
    if (st.mute || st.volume <= 0 || hid.has('s:' + n)) continue
    const clips = []
    lay.forEach((c, i) => {
      const m = mediaOf(c.mediaId)
      if (!hasAttached(c, m, n)) return
      const own = streamAudioOf(c, n) // this clip's own volume
      if (own.mute || own.volume <= 0) return
      const next = lay[i + 1]
      // the volume curve in seconds from the start of the clip on the timeline (it is kept in seconds of the file)
      const sp = speedOf(c)
      const env = (own.env || []).map((k) => ({ t: (c.reverse ? c.out - k.t : k.t - c.in) / sp, v: k.v })).sort((p, q) => p.t - q.t)
      clips.push({ file: m.path, stream: n, srcStart: c.in, srcDur: c.out - c.in, speed: sp, reverse: !!c.reverse, dur: c.dur, at: c.start, vol: st.volume * own.volume, clean: cleanActive(own.clean) ? own.clean : undefined, env, ufIn: own.fadeIn, ufOut: own.fadeOut, fadeIn: c.ov, fadeOut: next ? next.ov : 0 })
    })
    if (clips.length) audio.push({ name: `Video audio ${n + 1}`, clips })
  }
  for (const t of state.audioTracks) {
    if (t.mute || t.volume <= 0 || hid.has('a:' + t.id)) continue
    const clips = []
    for (const a of state.audioClips) {
      if (a.trackId !== t.id || a.start >= total) continue
      const m = mediaOf(a.mediaId)
      if (!m || m.missing) continue
      const own = audioClipVol(a)
      if (own.mute || own.volume <= 0) continue
      const env = (own.env || []).map((k) => ({ t: k.t - a.in, v: k.v })).sort((p, q) => p.t - q.t)
      clips.push({ file: m.path, stream: a.stream != null ? a.stream : 0, srcStart: a.in, dur: a.out - a.in, at: a.start, vol: t.volume * own.volume, clean: cleanActive(own.clean) ? own.clean : undefined, env, ufIn: own.fadeIn, ufOut: own.fadeOut, fadeIn: 0, fadeOut: 0 })
    }
    if (clips.length) audio.push({ name: t.name, clips })
  }

  return {
    w,
    h,
    fps,
    codec: s.codec,
    bitrateMbps: s.bitrate,
    preset: PRESETS[s.speed] || 'medium',
    audioMode: s.audioMode,
    audioKbps: s.audioKbps || 192,
    encoder: s.encoder || 'cpu',
    speed: s.speed,
    audioOnly,
    audioFormat: s.audioFormat || 'mp3',
    loudness: s.loudness || 'off',
    segments,
    audio,
    totalFrames,
    totalSec: totalFrames / fps,
  }
}

let cancelled = false
let exporting = false
export const isExporting = () => exporting
export function cancelExport() {
  cancelled = true
  window.api.exportCancel()
}

const pad5 = (n) => String(n).padStart(5, '0')

// Runs the export. onProgress({pct, label}). Resolves with the output path.
// onPreview(canvas): called now and then with the picture being rendered (effects part);
// onPreviewUrl(url): a small image of the video being encoded (final part).
export async function runExport({ state, settings, transitions, outPath, onProgress, onPreview, onPreviewUrl, onCheck }) {
  cancelled = false
  exporting = true
  const plan = buildPlan(state, settings)
  plan.out = outPath
  const { w, h, fps } = plan
  const dir = await window.api.exportBegin()
  let unsub = null
  let previewTimer = null
  try {
    const trans = plan.segments.filter((s) => s.kind === 'gl')
    const transFrames = trans.reduce((a, s) => a + s.frames, 0)
    // a rendered transition frame costs a few times more than a plain frame
    const W_T = 3
    const units = transFrames * W_T + plan.totalFrames
    let doneT = 0
    const report = (label, extra = 0) => onProgress({ pct: Math.min(99.5, ((doneT * W_T + extra) / units) * 100), label })
    report('Preparing…')

    // reversed clips are played from a reversed copy of their range (full quality), made first
    const todo = []
    for (const s of plan.segments) {
      if (s.kind === 'clip') todo.push(s)
      else if (s.kind === 'gl') for (const l of s.layers) todo.push(l.a, ...(l.b ? [l.b] : []))
    }
    const needProxy = todo.filter((x) => x.proxy && !x.file)
    for (let pi = 0; pi < needProxy.length; pi++) {
      if (cancelled) throw new Error('Export cancelled')
      report(`Preparing reversed clips ${pi + 1} of ${needProxy.length}`)
      needProxy[pi].file = await window.api.reverseProxy({ ...needProxy[pi].proxy, quality: 'export' })
    }

    if (trans.length) {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const renderer = createRenderer(canvas)
      for (const t of transitions) renderer.addTransition(t.name, t.source)
      // Frames come out of the graphics card as planar YUV 4:2:0 when the size allows it (1.5 bytes a pixel instead of 4, and the
      // encoder does not have to convert), and go to the encoder without waiting for each one to be taken: up to 3 are on their
      // way, each in its own buffer, in order.
      const yuv = renderer.canYuv()
      const ring = [0, 1, 2].map(() => new Uint8Array(yuv ? (w * h * 3) / 2 : w * h * 4))
      const flying = []
      const LOOK = 6 // frames decoded ahead, on other threads

      for (let ti = 0; ti < trans.length; ti++) {
        const s = trans[ti]
        const label = `Rendering effects ${ti + 1} of ${trans.length}`
        report(label)
        // every picture of every layer, as numbered images (not padded: the renderer fits them itself, like the preview)
        const srcs = []
        s.layers.forEach((l, li) => {
          if (!l.a.isText) srcs.push({ li, which: 'a', side: l.a })
          if (l.b && !l.b.isText) srcs.push({ li, which: 'b', side: l.b })
        })
        for (const x of srcs) {
          x.info = await window.api.exportExtract({ name: `t${s.k}l${x.li}${x.which}`, file: x.side.file, isImage: x.side.isImage, start: x.side.start, dur: s.dur * (x.side.speed || 1), speed: x.side.speed || 1, fps, w, h, maxFrames: s.frames + 2, noPad: true })
        }
        if (cancelled) throw new Error('Export cancelled')
        await window.api.exportSegBegin({ k: s.k, w, h, fps, yuv })
        const cache = new Map()
        const textCvs = new Map()
        for (const l of s.layers) if (l.a.isText) await loadFont(l.a.clip.text)
        const load = (x, i) => {
          const idx = Math.min(i, x.info.count - 1)
          const ck = `${x.li}${x.which}${x.info.count === 1 ? 0 : idx}`
          if (cache.has(ck)) return cache.get(ck)
          const img = new Image()
          img.src = toUrl(`${x.info.dir}\\${pad5(idx + 1)}.png`)
          // an ImageBitmap that is already flipped the way the renderer wants it uploads without a slow flip on the CPU
          const p = img.decode().then(() => createImageBitmap(img, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
          cache.set(ck, p)
          if (cache.size > LOOK * srcs.length + 8) cache.delete(cache.keys().next().value)
          return p
        }
        const pending = new Map() // frame number -> its pictures
        const want = (j) => {
          if (j < s.frames && !pending.has(j)) pending.set(j, srcs.map((x) => load(x, j)))
        }
        for (let j = 0; j < LOOK; j++) want(j)
        for (let i = 0; i < s.frames; i++) {
          if (cancelled) throw new Error('Export cancelled')
          const imgs = await Promise.all(pending.get(i))
          pending.delete(i)
          for (let j = 1; j <= LOOK; j++) want(i + j) // decode the next frames while this one renders
          const imgOf = new Map(srcs.map((x, j) => [`${x.li}${x.which}`, imgs[j]]))
          // each clip's motion and warp at the source time of this frame
          const sideOf = (li, which, sd) => {
            const ts = srcAt(sd.clip, sd.tl0 + i / fps)
            if (sd.isText) {
              const key = li + which
              let cv = textCvs.get(key)
              if (!cv) {
                cv = document.createElement('canvas')
                cv.width = w
                cv.height = h
                textCvs.set(key, cv)
              }
              drawText(cv, sd.clip.text, sd.tl0 + i / fps - sd.clip.start, sd.clip.dur)
              return { el: cv, w, h, tf: evalTransform(sd.clip, ts), warp: evalWarp(sd.clip, ts), fx: sd.clip.fx, mask: maskAt(sd.clip, ts) }
            }
            const img = imgOf.get(`${li}${which}`)
            return { el: img, w: img.width, h: img.height, tf: evalTransform(sd.clip, ts), warp: evalWarp(sd.clip, ts), fx: sd.clip.fx, mask: maskAt(sd.clip, ts) }
          }
          renderer.renderLayers(
            s.layers.map((l, li) => ({
              A: sideOf(li, 'a', l.a),
              B: l.b ? sideOf(li, 'b', l.b) : null,
              name: l.name,
              progress: l.p0 + (l.p1 - l.p0) * ((i + 0.5) / s.frames),
            }))
          )
          if (onPreview && i % 3 === 0) onPreview(canvas)
          const slot = ring[i % ring.length]
          if (yuv) renderer.readYuv(slot)
          else renderer.read(slot)
          flying.push(window.api.exportFrame(slot))
          if (flying.length >= ring.length) await flying.shift()
          doneT++
          report(label)
        }
        await Promise.all(flying.splice(0))
        await window.api.exportSegEnd()
      }
    }
    if (cancelled) throw new Error('Export cancelled')
    unsub = window.api.onExportProgress((p) => onProgress({ pct: p.label ? 99.5 : Math.min(99.5, ((doneT * W_T + p.frame) / units) * 100), label: p.label || 'Encoding video…' }))
    onProgress({ pct: Math.min(99.5, ((doneT * W_T) / units) * 100), label: 'Encoding video…' })
    if (onPreviewUrl) previewTimer = setInterval(() => onPreviewUrl(toUrl(`${dir}\\preview.jpg`) + '?t=' + Date.now()), 700)
    const forMain = { ...plan, segments: plan.segments.map((s) => (s.kind === 'gl' ? { kind: 'trans', k: s.k, frames: s.frames } : s)) }
    const res = await window.api.exportFinal(forMain)
    onProgress({ pct: 100, label: 'Done' })
    if (onCheck && res && res.check) onCheck(res.check)
    return (res && res.path) || outPath
  } finally {
    exporting = false
    if (previewTimer) clearInterval(previewTimer)
    if (unsub) unsub()
    await window.api.exportCleanup()
  }
}

if (typeof window !== 'undefined') window.__vibeExport = { buildPlan, runExport } // used by the developer self-test
