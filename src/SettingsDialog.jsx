import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import ThemeEditor from './ThemeEditor.jsx'
import { listDevices } from './audioDevices.js'

const MB = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.max(0, Math.round(n / 1048576)) + ' MB')

// ---- Settings > Sound: microphone and speakers
function SoundPage({ settings, setSettings }) {
  const [dev, setDev] = useState(null) // {inputs, outputs}
  const [level, setLevel] = useState(null) // microphone level 0..1 while the test runs
  const stop = useRef(null)
  const load = () => listDevices().then(setDev).catch(() => setDev({ inputs: [], outputs: [] }))
  useEffect(() => {
    load()
    const h = () => load()
    navigator.mediaDevices.addEventListener('devicechange', h)
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', h)
      if (stop.current) stop.current()
    }
  }, [])
  const missing = (id, list) => id && list && !list.some((d) => d.id === id)

  // play a short tone on the chosen speakers
  const testSpeakers = async () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      if (ctx.setSinkId) await ctx.setSinkId(settings.audioOutputId || '').catch(() => {})
      const osc = ctx.createOscillator()
      const g = ctx.createGain()
      osc.frequency.value = 523
      g.gain.setValueAtTime(0.0001, ctx.currentTime)
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.05)
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.9)
      osc.connect(g).connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 1)
      setTimeout(() => ctx.close().catch(() => {}), 1300)
    } catch {}
  }
  // show the microphone's level for a few seconds
  const testMic = async () => {
    if (stop.current) return stop.current()
    try {
      const constraints = { audio: settings.audioInputId ? { deviceId: { exact: settings.audioInputId } } : true }
      const stream = await navigator.mediaDevices.getUserMedia(constraints).catch(() => navigator.mediaDevices.getUserMedia({ audio: true }))
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const an = ctx.createAnalyser()
      an.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(an)
      const buf = new Uint8Array(an.fftSize)
      let raf = 0
      const tick = () => {
        an.getByteTimeDomainData(buf)
        let peak = 0
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128))
        setLevel(Math.min(1, peak / 80))
        raf = requestAnimationFrame(tick)
      }
      tick()
      const end = () => {
        cancelAnimationFrame(raf)
        stream.getTracks().forEach((t) => t.stop())
        ctx.close().catch(() => {})
        stop.current = null
        setLevel(null)
      }
      stop.current = end
      setTimeout(() => stop.current === end && end(), 12000)
    } catch {
      setLevel(null)
    }
  }

  return (
    <div className="set-page">
      <h4>Sound</h4>
      <div className="set-row">
        <div>
          <div className="set-title">Microphone</div>
          <div className="hint left">Used for voice-overs. Pick the one you really record with (a headset, a USB microphone).</div>
        </div>
        <span className="set-col">
          <select value={settings.audioInputId || ''} onChange={(e) => setSettings({ audioInputId: e.target.value })}>
            <option value="">System default</option>
            {dev && missing(settings.audioInputId, dev.inputs) && <option value={settings.audioInputId}>(not plugged in)</option>}
            {dev && dev.inputs.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
          <span className="set-test">
            <button className="mini" onClick={testMic}>{level == null ? 'Test the microphone' : 'Stop the test'}</button>
            {level != null && <span className="meter"><span style={{ width: Math.round(level * 100) + '%' }} /></span>}
          </span>
        </span>
      </div>
      <div className="set-row">
        <div>
          <div className="set-title">Speakers or headphones</div>
          <div className="hint left">Where the preview plays. Handy with two speaker setups or when headphones are plugged in as well. (The exported file is not affected.)</div>
        </div>
        <span className="set-col">
          <select value={settings.audioOutputId || ''} onChange={(e) => setSettings({ audioOutputId: e.target.value })}>
            <option value="">System default</option>
            {dev && missing(settings.audioOutputId, dev.outputs) && <option value={settings.audioOutputId}>(not plugged in)</option>}
            {dev && dev.outputs.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
          <button className="mini" onClick={testSpeakers}>Play a test sound</button>
        </span>
      </div>
      <div className="hint left">
        {dev ? `${dev.inputs.length} microphone${dev.inputs.length === 1 ? '' : 's'} and ${dev.outputs.length} output${dev.outputs.length === 1 ? '' : 's'} found.` : 'Looking for devices…'} The list updates by itself when something is plugged in.
      </div>
    </div>
  )
}

// ---- Settings > Storage: what the app keeps besides your projects
function StoragePage() {
  const [info, setInfo] = useState(null)
  const [px, setPx] = useState(null)
  const load = () => {
    window.api.storageInfo().then(setInfo)
    window.api.proxyInfo().then(setPx).catch(() => {})
  }
  useEffect(load, [])
  const clear = async (what, label) => {
    if (!window.confirm(`Delete ${label}?`)) return
    await window.api.storageClear(what)
    load()
  }
  const rows = info
    ? [
        { id: 'proxies', title: 'Smooth preview copies', note: 'Small copies of big videos, made in the background. Made again when needed.', ...info.proxies },
        { id: 'cleaned', title: 'Cleaned sound', note: 'The sound with noise reduction or a voice preset, for the preview. Made again when needed.', ...info.cleaned },
        { id: 'reverse', title: 'Reversed clips', note: 'Backwards copies for the preview and the export. Made again when needed.', ...info.reverse },
        { id: 'sam2', title: 'AI selection model', note: 'Smart select and mask tracking. Download it again from the Mask section when you want it.', ...info.sam2 },
        { id: 'whisper', title: 'Speech model', note: 'Captions from speech. Download it again from the Captions button when you want it.', ...info.whisper },
      ]
    : []
  return (
    <div className="set-page">
      <h4>Storage</h4>
      <div className="hint left">Things the editor keeps on this PC so it can be quick. Your projects and the files you imported are never in here.</div>
      {!info && <div className="hint">Counting…</div>}
      {rows.map((r) => (
        <div className="set-row" key={r.id}>
          <div>
            <div className="set-title">{r.title}</div>
            <div className="hint left">{r.note}</div>
          </div>
          <span className="set-col">
            <span className="set-size">{r.count ? `${MB(r.bytes)} · ${r.count} file${r.count === 1 ? '' : 's'}` : 'Nothing stored'}</span>
            {r.count > 0 && <button className="mini" onClick={() => clear(r.id, r.title.toLowerCase())} disabled={r.id === 'proxies' && px && px.making > 0}>Delete</button>}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function SettingsDialog({ settings, setSettings, theme, setTheme, themes, saveThemes, onPreviewTheme, version, onCheck, update, onClose }) {
  const [page, setPage] = useState('general')
  const checking = update.state === 'checking'
  let result = ''
  if (update.state === 'uptodate') result = "You're up to date."
  else if (update.state === 'error') result = 'Could not check (are you online?).'
  else if (update.state === 'dev') result = 'Updates only work in the installed app.'
  else if (update.state === 'available' || update.state === 'snoozed') result = `Version ${update.version} is available.`
  const [px, setPx] = useState(null)
  useEffect(() => {
    window.api.proxyInfo().then(setPx).catch(() => {})
  }, [])
  const tourAgain = () => {
    try {
      localStorage.removeItem('vibe.tour.video')
      localStorage.removeItem('vibe.tour.image')
    } catch {}
  }

  const NAV = [
    { id: 'general', label: 'General', icon: 'sliders' },
    { id: 'appearance', label: 'Appearance', icon: 'palette' },
    { id: 'sound', label: 'Sound', icon: 'volume' },
    { id: 'storage', label: 'Storage', icon: 'folder' },
  ]

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="set-head">
          <h3>Settings</h3>
          <button className="mini" onClick={onClose} title="Close"><Icon name="x" size={14} /></button>
        </div>
        <div className="set-layout">
          <nav className="set-nav">
            {NAV.map((n) => (
              <button key={n.id} className={page === n.id ? 'on' : ''} onClick={() => setPage(n.id)}>
                <Icon name={n.icon} size={15} /> {n.label}
              </button>
            ))}
            <span className="set-ver">Version {version}</span>
          </nav>
          <div className="set-body">
            {page === 'general' && (
              <div className="set-page">
                <h4>General</h4>
                <div className="set-row">
                  <div>
                    <div className="set-title">Automatic updates</div>
                    <div className="hint left">Check for a new version when the editor opens, and ask before downloading anything.</div>
                  </div>
                  <label className="switch">
                    <input type="checkbox" checked={settings.autoUpdate} onChange={(e) => setSettings({ autoUpdate: e.target.checked })} />
                    <span className="slider" />
                  </label>
                </div>
                <div className="set-row">
                  <div>
                    <div className="set-title">Show on Discord</div>
                    <div className="hint left">Shows “Playing Vibe Editing Suite” and what you are doing (editing a video, drawing…) on your Discord profile while the Discord app is open.</div>
                  </div>
                  <label className="switch">
                    <input type="checkbox" checked={settings.discordPresence !== false} onChange={(e) => setSettings({ discordPresence: e.target.checked })} />
                    <span className="slider" />
                  </label>
                </div>
                {settings.discordPresence !== false && (
                  <div className="set-row">
                    <div>
                      <div className="set-title">Show the project name on Discord</div>
                      <div className="hint left">Off by default, so people only see the kind of work, not the name of your project.</div>
                    </div>
                    <label className="switch">
                      <input type="checkbox" checked={!!settings.discordShowName} onChange={(e) => setSettings({ discordShowName: e.target.checked })} />
                      <span className="slider" />
                    </label>
                  </div>
                )}
                <div className="set-row">
                  <div>
                    <div className="set-title">Version {version}</div>
                    <div className="hint left">{result || 'You can always check by hand.'}</div>
                  </div>
                  <button onClick={onCheck} disabled={checking}>
                    <Icon name="refresh" /> {checking ? 'Checking…' : 'Check now'}
                  </button>
                </div>
                <div className="set-row">
                  <div>
                    <div className="set-title">Smooth preview for big videos</div>
                    <div className="hint left">
                      4K, very heavy videos and videos with few keyframes (common for screen recordings) get a small copy in the background, so the preview plays and jumps around smoothly. The export always uses your original file.
                      {px && px.count > 0 ? ` Copies on this PC: ${px.count} (${MB(px.bytes)}).` : ''}
                    </div>
                  </div>
                  <select value={settings.proxyMode || 'auto'} onChange={(e) => setSettings({ proxyMode: e.target.value })}>
                    <option value="auto">Auto (big or hard-to-scrub videos)</option>
                    <option value="always">Every video</option>
                    <option value="off">Off</option>
                  </select>
                </div>
                <div className="set-row">
                  <div>
                    <div className="set-title">Quick tour</div>
                    <div className="hint left">Shows the short tutorial again the next time you open the video editor or the image editor. (The Tutorial button at the top does it right away.)</div>
                  </div>
                  <button onClick={tourAgain}>Show it again</button>
                </div>
              </div>
            )}
            {page === 'appearance' && (
              <div className="set-page wide">
                <h4>Appearance</h4>
                <ThemeEditor themes={themes} onSave={saveThemes} theme={theme} setTheme={setTheme} onPreview={onPreviewTheme} />
              </div>
            )}
            {page === 'sound' && <SoundPage settings={settings} setSettings={setSettings} />}
            {page === 'storage' && <StoragePage />}
          </div>
        </div>
        <div className="modal-foot">
          <span />
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
