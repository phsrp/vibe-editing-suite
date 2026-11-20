import { useEffect, useRef, useState } from 'react'

// Waveforms: a picture of the loudness of an audio file inside its clip on the timeline.
// Only the part of the clip that is on screen is drawn, one bar per screen pixel, so it stays sharp at any zoom.
const cache = new Map() // file -> {data, promise}

export function usePeaks(file) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!file) return
    let live = true
    let e = cache.get(file)
    if (!e) {
      e = { data: null, promise: null }
      e.promise = window.api.audioPeaks(file).then((d) => {
        e.data = d
        return d
      })
      cache.set(file, e)
    }
    if (!e.data) e.promise.then(() => live && tick((n) => n + 1))
    return () => {
      live = false
    }
  }, [file])
  const e = file && cache.get(file)
  return e && e.data
}

const RATE = 200 // values per second, see electron/main.js

// Draws the part [from, to] (seconds of the file) of the file's waveform over a clip that is `width` px wide
// and starts `left` px into the lane; `view` = {l, r}: the lane pixels that are on screen.
// gain = the clip's volume (1 = 100%): the waveform grows and shrinks with it; bars that would be taller than the
// clip (above about 100% loudness) are cut off and drawn in a warm colour.
// gainFn(secondOfTheFile) = the volume curve and fades of the clip, so the picture follows them (shapeKey changes with it)
export default function Wave({ file, from, to, width, left, view, height, gain = 1, gainFn, shapeKey }) {
  const ref = useRef(null)
  const peaks = usePeaks(file)
  const x0 = Math.max(0, Math.floor(view.l - left))
  const x1 = Math.min(Math.ceil(width), Math.ceil(view.r - left))
  const w = x1 - x0
  useEffect(() => {
    const cv = ref.current
    if (!cv || !peaks || !peaks.length || w <= 0) return
    const dpr = window.devicePixelRatio || 1
    const cw = Math.max(1, Math.round(w * dpr))
    cv.width = cw
    cv.height = Math.round(height * dpr)
    const g = cv.getContext('2d')
    const color = getComputedStyle(cv).color
    const mid = cv.height / 2
    const full = cv.height - 2
    const span = Math.max(0.001, to - from)
    const secPerPx = span / width
    // two values per screen column: the loudest moment (the outline) and the average loudness (the solid body).
    // Zoomed in further than the data goes, the values are blended between neighbours so the shape stays smooth.
    const at = (t) => {
      const p = t * RATE - 0.5
      const i = Math.floor(p)
      const f = p - i
      const v0 = peaks[Math.max(0, Math.min(peaks.length - 1, i))]
      const v1 = peaks[Math.max(0, Math.min(peaks.length - 1, i + 1))]
      return v0 + (v1 - v0) * f
    }
    const top = new Float32Array(cw) // half heights in canvas px
    const body = new Float32Array(cw)
    const over = new Uint8Array(cw) // louder than the clip can show: it would be clipped
    for (let x = 0; x < cw; x++) {
      const t0 = from + (x0 + x / dpr) * secPerPx
      const t1 = from + (x0 + (x + 1) / dpr) * secPerPx
      if (t0 * RATE >= peaks.length) break
      const a = Math.floor(t0 * RATE)
      const b = Math.ceil(t1 * RATE)
      let m = 0
      let sum = 0
      let n = 0
      if (b - a <= 2) {
        m = at((t0 + t1) / 2)
        sum = m
        n = 1
      } else {
        for (let i = a; i < b && i < peaks.length; i++) {
          if (peaks[i] > m) m = peaks[i]
          sum += peaks[i]
          n++
        }
      }
      if (!n) continue
      const gx = gainFn ? gain * gainFn((t0 + t1) / 2) : gain
      const want = (m / 255) * full * gx
      over[x] = want > full + 0.5 ? 1 : 0
      top[x] = Math.min(full, want) / 2
      body[x] = Math.min(full, ((sum / n / 255) * full * gx) * 0.85) / 2
    }
    // soften the body a little so it reads as one shape, not a comb of single-pixel bars
    const soft = new Float32Array(cw)
    for (let x = 0; x < cw; x++) soft[x] = (body[Math.max(0, x - 1)] + 2 * body[x] + body[Math.min(cw - 1, x + 1)]) / 4
    // a mirrored filled shape: along the top edge, then back along the bottom edge
    const shape = (hh, minH) => {
      g.beginPath()
      g.moveTo(0, mid)
      for (let x = 0; x < cw; x++) g.lineTo(x + 0.5, mid - Math.max(minH, hh[x]))
      g.lineTo(cw, mid)
      for (let x = cw - 1; x >= 0; x--) g.lineTo(x + 0.5, mid + Math.max(minH, hh[x]))
      g.closePath()
      g.fill()
    }
    g.fillStyle = color
    // the centre line, like other editors
    g.globalAlpha = 0.35
    g.fillRect(0, Math.floor(mid - dpr * 0.5), cw, Math.max(1, Math.round(dpr)))
    g.globalAlpha = 0.42
    shape(top, 0)
    g.globalAlpha = 0.95
    shape(soft, 0)
    g.globalAlpha = 1
    // the clipped places: a warm cap on the top and bottom edges
    g.fillStyle = '#f6c177'
    const cap = Math.max(2, Math.round(2 * dpr))
    for (let x = 0; x < cw; x++) {
      if (!over[x]) continue
      let e = x
      while (e + 1 < cw && over[e + 1]) e++
      g.fillRect(x, 1, e - x + 1, cap)
      g.fillRect(x, cv.height - 1 - cap, e - x + 1, cap)
      x = e
    }
  }, [peaks, from, to, width, x0, w, height, gain, shapeKey])
  if (!file || w <= 0) return null
  return <canvas ref={ref} className="wave" style={{ left: x0, width: w, height }} />
}
