import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import { createRenderer } from './glRenderer.js'
import { layout, overlayLayout, srcAt, toUrl, fmtTime, aspectRatio, previewSize, setVideoSrc } from './state.js'
import { CC_SLIDERS, CC_DEFAULTS, CC_PRESETS } from './effects.js'

// The Colour tab: colour correction for one clip. You see the picture change here as you move the sliders,
// but the clip in the editor (and the export) only changes when you press Apply.
export default function ColourTab({ active, getProject, clipId, dispatchProject, onClose }) {
  const [project, setProject] = useState(() => getProject())
  const clip = layout(project.state.clips).find((c) => c.id === clipId) || overlayLayout(project.state.overlayClips).find((c) => c.id === clipId)
  const media = clip && project.state.media.find((m) => m.id === clip.mediaId)
  const applied = { ...CC_DEFAULTS, ...((clip && clip.fx && clip.fx.cc) || {}) }
  const [draft, setDraft] = useState(applied)
  const [compare, setCompare] = useState(false)
  const [srcTime, setSrcTime] = useState(() => (clip ? srcAt(clip, project.state.playhead) : 0))
  const canvasRef = useRef(null)
  const rendererRef = useRef(null)
  const elRef = useRef(null)
  const drawRef = useRef(() => {})

  // when this tab is shown again, look at the project as it is now (the clip may have changed)
  useEffect(() => {
    if (active) setProject(getProject())
  }, [active])

  const dirty = CC_SLIDERS.some((s) => draft[s.id] !== applied[s.id])
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }))

  // the picture: a video / image element for the clip, drawn by the same renderer the preview and export use
  useEffect(() => {
    if (!media) return
    rendererRef.current = createRenderer(canvasRef.current)
    let el
    const draw = () => {
      const r = rendererRef.current
      if (!r || !el) return
      const w = el.videoWidth || el.naturalWidth
      const h = el.videoHeight || el.naturalHeight
      if (!w) return
      r.render({ el, w, h, tf: null, fx: { cc: compare ? undefined : draftRef.current } })
    }
    drawRef.current = draw
    if (media.type === 'video') {
      el = document.createElement('video')
      el.muted = true
      el.preload = 'auto'
      setVideoSrc(el, media.path)
      el.addEventListener('loadeddata', () => {
        el.currentTime = timeRef.current
      })
      el.addEventListener('seeked', draw)
    } else {
      el = new Image()
      el.src = toUrl(media.path)
      el.onload = draw
    }
    elRef.current = el
    return () => {
      if (media.type === 'video') {
        el.removeAttribute('src')
        el.load()
      }
      elRef.current = null
    }
  }, [media && media.path])

  // redraw whenever the sliders, the frame or "compare" change
  const draftRef = useRef(draft)
  draftRef.current = draft
  const timeRef = useRef(srcTime)
  timeRef.current = srcTime
  useEffect(() => {
    const el = elRef.current
    if (el && media && media.type === 'video' && Math.abs(el.currentTime - srcTime) > 0.01) el.currentTime = srcTime
    drawRef.current = drawRef.current
    // draw straight away for sliders (the frame is already loaded)
    const draw = drawRef.current
    draw()
  }, [draft, compare, srcTime])

  if (!clip || !media) {
    return (
      <div className="colour-page" style={{ display: active ? undefined : 'none' }}>
        <div className="hint">This clip is no longer in the project.</div>
        <button onClick={onClose}>Close</button>
      </div>
    )
  }

  const apply = () => {
    const same = CC_SLIDERS.every((s) => draft[s.id] === CC_DEFAULTS[s.id])
    if (same) dispatchProject({ type: 'resetFx', id: clipId, only: 'cc' })
    else dispatchProject({ type: 'setFx', id: clipId, patch: { cc: draft } })
    setProject(getProject())
  }
  const close = () => {
    if (dirty && !window.confirm('You changed the colours but did not apply them. Close without applying?')) return
    onClose()
  }

  return (
    <div className="colour-page" style={{ display: active ? undefined : 'none' }}>
      <div className="colour-side">
        <h2><Icon name="palette" size={18} /> Colour correction</h2>
        <div className="hint left">
          {media.name}. Changes show here first. The clip in the editor and the export only change when you press <b>Apply</b>.
        </div>
        <div className="colour-presets">
          {CC_PRESETS.map((p) => (
            <button key={p.name} className="mini wide" onClick={() => setDraft({ ...CC_DEFAULTS, ...p.cc })}>{p.name}</button>
          ))}
        </div>
        {CC_SLIDERS.map((s) => (
          <div className="mrow" key={s.id}>
            <div className="mtop">
              <span className="mlabel">{s.label}</span>
              {draft[s.id] !== s.def && <button className="mini" onClick={() => set({ [s.id]: s.def })} title="Back to normal">Reset</button>}
            </div>
            <div className="minput">
              <input type="range" min={s.min} max={s.max} step={s.step} value={draft[s.id]} onChange={(e) => set({ [s.id]: +e.target.value })} />
              <input type="number" min={s.min} max={s.max} value={draft[s.id]} onChange={(e) => e.target.value !== '' && set({ [s.id]: +e.target.value })} />
            </div>
          </div>
        ))}
        <div className="export-actions">
          <button className="primary big" disabled={!dirty} onClick={apply}>Apply to the clip</button>
          <button className="big" onClick={() => setDraft({ ...CC_DEFAULTS })}>Reset all</button>
        </div>
        <div className="export-actions">
          <button onClick={() => {
            apply()
            onClose()
          }} disabled={!dirty}>Apply and close</button>
          <button onClick={close}>Close</button>
        </div>
        {dirty && <div className="hint warn">Not applied yet.</div>}
      </div>
      <div className="export-main">
        <div className="export-view colour-view">
          <canvas ref={canvasRef} width={previewSize(aspectRatio(project.state))[0]} height={previewSize(aspectRatio(project.state))[1]} />
        </div>
        <div className="colour-controls">
          <button
            className="big"
            onPointerDown={() => setCompare(true)}
            onPointerUp={() => setCompare(false)}
            onPointerLeave={() => setCompare(false)}
            title="Hold to see the picture without your colour changes"
          >
            Hold to compare with the original
          </button>
          {media.type === 'video' && (
            <label className="colour-scrub">
              Frame {fmtTime(srcTime).slice(0, 8)}
              <input type="range" min={clip.in} max={Math.max(clip.in + 0.05, clip.out - 0.05)} step="0.04" value={Math.min(Math.max(srcTime, clip.in), clip.out)} onChange={(e) => setSrcTime(+e.target.value)} />
            </label>
          )}
        </div>
      </div>
    </div>
  )
}