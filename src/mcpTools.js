// The AI connection, page side: what each tool does (the list and its descriptions are in electron/mcpTools.js).
// An AI app goes through the same actions as the buttons, so its changes show up at once and Ctrl+Z takes them back.
import { layout, overlayLayout, audioLayout, srcAt, projectDuration, rowKeys, hasAttached, isLocked, streamCount } from './state.js'
import { evalProp, keyTimes, PROPS } from './motion.js'

const round = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)
const wait = (ms = 90) => new Promise((r) => setTimeout(r, ms))
const json = (o) => ({ text: JSON.stringify(o) })
const need = (ok, msg) => {
  if (!ok) throw new Error(msg)
}

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
const time = (v, s) => Math.max(0, v == null ? s.playhead : +v)

function describeClip(c, s, where) {
  const m = s.media.find((x) => x.id === c.mediaId)
  const out = { id: c.id, kind: c.text ? 'text' : m ? m.type : 'audio', name: c.text ? c.text.content : m ? m.name : '?', start: round(c.start), end: round(c.start + c.dur), fileFrom: round(c.in), fileTo: round(c.out) }
  if (c.speed) out.speed = c.speed
  if (c.transition && c.transition.name) out.transitionIn = c.transition.name
  if (c.fx) out.effects = c.fx
  if (where !== 'audio') {
    const keys = {}
    for (const p of PROPS) {
      const list = c.anim && c.anim[p.id]
      if (list && list.length) keys[p.id] = list.map((k) => ({ fileTime: round(k.t), value: round(k.v) }))
    }
    if (Object.keys(keys).length) out.keyframes = keys
    else if (keyTimes(c).length) out.keyframes = 'warp or mask only'
    const look = {}
    for (const p of PROPS) if (!p.mask && evalProp(c, p.id, c.in) !== p.def) look[p.id] = round(evalProp(c, p.id, c.in))
    if (Object.keys(look).length) out.values = look
  }
  return out
}

function projectSummary(s) {
  const tracks = []
  for (const key of rowKeys(s)) {
    const base = { locked: s.lockedRows.includes(key), hidden: s.hiddenRows.includes(key) }
    if (key === 'main') tracks.push({ name: s.mainName, type: 'main video', ...base, clips: layout(s.clips).map((c) => describeClip(c, s, 'main')) })
    else if (key.startsWith('v:')) {
      const t = s.videoTracks.find((x) => x.id === key.slice(2))
      tracks.push({ name: t.name, type: 'video', ...base, clips: overlayLayout(s.overlayClips).filter((c) => c.trackId === t.id).map((c) => describeClip(c, s, 'video')) })
    } else if (key.startsWith('a:')) {
      const t = s.audioTracks.find((x) => x.id === key.slice(2))
      tracks.push({ name: t.name, type: 'audio', ...base, clips: audioLayout(s.audioClips).filter((c) => c.trackId === t.id).map((c) => describeClip(c, s, 'audio')) })
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
    markers: s.markers.map((m) => ({ time: round(m.t), label: m.label })),
  }
}

// ctx: project() = {id, handle} of the video project in use, or null; newProject(); openExport(id); focus(id)
export async function runTool(name, args, ctx) {
  if (name === 'new_video_project') {
    ctx.newProject()
    await wait(400)
    return { text: 'A new empty video project is open.' }
  }
  const p = ctx.project()
  need(p, ctx.onImage() ? 'The tab in front is a picture project, and the AI connection only works with video projects so far. Ask the person to switch to a video project, or use new_video_project.' : 'No video project is open. Ask the person to open one, or use new_video_project.')
  const h = p.handle
  const state = () => h.getState()
  const D = h.dispatch
  const s = state()

  switch (name) {
    case 'get_project':
      return json(projectSummary(s))
    case 'describe_clips': // (for the question the person is asked)
      return { text: (args.clipIds || []).slice(0, 8).map((id) => { try { return describeClip(locate(s, id).clip, s, locate(s, id).where).name } catch { return null } }).filter(Boolean).join('\n') }
    case 'get_preview': {
      ctx.focus(p.id)
      if (args.time != null) D({ type: 'setPlayhead', t: Math.max(0, +args.time), user: true })
      await wait(500)
      const cv = [...document.querySelectorAll('.preview-canvas')].find((c) => c.offsetParent)
      need(cv, 'The preview is not on screen.')
      const small = document.createElement('canvas')
      small.width = Math.min(960, cv.width)
      small.height = Math.round((small.width * cv.height) / cv.width)
      const g = small.getContext('2d')
      g.fillStyle = '#000'
      g.fillRect(0, 0, small.width, small.height)
      g.drawImage(cv, 0, 0, small.width, small.height)
      return { image: small.toDataURL('image/jpeg', 0.8).split(',')[1], mime: 'image/jpeg', text: `The picture at ${round(state().playhead)} s.` }
    }
    case 'get_transcript': {
      const tr = s.transcripts && s.transcripts[args.mediaId]
      need(tr && tr.words, 'That file has no transcript yet. The person can make one with the Captions button.')
      return json(tr.words.map((w) => ({ text: w.text, start: round(w.s), end: round(w.e) })))
    }
    case 'list_transitions':
      return json((await window.api.listTransitions()).map((t) => t.name))
    case 'import_media': {
      need(Array.isArray(args.paths) && args.paths.length, 'Give at least one file path.')
      const items = await window.api.describeFiles(args.paths)
      need(items.length, 'None of those files could be read.')
      h.addMedia(items)
      await wait()
      return json(items.map((m) => ({ id: m.id, name: m.name, type: m.type, seconds: round(m.duration) })))
    }
    case 'add_clip': {
      const m = s.media.find((x) => x.id === args.mediaId)
      need(m, `There is no file with the id ${args.mediaId}.`)
      if (m.type === 'audio') D({ type: 'addAudioClip', mediaId: m.id, trackId: null, start: time(args.time, s) })
      else if (args.time == null) D({ type: 'addClip', mediaId: m.id })
      else D({ type: 'addOverlayClip', mediaId: m.id, start: Math.max(0, +args.time) })
      await wait()
      return { text: `Added. Its id is ${state().selection[0]}.` }
    }
    case 'add_text': {
      D({ type: 'addText', t: time(args.time, s), dur: args.duration > 0 ? +args.duration : 3, y: +args.y || 0, text: { content: String(args.text) } })
      await wait()
      return { text: `Added. Its id is ${state().selection[0]}.` }
    }
    case 'set_text': {
      const { clip } = picture(s, args.clipId)
      need(clip.text, 'That is not a text clip.')
      D({ type: 'setText', id: clip.id, patch: { content: String(args.text) } })
      return { text: 'Done.' }
    }
    case 'move_clip': {
      const { clip, where } = editable(s, args.clipId)
      if (where === 'main') {
        need(args.index != null, 'That clip is on the main track: give index, its new place among the main track clips.')
        D({ type: 'moveMainTo', ids: [clip.id], toIndex: +args.index, gap: 0 })
      } else {
        need(args.start != null, 'Give start, the new time in seconds.')
        D({ type: 'checkpoint' })
        D({ type: 'moveItems', moves: [{ id: clip.id, start: +args.start }] })
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
      D({ type: 'selectMany', ids })
      D({ type: 'deleteSelection', keepGap: args.closeGaps === false })
      return { text: `Deleted ${ids.length}.` }
    }
    case 'set_value':
    case 'add_keyframe': {
      const { clip } = picture(s, args.clipId)
      propOk(args.property)
      const list = (clip.anim && clip.anim[args.property]) || []
      const t = srcAt(clip, time(args.time, s))
      D({ type: 'checkpoint' })
      if (name === 'add_keyframe' && !list.length) D({ type: 'toggleKey', id: clip.id, prop: args.property, t })
      D({ type: 'setProp', id: clip.id, prop: args.property, value: +args.value, t })
      return { text: 'Done.' }
    }
    case 'remove_keyframes': {
      const { clip } = picture(s, args.clipId)
      propOk(args.property)
      D({ type: 'clearProp', id: clip.id, prop: args.property })
      return { text: 'Done.' }
    }
    case 'set_transition': {
      const { clip, where } = picture(s, args.clipId)
      need(where === 'main', 'Transitions only work on the main track.')
      if (args.name) {
        const names = (await window.api.listTransitions()).map((t) => t.name)
        need(names.includes(args.name), `There is no transition called ${args.name}. Use list_transitions.`)
      }
      D({ type: 'setTransition', id: clip.id, transition: args.name ? { name: args.name, duration: args.duration > 0 ? +args.duration : 1 } : null })
      return { text: 'Done.' }
    }
    case 'set_effect': {
      const { clip } = picture(s, args.clipId)
      need(['blur', 'sharpen', 'vignette', 'glow'].includes(args.effect), `Unknown effect ${args.effect}.`)
      D({ type: 'checkpoint' })
      D({ type: 'setFx', id: clip.id, patch: { [args.effect]: Math.max(0, Math.min(100, +args.value)) } })
      return { text: 'Done.' }
    }
    case 'set_volume': {
      const { clip, where } = editable(s, args.clipId)
      const m = s.media.find((x) => x.id === clip.mediaId)
      const ids = where === 'audio' ? [clip.id] : []
      if (where === 'main') (m && m.audioStreams ? m.audioStreams : []).forEach((_, n) => hasAttached(clip, m, n) && ids.push(`sa:${clip.id}:${n}`))
      if (where === 'video') s.audioClips.forEach((a) => a.origin === clip.id && ids.push(a.id))
      need(ids.length, 'That clip has no sound.')
      D({ type: 'checkpoint' })
      D({ type: 'setClipAudio', ids, patch: { volume: Math.max(0, Math.min(2, +args.volume)) } })
      return { text: 'Done.' }
    }
    case 'add_marker':
      D({ type: 'addMarker', t: Math.max(0, +args.time), label: args.label ? String(args.label) : '' })
      return { text: 'Done.' }
    case 'seek':
      D({ type: 'setPlayhead', t: Math.max(0, +args.time), user: true })
      return { text: 'Done.' }
    case 'undo':
      D({ type: 'undo' })
      return { text: 'Done.' }
    case 'redo':
      D({ type: 'redo' })
      return { text: 'Done.' }
    case 'save_project':
      return { text: (await h.save()) ? 'Saved.' : 'It was not saved (the person closed the save window).' }
    case 'open_export':
      need(s.clips.length || s.overlayClips.length, 'The timeline is empty.')
      ctx.openExport(p.id)
      return { text: 'The Export tab is open. The person chooses the settings and presses Export there.' }
    default:
      throw new Error(`There is no tool called ${name}.`)
  }
}
