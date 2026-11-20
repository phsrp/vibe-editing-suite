import { useEffect, useRef, useState } from 'react'
import { meterLevels } from './Preview.jsx'

// Sound level meters (left and right), like the ones next to Premiere's timeline: how loud the sound you hear is,
// after every volume, fade and mute. The scale is dB below the loudest a file can hold (0 dB): keep the loud parts
// around -6 to -3; the red light at the top means it reached 0 dB and would be clipped (click it to switch it off).
const FLOOR = -60
const TICKS = [0, -6, -12, -18, -24, -36, -48]
const toDb = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity)
const pos = (db) => Math.max(0, Math.min(1, (db - FLOOR) / -FLOOR)) // 0 at the bottom, 1 at 0 dB

export default function Meter({ playing }) {
  const ref = useRef(null)
  const [clip, setClip] = useState([false, false])
  const clipRef = useRef(clip)
  clipRef.current = clip
  const [readout, setReadout] = useState(null) // the highest peak since playing started, in dB
  const readRef = useRef(null)
  useEffect(() => {
    if (playing) {
      readRef.current = null
      setReadout(null)
    }
  }, [playing])
  useEffect(() => {
    let raf = 0
    const shown = [0, 0] // the bar (0..1), falls back slowly
    const hold = [{ v: 0, at: 0 }, { v: 0, at: 0 }] // peak hold lines
    let lastRead = 0
    const draw = (now) => {
      raf = requestAnimationFrame(draw)
      const cv = ref.current
      if (!cv) return
      const lv = meterLevels()
      const dpr = window.devicePixelRatio || 1
      const W = Math.round(cv.clientWidth * dpr)
      const H = Math.round(cv.clientHeight * dpr)
      if (!W || !H) return
      if (cv.width !== W || cv.height !== H) {
        cv.width = W
        cv.height = H
      }
      const g = cv.getContext('2d')
      g.clearRect(0, 0, W, H)
      const css = getComputedStyle(cv)
      const col = (name, fb) => css.getPropertyValue(name).trim() || fb
      const green = col('--foam', '#9ccfd8')
      const gold = col('--gold', '#f6c177')
      const red = col('--love', '#eb6f92')
      const track = col('--line', '#26233a')
      const bw = Math.floor((W - 3 * dpr) / 2)
      let top = -Infinity
      for (let i = 0; i < 2; i++) {
        const peak = lv ? lv[i].peak : 0
        const db = toDb(peak)
        top = Math.max(top, db)
        const p = pos(db)
        shown[i] = p > shown[i] ? p : Math.max(p, shown[i] - 0.012) // rises at once, falls gently
        if (p >= hold[i].v) hold[i] = { v: p, at: now }
        else if (now - hold[i].at > 1500) hold[i].v = Math.max(shown[i], hold[i].v - 0.008) // held for 1.5 s, then it falls
        if (peak >= 0.999 && !clipRef.current[i]) setClip((c) => c.map((x, j) => (j === i ? true : x)))
        const x = i * (bw + 3 * dpr)
        g.fillStyle = track
        g.fillRect(x, 0, bw, H)
        // the bar in three colours: up to -12 dB, -12 to -3, above -3
        const y = H * (1 - shown[i])
        const band = (from, to, c) => {
          const y0 = H * (1 - pos(to))
          const y1 = H * (1 - pos(from))
          const a = Math.max(y, y0)
          if (a < y1) {
            g.fillStyle = c
            g.fillRect(x, a, bw, y1 - a)
          }
        }
        band(FLOOR, -12, green)
        band(-12, -3, gold)
        band(-3, 0, red)
        if (hold[i].v > 0.01) {
          g.fillStyle = hold[i].v >= pos(-3) ? red : '#e0def4'
          g.fillRect(x, Math.round(H * (1 - hold[i].v)), bw, Math.max(1, Math.round(dpr)))
        }
      }
      if (lv && now - lastRead > 250) {
        lastRead = now
        if (top > (readRef.current ?? -Infinity)) {
          readRef.current = top
          setReadout(top)
        }
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div className="meter-col" title="Sound level of what you hear (left and right). Loud parts are best around -6 to -3 dB; red at the top means it reached 0 dB and is too loud.">
      <div className="meter-head">
        {[0, 1].map((i) => (
          <button key={i} className={'meter-clip' + (clip[i] ? ' on' : '')} onClick={() => setClip([false, false])} title={clip[i] ? 'It reached 0 dB (too loud). Click to reset.' : 'Lights up red when the sound reaches 0 dB'} />
        ))}
      </div>
      <div className="meter-body">
        <canvas ref={ref} className="meter-cv" />
        <div className="meter-scale">
          {TICKS.map((d) => (
            <span key={d} style={{ top: (1 - pos(d)) * 100 + '%' }}>{d}</span>
          ))}
        </div>
      </div>
      <div className="meter-read" title="The loudest moment since you pressed play (dB)">{readout == null || readout === -Infinity ? '–' : readout.toFixed(1)}</div>
    </div>
  )
}
