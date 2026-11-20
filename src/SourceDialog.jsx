import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import { setVideoSrc, toUrl, fmtTime } from './state.js'

// The source viewer: watch a file and mark the part of it to use (In and Out) before it goes on the timeline,
// like Premiere's Source Monitor. The marks stay with the file: double-click or drag it later and only that part is added.
// Keys: Space play / pause, I and O mark, J K L, arrows one frame.
export default function SourceDialog({ media, onClose, onSave, onAdd }) {
  const vref = useRef(null)
  const barRef = useRef(null)
  const dur = (media && media.duration) || 0
  const [t, setT] = useState(media && media.mark ? media.mark.in || 0 : 0)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(1)
  const [mk, setMk] = useState(() => ({ in: media && media.mark ? media.mark.in ?? null : null, out: media && media.mark ? media.mark.out ?? null : null }))
  const isVideo = media && media.type === 'video'

  useEffect(() => {
    const v = vref.current
    if (!v || !media) return
    if (isVideo) setVideoSrc(v, media.proxy || media.path)
    else v.src = toUrl(media.path)
    const go = () => {
      v.currentTime = t
    }
    v.addEventListener('loadedmetadata', go, { once: true })
    return () => {
      v.pause()
      v.removeAttribute('src')
      v.load()
    }
  }, [media && media.path])

  // follow the video while it plays; backwards (J) jumps frame by frame; stop at the Out mark when playing from In
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const tick = (now) => {
      raf = requestAnimationFrame(tick)
      const v = vref.current
      if (!v) return
      const dt = (now - last) / 1000
      last = now
      if (playing && rate < 0) {
        const nt = Math.max(0, v.currentTime + dt * rate)
        if (!v.seeking) v.currentTime = nt
        setT(nt)
        if (nt <= 0) setPlaying(false)
      } else setT(v.currentTime)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, rate])

  useEffect(() => {
    const v = vref.current
    if (!v) return
    if (playing && rate > 0) {
      v.playbackRate = Math.min(16, rate)
      v.muted = rate > 2
      v.play().catch(() => {})
    } else v.pause()
  }, [playing, rate])

  const seek = (s) => {
    const v = vref.current
    const c = Math.max(0, Math.min(dur, s))
    if (v) v.currentTime = c
    setT(c)
  }
  const mark = (which, at) => {
    setMk((m) => {
      const n = { ...m, [which]: at }
      if (at != null && n.in != null && n.out != null && n.out - n.in < 0.04) n[which === 'in' ? 'out' : 'in'] = null
      return n
    })
  }
  const shuttle = (dir) => {
    if (!dir) {
      setPlaying(false)
      setRate(1)
      return
    }
    const r = playing ? rate : 0
    setRate(r * dir > 0 ? Math.max(-8, Math.min(8, r * 2)) : dir)
    setPlaying(true)
  }
  const result = () => ({ in: mk.in ?? 0, out: mk.out ?? dur })

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return
      const k = e.key.toLowerCase()
      const hit = {
        ' ': () => (playing ? shuttle(0) : (setRate(1), setPlaying(true))),
        i: () => mark('in', vref.current ? vref.current.currentTime : t),
        o: () => mark('out', vref.current ? vref.current.currentTime : t),
        j: () => shuttle(-1),
        k: () => shuttle(0),
        l: () => shuttle(1),
        arrowleft: () => (shuttle(0), seek(t - 1 / 30)),
        arrowright: () => (shuttle(0), seek(t + 1 / 30)),
        escape: onClose,
        enter: () => onAdd(result()),
      }[k]
      if (!hit || e.ctrlKey || e.altKey) return
      e.preventDefault()
      e.stopPropagation()
      hit()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // the bar: click or drag to move; the marked part is shaded and its ends can be dragged
  const barDrag = (e, what) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const r = barRef.current.getBoundingClientRect()
    const at = (x) => Math.max(0, Math.min(dur, ((x - r.left) / r.width) * dur))
    const move = (ev) => (what === 'play' ? seek(at(ev.clientX)) : mark(what, at(ev.clientX)))
    move(e)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  if (!media) return null
  const a = mk.in ?? 0
  const b = mk.out ?? dur
  const pct = (s) => (dur ? (s / dur) * 100 : 0) + '%'
  const marked = mk.in != null || mk.out != null
  return (
    <div className="modal-bg" onPointerDown={onClose}>
      <div className="modal source-dlg" onPointerDown={(e) => e.stopPropagation()}>
        <h3>Mark the part to use: {media.name}</h3>
        <div className="src-view">
          {isVideo ? <video ref={vref} className="src-video" playsInline preload="auto" /> : <audio ref={vref} preload="auto" />}
          {!isVideo && <div className="src-audio"><Icon name="music" size={40} /></div>}
          {playing && rate !== 1 && <div className="pv-rate">{rate < 0 ? 'Backwards ' : ''}{Math.abs(rate)}×</div>}
        </div>
        <div className="src-bar" ref={barRef} onPointerDown={(e) => barDrag(e, 'play')}>
          {marked && <div className="src-range" style={{ left: pct(a), width: `calc(${pct(b)} - ${pct(a)})` }} />}
          {mk.in != null && <div className="src-mark in" style={{ left: pct(mk.in) }} onPointerDown={(e) => barDrag(e, 'in')} title="In: drag to move it" />}
          {mk.out != null && <div className="src-mark out" style={{ left: pct(mk.out) }} onPointerDown={(e) => barDrag(e, 'out')} title="Out: drag to move it" />}
          <div className="src-head" style={{ left: pct(t) }} />
        </div>
        <div className="src-controls">
          <button onClick={() => mark('in', t)} title="Mark In here (I)"><Icon name="markIn" /> In</button>
          <button onClick={() => shuttle(-1)} title="Play backwards; press again to go faster (J)"><Icon name="skipBack" /></button>
          <button className="primary" onClick={() => (playing ? shuttle(0) : (setRate(1), setPlaying(true)))} title="Play / pause (Space; J K L also work)">
            {playing ? <><Icon name="pause" fill /> Pause</> : <><Icon name="play" fill /> Play</>}
          </button>
          <button onClick={() => mark('out', t)} title="Mark Out here (O)">Out <Icon name="markOut" /></button>
          <span className="timecode">{fmtTime(t)} / {fmtTime(dur)}</span>
        </div>
        <div className="src-info">
          {marked ? <>Using {fmtTime(a).slice(0, 8)} to {fmtTime(b).slice(0, 8)}, {(b - a).toFixed(1)} s of {dur.toFixed(1)} s. <button className="mini wide" onClick={() => setMk({ in: null, out: null })}>Use all of it</button></> : 'All of it is used. Mark In (I) and Out (O) to use only a part.'}
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>Cancel</button>
          <button onClick={() => { onSave(result()); onClose() }} title="Keep these marks: double-clicking or dragging the file adds only this part">Save marks</button>
          <button className="primary" onClick={() => onAdd(result())} title="Keep the marks and add this part to the timeline (Enter)">Add to the timeline</button>
        </div>
      </div>
    </div>
  )
}
