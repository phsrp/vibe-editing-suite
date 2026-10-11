import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import { projectDuration } from './state.js'
import { RESOLUTIONS, DEFAULT_BITRATE, defaultSettings, runExport, cancelExport, isExporting, frameSize } from './exporter.js'

const ENCODERS = [
  { id: 'nvenc', label: 'NVIDIA graphics card (NVENC)' },
  { id: 'amf', label: 'AMD graphics card (AMF)' },
  { id: 'qsv', label: 'Intel graphics (Quick Sync)' },
]

// ready-made export settings for the places videos usually go
const PRESET_LIST = [
  { id: 'custom', label: 'Custom (your own settings)' },
  { id: 'yt1080', label: 'YouTube 1080p', aspect: '16:9', s: { res: '1080p', fps: 30, codec: 'h264', bitrate: 12, container: 'mp4', speed: 'balanced', audioKbps: 192, loudness: '-14' } },
  { id: 'yt4k', label: 'YouTube 4K', aspect: '16:9', s: { res: '4K', fps: 30, codec: 'h264', bitrate: 45, container: 'mp4', speed: 'balanced', audioKbps: 256, loudness: '-14' } },
  { id: 'vertical', label: 'TikTok, Instagram Reels, YouTube Shorts', aspect: '9:16', s: { res: '1080p', fps: 30, codec: 'h264', bitrate: 10, container: 'mp4', speed: 'balanced', audioKbps: 192, loudness: '-14' } },
  { id: 'square', label: 'Instagram post (square)', aspect: '1:1', s: { res: '1080p', fps: 30, codec: 'h264', bitrate: 8, container: 'mp4', speed: 'balanced', audioKbps: 192, loudness: '-14' } },
  { id: 'portrait', label: 'Instagram post (portrait 4:5)', aspect: '4:5', s: { res: '1080p', fps: 30, codec: 'h264', bitrate: 8, container: 'mp4', speed: 'balanced', audioKbps: 192, loudness: '-14' } },
  { id: 'small10', label: 'Small file: under 10 MB (email, Discord)', limitMB: 10, s: { fps: 30, codec: 'h264', container: 'mp4', speed: 'balanced', audioKbps: 96 } },
  { id: 'small25', label: 'Small file: under 25 MB (Discord)', limitMB: 25, s: { fps: 30, codec: 'h264', container: 'mp4', speed: 'balanced', audioKbps: 128 } },
  { id: 'master', label: 'High quality master (4K, H.265)', s: { res: '4K', fps: 30, codec: 'h265', bitrate: 60, container: 'mkv', speed: 'best', audioKbps: 320, loudness: 'off' } },
  { id: 'draft', label: 'Quick draft (720p, fast)', s: { res: '720p', fps: 30, codec: 'h264', bitrate: 4, container: 'mp4', speed: 'fast', audioKbps: 128, loudness: 'off' } },
]

const KEY = 'vibe.exportSettings'
const load = () => {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem(KEY) || '{}') }
  } catch {
    return defaultSettings
  }
}

const fmtDur = (s) => {
  s = Math.max(0, Math.round(s))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h) return `${h}h ${String(m).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

// The Export tab of a project: settings on the left, and on the right the video as it is being made.
export default function ExportTab({ active, getProject, onStatus }) {
  const [s, setS] = useState(load)
  const [phase, setPhase] = useState('settings') // settings | running | done | error
  const [prog, setProg] = useState({ pct: 0, label: '' })
  const [eta, setEta] = useState(null)
  const [elapsed, setElapsed] = useState(0)
  const [out, setOut] = useState('')
  const [check, setCheck] = useState(null) // the result of checking the finished file
  const [err, setErr] = useState('')
  const [shown, setShown] = useState(null) // 'canvas' | 'image' | null: what the preview area shows
  const [imgUrl, setImgUrl] = useState('')
  const [project, setProject] = useState(() => getProject())
  const [gpu, setGpu] = useState(null) // {gpus: [names], available: ['nvenc'|'amf'|'qsv']} once checked
  const canvasRef = useRef(null)
  const t0 = useRef(0)
  useEffect(() => {
    window.api.exportEncoders().then(setGpu).catch(() => setGpu({ gpus: [], available: [] }))
  }, [])

  const set = (patch) => setS((x) => ({ ...x, ...patch, preset: 'custom' })) // changing anything by hand leaves the preset
  const applyPreset = (id) => {
    const p = PRESET_LIST.find((x) => x.id === id)
    if (!p || id === 'custom') return setS((x) => ({ ...x, preset: 'custom' }))
    const dur = Math.max(1, projectDuration(project.state))
    let patch = { ...p.s, outputKind: 'video', preset: id }
    if (p.limitMB) {
      // pick the video bitrate so the whole file stays under the limit
      const total = (p.limitMB * 8 * 0.9) / dur // Mbit/s for video + sound
      const video = Math.max(0.3, Math.min(60, total - p.s.audioKbps / 1000))
      patch = { ...patch, bitrate: +video.toFixed(2), res: video >= 3 ? '1080p' : '720p' }
    }
    setS((x) => ({ ...x, ...patch }))
  }
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s))
    } catch {}
  }, [s])
  // when this tab is opened or shown again, look at the project as it is now
  useEffect(() => {
    if (active && phase !== 'running') setProject(getProject())
  }, [active])
  // a clock while exporting
  useEffect(() => {
    if (phase !== 'running') return
    const id = setInterval(() => setElapsed((performance.now() - t0.current) / 1000), 500)
    return () => clearInterval(id)
  }, [phase])

  const state = project.state
  const duration = projectDuration(state)
  const [rw, rh] = frameSize(s.res, state)
  const audioOnly = s.outputKind === 'audio'
  const presetInfo = PRESET_LIST.find((p) => p.id === s.preset)
  const mb = audioOnly ? (s.audioKbps * duration) / 8 / 1000 : ((s.bitrate * 1000 + s.audioKbps) * duration) / 8 / 1000
  const sizeText = mb >= 1000 ? (mb / 1000).toFixed(1) + ' GB' : Math.round(mb) + ' MB' // from 1 GB up, show GB
  const empty = !state.clips.length && !state.overlayClips.length

  const start = async () => {
    if (isExporting()) {
      setErr('Another export is already running. Wait for it to finish, or cancel it first.')
      setPhase('error')
      return
    }
    const snap = getProject()
    setProject(snap)
    const ext = s.outputKind === 'audio' ? s.audioFormat : s.container
    const file = await window.api.exportChooseOutput(`${snap.name || 'My video'}.${ext}`, ext)
    if (!file) return
    setPhase('running')
    setErr('')
    setShown(null)
    setCheck(null)
    setProg({ pct: 0, label: 'Preparing…' })
    setElapsed(0)
    t0.current = performance.now()
    onStatus({ running: true, pct: 0 })
    try {
      const transitions = await window.api.listTransitions()
      const result = await runExport({
        state: snap.state,
        settings: { ...s, encoder },
        transitions,
        outPath: file,
        onCheck: setCheck,
        onProgress: (p) => {
          setProg(p)
          const el = (performance.now() - t0.current) / 1000
          setEta(p.pct > 3 ? (el / p.pct) * (100 - p.pct) : null)
          onStatus({ running: true, pct: p.pct })
        },
        onPreview: (canvas) => {
          const cv = canvasRef.current
          if (!cv) return
          setShown((v) => v || 'canvas')
          if (cv.width !== 640) {
            cv.width = 640
            cv.height = 360
          }
          cv.getContext('2d').drawImage(canvas, 0, 0, cv.width, cv.height)
        },
        onPreviewUrl: (url) => {
          setShown('image')
          setImgUrl(url)
        },
      })
      setOut(result)
      setPhase('done')
      onStatus({ running: false, pct: 100, done: true })
    } catch (e) {
      if (String(e.message).includes('cancelled')) setPhase('settings')
      else {
        setErr(String(e.message || e))
        setPhase('error')
      }
      onStatus({ running: false, pct: 0 })
    }
  }

  const running = phase === 'running'
  const has = (id) => !!gpu && gpu.available.includes(id)
  const encoder = s.encoder === 'cpu' || has(s.encoder) ? s.encoder : 'cpu' // a saved choice that does not work here falls back to the processor

  return (
    <div className="export-page" style={{ display: active ? undefined : 'none' }}>
      <div className="export-side">
        <h2>Export video</h2>
        <div className="exp-grid">
          <label>Preset</label>
          <select disabled={running} value={s.preset || 'custom'} onChange={(e) => applyPreset(e.target.value)}>
            {PRESET_LIST.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>

          <label>Make</label>
          <select disabled={running} value={s.outputKind || 'video'} onChange={(e) => set({ outputKind: e.target.value })}>
            <option value="video">A video (picture and sound)</option>
            <option value="audio">Sound only (audio file)</option>
          </select>

          {!audioOnly && (
            <>
              <label>Resolution</label>
              <select disabled={running} value={s.res} onChange={(e) => set({ res: e.target.value, bitrate: DEFAULT_BITRATE[e.target.value] })}>
                {Object.keys(RESOLUTIONS).map((k) => {
                  const [w, h] = frameSize(k, state)
                  return <option key={k} value={k}>{k} ({w}×{h})</option>
                })}
              </select>

              <label>Frame rate</label>
              <select disabled={running} value={s.fps} onChange={(e) => set({ fps: +e.target.value })}>
                {[24, 30, 60].map((f) => (
                  <option key={f} value={f}>{f} fps</option>
                ))}
              </select>

              <label>Video format</label>
              <select disabled={running} value={s.codec} onChange={(e) => set({ codec: e.target.value })}>
                <option value="h264">H.264 (works everywhere)</option>
                <option value="h265">H.265 / HEVC (smaller files, slower)</option>
              </select>

              <label>File type</label>
              <select disabled={running} value={s.container} onChange={(e) => set({ container: e.target.value })}>
                <option value="mp4">MP4 (works everywhere)</option>
                <option value="mkv">MKV (handles many audio tracks well)</option>
                <option value="mov">MOV (Apple, editing programs)</option>
              </select>

              <label>Video bitrate: {s.bitrate} Mbps</label>
              <input disabled={running} type="range" min="1" max="100" step="1" value={Math.max(1, Math.min(100, s.bitrate))} onChange={(e) => set({ bitrate: +e.target.value })} />

              <label>Speed / quality</label>
              <select disabled={running} value={s.speed} onChange={(e) => set({ speed: e.target.value })}>
                <option value="fast">Fast (bigger file)</option>
                <option value="balanced">Balanced</option>
                <option value="best">Best quality (slow)</option>
              </select>

              <label>Encoder</label>
              <select disabled={running} value={encoder} onChange={(e) => set({ encoder: e.target.value })}>
                <option value="cpu">Processor (works on every PC)</option>
                {ENCODERS.map((x) => (
                  <option key={x.id} value={x.id} disabled={!has(x.id)}>
                    {x.label}{has(x.id) ? '' : ' (not found)'}
                  </option>
                ))}
              </select>

              {gpu && s.encoder !== 'cpu' && encoder === 'cpu' && (
                <div className="hint warn" style={{ gridColumn: '1 / -1' }}>
                  The graphics card encoder you chose was not found on this PC, so the <b>processor</b> will be used. That is much slower.
                </div>
              )}
              {encoder === 'cpu' && s.codec === 'h265' && s.speed === 'best' && (
                <div className="hint warn" style={{ gridColumn: '1 / -1' }}>
                  <b>H.265 with “Best quality” on the processor is very slow</b>: on a fast PC it took about 4 to 5 times the length of the video at 1080p 60 fps
                  (a 2 minute video: about 9 minutes). Use a graphics card encoder (about 1 minute), or pick Balanced / H.264.
                </div>
              )}
              <label>Audio tracks</label>
              <select disabled={running} value={s.audioMode} onChange={(e) => set({ audioMode: e.target.value })}>
                <option value="mix">Mix everything into one track</option>
                <option value="separate">Keep tracks separate</option>
              </select>
            </>
          )}

          {audioOnly && (
            <>
              <label>Audio file type</label>
              <select disabled={running} value={s.audioFormat || 'mp3'} onChange={(e) => set({ audioFormat: e.target.value })}>
                <option value="mp3">MP3 (works everywhere)</option>
                <option value="m4a">M4A (AAC, better quality per size)</option>
                <option value="wav">WAV (no compression, big files)</option>
              </select>
            </>
          )}

          {!(audioOnly && s.audioFormat === 'wav') && (
            <>
              <label>Audio quality</label>
              <select disabled={running} value={s.audioKbps} onChange={(e) => set({ audioKbps: +e.target.value })}>
                {[96, 128, 192, 256, 320].map((k) => (
                  <option key={k} value={k}>{k} kbps{k === 192 ? ' (good)' : k === 320 ? ' (best)' : ''}</option>
                ))}
              </select>
            </>
          )}

          <label>Loudness</label>
          <select disabled={running || (!audioOnly && s.audioMode === 'separate')} value={s.loudness || 'off'} onChange={(e) => set({ loudness: e.target.value })} title="Make the whole sound as loud as streaming sites expect">
            <option value="off">Leave as it is</option>
            <option value="-14">Normalise to -14 LUFS (YouTube, Spotify)</option>
            <option value="-16">Normalise to -16 LUFS (podcasts, phones)</option>
            <option value="-23">Normalise to -23 LUFS (TV, broadcast)</option>
          </select>
        </div>
        {presetInfo && presetInfo.aspect && state.aspect !== presetInfo.aspect && (
          <div className="hint warn">This preset is made for {presetInfo.aspect} videos. Your project is {state.aspect}: change the shape next to the project name in the editor.</div>
        )}
        {presetInfo && presetInfo.limitMB && <div className="hint left">The video bitrate was chosen so the file stays under {presetInfo.limitMB} MB for a {fmtDur(duration)} video.</div>}        <div className="hint left exp-info">
          <b>Graphics card encoding</b> is much faster for H.265 and somewhat faster for H.264, but needs a graphics card with a video encoder: an <b>NVIDIA</b> GeForce (GTX 600 or newer, or any RTX), an <b>AMD</b> Radeon (RX 400 or newer) or <b>Intel</b> built-in graphics (2nd generation Core or newer), with up-to-date drivers.
        </div>
        <div className="hint left exp-info">
          <b>
            {gpu == null
              ? 'Checking this PC…'
              : gpu.gpus.length
                ? `Found on this PC: ${gpu.gpus.join(', ')}. ${gpu.available.length ? 'It can be used for exporting.' : 'None of them can be used for exporting here.'}`
                : 'No graphics card was found on this PC.'}
          </b>
        </div>        <div className="hint left exp-info">
          {state.clips.length + state.overlayClips.length} clip{state.clips.length + state.overlayClips.length === 1 ? '' : 's'} · length {fmtDur(duration)} · about {sizeText} at {rw}×{rh}. Muted tracks are not included.
          {s.audioMode === 'separate' && ' Each audio track becomes its own audio stream in the file (switch between them in a player like VLC).'}
        </div>
        {phase === 'error' && <div className="exp-error">Export failed:<pre>{err}</pre></div>}
        <div className="export-actions">
          {!running && (
            <button className="primary big" onClick={start} disabled={empty}>
              <Icon name="upload" size={16} /> {phase === 'done' ? 'Export again…' : 'Start export…'}
            </button>
          )}
          {running && (
            <button className="big" onClick={cancelExport}>Cancel export</button>
          )}
          {phase === 'done' && (
            <button className="big" onClick={() => window.api.exportReveal(out)}>
              <Icon name="folder" size={16} /> Show in folder
            </button>
          )}
        </div>
        {empty && <div className="hint warn">This project has nothing on its timeline yet.</div>}
      </div>

      <div className="export-main">
        <div className="export-view">
          <canvas ref={canvasRef} width="640" height="360" style={{ display: shown === 'canvas' ? 'block' : 'none' }} />
          {shown === 'image' && <img src={imgUrl} alt="" />}
          {!shown && (
            <div className="export-placeholder">
              {running ? 'Getting ready…' : phase === 'done' ? 'Done. Your video is saved.' : 'The video appears here while it is being made.'}
            </div>
          )}
        </div>
        {(running || phase === 'done') && (
          <div className="export-status">
            <div className="exp-label">{phase === 'done' ? 'Your video is ready.' : prog.label}</div>
            <div className="bar"><div className="bar-fill" style={{ width: `${phase === 'done' ? 100 : prog.pct}%` }} /></div>
            <div className="exp-pct">
              {phase === 'done' ? `Finished in ${fmtDur(elapsed)}` : `${prog.pct.toFixed(0)}% · ${fmtDur(elapsed)} so far${eta != null ? ` · about ${fmtDur(eta)} left` : ''}`}
            </div>
            {phase === 'done' && <div className="hint left" style={{ wordBreak: 'break-all' }}>{out}</div>}
            {phase === 'done' && check && (
              <div className={'exp-check' + (check.ok ? ' ok' : ' bad')}>
                {check.ok ? (
                  <div>Checked: the file is {check.duration.toFixed(1)} s long (expected {check.expected.toFixed(1)} s){check.hasVideo ? ', has its picture' : ''}{check.hasAudio ? ' and its sound' : ''}, and every frame decodes.</div>
                ) : (
                  <>
                    <div><b>The finished file did not pass the check, so it was saved under its own name and did not replace anything.</b></div>
                    {check.problems.map((p, i) => <div key={i}>• {p}</div>)}
                  </>
                )}
                {check.warnings.map((w, i) => <div key={i}>• {w}</div>)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
