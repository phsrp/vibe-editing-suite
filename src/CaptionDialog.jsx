import { useEffect, useState } from 'react'
import Icon from './Icon.jsx'
import { TEXT_PRESETS } from './textRender.js'
import { makeCaptions, speechSources, toSrt, LANGUAGES } from './whisper.js'

const MB = (n) => Math.round(n / 1048576)

// Captions from speech: the speech model listens to the video's sound and the words become text clips on a "Captions" track.
export default function CaptionDialog({ state, dispatch, onClose, onEditByText }) {
  const [status, setStatus] = useState(null) // the model: {ready, totalBytes, folder}
  const [dl, setDl] = useState(null) // download progress {received, total}
  const [dlErr, setDlErr] = useState('')
  const hasSel = speechSources(state, true).length > 0 // something with sound is selected
  const [only, setOnly] = useState(hasSel)
  const [lang, setLang] = useState(() => {
    try {
      return localStorage.getItem('vibe.captionLang') || ''
    } catch {
      return ''
    }
  })
  const [styleName, setStyleName] = useState('Subtitle')
  const [maxChars, setMaxChars] = useState(36)
  const [replace, setReplace] = useState(true)
  const [busy, setBusy] = useState(false)
  const [pct, setPct] = useState(0)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    window.api.whisperStatus().then(setStatus)
    return window.api.onWhisperProgress(setDl)
  }, [])

  const download = async () => {
    setDlErr('')
    setDl({ received: 0, total: status.totalBytes })
    const r = await window.api.whisperDownload()
    setStatus(r)
    if (r.error) setDlErr(r.error)
    setDl(null)
  }

  const captionClips = state.overlayClips.filter((c) => c.caption && c.text)

  const generate = async () => {
    setBusy(true)
    setPct(0)
    setMsg('Loading the speech model…')
    try {
      const r = await makeCaptions({ state, dispatch, folder: status.folder, only, language: lang, maxChars, style: TEXT_PRESETS.find((p) => p.name === styleName), replace, onMessage: setMsg, onProgress: setPct })
      if (r.count) setPct(1)
      setMsg(r.message)
    } catch (e) {
      setMsg('Something went wrong: ' + String((e && e.message) || e))
    } finally {
      setBusy(false)
    }
  }

  const saveSrt = async () => {
    const items = captionClips.map((c) => ({ start: c.start, dur: c.out - c.in, text: c.text.content }))
    const file = await window.api.saveSubtitles({ name: 'Subtitles', text: toSrt(items) })
    if (file) setMsg('Subtitles saved: ' + file)
  }

  const downloading = !!dl
  return (
    <div className="modal-bg" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Captions from speech</h3>
        <div className="hint left">The speech model listens to the sound of your video and turns the words into text clips, timed to the speech. Everything stays on your PC.</div>

        {status && !status.ready && (
          <div className="mtop">
            <div className="hint left">
              The speech model (about {MB(status.totalBytes)} MB) is downloaded once, from the internet. After that it works offline.
            </div>
            <button className="primary wide" onClick={download} disabled={downloading}>
              <Icon name="download" size={14} /> {downloading ? `Downloading… ${MB(dl.received)} of ${MB(dl.total)} MB` : 'Download the speech model'}
            </button>
            {dlErr && <div className="hint left warn">{dlErr}</div>}
          </div>
        )}

        <fieldset disabled={!status || !status.ready || busy} className="lock-fs">
          <div className="mtop">
            <span className="mlabel">Listen to</span>
            <select value={only ? 'sel' : 'all'} onChange={(e) => setOnly(e.target.value === 'sel')}>
              <option value="all">All the speech in the video</option>
              <option value="sel" disabled={!hasSel}>Only what is selected{hasSel ? '' : ' (nothing is)'}</option>
            </select>
          </div>
          <div className="mtop">
            <span className="mlabel">Language</span>
            <select
              value={lang}
              onChange={(e) => {
                setLang(e.target.value)
                try {
                  localStorage.setItem('vibe.captionLang', e.target.value)
                } catch {}
              }}
            >
              {LANGUAGES.map(([v, label]) => (
                <option key={v} value={v}>{label}</option>
              ))}
            </select>
          </div>
          <div className="mtop">
            <span className="mlabel">Look</span>
            <select value={styleName} onChange={(e) => setStyleName(e.target.value)}>
              {TEXT_PRESETS.map((p) => (
                <option key={p.name} value={p.name}>{p.name}{p.name === 'Subtitle' ? ' (recommended)' : ''}</option>
              ))}
            </select>
          </div>
          <div className="mrow">
            <div className="mtop"><span className="mlabel">Longest caption (letters)</span></div>
            <div className="minput">
              <input type="range" min="16" max="70" value={maxChars} onChange={(e) => setMaxChars(+e.target.value)} />
              <input type="number" min="16" max="70" value={maxChars} onChange={(e) => e.target.value !== '' && setMaxChars(+e.target.value)} />
            </div>
          </div>
          <label className="chk">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            Replace the captions that are already there
          </label>
        </fieldset>

        {busy && (
          <div className="cap-bar"><span style={{ width: Math.round(pct * 100) + '%' }} /></div>
        )}
        {msg && <div className="hint left">{msg}</div>}

        <div className="modal-foot">
          <span className="btn-row">
            <button onClick={saveSrt} disabled={!captionClips.length || busy} title={captionClips.length ? 'Save the captions as a subtitles file (.srt) for YouTube and others' : 'Make captions first'}>
              Save subtitles (.srt)
            </button>
            <button onClick={onEditByText} disabled={busy || !Object.keys(state.transcripts || {}).length} title={Object.keys(state.transcripts || {}).length ? 'See the words and cut your video by deleting words, filler words or pauses' : 'Make captions first: that listens to your video'}>
              Edit by text…
            </button>
          </span>
          <span className="btn-row">
            <button onClick={onClose} disabled={busy}>Close</button>
            <button className="primary" onClick={generate} disabled={!status || !status.ready || busy}>
              {busy ? 'Working…' : 'Make captions'}
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}
