import { useEffect, useRef, useState } from 'react'
import { createRenderer } from './glRenderer.js'
import { evalTransform, evalWarp } from './motion.js'
import { maskAt } from './masks.js'
import { routeOutput, onDevices } from './audioDevices.js'
import { layout, overlayLayout, audioLayout, audioSource, totalDuration, projectDuration, videoRowsBottomUp, toUrl, srcAt, speedOf, aspectRatio, previewSize, streamAudioOf, cleanActive, envAt, fadeAt } from './state.js'
import WarpOverlay from './WarpOverlay.jsx'
import { drawText, loadFont } from './textRender.js'
import TransformOverlay from './TransformOverlay.jsx'
import MaskOverlay from './MaskOverlay.jsx'

// One shared Web Audio context: every audio element goes through a gain node, which lets the volume go
// above 100% (up to 200%). A plain <audio> element can only be turned down.
let audioCtx = null
const getCtx = () => {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    routeOutput(audioCtx) // the speakers chosen in Settings
    onDevices(() => routeOutput(audioCtx))
  }
  return audioCtx
}

// Owns the canvas, the playback clock and the <video>/<img> elements.
export default function Preview({ state, dispatch, transitions, onCompiled, active = true, mode = 'none', setMode = () => {}, freeMode = false }) {
  const activeRef = useRef(active)
  activeRef.current = active
  const canvasRef = useRef(null)
  const rendererRef = useRef(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const qualityRef = useRef('full')
  const autoLevelRef = useRef(1)
  const setAutoLevelRef = useRef(null)
  const els = useRef(new Map()) // clipId -> {el, kind, media}
  const aels = useRef(new Map()) // audio key -> {el}

  useEffect(() => {
    const renderer = createRenderer(canvasRef.current)
    rendererRef.current = renderer
    window.__renderer = renderer
    window.__aels = aels.current // for the developer self-test
    window.__els = els.current // for the developer self-test
    import('./smartMask.js').then((m) => (window.__smartMask = m)) // developer self-test
    import('./sam2.js').then((m) => (window.__sam2 = m))
    import('./planarTrack.js').then((m) => (window.__planar = m))
    let raf
    let clock = { ms: 0, t0: 0, seek: -1, playing: false }
    let haveFrame = false
    let lastFrameAt = 0 // for the Auto preview quality
    let slowAvg = 16
    let lastStep = 0
    let missingSince = 0 // since when a needed picture has not been ready (ms clock of requestAnimationFrame)

    // which file the preview plays: the smooth copy of a big video when there is one (the export always uses the original),
    // but the original while the preview is zoomed in, where the sharper picture matters (masks)
    const playPath = (media) => (media.proxy && zoomRef.current <= 1.01 ? media.proxy : media.path)

    // a clip that let go of its video file gets it back (see "far from the playhead" below)
    function ensureSrc(e, media) {
      if (e.kind === 'video' && !e.srcPath) {
        e.srcPath = playPath(media)
        e.el.src = toUrl(e.srcPath)
      }
    }

    function getEl(clip, media) {
      let e = els.current.get(clip.id)
      if (e) return e
      let el
      if (media.type === 'video') {
        el = document.createElement('video')
        el.preload = 'auto'
        el.playsInline = true
        el.muted = true // sound comes from the separately extracted audio streams
        el.src = toUrl(playPath(media))
      } else {
        el = new Image()
        el.src = toUrl(media.path)
      }
      e = { el, kind: media.type, media, srcPath: media.type === 'video' ? playPath(media) : media.path }
      els.current.set(clip.id, e)
      return e
    }

    // Clean-up of a clip's sound (noise reduction, rumble, voice preset): ffmpeg renders a cleaned copy in the background
    // (the export uses the same chain). Until it is ready the plain sound plays.
    const cleaned = new Map() // "file|settings" -> path of the cleaned copy, or null while it is being made
    function cleanedFile(file, clean) {
      if (!file || !cleanActive(clean)) return file
      const key = file + '|' + JSON.stringify([clean.nr || 0, !!clean.rumble, clean.voice || ''])
      if (!cleaned.has(key)) {
        cleaned.set(key, null)
        window.api.cleanAudio({ file, clean }).then((p) => cleaned.set(key, p || file)).catch(() => cleaned.set(key, file))
      }
      return cleaned.get(key) || file
    }

    // ---- audio: every video audio stream and every audio clip plays from its own <audio>
    function getAudio(key, file) {
      let e = aels.current.get(key)
      if (e && e.file !== file) {
        // the cleaned copy became ready (or the settings changed): switch the file, the sync code puts it at the right time
        e.file = file
        e.el.src = toUrl(file)
      }
      if (!e) {
        const el = new Audio()
        el.preload = 'auto'
        el.preservesPitch = true // a clip at another speed keeps its voice pitch
        el.src = toUrl(file)
        const ctx = getCtx()
        const gain = ctx.createGain()
        ctx.createMediaElementSource(el).connect(gain)
        gain.connect(ctx.destination)
        e = { el, gain, file }
        aels.current.set(key, e)
      }
      return e
    }

    function audioPass(t, s, clips) {
      const hid = new Set(s.hiddenRows || []) // hidden rows are silent
      const want = new Map() // key -> {file, src, vol}
      const soon = [] // clips starting in the next few seconds: loaded ahead so they start on time
      const valid = new Set()
      const mediaOf = (id) => s.media.find((m) => m.id === id)
      clips.forEach((c, i) => {
        const m = mediaOf(c.mediaId)
        if (!m || m.type !== 'video') return
        const active = t >= c.start && t < c.start + c.dur
        const upcoming = !active && c.start > t && c.start - t < 3
        ;(m.audioFiles || []).forEach((f, n) => {
          if (!f || (c.noAudio || []).includes(n) || hid.has('s:' + n) || c.reverse) return // (a reversed clip is silent in the preview; the export has its reversed sound) // missing file, or detached/deleted stream
          const key = `v:${c.id}:${n}`
          valid.add(key)
          if (active) {
            // crossfade the audio of the two clips during a transition
            let fade = 1
            if (c.ov > 0 && t < c.start + c.ov) fade *= (t - c.start) / c.ov
            const nx = clips[i + 1]
            if (nx && nx.ov > 0 && t >= nx.start) fade *= 1 - (t - nx.start) / nx.ov
            const st = s.streamSettings[n] || {}
            const own = streamAudioOf(c, n) // this clip's own volume and clean-up
            fade *= envAt(own.env, srcAt(c, t)) * fadeAt(t - c.start, c.dur, own.fadeIn, own.fadeOut) // its volume curve and fade handles
            want.set(key, { file: cleanedFile(f, own.clean), src: srcAt(c, t), rate: speedOf(c), vol: st.mute || own.mute ? 0 : (st.volume ?? 1) * own.volume * fade })
          } else if (upcoming) soon.push({ key, file: cleanedFile(f, streamAudioOf(c, n).clean), src: c.in })
        })
      })
      for (const a of audioLayout(s.audioClips)) {
        const file = audioSource(a, mediaOf(a.mediaId))
        if (!file) continue // e.g. a detached stream that is still being prepared
        const key = `a:${a.id}`
        valid.add(key)
        const tr = s.audioTracks.find((x) => x.id === a.trackId)
        const active = t >= a.start && t < a.start + a.dur
        if (active && !hid.has('a:' + a.trackId)) want.set(key, { file: cleanedFile(file, a.clean), src: a.in + (t - a.start), vol: (tr ? (tr.mute ? 0 : tr.volume) : 1) * (a.mute ? 0 : a.volume ?? 1) * envAt(a.env, a.in + (t - a.start)) * fadeAt(t - a.start, a.dur, a.fadeIn || 0, a.fadeOut || 0) })
        else if (a.start > t && a.start - t < 3) soon.push({ key, file: cleanedFile(file, a.clean), src: a.in })
      }
      for (const [key, w] of want) {
        const ae = getAudio(key, w.file)
        const el = ae.el
        ae.gain.gain.value = Math.max(0, Math.min(4, w.vol))
        if (w.rate && el.playbackRate !== w.rate) el.playbackRate = w.rate
        if (s.playing) {
          if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
          if (Math.abs(el.currentTime - w.src) > 0.25) el.currentTime = w.src
          if (el.paused) el.play().catch(() => {})
        } else if (!el.paused) el.pause()
      }
      for (const u of soon) {
        const el = getAudio(u.key, u.file).el
        if (el.paused && el.readyState > 0 && Math.abs(el.currentTime - u.src) > 0.05 && !el.seeking) el.currentTime = u.src
      }
      const soonKeys = new Set(soon.map((u) => u.key))
      const nowMs = performance.now()
      for (const [key, e] of aels.current) {
        // a sound that has been idle for a while lets go of its file (hundreds of open files can make the browser give up)
        if (want.has(key) || soonKeys.has(key)) e.idle = 0
        else if (!e.idle) e.idle = nowMs
        if (!valid.has(key) || (e.idle && nowMs - e.idle > 10000 && e.el.paused)) {
          e.el.pause()
          e.el.removeAttribute('src')
          e.el.load()
          try {
            e.gain.disconnect()
          } catch {}
          aels.current.delete(key)
        } else if (!want.has(key) && !e.el.paused) e.el.pause()
      }
    }

    // Keep a clip's <video> in step with the timeline; returns {el,w,h} if a frame is ready.
    // A reversed clip is played from a reversed copy of its range, which ffmpeg makes in the background
    const proxies = new Map() // key -> {path}
    function proxyFor(clip, media) {
      const key = `${media.path}|${clip.in.toFixed(3)}|${clip.out.toFixed(3)}`
      let p = proxies.get(key)
      if (!p) {
        p = { path: null }
        proxies.set(key, p)
        window.api.reverseProxy({ file: media.path, from: clip.in, to: clip.out }).then((r) => (p.path = r)).catch(() => {})
      }
      return p.path
    }

    // text clips: the text is drawn onto a canvas (as big as the preview) which then is a picture like any other
    const textCvs = new Map()
    function textLayer(c, t) {
      const W = canvasRef.current.width
      const H = canvasRef.current.height
      let cv = textCvs.get(c.id)
      if (!cv) {
        cv = document.createElement('canvas')
        textCvs.set(c.id, cv)
        loadFont(c.text)
      }
      if (cv.width !== W || cv.height !== H) {
        cv.width = W
        cv.height = H
      }
      drawText(cv, c.text, t - c.start, c.dur)
      return { el: cv, w: W, h: H }
    }

    // how many videos are still on their way to the frame they should show (the AI connection waits for none)
    let unsettled = 0
    function syncClip(clip, t, playing, media) {
      const e = getEl(clip, media)
      if (e.kind === 'video') {
        const v = e.el
        let src = srcAt(clip, t)
        let want = playPath(media)
        let canPlay = true
        if (clip.reverse) {
          const pp = proxyFor(clip, media)
          if (pp) {
            want = pp
            src = Math.min((t - clip.start) * speedOf(clip), clip.out - clip.in)
          } else canPlay = false // not ready yet: show the still frame
        }
        if (e.srcPath !== want) {
          e.srcPath = want
          v.src = toUrl(want)
        }
        if (v.playbackRate !== speedOf(clip)) v.playbackRate = speedOf(clip)
        playing = playing && canPlay
        if (playing) {
          if (Math.abs(v.currentTime - src) > 0.3) v.currentTime = src
          if (v.paused) v.play().catch(() => {})
        } else {
          if (!v.paused) v.pause()
          if (Math.abs(v.currentTime - src) > 0.02 && !v.seeking) v.currentTime = src
          if (v.seeking || v.readyState < 2 || Math.abs(v.currentTime - src) > 0.05) unsettled++
        }
        return v.readyState >= 2 ? { el: v, w: v.videoWidth, h: v.videoHeight } : null
      }
      return e.el.complete && e.el.naturalWidth ? { el: e.el, w: e.el.naturalWidth, h: e.el.naturalHeight } : null
    }

    function frame(now) {
      raf = requestAnimationFrame(frame)
      // a project in a background tab does nothing and makes no sound
      if (!activeRef.current) {
        for (const e of els.current.values()) if (e.kind === 'video' && !e.el.paused) e.el.pause()
        for (const e of aels.current.values()) if (!e.el.paused) e.el.pause()
        clock.playing = false
        return
      }
      const s = stateRef.current
      unsettled = 0
      // Auto quality: while playing, if frames come slower than about 25 per second, draw a bit coarser (at most every 2 s)
      if (qualityRef.current === 'auto') {
        const dt = now - lastFrameAt
        lastFrameAt = now
        if (s.playing && dt > 0 && dt < 500) {
          slowAvg = slowAvg * 0.92 + dt * 0.08
          if (slowAvg > 42 && autoLevelRef.current < 3 && now - lastStep > 2000) {
            lastStep = now
            slowAvg = 16
            setAutoLevelRef.current(autoLevelRef.current + 1)
          }
        } else if (!s.playing) {
          slowAvg = 16
          if (autoLevelRef.current !== 1) setAutoLevelRef.current(1)
        }
      } else lastFrameAt = now
      const clips = layout(s.clips)
      const overlays = overlayLayout(s.overlayClips)
      const mainTotal = totalDuration(s.clips)
      const total = projectDuration(s)

      // playback clock
      let t = s.playhead
      if (s.playing) {
        if (!clock.playing || clock.seek !== s.seekId) {
          if (!clock.playing && t >= total - 0.05) t = 0
          clock = { ms: now, t0: t, seek: s.seekId, playing: true }
        }
        t = clock.t0 + (now - clock.ms) / 1000
        if (t >= total) {
          t = total
          dispatch({ type: 'setPlaying', value: false })
          clock.playing = false
        }
        dispatch({ type: 'setPlayhead', t })
      } else {
        clock.playing = false
      }

      // drop elements of deleted clips
      for (const [id, e] of els.current) {
        if (!clips.some((c) => c.id === id) && !overlays.some((c) => c.id === id)) {
          if (e.kind === 'video') {
            e.el.pause()
            e.el.removeAttribute('src')
            e.el.load()
          }
          els.current.delete(id)
        }
      }

      audioPass(t, s, clips)

      const mediaOf = (c) => s.media.find((m) => m.id === c.mediaId)
      const motionAt = (c) => srcAt(c, t)

      // main video: one clip under the playhead normally, two during a transition
      const hid = new Set(s.hiddenRows || [])
      let act = hid.has('main') ? [] : clips.filter((c) => t >= c.start && t < c.start + c.dur)
      if (!act.length && clips.length && t >= mainTotal && t >= total - 0.001) act = [clips[clips.length - 1]]
      act = act.slice(-2)
      const actIds = new Set(act.map((c) => c.id))
      const layerFor = {}
      let missing = false // a picture that should be on screen is not ready yet (for example while it seeks)
      if (act.length) {
        const cA = act[0]
        const cB = act.length > 1 ? act[1] : null
        const mA = mediaOf(cA)
        const mB = cB && mediaOf(cB)
        const A = cA.text ? textLayer(cA, t) : mA ? syncClip(cA, t, s.playing, mA) : null
        const B = cB && cB.text ? textLayer(cB, t) : cB && mB ? syncClip(cB, t, s.playing, mB) : null
        // each clip's motion (position / scale / rotation / opacity) and warp at this moment
        if (A) {
          A.tf = evalTransform(cA, motionAt(cA))
          A.warp = evalWarp(cA, motionAt(cA))
          A.fx = cA.fx
          A.mask = maskAt(cA, motionAt(cA))
        }
        if (B) {
          B.tf = evalTransform(cB, motionAt(cB))
          B.warp = evalWarp(cB, motionAt(cB))
          B.fx = cB.fx
          B.mask = maskAt(cB, motionAt(cB))
        }
        if (cB && B && A) layerFor.main = { A, B, name: cB.transition && cB.transition.name, progress: (t - cB.start) / cB.ov }
        else if (A) layerFor.main = { A }
        if (!layerFor.main || (cB && !(A && B))) missing = true
      }
      // overlay tracks: the clip of each track under the playhead (the later one wins)
      for (const tr of s.videoTracks) {
        if (hid.has('v:' + tr.id)) continue
        const hit = overlays.filter((c) => c.trackId === tr.id && t >= c.start && t < c.start + c.dur)
        const c = hit[hit.length - 1]
        if (!c) continue
        actIds.add(c.id)
        const m = mediaOf(c)
        const A = c.text ? textLayer(c, t) : m ? syncClip(c, t, s.playing, m) : null
        if (!A) {
          missing = true
          continue
        }
        A.tf = evalTransform(c, motionAt(c))
        A.warp = evalWarp(c, motionAt(c))
        A.fx = c.fx
        A.mask = maskAt(c, motionAt(c))
        layerFor['v:' + tr.id] = { A }
      }
      for (const [id, e] of els.current) {
        if (e.kind === 'video' && !actIds.has(id) && !e.el.paused) e.el.pause()
      }
      // Clips far from the playhead let go of their video file. A project with many clips would otherwise keep a video
      // decoder open for every one of them, and the browser runs out: seeks then never finish and the picture freezes.
      const span = new Map()
      for (const c of clips) span.set(c.id, [c.start, c.start + c.dur])
      for (const c of overlays) span.set(c.id, [c.start, c.start + c.dur])
      for (const [id, e] of els.current) {
        const sp = span.get(id)
        if (e.kind !== 'video' || !e.srcPath || actIds.has(id) || !sp) continue
        if (sp[0] > t + 10 || sp[1] < t - 6) {
          e.el.pause()
          e.el.removeAttribute('src')
          e.el.load()
          e.srcPath = null
        }
      }
      // overlay clips about to start: get their first frame ready
      for (const c of overlays) {
        if (c.start > t && c.start - t < 3) {
          const m = mediaOf(c)
          if (!m) continue
          const e = getEl(c, m)
          ensureSrc(e, m)
          if (e.kind === 'video' && e.el.paused && !c.reverse && e.el.readyState > 0 && Math.abs(e.el.currentTime - c.in) > 0.05 && !e.el.seeking) e.el.currentTime = c.in
        }
      }
      const layers = []
      for (const key of videoRowsBottomUp(s)) if (layerFor[key]) layers.push(layerFor[key])
      // While a video is still seeking (for example right after pausing) keep the picture that is already
      // on screen instead of drawing a black or half-finished frame: that was the blink.
      // (but never for long: a stuck seek gets the video reloaded, and after a few seconds we stop holding the old picture)
      if (missing) {
        if (!missingSince) missingSince = now
        const held = now - missingSince
        if (held > 1200) {
          for (const [id, e] of els.current) {
            if (e.kind === 'video' && actIds.has(id) && e.el.readyState < 2 && now - (e.reloaded || 0) > 2000) {
              e.reloaded = now
              e.srcPath = null // the next syncClip sets the source again, which loads the video afresh
            }
          }
        }
        window.__held = held // developer self-test
        if (haveFrame && held < 4000) return
      } else {
        missingSince = 0
        window.__held = 0
      }
      // what is on screen now, and whether every picture in it is the right one
      canvasRef.current.__drawn = { s, settled: !missing && !unsettled }
      if (!layers.length) {
        haveFrame = false
        return renderer.clear()
      }
      renderer.renderLayers(layers)
      haveFrame = !missing
      if (!act.length) return
      // warm up the following clip so the cut / transition starts seamlessly
      const last = act[act.length - 1]
      const next = clips[clips.findIndex((c) => c.id === last.id) + 1]
      if (next) {
        const nm = mediaOf(next)
        if (nm) {
          const ne = getEl(next, nm)
          ensureSrc(ne, nm)
          if (ne.kind === 'video' && ne.el.paused && !next.reverse && ne.el.readyState > 0 && Math.abs(ne.el.currentTime - next.in) > 0.05 && !ne.el.seeking)
            ne.el.currentTime = next.in
        }
      }
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [dispatch])

  // (re)compile the transition library whenever the list changes
  useEffect(() => {
    const r = rendererRef.current
    if (!r || !transitions) return
    const errors = {}
    for (const tr of transitions) {
      const err = r.addTransition(tr.name, tr.source)
      if (err) errors[tr.name] = err
    }
    onCompiled && onCompiled(errors)
  }, [transitions])

  // the picture fits the available space; zoom (1 = fit) makes it bigger, and the area then scrolls (wheel + Ctrl zooms
  // towards the pointer, the middle mouse button drags the picture around). Handy for tight masks.
  const areaRef = useRef(null)
  const wrapRef = useRef(null)
  const ratio = aspectRatio(state)
  const [zoom, setZoomState] = useState(1)
  const [fitBox, setFitBox] = useState({ w: 640, h: 360 })
  const zoomRef = useRef(1)
  const [cw0, ch0] = previewSize(ratio)
  const sharp = Math.min(3, Math.max(1, zoom)) // the picture is drawn finer while zoomed in
  // preview quality: how finely the picture is drawn (a lower one plays smoother on a slow PC). Auto starts full and
  // steps down by itself while playback cannot keep up, then goes back to full when paused.
  const [quality, setQualityState] = useState(() => {
    try {
      const q = localStorage.getItem('vibe.previewQuality')
      return ['full', 'half', 'quarter', 'auto'].includes(q) ? q : 'full'
    } catch {
      return 'full'
    }
  })
  const [autoLevel, setAutoLevel] = useState(1) // 1 full, 2 half, 3 quarter
  const setQuality = (q) => {
    setQualityState(q)
    setAutoLevel(1)
    try {
      localStorage.setItem('vibe.previewQuality', q)
    } catch {}
  }
  qualityRef.current = quality
  autoLevelRef.current = autoLevel
  setAutoLevelRef.current = setAutoLevel
  const qScale = quality === 'full' ? 1 : quality === 'half' ? 0.5 : quality === 'quarter' ? 0.25 : [1, 0.5, 0.25][autoLevel - 1]
  const cw = Math.max(64, Math.round(cw0 * sharp * qScale))
  const ch = Math.max(36, Math.round(ch0 * sharp * qScale))
  const box = { w: fitBox.w * zoom, h: fitBox.h * zoom }
  useEffect(() => {
    const el = areaRef.current
    const fit = () => {
      const pad = 28 // room around the picture for handles that stick out
      const w = Math.max(1, Math.min(el.clientWidth - pad, (el.clientHeight - pad) * ratio))
      setFitBox({ w, h: w / ratio })
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ratio])
  // change the zoom keeping the point under (px, py) (pixels inside the scroll area) where it is
  const setZoom = (z, px, py) => {
    const wrap = wrapRef.current
    const nz = Math.min(16, Math.max(1, z))
    const old = zoomRef.current
    if (nz === old) return
    if (wrap) {
      const cx = px == null ? wrap.clientWidth / 2 : px
      const cy = py == null ? wrap.clientHeight / 2 : py
      const fx = (wrap.scrollLeft + cx) / old
      const fy = (wrap.scrollTop + cy) / old
      zoomRef.current = nz
      setZoomState(nz)
      requestAnimationFrame(() => {
        wrap.scrollLeft = fx * nz - cx
        wrap.scrollTop = fy * nz - cy
      })
    } else {
      zoomRef.current = nz
      setZoomState(nz)
    }
  }
  const onWheel = (e) => {
    if (!e.ctrlKey) return
    e.preventDefault()
    const r = wrapRef.current.getBoundingClientRect()
    setZoom(zoomRef.current * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX - r.left, e.clientY - r.top)
  }
  const onPan = (e) => {
    if (e.button !== 1) return
    e.preventDefault()
    const wrap = wrapRef.current
    const x0 = e.clientX
    const y0 = e.clientY
    const sl = wrap.scrollLeft
    const st = wrap.scrollTop
    const move = (ev) => {
      wrap.scrollLeft = sl - (ev.clientX - x0)
      wrap.scrollTop = st - (ev.clientY - y0)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="preview-area" ref={areaRef}>
    <div className="preview-wrap" ref={wrapRef} onWheel={onWheel} onPointerDown={onPan} onAuxClick={(e) => e.preventDefault()}>
      <div className="preview-box" style={{ width: box.w, height: box.h }}>
        <canvas ref={canvasRef} width={cw} height={ch} className="preview-canvas" />
        {mode === 'warp' && <WarpOverlay state={state} dispatch={dispatch} />}
        {mode === 'transform' && <TransformOverlay state={state} dispatch={dispatch} free={freeMode} box={box} />}
        {(mode === 'mask' || mode === 'maskdraw' || mode === 'maskpoly' || mode === 'maskdrawsmart') && (
          <MaskOverlay
            state={state}
            dispatch={dispatch}
            mode={mode}
            setMode={setMode}
            box={box}
            getFrame={(id) => {
              // the picture of a clip as it is on screen now (for the smart mask)
              const e = els.current.get(id)
              const el = e && e.el
              const w = el && (el.videoWidth || el.naturalWidth)
              const h = el && (el.videoHeight || el.naturalHeight)
              return w ? { el, w, h } : null
            }}
          />
        )}
      </div>
    </div>
    <div className="zoom-bar">
      <button className="mini" onClick={() => setZoom(zoomRef.current / 1.5)} title="Zoom out the preview">−</button>
      <span title="Ctrl + mouse wheel zooms towards the pointer; drag with the middle mouse button to move around">{Math.round(zoom * 100)}%</span>
      <button className="mini" onClick={() => setZoom(zoomRef.current * 1.5)} title="Zoom in the preview (Ctrl + mouse wheel zooms towards the pointer)">+</button>
      <button className="mini" onClick={() => setZoom(1)} title="Fit the picture in the preview">Fit</button>
      <select value={quality} onChange={(e) => setQuality(e.target.value)} title="Preview quality. Lower is smoother on a slow PC. It does not change the export. Auto lowers it by itself while playback stutters.">
        <option value="full">Full</option>
        <option value="half">Half</option>
        <option value="quarter">Quarter</option>
        <option value="auto">Auto</option>
      </select>
    </div>
    </div>
  )
}
