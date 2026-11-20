// Nesting (like Premiere's nested sequences): several clips become one clip you can move, cut, speed up, add effects or
// transitions to, as one. Open it to change what is inside; "Update the nest" puts the changes back.
//
// How it works: the clips go into a project of their own (kept inside the media entry: media.nest = {json, name}), which is
// rendered to a high-quality video file in userData/nests. That file is the nest clip's media, so the preview, the export,
// tracking, masks and everything else treat it like any other video. Rendering takes a moment (about as long as an export).
import { reducer, layout, overlayLayout, audioLayout, sectionOf } from './state.js'
import { runExport, cancelExport, isExporting, defaultSettings } from './exporter.js'
import { serialize, restore } from './project.js'
import { startJob, jobRunning } from './mcpJobs.js'

// what a selection means for a nest: the clips (attached sound = its video clip), and the time they cover
export function nestPlan(state, ids) {
  const want = new Set(ids.filter((id) => !String(id).startsWith('gap:')).map((id) => (String(id).startsWith('sa:') ? String(id).split(':')[1] : id)))
  const main = layout(state.clips).filter((c) => want.has(c.id))
  const ov = overlayLayout(state.overlayClips).filter((c) => want.has(c.id))
  const au = audioLayout(state.audioClips).filter((c) => want.has(c.id))
  if (!main.length && !ov.length) return { error: 'Select the clips to nest: at least one video, picture or text clip.' }
  const items = [...main, ...ov, ...au]
  const t0 = Math.min(...items.map((c) => c.start))
  const t1 = Math.max(...[...main, ...ov].map((c) => c.start + c.dur))
  if (t1 - t0 < 0.2) return { error: 'The clips to nest must cover at least a fifth of a second.' }
  return { t0, t1, ids: items.map((c) => c.id), hasMain: main.length > 0, track: ov.length ? ov[0].trackId : null }
}

// the nested project: only the planned clips, starting at 0 (with their tracks, effects, transitions and sound)
export function nestState(state, plan) {
  const keep = new Set(plan.ids)
  const others = [...state.clips, ...state.overlayClips, ...state.audioClips].map((c) => c.id).filter((id) => !keep.has(id))
  let st = { ...state, lockedRows: [], selection: others }
  if (others.length) st = reducer(st, { type: 'deleteSelection', keepGap: true })
  st = sectionOf(st, plan.t0, plan.t1)
  return { ...st, past: [], future: [], selection: [], playhead: 0, playing: false, mark: { in: null, out: null }, markers: [], lockedRows: state.lockedRows }
}

// export settings for the nest's video: the size and frame rate of its biggest, fastest video, high quality
function nestSettings(st) {
  const used = new Set([...st.clips, ...st.overlayClips].map((c) => c.mediaId))
  const vids = st.media.filter((m) => used.has(m.id) && m.type === 'video')
  const short = Math.max(0, ...vids.map((m) => Math.min(m.width || 0, m.height || 0)))
  const fps = vids.some((m) => (m.fps || 30) > 45) ? 60 : vids.some((m) => m.fps && m.fps < 26) ? 24 : 30
  const res = short >= 2000 ? '4K' : short >= 1400 ? '2K' : '1080p'
  const bitrate = { '1080p': 30, '2K': 50, '4K': 90 }[res] * (fps === 60 ? 1.5 : 1)
  return { ...defaultSettings, res, fps, bitrate, codec: 'h264', speed: 'fast', container: 'mp4', audioKbps: 320, audioMode: 'mix', outputKind: 'video', loudness: 'off', encoder: 'cpu', preset: 'custom' }
}

// render a nested project to a new file; resolves with the media item of that file
async function render(st, progress) {
  if (isExporting()) throw new Error('An export is running. Wait for it to finish (or cancel it) and try again.')
  const out = await window.api.nestPath()
  const transitions = await window.api.listTransitions()
  const file = await runExport({ state: st, settings: nestSettings(st), transitions, outPath: out, onProgress: (p) => progress(Math.round(p.pct), 100, p.label) })
  const [item] = await window.api.describeFiles([file || out])
  if (!item) throw new Error('The nest was made but could not be read back.')
  // its sound, ready before the clip goes on the timeline
  if (item.audioPending) {
    progress(100, 100, 'Preparing its sound…')
    item.audioFiles = await window.api.extractAudio(item.path, item.id, item.audioStreams)
    item.audioPending = false
  }
  return item
}

// Make a nest of the selected clips. dispatch / getState = the project's. Runs as a job (progress and Cancel in a dialog).
// Resolves with the new clip's id, or throws with a reason.
export function makeNest({ getState, dispatch, ids, name, byPerson = true }) {
  const state = getState()
  const plan = nestPlan(state, ids || state.selection)
  if (plan.error) return Promise.reject(new Error(plan.error))
  if (jobRunning()) return Promise.reject(new Error('Something else is still working. Wait for it to finish.'))
  const nested = nestState(state, plan)
  const nm = name || 'Nest ' + (state.media.filter((m) => m.nest).length + 1)
  return new Promise((resolve, reject) => {
    startJob({ title: 'Making the nest', text: 'Rendering the clips into one…', byPerson }, async ({ progress, onCancel }) => {
      onCancel(cancelExport)
      try {
        const item = await render(nested, progress)
        const media = { ...item, name: nm, nest: { json: serialize(nested), name: nm } }
        const before = new Set(getState().clips.map((c) => c.id).concat(getState().overlayClips.map((c) => c.id)))
        dispatch({ type: 'nestApply', plan, media })
        await new Promise((r) => setTimeout(r, 50))
        const st = getState()
        const made = [...st.clips, ...st.overlayClips].find((c) => c.mediaId === media.id && !before.has(c.id))
        resolve(made ? made.id : null)
        return { clip: made && made.id }
      } catch (e) {
        reject(e)
        throw e
      }
    })
  })
}

// Put a changed nest back: render the inside again and swap the file of the nest's media in the outer project.
// The nest clips keep their place; one that is now longer than the nest is shortened.
export function updateNest({ outer, mediaId, innerState, byPerson = true }) {
  if (jobRunning()) return Promise.reject(new Error('Something else is still working. Wait for it to finish.'))
  return new Promise((resolve, reject) => {
    startJob({ title: 'Updating the nest', text: 'Rendering the clips into one…', byPerson }, async ({ progress, onCancel }) => {
      onCancel(cancelExport)
      try {
        const nested = { ...innerState, past: [], future: [], selection: [], playing: false }
        const item = await render(nested, progress)
        const old = outer.getState().media.find((m) => m.id === mediaId)
        const name = (old && old.nest && old.nest.name) || (old && old.name) || 'Nest'
        outer.dispatch({ type: 'nestReplace', id: mediaId, media: { ...item, name, nest: { json: serialize(nested), name } } })
        resolve(item.id)
        return { updated: true, mediaId: item.id }
      } catch (e) {
        reject(e)
        throw e
      }
    })
  })
}

// the inside of a nest as a project (for opening it in a tab)
export const nestJson = (media) => (media && media.nest && media.nest.json) || null
export { restore }
