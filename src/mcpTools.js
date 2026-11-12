// The AI connection, page side: what each tool does (the list and its descriptions are in electron/mcpTools.js).
// An AI app goes through the same actions as the buttons, so its changes show up at once and Ctrl+Z takes them back.
// mcpApp.js = the editor as a whole, mcpPicture.js = what is special in picture projects, this file = the rest.
import { layout, overlayLayout, audioLayout, srcAt, tlOf, projectDuration, sectionOf, rowKeys, hasAttached, isLocked, streamCount, streamAudioOf, audioClipVol, copySelection, clipPicture, aspectRatio, ASPECTS, uid } from './state.js'
import { evalProp, keyAt, PROPS, EASES, WARP_ZERO } from './motion.js'
import { CC_DEFAULTS, CC_SLIDERS, CC_PRESETS, FX_SLIDERS } from './effects.js'
import { TEXT_PRESETS } from './textRender.js'
import { imageFor, imagesReady } from './imageRender.js'
import { rasterView } from './paint/raster.js'
import { boxPrompt, startFollow, startTrackMask, subjectOutline, videoOutline } from './followSubject.js'
import { startJob, jobRunning } from './mcpJobs.js'
import { appTool } from './mcpApp.js'
import { pictureTool, isPictureTool, textBox } from './mcpPicture.js'
import { makeCaptions, toSrt } from './whisper.js'
import { sequenceWords, wordsRange, fillerRanges, pauseRanges } from './TranscriptDialog.jsx'
import { runExport, cancelExport, isExporting } from './exporter.js'
import { load as exportDefaults, presetPatch } from './ExportTab.jsx'
import { LABELS } from './labels.js'

const round = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)
const wait = (ms = 90) => new Promise((r) => setTimeout(r, ms))
const json = (o) => ({ text: JSON.stringify(o) })
const need = (ok, msg) => {
  if (!ok) throw new Error(msg)
}
const pct = (v) => (v == null ? undefined : +v / 100)

// find a clip anywhere on the timeline
function locate(s, id) {
  const main = layout(s.clips).find((c) => c.id === id)
  if (main) return { clip: main, where: 'main' }
  const over = overlayLayout(s.overlayClips).find((c) => c.id === id)
  if (over) return { clip: over, where: 'video' }
  const aud = audioLayout(s.audioClips).find((c) => c.id === id)
  if (aud) return { clip: aud, where: 'audio' }
  throw new Error(`There is no clip with the id ${id}. Call get_project for the current ids.`)
}
const editable = (s, id) => {
  const f = locate(s, id)
  need(!isLocked(s, id), 'That clip is on a locked track. The person can unlock it with the padlock on the track.')
  return f
}
const picture = (s, id) => {
  const f = editable(s, id)
  need(f.where !== 'audio', 'That is an audio clip: this only works on video, picture and text clips.')
  return f
}
const propOk = (p) => need(PROPS.some((x) => x.id === p && !x.mask), `Unknown property ${p}.`)
// what a value may be: wider than the sliders (a clip can slide in from outside the frame), but nothing that makes no sense
const LIMITS = { x: [-500, 500], y: [-500, 500], scale: [1, 1000], sx: [1, 1000], sy: [1, 1000], rot: [-3600, 3600], opacity: [0, 100] }
const valueOk = (p, v) => {
  const [lo, hi] = LIMITS[p]
  need(Number.isFinite(+v) && +v >= lo && +v <= hi, `${p} must be between ${lo} and ${hi}.`)
}
const time = (v, s) => Math.max(0, v == null ? s.playhead : +v)
const trackKey = (s, key) => {
  need(rowKeys(s).includes(key), `There is no track ${key}. Call get_project for the current tracks.`)
  return key
}

// how a sound is set: only what differs from the original. toTime = seconds of the file -> seconds on the timeline
function soundInfo(st, toTime) {
  const o = {}
  if (st.volume !== 1) o.volume = round(st.volume)
  if (st.mute) o.mute = true
  if (st.fadeIn) o.fadeIn = round(st.fadeIn)
  if (st.fadeOut) o.fadeOut = round(st.fadeOut)
  if (st.env && st.env.length) o.volumeLine = st.env.map((p) => [round(toTime(p.t)), round(p.v)])
  if (st.clean && (st.clean.nr || st.clean.rumble || st.clean.voice)) o.cleanUp = st.clean
  return o
}

function describeClip(c, s, where) {
  const m = s.media.find((x) => x.id === c.mediaId)
  const out = { id: c.id, kind: c.text ? 'text' : m ? m.type : 'audio', name: c.text ? c.text.content : m ? m.name : '?', start: round(c.start), end: round(c.start + c.dur), fileFrom: round(c.in), fileTo: round(c.out) }
  if (c.speed) out.speed = c.speed
  if (c.reverse) out.reverse = true
  if (c.gap) out.gapBefore = round(c.gap)
  if (c.groupId) out.group = c.groupId
  if (c.label) out.label = c.label
  if (c.transition && c.transition.name) out.transitionIn = { name: c.transition.name, seconds: c.transition.duration }
  if (c.fx) out.effects = c.fx
  if (c.text) {
    out.text = c.text
    out.textBox = textBox(s, c) // where the words are, in % of the frame
  }
  if (where !== 'audio') {
    // a keyframe's time: on the timeline (what the tools take) and in the file (what is stored)
    const at = (k) => ({ time: round(tlOf(c, k.t)), fileTime: round(k.t) })
    const keys = {}
    for (const p of PROPS) {
      const list = c.anim && c.anim[p.id]
      if (list && list.length) keys[p.id] = list.map((k) => ({ ...at(k), value: round(k.v), ease: k.ease }))
    }
    if (Object.keys(keys).length) out.keyframes = keys
    if (c.mask) out.mask = { shape: c.mask.shape, tracked: !!(c.mask.frames && c.mask.frames.length), invert: !!c.mask.invert, feather: c.mask.feather }
    if (c.warp) out.warp = { fixed: c.warp.fixed, keyframes: (c.warp.keys || []).map((k) => ({ ...at(k), corners: k.c, ease: k.ease })) }
    if (where === 'main' && m && m.type === 'video') {
      out.sound = (m.audioStreams || []).map((_, n) => (hasAttached(c, m, n) ? { stream: n, ...soundInfo(streamAudioOf(c, n), (t) => tlOf(c, t)) } : { stream: n, detached: true }))
      if (!out.sound.length) delete out.sound
    }
    const look = {}
    for (const p of PROPS) if (!p.mask && evalProp(c, p.id, c.in) !== p.def) look[p.id] = round(evalProp(c, p.id, c.in))
    if (Object.keys(look).length) out.values = look
  } else {
    Object.assign(out, soundInfo(audioClipVol(c), (t) => c.start + t - c.in))
    if (c.origin) out.soundOf = c.origin
  }
  return out
}

function projectSummary(s) {
  const tracks = []
  for (const key of rowKeys(s)) {
    const base = { key, locked: s.lockedRows.includes(key), hidden: s.hiddenRows.includes(key) }
    if (key === 'main') tracks.push({ name: s.mainName, type: 'main video', ...base, clips: layout(s.clips).map((c) => describeClip(c, s, 'main')) })
    else if (key.startsWith('v:')) {
      const t = s.videoTracks.find((x) => x.id === key.slice(2))
      tracks.push({ name: t.name, type: 'video', ...base, clips: overlayLayout(s.overlayClips).filter((c) => c.trackId === t.id).map((c) => describeClip(c, s, 'video')) })
    } else if (key.startsWith('a:')) {
      const t = s.audioTracks.find((x) => x.id === key.slice(2))
      tracks.push({ name: t.name, type: 'audio', volume: t.volume, mute: !!t.mute, ...base, clips: audioLayout(s.audioClips).filter((c) => c.trackId === t.id).map((c) => describeClip(c, s, 'audio')) })
    }
  }
  return {
    kind: 'video',
    length: round(projectDuration(s)),
    playhead: round(s.playhead),
    shape: s.aspect,
    files: s.media.map((m) => ({ id: m.id, name: m.name, type: m.type, seconds: round(m.duration), width: m.width, height: m.height, audioStreams: (m.audioStreams || []).length, hasTranscript: !!(s.transcripts && s.transcripts[m.id]), missing: !!m.missing })),
    tracks,
    audioThatFollowsMainClips: streamCount(s),
    markers: s.markers.map((m) => ({ id: m.id, time: round(m.t), label: m.label })),
    selection: s.selection,
    canUndo: s.past.length > 0,
    canRedo: s.future.length > 0,
  }
}

// the sound of a clip, as the ids setClipAudio takes
function audioIds(s, clip, where, stream) {
  const m = s.media.find((x) => x.id === clip.mediaId)
  const ids = where === 'audio' ? [clip.id] : []
  if (where === 'main') (m && m.audioStreams ? m.audioStreams : []).forEach((_, n) => hasAttached(clip, m, n) && (stream == null || stream === n) && ids.push(`sa:${clip.id}:${n}`))
  if (where === 'video') s.audioClips.forEach((a) => a.origin === clip.id && (stream == null || stream === a.stream) && ids.push(a.id))
  return ids
}
// which file and part of it a sound is, and how to turn timeline seconds into seconds of that file
function soundOf(s, id) {
  if (id.startsWith('sa:')) {
    const [, cid, n] = id.split(':')
    const c = layout(s.clips).find((x) => x.id === cid)
    const m = s.media.find((x) => x.id === c.mediaId)
    return { st: streamAudioOf(c, +n), file: (m.audioFiles || [])[+n], from: c.in, to: c.out, src: (t) => srcAt(c, t) }
  }
  const a = audioLayout(s.audioClips).find((x) => x.id === id)
  const m = s.media.find((x) => x.id === a.mediaId)
  return { st: audioClipVol(a), file: a.stream != null ? (m.audioFiles || [])[a.stream] : m.path, from: a.in, to: a.out, src: (t) => a.in + (t - a.start) }
}

const VIDEO_ONLY = new Set(['get_transcript', 'get_words', 'remove_words', 'add_clip', 'move_clip', 'trim_clip', 'split_clip', 'copy_clips', 'paste_clips', 'duplicate_clips', 'group_clips', 'ungroup_clips', 'set_label', 'freeze_frame', 'close_gap', 'cut_ranges', 'set_speed', 'set_transition', 'follow_subject', 'track_mask', 'subject_in_front', 'set_audio', 'add_marker', 'edit_marker', 'seek', 'set_playing', 'set_timeline_option', 'add_track', 'set_track', 'remove_track', 'set_aspect', 'remove_media', 'make_captions', 'save_subtitles', 'start_voiceover', 'stop_voiceover', 'open_export', 'export_video', 'list_versions', 'restore_version'])

// ctx = the ref in App.jsx: project() = {id, handle} of the project in use, or null, and what the window can do
export async function runTool(name, args, ctxRef) {
  const general = await appTool(name, args, ctxRef)
  if (general) return general
  const ctx = ctxRef.current
  const p = ctx.project()
  need(p, 'No project is open. Use new_video_project, new_picture_project, open_project or open_picture.')
  const h = p.handle
  const pic = h.kind === 'image'
  need(!pic || !VIDEO_ONLY.has(name), `${name} only works in a video project, and a picture project is in front. Use list_projects and switch_project, or new_video_project.`)
  need(pic || !isPictureTool(name), `${name} only works in a picture project, and a video project is in front. Use list_projects and switch_project, or new_picture_project.`)
  if (pic) {
    const r = await pictureTool(name, args, { p, h, ctx })
    if (r) return r
  }
  const state = () => h.getState()
  const D = h.dispatch
  const live = h.live()
  const s = state()

  switch (name) {
    case 'get_project':
      return json(projectSummary(s))
    case 'describe_clips': // (for the question the person is asked)
      return { text: (args.clipIds || []).slice(0, 8).map((id) => { try { return describeClip(locate(s, id).clip, s, locate(s, id).where).name } catch { return null } }).filter(Boolean).join('\n') }
    case 'get_preview': {
      ctx.focus(p.id)
      if (args.time != null) D({ type: 'setPlayhead', t: Math.max(0, +args.time), user: true })
      // wait until the preview has drawn this very state, with every video at its frame (seeking takes a moment)
      const t0 = Date.now()
      let cv
      let fresh = false
      while (Date.now() - t0 < 6000) {
        await wait(40)
        cv = [...document.querySelectorAll('.preview-canvas')].find((c) => c.offsetParent)
        const d = cv && cv.__drawn
        if (d && d.settled && (d.s === state() || (state().playing && Date.now() - t0 > 300))) {
          fresh = true
          await wait(50)
          break
        }
      }
      need(cv, 'The preview is not on screen.')
      const small = document.createElement('canvas')
      small.width = Math.min(960, cv.width)
      small.height = Math.round((small.width * cv.height) / cv.width)
      const g = small.getContext('2d')
      g.fillStyle = '#000'
      g.fillRect(0, 0, small.width, small.height)
      g.drawImage(cv, 0, 0, small.width, small.height)
      return { image: small.toDataURL('image/jpeg', 0.8).split(',')[1], mime: 'image/jpeg', text: `The picture at ${round(state().playhead)} s.${fresh ? '' : ' A video was still loading, so it may not be fully up to date: look again in a moment.'}` }
    }
    case 'get_transcript': {
      const tr = s.transcripts && s.transcripts[args.mediaId]
      need(tr && tr.words, 'That file has no transcript yet. Use make_captions.')
      return json(tr.words.map((w) => ({ text: w.text, start: round(w.s), end: round(w.e) })))
    }
    case 'get_words': {
      const words = sequenceWords(s)
      need(words.length, 'There are no words for the video on the main track yet. Use make_captions.')
      return json(words.map((w, i) => ({ i, text: w.text, start: round(w.start), end: round(w.end), filler: w.filler || undefined })))
    }
    case 'remove_words': {
      const words = sequenceWords(s)
      need(words.length, 'There are no words for the video on the main track yet. Use make_captions.')
      let ranges
      if (args.fillers) ranges = fillerRanges(words)
      else if (args.pausesOver != null) ranges = pauseRanges(words, Math.max(0.3, +args.pausesOver))
      else {
        need(words[args.first] && words[args.last == null ? args.first : args.last], 'first and last are word numbers from get_words.')
        ranges = [wordsRange(words, +args.first, args.last == null ? +args.first : +args.last)]
      }
      need(ranges.length, 'Nothing to remove.')
      D({ type: 'rippleDelete', ranges, tidy: true })
      await wait()
      return { text: `Cut ${ranges.length} place${ranges.length === 1 ? '' : 's'}, ${round(ranges.reduce((a, r) => a + r[1] - r[0], 0))} seconds.` }
    }
    case 'import_media': {
      need(Array.isArray(args.paths) && args.paths.length, 'Give at least one file path.')
      const items = await window.api.describeFiles(args.paths)
      need(items.length, 'None of those files could be read.')
      h.addMedia(items)
      await wait()
      return json(items.map((m) => ({ id: m.id, name: m.name, type: m.type, seconds: round(m.duration) })))
    }
    case 'remove_media': {
      need(s.media.some((m) => m.id === args.mediaId), `There is no file with the id ${args.mediaId}.`)
      D({ type: 'removeMedia', id: args.mediaId })
      return { text: 'Removed from the project. This cannot be undone.' }
    }
    case 'add_clip': {
      const m = s.media.find((x) => x.id === args.mediaId)
      need(m, `There is no file with the id ${args.mediaId}.`)
      const track = args.track ? trackKey(s, args.track) : null
      if (m.type === 'audio') {
        need(!track || track.startsWith('a:'), 'A sound goes on an audio track.')
        D({ type: 'addAudioClip', mediaId: m.id, trackId: track ? track.slice(2) : null, start: time(args.time, s) })
      } else if (track && track.startsWith('v:')) D({ type: 'addOverlayClip', mediaId: m.id, trackId: track.slice(2), start: time(args.time, s) })
      else if (args.time == null || track === 'main') D({ type: 'addClip', mediaId: m.id })
      else D({ type: 'addOverlayClip', mediaId: m.id, start: Math.max(0, +args.time) })
      await wait()
      return { text: `Added. Its id is ${state().selection[0]}.` }
    }
    case 'add_text': {
      D({ type: 'addText', t: time(args.time, s), dur: args.duration > 0 ? +args.duration : 3, y: +args.y || 0, text: { ...args.style, content: String(args.text) } })
      await wait()
      return { text: `Added. Its id is ${state().selection[0]}.` }
    }
    case 'set_text': {
      const { clip } = picture(s, args.clipId)
      need(clip.text, 'That is not a text clip.')
      if (args.preset) {
        const look = TEXT_PRESETS.find((x) => x.name.toLowerCase() === String(args.preset).toLowerCase())
        need(look, `There is no text preset ${args.preset}. See editor_info.`)
        // the look only: the text stays where it is unless presetPosition asks for the preset's place too
        D({ type: 'applyTextPreset', id: clip.id, text: look.text, y: args.presetPosition ? look.y : evalProp(clip, 'y', clip.in) })
      }
      const patch = { ...args.style }
      if (args.text != null) patch.content = String(args.text)
      if (Object.keys(patch).length) D({ type: 'setText', id: clip.id, patch })
      return { text: 'Done.' }
    }
    case 'move_clip': {
      const { clip, where } = editable(s, args.clipId)
      const track = args.track ? trackKey(s, args.track) : null
      if (where === 'main') {
        if (track && track !== 'main') {
          need(track.startsWith('v:'), 'A video clip goes on a video track.')
          D({ type: 'clipToOverlay', id: clip.id, trackId: track.slice(2), start: args.start == null ? clip.start : +args.start })
          return { text: 'Moved.' }
        }
        need(args.index != null, 'That clip is on the main track: give index, its new place among the main track clips.')
        D({ type: 'moveMainTo', ids: [clip.id], toIndex: +args.index, gap: args.gapBefore > 0 ? +args.gapBefore : 0 })
      } else if (track === 'main') {
        need(where === 'video', 'A sound cannot go on the main track.')
        D({ type: 'overlayToMain', id: clip.id, toIndex: args.index == null ? s.clips.length : +args.index, start: args.start })
      } else {
        need(args.start != null || track, 'Give start, the new time in seconds, or a track.')
        if (track) need(track.slice(0, 2) === (where === 'audio' ? 'a:' : 'v:'), where === 'audio' ? 'A sound goes on an audio track.' : 'A video clip goes on a video track.')
        D({ type: 'checkpoint' })
        D({ type: 'moveItems', moves: [{ id: clip.id, start: args.start == null ? clip.start : +args.start, trackId: track ? track.slice(2) : undefined }] })
      }
      return { text: 'Moved.' }
    }
    case 'trim_clip': {
      const { clip, where } = editable(s, args.clipId)
      const type = where === 'main' ? 'trim' : where === 'video' ? 'trimOverlay' : 'trimAudio'
      D({ type: 'checkpoint' })
      if (args.to != null) D({ type, id: clip.id, side: 'out', value: +args.to })
      if (args.from != null) D({ type, id: clip.id, side: 'in', value: +args.from })
      return { text: 'Trimmed.' }
    }
    case 'split_clip': {
      if (args.clipId) editable(s, args.clipId)
      D({ type: 'select', id: args.clipId || null })
      D({ type: 'split', t: Math.max(0, +args.time) })
      await wait()
      return { text: 'Split.' }
    }
    case 'delete_clips': {
      const ids = (args.clipIds || []).filter((id) => {
        editable(s, id)
        return true
      })
      need(ids.length, 'Give at least one clip id.')
      D({ type: 'selectMany', ids, exact: true }) // only these: the other clips of their groups stay
      D({ type: 'deleteSelection', keepGap: args.closeGaps === false })
      return { text: `Deleted ${ids.length}.` }
    }
    case 'copy_clips': {
      need(Array.isArray(args.clipIds) && args.clipIds.length, 'Give at least one clip id.')
      D({ type: 'selectMany', ids: args.clipIds, exact: true })
      await wait()
      return { text: `Copied ${copySelection(state())}.` }
    }
    case 'paste_clips': {
      D({ type: 'paste', t: time(args.time, s) })
      await wait()
      return json({ newIds: state().selection })
    }
    case 'duplicate_clips': {
      need(Array.isArray(args.clipIds) && args.clipIds.length, 'Give at least one clip id.')
      D({ type: 'selectMany', ids: args.clipIds, exact: true })
      D({ type: 'duplicate' })
      await wait()
      return json({ newIds: state().selection })
    }
    case 'group_clips':
    case 'ungroup_clips': {
      need(Array.isArray(args.clipIds) && args.clipIds.length, 'Give at least one clip id.')
      D({ type: 'selectMany', ids: args.clipIds })
      D({ type: name === 'group_clips' ? 'group' : 'ungroup' })
      await wait()
      return { text: 'Done.' }
    }
    case 'set_label': {
      need(args.color == null || LABELS[args.color], `Unknown colour. It is one of ${Object.keys(LABELS).join(', ')}.`)
      D({ type: 'setLabel', ids: args.clipIds || [], color: args.color || null })
      return { text: 'Done.' }
    }
    case 'freeze_frame': {
      D({ type: 'setPlayhead', t: time(args.time, s), user: true })
      await wait()
      await live.freezeFrame()
      await wait(200)
      return { text: 'Frozen frame put in at that moment.' }
    }
    case 'close_gap':
      D({ type: 'closeGap', id: args.clipId })
      return { text: 'Done.' }
    case 'cut_ranges': {
      need(Array.isArray(args.ranges) && args.ranges.length, 'Give ranges, like [[3, 5.5], [10, 12]].')
      D({ type: 'rippleDelete', ranges: args.ranges.map(([a, b]) => [+a, +b]) })
      await wait()
      return { text: 'Cut, and the gaps closed.' }
    }
    case 'set_speed': {
      const { clip } = picture(s, args.clipId)
      if (args.speed != null) D({ type: 'setSpeed', id: clip.id, speed: +args.speed })
      if (args.reverse != null) D({ type: 'setReverse', id: clip.id, value: !!args.reverse })
      return { text: 'Done.' }
    }
    case 'set_value':
    case 'add_keyframe': {
      const { clip } = picture(s, args.clipId)
      propOk(args.property)
      valueOk(args.property, args.value)
      const list = (clip.anim && clip.anim[args.property]) || []
      const t = srcAt(clip, time(args.time, s))
      D({ type: 'checkpoint' })
      if (name === 'add_keyframe' && !list.length) D({ type: 'toggleKey', id: clip.id, prop: args.property, t })
      D({ type: 'setProp', id: clip.id, prop: args.property, value: +args.value, t })
      return { text: 'Done.' }
    }
    case 'edit_keyframe': {
      const { clip } = picture(s, args.clipId)
      propOk(args.property)
      const list = (clip.anim && clip.anim[args.property]) || []
      const t = srcAt(clip, +args.time)
      need(keyAt(list, t), `${args.property} has no keyframe at that moment. See get_project.`)
      if (args.remove) {
        D({ type: 'toggleKey', id: clip.id, prop: args.property, t })
        return { text: 'Removed.' }
      }
      if (args.ease || args.bezier) {
        const ease = args.bezier ? 'custom' : args.ease
        need(args.bezier || EASES[ease], `Unknown easing. It is one of ${Object.keys(EASES).join(', ')}.`)
        D({ type: 'setEase', id: clip.id, prop: args.property, t, ease, bez: args.bezier })
      }
      if (args.value != null) {
        valueOk(args.property, args.value)
        D({ type: 'checkpoint' })
        D({ type: 'setProp', id: clip.id, prop: args.property, value: +args.value, t })
      }
      if (args.newTime != null) {
        D({ type: 'checkpoint' })
        D({ type: 'moveKeyframes', id: clip.id, from: t, to: srcAt(clip, +args.newTime) })
      }
      return { text: 'Done.' }
    }
    case 'remove_keyframes': {
      const { clip } = picture(s, args.clipId)
      propOk(args.property)
      D({ type: 'clearProp', id: clip.id, prop: args.property })
      return { text: 'Done.' }
    }
    case 'place_clip': {
      const { clip } = picture(s, args.clipId)
      const ratio = aspectRatio(s)
      const pic2 = clipPicture(s, clip, ratio)
      need(pic2 && pic2.width, 'That clip has no size yet.')
      const ma = pic2.width / pic2.height
      const sc = [Math.max(1, ratio / ma), Math.max(1, ma / ratio)]
      const { left, top, right, bottom } = args
      const bw = (right - left) / 100
      const bh = (bottom - top) / 100
      need(bw > 0 && bh > 0, 'left must be less than right, and top less than bottom.')
      const fit = args.fit || 'contain'
      need(['contain', 'cover', 'stretch'].includes(fit), 'fit is contain, cover or stretch.')
      const scale = fit === 'cover' ? Math.max(bw * sc[0], bh * sc[1]) : fit === 'stretch' ? bw * sc[0] : Math.min(bw * sc[0], bh * sc[1])
      const t = srcAt(clip, time(args.time, s))
      const put = { x: (left + right) / 2 - 50, y: (top + bottom) / 2 - 50, scale: scale * 100, sx: 100, sy: fit === 'stretch' ? (100 * (bh * sc[1])) / scale : 100 }
      D({ type: 'checkpoint' })
      for (const [prop, value] of Object.entries(put)) D({ type: 'setProp', id: clip.id, prop, value, t })
      return { text: 'Placed.' }
    }
    case 'set_warp': {
      const { clip } = picture(s, args.clipId)
      if (args.reset) {
        D({ type: 'warpReset', id: clip.id })
        return { text: 'Done.' }
      }
      const c = args.corners || WARP_ZERO
      need(Array.isArray(c) && c.length === 8, 'corners is 8 numbers: x and y for the top left, top right, bottom right and bottom left corners, in % of the picture.')
      const t = srcAt(clip, time(args.time, s))
      D({ type: 'checkpoint' })
      if (args.keyframe && !keyAt(clip.warp && clip.warp.keys, t)) D({ type: 'warpToggleKey', id: clip.id, t })
      D({ type: 'warpSet', id: clip.id, c: c.map(Number), t })
      return { text: 'Done.' }
    }
    case 'set_transition': {
      const { clip, where } = picture(s, args.clipId)
      need(where === 'main', 'Transitions only work on the main track.')
      if (args.name) {
        const names = (await window.api.listTransitions()).map((t) => t.name)
        need(names.includes(args.name), `There is no transition called ${args.name}. Use list_transitions.`)
      }
      const lay = layout(s.clips)
      const i = lay.findIndex((x) => x.id === clip.id)
      need(i > 0 || !args.name, 'The first clip has nothing before it to come from.')
      // it overlaps the clip before, so it cannot be longer than either clip (or the 4 seconds the slider allows)
      const most = i > 0 ? Math.floor(Math.min(4, lay[i - 1].dur, clip.dur) * 100) / 100 : 4
      const dur = args.duration == null ? Math.min(1, most) : +args.duration
      need(dur > 0 && dur <= most, `duration must be more than 0 and at most ${most} seconds here.`)
      D({ type: 'setTransition', id: clip.id, transition: args.name ? { name: args.name, duration: dur } : null })
      return { text: 'Done.' }
    }
    case 'set_effect': {
      const { clip } = picture(s, args.clipId)
      need(FX_SLIDERS.some((f) => f.id === args.effect), `Unknown effect ${args.effect}.`)
      D({ type: 'checkpoint' })
      D({ type: 'setFx', id: clip.id, patch: { [args.effect]: Math.max(0, Math.min(100, +args.value)) } })
      return { text: 'Done.' }
    }
    case 'set_colour': {
      const { clip } = picture(s, args.clipId)
      const cc = {}
      if (args.preset) {
        const look = CC_PRESETS.find((x) => x.name.toLowerCase() === String(args.preset).toLowerCase())
        need(look, `There is no colour preset ${args.preset}. See editor_info.`)
        Object.assign(cc, CC_DEFAULTS, look.cc)
      }
      for (const f of CC_SLIDERS) if (args[f.id] != null) cc[f.id] = Math.max(f.min, Math.min(f.max, +args[f.id]))
      need(Object.keys(cc).length, 'Give a preset or at least one value.')
      D({ type: 'setFx', id: clip.id, patch: { cc } })
      return { text: 'Done.' }
    }
    case 'set_chroma_key': {
      const { clip } = picture(s, args.clipId)
      const key = {}
      for (const k of ['on', 'color', 'sim', 'smooth', 'spill']) if (args[k] != null) key[k] = args[k]
      D({ type: 'setFx', id: clip.id, patch: { key } })
      return { text: 'Done.' }
    }
    case 'reset_effects': {
      const { clip } = picture(s, args.clipId)
      need(args.only == null || ['effects', 'cc'].includes(args.only), 'only is effects or cc.')
      D({ type: 'resetFx', id: clip.id, only: args.only })
      return { text: 'Done.' }
    }
    case 'set_mask': {
      const { clip } = picture(s, args.clipId)
      const patch = {}
      if (args.shape) {
        need(['rect', 'ellipse', 'poly'].includes(args.shape), 'shape is rect, ellipse or poly.')
        patch.shape = args.shape
      }
      for (const [k, v] of [['cx', args.centerX], ['cy', args.centerY], ['w', args.width], ['h', args.height]]) if (v != null) patch[k] = pct(v)
      for (const k of ['feather', 'expand', 'rot']) if (args[k] != null) patch[k] = +args[k]
      if (args.invert != null) patch.invert = !!args.invert
      if (args.points) {
        need(args.points.length >= 3, 'A shape needs at least three points.')
        patch.pts = args.points.map(([x, y]) => [x / 100, y / 100])
        patch.shape = 'poly'
      }
      if (args.from != null) patch.from = srcAt(clip, +args.from)
      if (args.to != null) patch.to = srcAt(clip, +args.to)
      D({ type: 'setMask', id: clip.id, patch })
      return { text: 'Done.' }
    }
    case 'remove_mask': {
      D({ type: 'clearMask', id: picture(s, args.clipId).clip.id })
      return { text: 'Done.' }
    }
    case 'subject_in_front': {
      const { clip } = picture(s, args.clipId)
      need(clip.mask, 'That clip has no mask yet.')
      D({ type: 'maskCopyAbove', id: clip.id })
      await wait()
      return { text: `A masked copy is on a new top track. Its id is ${state().selection[0]}. Text on the tracks below it now goes behind the subject.` }
    }
    case 'smart_mask': {
      const { clip } = picture(s, args.clipId)
      const m = s.media.find((x) => x.id === clip.mediaId)
      need(!clip.text, 'Smart mask does not work on text.')
      const st = await window.api.modelsStatus()
      const { gpuInfo } = await import('./smartMask.js')
      need(st.ready, 'The tracking AI model is not downloaded. Use download_model with tracking, or ask the person.')
      need((await gpuInfo()).ok, 'This needs a graphics card, and this computer does not seem to have a usable one.')
      const size = clipPicture(s, clip, aspectRatio(s))
      const ts = srcAt(clip, time(args.time, s))
      const prompt = boxPrompt(args.box || {}, clip, ts, s, size)
      need(prompt, 'That box is empty: give left, top, right and bottom in % of the picture.')
      let pts
      if (m && m.type === 'video') pts = await videoOutline(m.proxy || m.path, ts, prompt, st.paths)
      else if (clip.raster) {
        const cv = rasterView(clip)
        pts = await subjectOutline({ el: cv, w: cv.width, h: cv.height, prompt, paths: st.paths })
      } else {
        await imagesReady(s)
        const e = imageFor(m.path)
        pts = await subjectOutline({ el: e.img, w: e.img.naturalWidth, h: e.img.naturalHeight, prompt, paths: st.paths })
      }
      need(pts, 'Nothing was found inside that box. Make the box fit the subject better and try again.')
      const keep = clip.mask || {}
      D({ type: 'setMask', id: clip.id, patch: { shape: 'poly', pts, from: undefined, to: undefined, frames: undefined, feather: args.feather != null ? +args.feather : keep.feather == null ? 6 : keep.feather, invert: !!args.invert, expand: keep.expand || 0 } })
      return { text: `Masked with ${pts.length} points. Check it with get_preview. For a moving subject use track_mask.` }
    }
    case 'track_mask': {
      const { clip } = picture(s, args.clipId)
      const m = s.media.find((x) => x.id === clip.mediaId)
      need(m && m.type === 'video' && clip.mask && clip.mask.shape === 'poly', 'Tracking works on video clips with a drawn or smart mask.')
      need(!jobRunning(), 'Something else is running. Use check_job, or wait for it to finish.')
      const engine = args.engine || 'ai'
      need(['ai', 'quick'].includes(engine), 'engine is ai or quick.')
      const st = await window.api.modelsStatus()
      if (engine === 'ai') {
        const { gpuInfo } = await import('./smartMask.js')
        need(st.ready, 'The tracking AI model is not downloaded. Use download_model with tracking, the quick engine, or ask the person.')
        need((await gpuInfo()).ok, 'AI tracking needs a graphics card. Use the quick engine.')
      }
      const method = args.method || 'position'
      need(['position', 'rotation', 'similarity'].includes(method), 'method is position, rotation or similarity.')
      const ts = srcAt(clip, time(args.time, s))
      const end = srcAt(clip, args.until == null ? clip.start + clip.dur : +args.until)
      need(Math.abs(end - ts) >= 0.1, 'Give at least 0.1 seconds to track.')
      const seconds = startTrackMask({ handle: h, clip, media: m, ts, end, engine, method, quad: !!args.straightEdges, paths: st.paths })
      return json({ state: 'started', aboutSeconds: seconds, next: 'Call check_job every 10 seconds or so until it says done. The person sees the progress and can cancel.' })
    }
    case 'follow_subject': {
      const { clip } = picture(s, args.clipId)
      const media = s.media.find((m) => m.id === clip.mediaId)
      need(media && media.type === 'video', 'Following only works on video clips.')
      const { isTracking, gpuInfo } = await import('./smartMask.js')
      need(!isTracking() && !jobRunning(), 'Something else is running. Use check_job, or wait for it to finish.')
      const scale = args.zoom == null ? 150 : +args.zoom
      need(scale > 100 && scale <= 400, 'zoom must be above 100 (the whole picture) and at most 400.')
      need(!clip.warp && !(clip.anim && clip.anim.rot) && evalProp(clip, 'rot', clip.in) === 0, 'That clip is warped or rotated, so following cannot work it out. The person can reset that first.')
      const end = clip.start + clip.dur
      const inClip = (t) => t >= clip.start - 0.001 && t <= end + 0.001
      need(inClip(+args.time), `time must be on that clip: ${round(clip.start)} to ${round(end)} s.`)
      const a = srcAt(clip, args.from == null ? clip.start : +args.from)
      const b = srcAt(clip, args.to == null ? end : +args.to)
      const ts = srcAt(clip, +args.time)
      const from = Math.min(a, b, ts)
      const to = Math.max(a, b, ts)
      need(to - from >= 0.2, 'Give at least 0.2 seconds to follow.')
      const st = await window.api.modelsStatus()
      need(st.ready, 'The tracking AI model is not downloaded. Use download_model with tracking, or ask the person.')
      need((await gpuInfo()).ok, 'Tracking needs a graphics card, and this computer does not seem to have a usable one.')
      const prompt = boxPrompt(args.box || {}, clip, ts, s, media)
      need(prompt, 'That box is empty: give left, top, right and bottom in % of the picture.')
      const seconds = startFollow({ handle: h, clip, media, ts, from, to, prompt, scale, paths: st.paths })
      return json({ state: 'started', aboutSeconds: seconds, next: 'Call check_job every 10 seconds or so until it says done. The person sees the progress and can cancel.' })
    }
    case 'set_audio': {
      const { clip, where } = editable(s, args.clipId)
      const ids = audioIds(s, clip, where, args.stream)
      need(ids.length, 'That clip has no sound.')
      const patch = {}
      if (args.volume != null) patch.volume = Math.max(0, Math.min(2, +args.volume))
      if (args.mute != null) patch.mute = !!args.mute
      if (args.fadeIn != null) patch.fadeIn = Math.max(0, +args.fadeIn)
      if (args.fadeOut != null) patch.fadeOut = Math.max(0, +args.fadeOut)
      const clean = {}
      if (args.noiseReduction != null) clean.nr = Math.max(0, Math.min(100, +args.noiseReduction))
      if (args.cutRumble != null) clean.rumble = !!args.cutRumble
      if (args.voice != null) {
        need(['', 'clear', 'podcast', 'warm', 'phone'].includes(args.voice), 'voice is clear, podcast, warm, phone, or empty for as recorded.')
        clean.voice = args.voice
      }
      if (Object.keys(clean).length) patch.clean = clean
      let said = 'Done.'
      if (args.envelope) {
        need(ids.length === 1 || args.stream != null, 'A volume line goes on one sound: give stream too.')
        const { src } = soundOf(s, ids[0])
        const end = clip.start + clip.dur
        for (const [t] of args.envelope) need(+t >= clip.start - 0.001 && +t <= end + 0.001, `The volume line's times must be on that clip: ${round(clip.start)} to ${round(end)} s.`)
        patch.env = args.envelope.map(([t, v]) => ({ t: src(+t), v: Math.max(0, Math.min(2, +v)) })).sort((a, b) => a.t - b.t)
      }
      if (args.loudness != null) {
        const sound = soundOf(s, ids[0])
        need(sound.file, 'That sound is not ready yet. Try again in a moment.')
        const r = await window.api.measureLoudness({ file: sound.file, from: sound.from, to: sound.to, stream: 0 })
        need(r.lufs != null, 'That sound could not be measured. Is it silent?')
        const factor = Math.pow(10, (+args.loudness - r.lufs) / 20)
        patch.volume = Math.max(0.05, Math.min(2, factor))
        said = `It measured ${r.lufs.toFixed(1)} LUFS. Volume set to ${Math.round(patch.volume * 100)}%.${factor > 2 ? ' That is the most: it will still be quieter than the target.' : ''}`
      }
      need(Object.keys(patch).length, 'Give at least one thing to change.')
      D({ type: 'setClipAudio', ids, patch })
      return { text: said }
    }
    case 'add_marker':
      D({ type: 'addMarker', t: Math.max(0, +args.time), label: args.label ? String(args.label) : '' })
      return { text: 'Done.' }
    case 'edit_marker': {
      need(s.markers.some((m) => m.id === args.markerId), `There is no marker ${args.markerId}. See get_project.`)
      if (args.remove) D({ type: 'removeMarker', id: args.markerId })
      if (args.label != null) D({ type: 'renameMarker', id: args.markerId, label: String(args.label) })
      if (args.time != null) {
        D({ type: 'checkpoint' })
        D({ type: 'moveMarker', id: args.markerId, t: +args.time })
      }
      return { text: 'Done.' }
    }
    case 'seek':
      D({ type: 'setPlayhead', t: Math.max(0, +args.time), user: true })
      return { text: 'Done.' }
    case 'set_playing':
      ctx.focus(p.id)
      D({ type: 'setPlaying', value: !!args.playing })
      return { text: 'Done.' }
    case 'set_timeline_option':
      if (args.snap != null) live.setSnapOn(!!args.snap)
      if (args.closeGaps != null) live.setRippleOn(!!args.closeGaps)
      return { text: 'Done.' }
    case 'add_track': {
      need(['video', 'audio'].includes(args.kind), 'kind is video or audio.')
      const id = uid()
      D({ type: args.kind === 'video' ? 'addVideoTrack' : 'addAudioTrack', id })
      const key = (args.kind === 'video' ? 'v:' : 'a:') + id
      if (args.name) D({ type: 'renameRow', key, name: args.name })
      await wait()
      return { text: `Added. Its key is ${key}.` }
    }
    case 'set_track': {
      const key = trackKey(s, args.track)
      if (args.name != null) D({ type: 'renameRow', key, name: args.name })
      if (args.locked != null && !!args.locked !== s.lockedRows.includes(key)) D({ type: 'toggleRowLock', key })
      if (args.hidden != null && !!args.hidden !== s.hiddenRows.includes(key)) D({ type: 'toggleRowHide', key })
      if (args.index != null) D({ type: 'moveRow', key, toIndex: +args.index })
      const lane = {}
      if (args.volume != null) lane.volume = Math.max(0, Math.min(2, +args.volume))
      if (args.mute != null) lane.mute = !!args.mute
      if (Object.keys(lane).length) {
        need(key.startsWith('a:') || key.startsWith('s:'), 'Only sound tracks have a volume.')
        if (key.startsWith('a:')) D({ type: 'setTrack', id: key.slice(2), patch: lane })
        else D({ type: 'setStream', n: +key.slice(2), patch: lane })
      }
      return { text: 'Done.' }
    }
    case 'remove_track': {
      const key = trackKey(s, args.track)
      need(key.startsWith('v:') || key.startsWith('a:'), 'That track cannot be removed.')
      D({ type: key.startsWith('v:') ? 'removeVideoTrack' : 'removeAudioTrack', id: key.slice(2) })
      return { text: 'Removed, with its clips.' }
    }
    case 'set_aspect': {
      need(ASPECTS.some((a) => a.id === args.shape), `shape is one of ${ASPECTS.map((a) => a.id).join(', ')}.`)
      D({ type: 'setAspect', aspect: args.shape })
      return { text: 'Done.' }
    }
    case 'make_captions': {
      need(!jobRunning(), 'Something else is running. Use check_job, or wait for it to finish.')
      const st = await window.api.whisperStatus()
      need(st.ready, 'The speech model is not downloaded. Use download_model with speech, or ask the person.')
      const look = TEXT_PRESETS.find((x) => x.name.toLowerCase() === String(args.look || 'Subtitle').toLowerCase())
      need(look, `There is no text preset ${args.look}. See editor_info.`)
      const only = Array.isArray(args.clipIds) && args.clipIds.length > 0
      if (only) D({ type: 'selectMany', ids: args.clipIds })
      await wait()
      startJob({ title: 'Making captions', text: 'Loading the speech model…' }, async ({ progress, cancelled }) => {
        const r = await makeCaptions({ state: state(), dispatch: D, folder: st.folder, only, language: args.language || '', maxChars: args.longestCaption > 0 ? +args.longestCaption : 36, style: look, replace: args.replace !== false, onMessage: (m) => progress(0, 100, m), onProgress: (f) => (cancelled() ? null : progress(Math.round(f * 100), 100)) })
        return r
      })
      return json({ state: 'started', next: 'Call check_job every 10 seconds or so until it says done.' })
    }
    case 'save_subtitles': {
      const items = s.overlayClips.filter((c) => c.caption && c.text).map((c) => ({ start: c.start, dur: c.out - c.in, text: c.text.content }))
      need(items.length, 'There are no captions yet. Use make_captions.')
      need(/\.srt$/i.test(args.path || ''), 'The path must end in .srt.')
      return { text: `Saved: ${await window.api.saveSubtitles({ name: 'Subtitles', text: toSrt(items), file: args.path })}` }
    }
    case 'start_voiceover':
      need(!live.recording, 'It is already recording.')
      ctx.focus(p.id)
      if (args.time != null) D({ type: 'setPlayhead', t: Math.max(0, +args.time), user: true })
      await wait()
      live.startRecording()
      return { text: 'A 3 second countdown started, then the project plays while the microphone records. Use stop_voiceover to finish.' }
    case 'stop_voiceover':
      need(live.recording, 'Nothing is being recorded.')
      live.stopRecording()
      await wait(800)
      return { text: 'Stopped. The recording goes on a track called Voice-over.' }
    case 'undo':
      D({ type: 'undo' })
      return { text: 'Done.' }
    case 'redo':
      D({ type: 'redo' })
      return { text: 'Done.' }
    case 'save_project': {
      if (args.path) {
        need(/\.json$/i.test(args.path), 'The path must end in .json.')
        return { text: (await h.saveAs(args.path)) ? `Saved: ${args.path}` : 'It was not saved.' }
      }
      return { text: (await h.save()) ? 'Saved.' : 'It was not saved (the person closed the save window).' }
    }
    case 'list_versions': {
      const key = live.historyKey()
      return json((await window.api.historyList(key)).map((v) => ({ id: v.id, time: new Date(v.time).toLocaleString(), label: v.label, clips: v.clips, seconds: round(v.seconds) })))
    }
    case 'restore_version': {
      const json2 = await window.api.historyRead({ key: live.historyKey(), id: args.id })
      await live.restoreJson(json2)
      return { text: 'Restored. The version from before is kept in the history. Save to keep this one.' }
    }
    case 'open_export':
      need(s.clips.length || s.overlayClips.length, 'The timeline is empty.')
      ctx.openExport(p.id)
      return { text: 'The Export tab is open.' }
    case 'export_video': {
      need(s.clips.length || s.overlayClips.length, 'The timeline is empty.')
      need(!isExporting() && !jobRunning(), 'Something else is running. Use check_job, or wait for it to finish.')
      const st = { ...exportDefaults() }
      if (args.preset) {
        const patch = presetPatch(args.preset, projectDuration(s))
        need(patch, `There is no export preset ${args.preset}. See editor_info.`)
        Object.assign(st, patch)
      }
      for (const k of ['res', 'fps', 'codec', 'bitrate', 'container', 'speed', 'audioKbps', 'encoder', 'loudness', 'audioFormat']) if (args[k] != null) st[k] = args[k]
      if (args.soundOnly) st.outputKind = 'audio'
      const total = projectDuration(s)
      const a = args.from == null ? 0 : +args.from
      const b = args.to == null ? total : Math.min(+args.to, total)
      const part = args.from != null || args.to != null
      if (part) need(a >= 0 && b - a >= 0.5, `from and to must give at least half a second of the video, which is ${round(total)} s long.`)
      const ext = st.outputKind === 'audio' ? st.audioFormat : st.container
      need(String(args.path || '').toLowerCase().endsWith('.' + ext), `For these settings the path must end in .${ext}.`)
      const enc = await window.api.exportEncoders()
      if (st.encoder !== 'cpu' && !enc.available.includes(st.encoder)) st.encoder = 'cpu'
      startJob({ title: 'Exporting', text: 'Preparing…' }, async ({ progress, onCancel }) => {
        onCancel(cancelExport)
        let check = null
        const transitions = await window.api.listTransitions()
        const file = await runExport({ state: part ? sectionOf(state(), a, b) : state(), settings: st, transitions, outPath: args.path, onCheck: (c) => (check = c), onProgress: (x) => progress(Math.round(x.pct), 100, x.label) })
        return { file, check }
      })
      return json({ state: 'started', next: 'Call check_job every 15 seconds or so until it says done. The person sees the progress and can cancel.' })
    }
    default:
      throw new Error(`There is no tool called ${name}.`)
  }
}
