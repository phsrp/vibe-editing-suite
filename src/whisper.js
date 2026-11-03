// Speech to text (captions): Whisper base running in the app, on the graphics card when there is one.
// The model files are downloaded once on request (see electron/main.js, 'whisper:download') and loaded from there.
import { toUrl, layout, speedOf, hasAttached, streamAudioOf, audioClipVol } from './state.js'

let transcriber = null
let loading = null

export const LANGUAGES = [
  ['', 'Detect it by itself'],
  ['english', 'English'], ['spanish', 'Spanish'], ['french', 'French'], ['german', 'German'], ['italian', 'Italian'],
  ['portuguese', 'Portuguese'], ['dutch', 'Dutch'], ['polish', 'Polish'], ['turkish', 'Turkish'], ['russian', 'Russian'],
  ['ukrainian', 'Ukrainian'], ['arabic', 'Arabic'], ['hindi', 'Hindi'], ['japanese', 'Japanese'], ['korean', 'Korean'],
  ['chinese', 'Chinese'], ['swedish', 'Swedish'], ['norwegian', 'Norwegian'], ['danish', 'Danish'], ['finnish', 'Finnish'],
  ['greek', 'Greek'], ['czech', 'Czech'], ['romanian', 'Romanian'], ['hungarian', 'Hungarian'], ['indonesian', 'Indonesian'],
]

// load the model (once); folder = where the downloaded files are
export async function loadWhisper(folder) {
  if (transcriber) return transcriber
  if (loading) return loading
  loading = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers')
    env.allowRemoteModels = false // everything comes from the downloaded files, nothing is fetched from the internet
    env.allowLocalModels = true
    env.useBrowserCache = false
    env.localModelPath = toUrl(folder) + '/'
    const base = new URL('./ort-tf/', document.baseURI).href
    env.backends.onnx.wasm.wasmPaths = { mjs: base + 'ort-wasm-simd-threaded.asyncify.mjs', wasm: base + 'ort-wasm-simd-threaded.asyncify.wasm' }
    const gpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter().catch(() => null)))
    transcriber = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base_timestamped', {
      device: gpu ? 'webgpu' : 'wasm',
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    })
    transcriber.__device = gpu ? 'graphics card' : 'processor'
    return transcriber
  })()
  try {
    return await loading
  } finally {
    loading = null
  }
}
export const whisperDevice = () => (transcriber && transcriber.__device) || ''

// Listen to 16 kHz mono sound (Float32Array). Returns words: [{text, start, end}] in seconds from the start of the sound.
export async function transcribeWords(pcm, { language, onProgress } = {}) {
  const t = transcriber
  if (!t) throw new Error('The speech model is not loaded.')
  const seconds = pcm.length / 16000
  const total = Math.max(1, Math.ceil(seconds / 20)) // about 20 new seconds per 30-second window
  let seen = 0
  const run = (mode) =>
    t(pcm, {
      return_timestamps: mode,
      chunk_length_s: 30,
      stride_length_s: 5,
      language: language || null,
      task: 'transcribe',
      chunk_callback: () => {
        seen++
        onProgress && onProgress(Math.min(0.99, seen / total))
      },
    })
  // the model gives the time of every WORD; if it ever cannot, the time of every phrase is spread over its words
  let r
  let perWord = true
  try {
    r = await run('word')
  } catch (e) {
    if (!/cross.?attention/i.test(String((e && e.message) || e))) throw e
    perWord = false
    seen = 0
    r = await run(true)
  }
  const words = []
  if (perWord) {
    const list = (r.chunks || []).filter((c) => String(c.text || '').trim() && c.timestamp && c.timestamp[0] != null)
    list.forEach((c, i) => {
      const text = String(c.text).trim()
      if (/^\[.*\]$|^\(.*\)$/.test(text)) return // (sound notes like [MUSIC] are not speech)
      const s = c.timestamp[0]
      const nextStart = list[i + 1] ? list[i + 1].timestamp[0] : null
      let e = c.timestamp[1]
      if (e == null || e <= s) e = nextStart != null && nextStart > s ? Math.min(nextStart, s + 0.6) : s + 0.35
      words.push({ text, start: s, end: e })
    })
    return words
  }
  for (const c of r.chunks || []) {
    const text = String(c.text || '').replace(/\s+/g, ' ').trim()
    if (!text || /^\[.*\]$|^\(.*\)$/.test(text)) continue // (sound notes like [MUSIC] are not speech)
    const [s, e0] = c.timestamp || []
    if (s == null) continue
    const e = e0 == null || e0 <= s ? Math.min(seconds, s + Math.max(1, text.length * 0.06)) : e0
    // spread the words over the phrase, each taking time in proportion to its length
    const parts = text.split(' ')
    const weight = parts.reduce((a, w) => a + w.length + 1, 0)
    let at = s
    for (const w of parts) {
      const dur = ((w.length + 1) / weight) * (e - s)
      words.push({ text: w, start: at, end: at + dur })
      at += dur
    }
  }
  return words
}

// Which sound should be listened to: the video's own speech (first sound of every video clip, and the sound that was
// detached from videos), or only the selected clips. Muted and hidden sound is left out.
export function speechSources(state, onlySelected) {
  const sel = new Set(state.selection)
  const hid = new Set(state.hiddenRows || [])
  const media = (id) => state.media.find((m) => m.id === id)
  const out = []
  for (const c of layout(state.clips)) {
    const m = media(c.mediaId)
    if (!m || m.type !== 'video' || m.missing || c.reverse) continue
    const streams = (m.audioStreams || []).map((_, n) => n).filter((n) => hasAttached(c, m, n))
    if (onlySelected && !sel.has(c.id) && !streams.some((n) => sel.has(`sa:${c.id}:${n}`))) continue
    const n = onlySelected ? streams.find((k) => sel.has(c.id) || sel.has(`sa:${c.id}:${k}`)) : streams.find((k) => !hid.has('s:' + k) && !(state.streamSettings[k] || {}).mute)
    if (n == null || streamAudioOf(c, n).mute) continue
    out.push({ mediaId: m.id, file: m.path, stream: n, from: c.in, to: c.out, start: c.start, speed: speedOf(c), name: m.name })
  }
  for (const a of state.audioClips) {
    const m = media(a.mediaId)
    if (!m || m.missing) continue
    if (onlySelected ? !sel.has(a.id) : a.stream == null) continue // (without a selection only the sound of videos, not music)
    const tr = state.audioTracks.find((x) => x.id === a.trackId)
    if ((tr && tr.mute) || hid.has('a:' + a.trackId) || audioClipVol(a).mute) continue
    out.push({ mediaId: m.id, file: m.path, stream: a.stream != null ? a.stream : 0, from: a.in, to: a.out, start: a.start, speed: 1, name: m.name })
  }
  return out
}

// words (timeline seconds) -> caption lines: [{start, dur, text}]
export function toCaptions(words, maxChars = 36, maxSeconds = 4.5) {
  const textOf = (ws) => ws.map((w) => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1')
  // 1) sentences: a full stop or a pause ends one
  const groups = []
  let cur = []
  for (const w of words) {
    if (cur.length && w.start - cur[cur.length - 1].end > 0.9) {
      groups.push(cur)
      cur = []
    }
    cur.push(w)
    if (/[.!?…]$/.test(w.text)) {
      groups.push(cur)
      cur = []
    }
  }
  if (cur.length) groups.push(cur)
  // 2) a long sentence is cut into captions of about the same length (no lonely last word)
  const lines = []
  for (const g of groups) {
    const total = textOf(g).length
    const n = Math.max(1, Math.ceil(total / maxChars), Math.ceil((g[g.length - 1].end - g[0].start) / maxSeconds))
    const target = total / n
    let line = []
    let made = 0
    g.forEach((w, i) => {
      line.push(w)
      const last = i === g.length - 1
      const next = g[i + 1]
      // cut once this caption has its share of the letters (or the next word would go over the limit)
      const over = next && textOf([...line, next]).length > maxChars
      if (last || (made < n - 1 && (over || textOf(line).length >= target))) {
        lines.push({ start: line[0].start, end: line[line.length - 1].end, text: textOf(line) })
        line = []
        made++
      }
    })
  }
  // each caption stays up a little (at least 0.6 s) but never runs into the next one
  return lines.map((l, i) => {
    const next = lines[i + 1]
    let end = Math.max(l.end, l.start + 0.6)
    if (next) end = Math.min(end, Math.max(l.end, next.start - 0.02))
    return { start: l.start, dur: Math.max(0.2, end - l.start), text: l.text }
  })
}

// Listens to the project and adds the captions. Returns {count, message}. Throws if the model cannot run.
export async function makeCaptions({ state, dispatch, folder, only, language, maxChars = 36, style, replace, onMessage, onProgress }) {
  const sources = speechSources(state, only)
  if (!sources.length) return { count: 0, message: only ? 'Nothing selected has speech in it. Select a video clip (or its sound) first.' : 'No sound to listen to: the videos are silent or muted.' }
  await loadWhisper(folder)
  const all = []
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i]
    onMessage(`Listening to ${s.name}${sources.length > 1 ? ` (${i + 1} of ${sources.length})` : ''}… (on the ${whisperDevice()})`)
    const buf = await window.api.pcm16k({ file: s.file, stream: s.stream, start: s.from, dur: s.to - s.from })
    const words = await transcribeWords(new Float32Array(buf), { language, onProgress: (p) => onProgress((i + p) / sources.length) })
    const len = s.to - s.from
    // keep what was said with the video (seconds of the file), for editing by text
    dispatch({ type: 'setTranscript', mediaId: s.mediaId, from: s.from, to: s.to, words: words.map((w) => ({ text: w.text, s: s.from + Math.min(w.start, len), e: s.from + Math.min(w.end, len) })) })
    for (const w of words) all.push({ text: w.text, start: s.start + Math.min(w.start, len) / s.speed, end: s.start + Math.min(w.end, len) / s.speed })
  }
  all.sort((a, b) => a.start - b.start)
  const items = toCaptions(all, maxChars)
  if (!items.length) return { count: 0, message: 'No speech was found.' }
  dispatch({ type: 'addCaptions', items, style, replace })
  return { count: items.length, message: `Added ${items.length} captions on the "Captions" track. Click one on the timeline to fix a word or change its look.` }
}

// .srt text of the captions: [{start, dur, text}]
export function toSrt(items) {
  const ts = (t) => {
    const ms = Math.round(Math.max(0, t) * 1000)
    const p = (n, w = 2) => String(n).padStart(w, '0')
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`
  }
  return items
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((it, i) => `${i + 1}\r\n${ts(it.start)} --> ${ts(it.start + it.dur)}\r\n${it.text}\r\n`)
    .join('\r\n')
}
