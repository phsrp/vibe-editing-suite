import { useEffect, useRef, useState } from 'react'
import { keyTimes } from './motion.js'
import Icon from './Icon.jsx'
import Wave from './Wave.jsx'
import VolumeEdit from './VolumeEdit.jsx'
import MiniMap from './MiniMap.jsx'
import { maskSpan } from './masks.js'
import { srcAt, tlOf, speedOf, lenOf, layout, audioLayout, overlayLayout, streamCount, projectDuration, rowKeys, audioSource, fmtTime, fmtDur, toUrl, uid, hasAttached, canGroup, canUngroup, hasClipboard, streamAudioOf, envAt, fadeAt } from './state.js'
import { labelColor } from './labels.js'

const TRACK_PAD = 12
const LABEL = 196
const H_VIDEO = 76
const H_AUDIO = 60

// a stable colour per group, shown as a stripe on every member
const groupColor = (g) => {
  let h = 0
  for (const ch of g) h = (h * 31 + ch.charCodeAt(0)) % 360
  return `hsl(${h}, 75%, 62%)`
}

// The left part of a row: a grip to drag the row up or down, the name (double-click to rename) and,
// for audio rows, mute. (The volume belongs to each audio clip: select it and use the inspector.)
function RowLabel({ name, sub, mute, onMute, onRemove, onRename, onGrip, locked, hidden, onLock, onHide }) {
  const [edit, setEdit] = useState(false)
  const done = (v) => {
    setEdit(false)
    if (v && v.trim() && v.trim() !== name) onRename(v.trim())
  }
  return (
    <div className="tl-label" style={{ width: LABEL }} onPointerDown={onGrip} title="Drag up or down to move this track">
      <div className="tl-label-top">
        <span className="grip"><Icon name="grip" size={12} /></span>
        {edit ? (
          <input
            className="name-edit"
            autoFocus
            defaultValue={name}
            onFocus={(e) => e.target.select()}
            onBlur={(e) => done(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') done(e.target.value)
              else if (e.key === 'Escape') setEdit(false)
            }}
          />
        ) : (
          <span className="tl-name" title={name + ' (double-click to rename)'} onDoubleClick={() => setEdit(true)}>{name}</span>
        )}
        {onMute && (
          <button className={'mini' + (mute ? ' on' : '')} title={mute ? 'Unmute' : 'Mute'} onClick={onMute}>
            <Icon name={mute ? 'mute' : 'volume'} size={13} />
          </button>
        )}
        {onHide && (
          <button className={'mini' + (hidden ? ' on' : '')} title={hidden ? 'Show this track again' : 'Hide this track (not shown or exported, audio is silent)'} onClick={onHide}>
            <Icon name={hidden ? 'eyeOff' : 'eye'} size={13} />
          </button>
        )}
        {onLock && (
          <button className={'mini' + (locked ? ' on' : '')} title={locked ? 'Unlock this track' : 'Lock this track so its clips cannot be changed'} onClick={onLock}>
            <Icon name={locked ? 'lock' : 'unlock'} size={13} />
          </button>
        )}
        {onRemove && (
          <button className="mini" title="Remove this track" onClick={onRemove}><Icon name="x" size={12} /></button>
        )}
      </div>
      {sub && <div className="tl-sub" title={sub}>{sub}</div>}
    </div>
  )
}
export default function Timeline({ onCaptions, height, state, dispatch, zoom, setZoom, splitKey, freezeKey, groupKey, ungroupKey, onFreeze, onKeybinds, snapOn, setSnapOn, rippleOn, setRippleOn, onCopy, fitRef, miniOn, setMiniOn, rec, onRecord }) {
  const scrollRef = useRef(null)
  const innerRef = useRef(null)
  const trackRef = useRef(null) // the ruler lane: reference for time <-> pixel conversion
  const scrubbing = useRef(false)
  const [drag, setDrag] = useState(null) // {id, dx, target}
  const [dropIdx, setDropIdx] = useState(null)
  const [marquee, setMarquee] = useState(null) // {x0,y0,x1,y1} in timeline-content pixels
  const [rowDrag, setRowDrag] = useState(null) // {key, to}: a track being dragged up or down
  const [showAdd, setShowAdd] = useState(false) // the 'Add track' popup
  const [snapLine, setSnapLine] = useState(null) // time (s) of the snap guide while dragging
  const [editMarker, setEditMarker] = useState(null) // id of the marker whose name is being typed
  const rowEls = useRef({})
  // the part of the timeline that is on screen (in lane pixels), so waveforms are only drawn there, sharp
  const [view, setView] = useState({ l: 0, r: 3000 })
  useEffect(() => {
    const el = scrollRef.current
    let raf = 0
    const upd = () => {
      raf = 0
      const l = Math.floor((el.scrollLeft - LABEL - TRACK_PAD) / 250) * 250
      const r = Math.ceil((el.scrollLeft + el.clientWidth - LABEL - TRACK_PAD) / 250) * 250
      setView((v) => (v.l === l && v.r === r ? v : { l, r }))
    }
    const on = () => {
      if (!raf) raf = requestAnimationFrame(upd)
    }
    upd()
    el.addEventListener('scroll', on, { passive: true })
    const ro = new ResizeObserver(on)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', on)
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [])

  const clips = layout(state.clips)
  const aclips = audioLayout(state.audioClips)
  const oclips = overlayLayout(state.overlayClips)
  const keys = rowKeys(state)
  const total = Math.max(projectDuration(state), ...aclips.map((a) => a.start + a.dur), 0)
  const nStreams = streamCount(state)
  const width = LABEL + TRACK_PAD * 2 + Math.max(total + 15, 40) * zoom
  const mediaOf = (c) => state.media.find((m) => m.id === c.mediaId)
  const sel = new Set(state.selection)

  // Keep the playhead in view: page the timeline when it nears the right edge (or leaves the left).
  useEffect(() => {
    const el = scrollRef.current
    if (!el || scrubbing.current) return
    const x = LABEL + TRACK_PAD + state.playhead * zoom
    const view = el.clientWidth
    if (x > el.scrollLeft + view - 40 || x < el.scrollLeft + LABEL) {
      if (state.playing || x < el.scrollLeft + LABEL || x > el.scrollLeft + view) el.scrollLeft = Math.max(0, x - view * 0.2)
    }
  }, [state.playhead, state.playing, zoom])

  const indexAtX = (x, skip) => {
    let i = 0
    for (const c of clips) {
      if (skip && skip.has(c.id)) continue
      if ((c.start + c.dur / 2) * zoom < x) i++
    }
    return i
  }
  const [dropRow, setDropRow] = useState(null) // the row a dragged clip would land on (highlighted)
  // the track under a height on screen: rowUnder(y, 'v:') = an overlay video track id, 'a:' = an audio track id
  const rowUnder = (y, prefix) => {
    for (const k of Object.keys(rowEls.current)) {
      if (!k.startsWith(prefix)) continue
      const r = rowEls.current[k].getBoundingClientRect()
      if (y >= r.top && y < r.bottom) return k.slice(prefix.length)
    }
    return null
  }
  const locked = (k) => (state.lockedRows || []).includes(k)
  const hiddenRow = (k) => (state.hiddenRows || []).includes(k)

  // ---- snapping: while dragging, clip edges stick to other clips' edges, markers and the playhead
  const snapPoints = (skip, withPlayhead = true) => {
    const pts = [0, ...state.markers.filter((m) => m.id !== skipMarker.current).map((m) => m.t)]
    if (withPlayhead) pts.push(state.playhead)
    for (const c of [...clips, ...oclips, ...aclips]) if (!skip.has(c.id)) pts.push(c.start, c.start + c.dur)
    return pts
  }
  // how many seconds to shift so that one of the edges lands on a snap point (0 when none is close)
  const snapShift = (edges, skip, withPlayhead = true) => {
    if (!snapOn) return 0
    const thr = 10 / zoom
    let best = null
    for (const p of snapPoints(skip, withPlayhead)) for (const e of edges) if (Math.abs(p - e) <= thr && (!best || Math.abs(p - e) < Math.abs(best.d))) best = { d: p - e, p }
    setSnapLine(best ? best.p : null)
    return best ? best.d : 0
  }
  // rows for the overview strip
  const miniRows = keys.map((k) => {
    if (k === 'main') return { key: k, kind: 'v', items: clips.map((c) => ({ start: c.start, dur: c.dur })) }
    if (k.startsWith('v:')) return { key: k, kind: 'v', items: oclips.filter((c) => c.trackId === k.slice(2)).map((c) => ({ start: c.start, dur: c.dur })) }
    if (k.startsWith('s:')) return { key: k, kind: 'a', items: clips.filter((c) => hasAttached(c, mediaOf(c), +k.slice(2))).map((c) => ({ start: c.start, dur: c.dur })) }
    return { key: k, kind: 'a', items: aclips.filter((c) => c.trackId === k.slice(2)).map((c) => ({ start: c.start, dur: c.dur })) }
  })
  const skipMarker = useRef(null)
  // ---- markers: click = jump to it, drag = move it, double-click = name it
  const startMarkerDrag = (e, m) => {
    if (e.button !== 0 || e.target.closest('input, .marker-x')) return
    e.stopPropagation()
    e.preventDefault()
    dispatch({ type: 'setPlayhead', t: m.t, user: true })
    const x0 = e.clientX
    let started = false
    skipMarker.current = m.id
    const move = (ev) => {
      if (!started && Math.abs(ev.clientX - x0) < 3) return
      if (!started) dispatch({ type: 'checkpoint' })
      started = true
      let t = Math.max(0, m.t + (ev.clientX - x0) / zoom)
      t = Math.max(0, t + snapShift([t], new Set()))
      dispatch({ type: 'moveMarker', id: m.id, t })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      skipMarker.current = null
      setSnapLine(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  // zoom so the whole project fits on screen
  const fit = () => {
    const el = scrollRef.current
    const w = el.clientWidth - LABEL - TRACK_PAD * 2 - 24
    setZoom(Math.min(400, Math.max(0.2, w / Math.max(total, 1))))
    el.scrollLeft = 0
  }
  if (fitRef) fitRef.current = fit
  const localX = (clientX) => clientX - trackRef.current.getBoundingClientRect().left - TRACK_PAD

  // Pointer-drag helper with edge auto-scroll. onMove(clientX, clientY) is called on every move and
  // every frame while the pointer sits near the edge of the timeline (so content keeps scrolling).
  const trackPointer = (e, { onMove, onEnd, scrollX = true, scrollY = false }) => {
    let last = { x: e.clientX, y: e.clientY }
    let prev = performance.now()
    let raf
    const loop = (now) => {
      const dt = Math.min(0.05, (now - prev) / 1000)
      prev = now
      const el = scrollRef.current
      const r = el.getBoundingClientRect()
      const zone = 60
      let vx = 0
      let vy = 0
      if (scrollX) {
        if (last.x > r.right - zone) vx = Math.min(500, 60 + (last.x - (r.right - zone)) * 8)
        else if (last.x < r.left + LABEL + zone) vx = -Math.min(500, 60 + (r.left + LABEL + zone - last.x) * 8)
      }
      if (scrollY) {
        if (last.y > r.bottom - 30) vy = Math.min(400, 60 + (last.y - (r.bottom - 30)) * 8)
        else if (last.y < r.top + 56) vy = -Math.min(400, 60 + (r.top + 56 - last.y) * 8)
      }
      if (vx || vy) {
        el.scrollLeft += vx * dt
        el.scrollTop += vy * dt
        onMove(last.x, last.y)
      }
      raf = requestAnimationFrame(loop)
    }
    const move = (ev) => {
      last = { x: ev.clientX, y: ev.clientY }
      onMove(last.x, last.y)
    }
    const up = (ev) => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      onEnd && onEnd(ev)
    }
    raf = requestAnimationFrame(loop)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---- playhead scrubbing on the ruler
  const scrub = (e) => {
    scrubbing.current = true
    const apply = (x) => {
      let t = Math.min(Math.max(0, localX(x) / zoom), total)
      t = Math.max(0, t + snapShift([t], new Set(), false))
      dispatch({ type: 'setPlayhead', t, user: true })
    }
    apply(e.clientX)
    trackPointer(e, {
      onMove: (x) => apply(x),
      onEnd: () => {
        scrubbing.current = false
        setSnapLine(null)
      },
    })
  }

  // ---- drag-select (like dragging a box around icons in Explorer)
  const startMarquee = (e) => {
    if (e.button !== 0) return
    if (e.target.closest('.clip, .aclip, .tl-label, .ruler-row, button, input')) return
    const additive = e.ctrlKey || e.shiftKey
    const base = additive ? state.selection : []
    if (!additive) dispatch({ type: 'select', id: null })
    const el = innerRef.current
    const inner = () => el.getBoundingClientRect()
    const start = { x: e.clientX - inner().left, y: e.clientY - inner().top }
    let moved = false
    trackPointer(e, {
      scrollY: true,
      onMove: (cx, cy) => {
        const r = inner()
        const x1 = cx - r.left
        const y1 = cy - r.top
        if (!moved && Math.abs(x1 - start.x) < 4 && Math.abs(y1 - start.y) < 4) return
        moved = true
        setMarquee({ x0: start.x, y0: start.y, x1, y1 })
        const L = r.left + Math.min(start.x, x1)
        const R = r.left + Math.max(start.x, x1)
        const T = r.top + Math.min(start.y, y1)
        const B = r.top + Math.max(start.y, y1)
        const hits = []
        el.querySelectorAll('[data-sel]').forEach((n) => {
          const b = n.getBoundingClientRect()
          if (b.right >= L && b.left <= R && b.bottom >= T && b.top <= B) hits.push(n.dataset.sel)
        })
        dispatch({ type: 'selectMany', ids: [...new Set([...base, ...hits])] })
      },
      onEnd: () => setMarquee(null),
    })
  }

  // ---- drag a video clip body to reorder (the whole selection / group moves together)
  const startMove = (e, c) => {
    if (e.button !== 0) return
    if (locked('main')) return void dispatch({ type: 'select', id: c.id })
    const mod = e.ctrlKey || e.shiftKey
    const wasSelected = sel.has(c.id)
    if (mod) dispatch({ type: 'select', id: c.id, additive: true })
    else if (!wasSelected) dispatch({ type: 'select', id: c.id })
    // which video clips travel with this one
    const ids = new Set(
      wasSelected ? clips.filter((x) => sel.has(x.id)).map((x) => x.id) : c.groupId ? clips.filter((x) => x.groupId === c.groupId).map((x) => x.id) : [c.id]
    )
    ids.add(c.id)
    const x0 = e.clientX
    let moved = false
    const targetFor = (dx) => indexAtX((c.start + c.dur / 2) * zoom + dx, ids)
    // one clip dragged up onto an overlay track moves to that track
    let over = null
    // the magnet: the clips that follow on the main track move along, so they are nothing to line up with
    const moving = clips.filter((x) => ids.has(x.id))
    const fromIdx = clips.indexOf(moving[0])
    const skip = new Set([...ids, ...clips.slice(fromIdx).map((x) => x.id)])
    const snapped = (raw) => {
      const d = raw / zoom
      return (d + snapShift(moving.flatMap((b) => [b.start + d, b.start + d + b.dur]), skip)) * zoom
    }
    let lastDx = 0
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 4) return
      moved = true
      const dx = snapped(ev.clientX - x0)
      lastDx = dx
      const tr = ids.size === 1 ? rowUnder(ev.clientY, 'v:') : null
      over = tr && !locked('v:' + tr) ? tr : null
      setDropRow(over ? 'v:' + over : null)
      // moving without passing a neighbour leaves a gap (no insert line); passing one reorders
      setDrag({ ids, dx, target: over || targetFor(dx) === targetFor(0) ? null : targetFor(dx) })
    }
    const up = (ev) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setSnapLine(null)
      if (moved && over) dispatch({ type: 'clipToOverlay', id: c.id, trackId: over, start: Math.max(0, c.start + lastDx / zoom) })
      else if (moved) {
        const dx = lastDx
        const idx = targetFor(dx)
        // dragged without passing a neighbour: the empty time in front of the clip changes (a gap, shown as black)
        let gap = 0
        if (idx === targetFor(0)) {
          const first = clips.find((x) => ids.has(x.id))
          const before = clips.filter((x, i) => !ids.has(x.id) && i < clips.indexOf(first))
          const prev = before[before.length - 1]
          gap = Math.max(0, first.start + dx / zoom - (prev ? prev.start + prev.dur : 0))
          if (gap * zoom < 9) gap = 0
        }
        dispatch({ type: 'moveMainTo', ids: [...ids], toIndex: idx, gap })
      }
      else if (wasSelected && !mod) dispatch({ type: 'select', id: c.id })
      setDrag(null)
      setDropRow(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  // ---- the mask bar on a clip: drag its ends to make the mask shorter / longer, drag the middle to move it, x removes it
  const startMaskDrag = (e, c, part) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    dispatch({ type: 'select', id: c.id })
    const [a0, b0] = maskSpan(c)
    const t0 = Math.min(tlOf(c, a0), tlOf(c, b0))
    const t1 = Math.max(tlOf(c, a0), tlOf(c, b0))
    const lo = c.start
    const hi = c.start + lenOf(c)
    const x0 = e.clientX
    let started = false
    const move = (ev) => {
      if (!started && Math.abs(ev.clientX - x0) < 3) return
      if (!started) {
        started = true
        dispatch({ type: 'checkpoint' })
      }
      const d = (ev.clientX - x0) / zoom
      let L = t0
      let R = t1
      if (part === 'l') L = Math.min(R - 0.1, Math.max(lo, t0 + d))
      else if (part === 'r') R = Math.max(L + 0.1, Math.min(hi, t1 + d))
      else {
        const dd = Math.min(hi - t1, Math.max(lo - t0, d))
        L = t0 + dd
        R = t1 + dd
      }
      const s1 = srcAt(c, L)
      const s2 = srcAt(c, R)
      dispatch({ type: 'setMask', id: c.id, patch: { from: Math.min(s1, s2), to: Math.max(s1, s2) }, live: true })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const maskBar = (c) => {
    if (!c.mask) return null
    const [a, b] = maskSpan(c)
    if (b <= a) return null
    const x1 = (tlOf(c, a) - c.start) * zoom
    const x2 = (tlOf(c, b) - c.start) * zoom
    const left = Math.min(x1, x2)
    const w = Math.max(10, Math.abs(x2 - x1))
    return (
      <div className="mask-bar" style={{ left, width: w }} onPointerDown={(e) => startMaskDrag(e, c, 'm')} title="Mask: drag the ends to make it shorter or longer, drag the middle to move it">
        <div className="mask-edge l" onPointerDown={(e) => startMaskDrag(e, c, 'l')} />
        <span>Mask</span>
        <button className="mask-x" title="Remove the mask" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); dispatch({ type: 'clearMask', id: c.id }) }}>×</button>
        <div className="mask-edge r" onPointerDown={(e) => startMaskDrag(e, c, 'r')} />
      </div>
    )
  }
  // ---- keyframe markers on a clip: click = jump to it, drag = move it in time
  const startKfDrag = (e, c, t0) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    dispatch({ type: 'select', id: c.id })
    dispatch({ type: 'setPlayhead', t: tlOf(c, t0), user: true })
    const x0 = e.clientX
    let cur = t0
    let started = false
    const move = (ev) => {
      if (!started && Math.abs(ev.clientX - x0) < 3) return
      if (!started) {
        started = true
        dispatch({ type: 'checkpoint' })
      }
      const nt = Math.min(c.out, Math.max(c.in, srcAt(c, tlOf(c, t0) + (ev.clientX - x0) / zoom)))
      dispatch({ type: 'moveKeyframes', id: c.id, from: cur, to: nt })
      dispatch({ type: 'setPlayhead', t: tlOf(c, nt), user: true })
      cur = nt
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---- drag the left/right edge of a video clip to trim
  const startTrim = (e, c, side) => {
    e.stopPropagation()
    e.preventDefault()
    dispatch({ type: 'select', id: c.id })
    if (locked('main')) return
    dispatch({ type: 'checkpoint' })
    const x0 = e.clientX
    const sp = speedOf(c)
    const rev = !!c.reverse
    const srcSide = side === 'in' ? (rev ? 'out' : 'in') : rev ? 'in' : 'out' // a reversed clip's left end is its source out point
    const base = srcSide === 'in' ? c.in : c.out
    // the clips after this one follow its end, so only the end moves: that is the edge that sticks to things
    const skip = new Set(clips.slice(clips.findIndex((x) => x.id === c.id)).map((x) => x.id))
    const edge = side === 'in' ? -1 : 1
    const move = (ev) => {
      let dt = (ev.clientX - x0) / zoom
      dt += edge * snapShift([c.start + c.dur + edge * dt], skip)
      dispatch({ type: 'trim', id: c.id, side: srcSide, value: base + (rev ? -1 : 1) * dt * sp })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setSnapLine(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---- attached audio boxes: click to select (their video clip's audio)
  const clickStream = (e, c, n) => {
    if (e.button !== 0) return
    e.stopPropagation()
    dispatch({ type: 'select', id: `sa:${c.id}:${n}`, additive: e.ctrlKey || e.shiftKey })
  }

  // ---- audio clips: drag to move (all selected audio clips move together), drag edges to trim
  const startMoveAudio = (e, a) => {
    if (e.button !== 0) return
    const mod = e.ctrlKey || e.shiftKey
    const wasSelected = sel.has(a.id)
    let ids = state.selection
    if (mod) {
      dispatch({ type: 'select', id: a.id, additive: true })
      ids = wasSelected ? state.selection.filter((x) => x !== a.id) : [...state.selection, a.id, ...aclips.filter((x) => a.groupId && x.groupId === a.groupId).map((x) => x.id)]
    } else if (!wasSelected) {
      dispatch({ type: 'select', id: a.id })
      ids = a.groupId ? aclips.filter((x) => x.groupId === a.groupId).map((x) => x.id) : [a.id]
    }
    if (locked('a:' + a.trackId)) return
    const bases = aclips.filter((x) => ids.includes(x.id)).map((x) => ({ id: x.id, start: x.start, dur: x.dur }))
    const skip = new Set(bases.map((b) => b.id))
    const x0 = e.clientX
    let started = false
    const move = (ev) => {
      if (!started && Math.abs(ev.clientX - x0) < 4) return
      if (!started) {
        started = true
        dispatch({ type: 'checkpoint' })
      }
      let d = (ev.clientX - x0) / zoom
      d += snapShift(bases.flatMap((b) => [b.start + d, b.start + d + b.dur]), skip)
      // keep the group together even if the earliest clip hits time 0
      const minStart = Math.min(...bases.map((b) => b.start))
      d = Math.max(d, -minStart)
      // the dragged clip can change to another audio track
      const tr = rowUnder(ev.clientY, 'a:')
      dispatch({ type: 'moveItems', moves: bases.map((b) => ({ id: b.id, start: b.start + d, trackId: b.id === a.id && tr && !locked('a:' + tr) ? tr : undefined })) })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setSnapLine(null)
      if (!started && wasSelected && !mod) dispatch({ type: 'select', id: a.id })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const startTrimAudio = (e, a, side) => {
    e.stopPropagation()
    e.preventDefault()
    dispatch({ type: 'select', id: a.id })
    dispatch({ type: 'checkpoint' })
    const x0 = e.clientX
    if (locked('a:' + a.trackId)) return
    const base = side === 'in' ? a.in : a.out
    const move = (ev) => {
      let v = base + (ev.clientX - x0) / zoom
      v += snapShift([a.start + (v - a.in)], new Set([a.id]))
      dispatch({ type: 'trimAudio', id: a.id, side, value: v })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setSnapLine(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---- overlay clips: drag to move in time (or onto another video track), drag edges to trim
  const startMoveOverlay = (e, c) => {
    if (e.button !== 0) return
    const mod = e.ctrlKey || e.shiftKey
    const wasSelected = sel.has(c.id)
    const groupIds = (g) => (g ? [...oclips, ...aclips].filter((x) => x.groupId === g).map((x) => x.id) : [])
    let ids = state.selection
    if (mod) {
      dispatch({ type: 'select', id: c.id, additive: true })
      ids = wasSelected ? state.selection.filter((x) => x !== c.id) : [...state.selection, c.id, ...groupIds(c.groupId)]
    } else if (!wasSelected) {
      dispatch({ type: 'select', id: c.id })
      ids = [c.id, ...groupIds(c.groupId)]
    }
    if (locked('v:' + c.trackId)) return
    const bases = [...oclips, ...aclips].filter((x) => ids.includes(x.id)).map((x) => ({ id: x.id, start: x.start, dur: x.dur, trackId: x.trackId }))
    const skip = new Set(bases.map((b) => b.id))
    const x0 = e.clientX
    let started = false
    let overMain = false
    let lastX = x0
    let lastT = c.start
    const trackUnder = (y) => {
      for (const k of keys) {
        if (!k.startsWith('v:')) continue
        const el = rowEls.current[k]
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (y >= r.top && y < r.bottom) return k.slice(2)
      }
      return null
    }
    const move = (ev) => {
      if (!started && Math.abs(ev.clientX - x0) < 4) return
      if (!started) {
        started = true
        dispatch({ type: 'checkpoint' })
      }
      let d = (ev.clientX - x0) / zoom
      d += snapShift(bases.flatMap((b) => [b.start + d, b.start + d + b.dur]), skip)
      const minStart = Math.min(...bases.map((b) => b.start))
      d = Math.max(d, -minStart)
      const tr = trackUnder(ev.clientY)
      // one video clip dragged down onto the main track goes there
      const mr = rowEls.current.main && rowEls.current.main.getBoundingClientRect()
      overMain = !!(mr && bases.filter((b) => oclips.some((x) => x.id === b.id)).length === 1 && !locked('main') && ev.clientY >= mr.top && ev.clientY < mr.bottom)
      lastX = ev.clientX
      lastT = c.start + d
      setDropRow(overMain ? 'main' : null)
      dispatch({ type: 'moveItems', moves: bases.map((b) => ({ id: b.id, start: b.start + d, trackId: b.id === c.id ? tr || b.trackId : undefined })) })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setSnapLine(null)
      setDropRow(null)
      if (started && overMain) dispatch({ type: 'overlayToMain', id: c.id, toIndex: indexAtX((c.start + c.dur / 2) * zoom + (lastX - x0), new Set()), start: lastT })
      if (!started && wasSelected && !mod) dispatch({ type: 'select', id: c.id })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const startTrimOverlay = (e, c, side) => {
    e.stopPropagation()
    e.preventDefault()
    dispatch({ type: 'select', id: c.id })
    dispatch({ type: 'checkpoint' })
    const x0 = e.clientX
    if (locked('v:' + c.trackId)) return
    const sp = speedOf(c)
    const rev = !!c.reverse
    const srcSide = side === 'in' ? (rev ? 'out' : 'in') : rev ? 'in' : 'out'
    const base = srcSide === 'in' ? c.in : c.out
    const move = (ev) => {
      let dt = (ev.clientX - x0) / zoom
      dt += snapShift([side === 'in' ? c.start + dt : c.start + c.dur + dt], new Set([c.id]))
      dispatch({ type: 'trimOverlay', id: c.id, side: srcSide, value: base + (rev ? -1 : 1) * dt * sp })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setSnapLine(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const onOverlayDrop = (e, trackId) => {
    const id = e.dataTransfer.getData('text/vibe-media')
    if (!id) return
    e.preventDefault()
    dispatch({ type: 'addOverlayClip', mediaId: id, trackId, start: Math.max(0, localX(e.clientX) / zoom) })
  }

  // ---- drag a whole track (a row) up or down, over the others
  const startRowDrag = (e, key) => {
    if (e.button !== 0 || e.target.closest('button, input')) return
    e.preventDefault()
    const targetFor = (y) => {
      let idx = 0
      for (const k of keys) {
        if (k === key) continue
        const el = rowEls.current[k]
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (y > r.top + r.height / 2) idx++
      }
      return idx
    }
    let moved = false
    const y0 = e.clientY
    trackPointer(e, {
      scrollX: false,
      scrollY: true,
      onMove: (x, y) => {
        if (!moved && Math.abs(y - y0) < 5) return
        moved = true
        setRowDrag({ key, to: targetFor(y) })
      },
      onEnd: (ev) => {
        if (moved) dispatch({ type: 'moveRow', key, toIndex: targetFor(ev.clientY) })
        setRowDrag(null)
      },
    })
  }

  // ---- drops from the media bin
  const hasMedia = (e) => e.dataTransfer.types.includes('text/vibe-media')
  const onVideoDragOver = (e) => {
    if (!hasMedia(e)) return
    e.preventDefault()
    setDropIdx(indexAtX(localX(e.clientX), null))
  }
  const onVideoDrop = (e) => {
    const id = e.dataTransfer.getData('text/vibe-media')
    if (!id) return
    e.preventDefault()
    dispatch({ type: 'addClip', mediaId: id, index: indexAtX(localX(e.clientX), null) })
    setDropIdx(null)
  }
  const onAudioDrop = (e, trackId) => {
    const id = e.dataTransfer.getData('text/vibe-media')
    if (!id) return
    e.preventDefault()
    dispatch({ type: 'addAudioClip', mediaId: id, trackId, start: Math.max(0, localX(e.clientX) / zoom) })
  }

  const onWheel = (e) => {
    if (e.ctrlKey) {
      e.preventDefault()
      setZoom((z) => Math.min(400, Math.max(0.2, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))))
    }
  }

  // ruler ticks
  // the smallest "nice" step that keeps the labels at least 80px apart, however far out you zoom
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18000, 36000].find((n) => n * zoom >= 80) || 36000
  const ticks = []
  for (let s = 0; s <= total + 15; s += step) ticks.push(s)

  // where a drop/move indicator should be drawn
  const indicatorIdx = drag ? drag.target : dropIdx
  let indicatorX = null
  if (indicatorIdx != null) {
    const others = clips.filter((c) => !drag || !drag.ids.has(c.id))
    const lastO = others[others.length - 1]
    indicatorX = indicatorIdx >= others.length ? (lastO ? (lastO.start + lastO.dur) * zoom : 0) : others[indicatorIdx].start * zoom
  }

  const groupOk = canGroup(state)
  const ungroupOk = canUngroup(state)

  const streamName = (n) => `Video audio ${n + 1}`
  const streamSub = (n) => {
    for (const m of state.media) if (m.type === 'video' && m.audioStreams && m.audioStreams[n] && m.audioStreams[n].title) return m.audioStreams[n].title
    return ''
  }
  const clipAudioName = (a) => {
    const m = state.media.find((x) => x.id === a.mediaId)
    if (!m) return ''
    return a.stream != null ? `${m.name} (audio ${a.stream + 1})` : m.name
  }

  // ---- the rows (tracks), in the order the user arranged them
  const rowClass = (key) => {
    const flags = (locked(key) ? ' locked' : '') + (hiddenRow(key) ? ' hidden' : '')
    if (!rowDrag) return flags
    if (rowDrag.key === key) return flags + ' row-dragging'
    const others = keys.filter((k) => k !== rowDrag.key)
    const at = others.indexOf(key)
    if (at === rowDrag.to) return flags + ' drop-above'
    if (rowDrag.to >= others.length && at === others.length - 1) return flags + ' drop-below'
    return flags
  }
  // the props every row label needs for locking and hiding
  const rowFlags = (key) => ({ locked: locked(key), hidden: hiddenRow(key), onLock: () => dispatch({ type: 'toggleRowLock', key }), onHide: () => dispatch({ type: 'toggleRowHide', key }) })
  const rowRef = (key) => (el) => {
    if (el) rowEls.current[key] = el
    else delete rowEls.current[key]
  }

  const renderMain = (key) => (
    <div className={'tl-row' + rowClass(key) + (dropRow === key ? ' drop-here' : '')} key={key} ref={rowRef(key)} style={{ height: H_VIDEO }}>
      <RowLabel name={state.mainName} onRename={(name) => dispatch({ type: 'renameRow', key, name })} onGrip={(e) => startRowDrag(e, key)} {...rowFlags(key)} />
      <div className="lane" onDragOver={onVideoDragOver} onDragLeave={() => setDropIdx(null)} onDrop={onVideoDrop}>
        <div className="lane-inner" style={{ left: TRACK_PAD }}>
          {clips
            .filter((c) => c.gap > 0)
            .map((c) => (
              <div
                key={'gap' + c.id}
                className={'gap-block' + (sel.has('gap:' + c.id) ? ' selected' : '')}
                style={{ left: (c.start - c.gap) * zoom, width: Math.max(4, c.gap * zoom) }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.stopPropagation()
                  dispatch({ type: 'select', id: 'gap:' + c.id })
                }}
                title="Empty time: the preview and export show black here. Select it and press Delete (or click ×) to close the gap."
              >
                <span>{c.gap * zoom > 60 ? 'Gap ' + fmtDur(c.gap) : ''}</span>
                <button className="gap-x" onPointerDown={(e) => e.stopPropagation()} onClick={() => !locked('main') && dispatch({ type: 'closeGap', id: c.id })} title="Close this gap">×</button>
              </div>
            ))}
          {clips.map((c) => {
            const m = c.text ? { type: 'text', name: c.text.content, thumb: null } : mediaOf(c)
            if (!m) return null
            const dragging = drag && drag.ids.has(c.id)
            const nAtt = m.type === 'video' ? (m.audioStreams || []).filter((_, n) => hasAttached(c, m, n)).length : 0
            const silenced = m.type === 'video' && (m.audioStreams || []).length > 0 && nAtt === 0
            return (
              <div
                key={c.id}
                data-sel={c.id}
                className={'clip ' + m.type + (sel.has(c.id) ? ' selected' : '') + (dragging ? ' dragging' : '') + (c.groupId ? ' grouped' : '')}
                style={{
                  left: c.start * zoom,
                  width: Math.max(4, c.dur * zoom),
                  transform: dragging ? `translateX(${drag.dx}px)` : undefined,
                  backgroundImage: m.thumb ? `url("${toUrl(m.thumb)}")` : undefined,
                  '--gcol': c.groupId ? groupColor(c.groupId) : undefined,
                  '--lbl': labelColor(c),
                }}
                onPointerDown={(e) => startMove(e, c)}
              >
                {c.ov > 0 && (
                  <div className="tr-zone" style={{ width: c.ov * zoom }} title={c.transition.name}>
                    <span>{c.ov * zoom > 40 ? c.transition.name : '•'}</span>
                  </div>
                )}
                {keyTimes(c)
                  .filter((t) => t >= c.in - 0.001 && t <= c.out + 0.001)
                  .map((t) => (
                    <div key={t.toFixed(3)} className="kf" style={{ left: (tlOf(c, t) - c.start) * zoom }} onPointerDown={(e) => startKfDrag(e, c, t)} title="Keyframe: click to jump to it, drag to move it" />
                  ))}
                {maskBar(c)}
                <div className="handle left" onPointerDown={(e) => startTrim(e, c, 'in')} />
                <span className="clip-name">{c.groupId && <Icon name="link" size={11} />}{m.name}</span>
                <span className="clip-dur">{fmtDur(c.dur)}{silenced ? ' · no audio' : ''}</span>
                <div className="handle right" onPointerDown={(e) => startTrim(e, c, 'out')} />
              </div>
            )
          })}
          {indicatorX != null && <div className="insert-line" style={{ left: indicatorX }} />}
        </div>
        {!clips.length && <div className="empty-hint">Drag media here, or double-click an item in the Media panel</div>}
      </div>
    </div>
  )

  const renderOverlay = (key) => {
    const tr = state.videoTracks.find((x) => x.id === key.slice(2))
    if (!tr) return null
    return (
      <div className={'tl-row' + rowClass(key) + (dropRow === key ? ' drop-here' : '')} key={key} ref={rowRef(key)} style={{ height: H_VIDEO }}>
        <RowLabel
          name={tr.name}
          onRename={(name) => dispatch({ type: 'renameRow', key, name })}
          onGrip={(e) => startRowDrag(e, key)}
          onRemove={() => dispatch({ type: 'removeVideoTrack', id: tr.id })}
          {...rowFlags(key)}
        />
        <div className="lane" onDragOver={(e) => hasMedia(e) && e.preventDefault()} onDrop={(e) => onOverlayDrop(e, tr.id)}>
          <div className="lane-inner" style={{ left: TRACK_PAD }}>
            {oclips
              .filter((c) => c.trackId === tr.id)
              .map((c) => {
                const m = c.text ? { type: 'text', name: c.text.content, thumb: null } : mediaOf(c)
                if (!m) return null
                return (
                  <div
                    key={c.id}
                    data-sel={c.id}
                    className={'clip overlay ' + m.type + (sel.has(c.id) ? ' selected' : '') + (c.groupId ? ' grouped' : '')}
                    style={{
                      left: c.start * zoom,
                      width: Math.max(4, c.dur * zoom),
                      backgroundImage: m.thumb ? `url("${toUrl(m.thumb)}")` : undefined,
                      '--gcol': c.groupId ? groupColor(c.groupId) : undefined,
                  '--lbl': labelColor(c),
                    }}
                    onPointerDown={(e) => startMoveOverlay(e, c)}
                  >
                    {keyTimes(c)
                      .filter((t) => t >= c.in - 0.001 && t <= c.out + 0.001)
                      .map((t) => (
                        <div key={t.toFixed(3)} className="kf" style={{ left: (tlOf(c, t) - c.start) * zoom }} onPointerDown={(e) => startKfDrag(e, c, t)} title="Keyframe: click to jump to it, drag to move it" />
                      ))}
                    {maskBar(c)}
                    <div className="handle left" onPointerDown={(e) => startTrimOverlay(e, c, 'in')} />
                    <span className="clip-name">{c.groupId && <Icon name="link" size={11} />}{m.name}</span>
                    <span className="clip-dur">{fmtDur(c.dur)}</span>
                    <div className="handle right" onPointerDown={(e) => startTrimOverlay(e, c, 'out')} />
                  </div>
                )
              })}
          </div>
          {!oclips.some((c) => c.trackId === tr.id) && <div className="empty-hint">Drag a video or image here, or press T for text</div>}
        </div>
      </div>
    )
  }

  const renderStream = (key) => {
    const n = +key.slice(2)
    const st = { volume: 1, mute: false, ...state.streamSettings[n] }
    return (
      <div className={'tl-row' + rowClass(key)} key={key} ref={rowRef(key)} style={{ height: H_AUDIO }}>
        <RowLabel
          name={st.name || streamName(n)}
          mute={st.mute}
          onMute={() => dispatch({ type: 'setStream', n, patch: { mute: !st.mute } })}
          onRename={(name) => dispatch({ type: 'renameRow', key, name })}
          onGrip={(e) => startRowDrag(e, key)}
          {...rowFlags(key)}
        />
        {/* an audio file dropped on a video's sound lane goes to the first audio track that has room there (or a new one) */}
        <div className="lane" onDragOver={(e) => hasMedia(e) && e.preventDefault()} onDrop={(e) => onAudioDrop(e, null)}>
          <div className="lane-inner" style={{ left: TRACK_PAD }}>
            {clips.map((c) => {
              const m = mediaOf(c)
              if (!hasAttached(c, m, n)) return null
              const sid = `sa:${c.id}:${n}`
              const own = streamAudioOf(c, n)
              const sp = speedOf(c)
              const rel = (s) => (c.reverse ? c.out - s : s - c.in) / sp // seconds from the start of the clip
              const gainFn = (s) => envAt(own.env, s) * fadeAt(rel(s), c.dur, own.fadeIn, own.fadeOut)
              return (
                <div
                  key={c.id}
                  data-sel={sid}
                  className={'aclip stream' + (st.mute || streamAudioOf(c, n).mute ? ' muted' : '') + (sel.has(sid) ? ' selected' : '')}
                  style={{ left: c.start * zoom, width: Math.max(2, c.dur * zoom) }}
                  onPointerDown={(e) => clickStream(e, c, n)}
                >
                  <Wave file={(m.audioFiles || [])[n]} from={c.in} to={c.out} width={c.dur * zoom} left={c.start * zoom} view={view} height={H_AUDIO - 12} gain={(st.volume ?? 1) * own.volume} gainFn={gainFn} shapeKey={JSON.stringify([own.env, own.fadeIn, own.fadeOut])} />
                  {sel.has(sid) && (
                    <VolumeEdit
                      width={c.dur * zoom - 2}
                      height={H_AUDIO - 12}
                      dur={c.dur}
                      env={own.env || []}
                      fadeIn={own.fadeIn}
                      fadeOut={own.fadeOut}
                      toX={(s) => rel(s) * zoom}
                      toKey={(x) => (c.reverse ? c.out - (x / zoom) * sp : c.in + (x / zoom) * sp)}
                      onStart={() => dispatch({ type: 'checkpoint' })}
                      onChange={(patch, live) => dispatch({ type: 'setClipAudio', ids: [sid], patch, live })}
                    />
                  )}
                  <span>{m.name}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  const renderAudioTrack = (key) => {
    const t = state.audioTracks.find((x) => x.id === key.slice(2))
    if (!t) return null
    return (
      <div className={'tl-row' + rowClass(key)} key={key} ref={rowRef(key)} style={{ height: H_AUDIO }}>
        <RowLabel
          name={t.name}
          mute={t.mute}
          onMute={() => dispatch({ type: 'setTrack', id: t.id, patch: { mute: !t.mute } })}
          onRemove={() => dispatch({ type: 'removeAudioTrack', id: t.id })}
          onRename={(name) => dispatch({ type: 'renameRow', key, name })}
          onGrip={(e) => startRowDrag(e, key)}
          {...rowFlags(key)}
        />
        <div className="lane" onDragOver={(e) => hasMedia(e) && e.preventDefault()} onDrop={(e) => onAudioDrop(e, t.id)}>
          <div className="lane-inner" style={{ left: TRACK_PAD }}>
            {aclips
              .filter((a) => a.trackId === t.id)
              .map((a) => {
                const am = state.media.find((x) => x.id === a.mediaId)
                const gainFn = (s) => envAt(a.env, s) * fadeAt(s - a.in, a.dur, a.fadeIn || 0, a.fadeOut || 0)
                return (
                  <div
                    key={a.id}
                    data-sel={a.id}
                    className={'aclip' + (a.stream != null ? ' detached' : ' free') + (t.mute || a.mute ? ' muted' : '') + (sel.has(a.id) ? ' selected' : '') + (a.groupId ? ' grouped' : '')}
                    style={{ left: a.start * zoom, width: Math.max(6, a.dur * zoom), '--gcol': a.groupId ? groupColor(a.groupId) : undefined, '--lbl': labelColor(a) }}
                    onPointerDown={(e) => startMoveAudio(e, a)}
                    title={clipAudioName(a)}
                  >
                    <Wave file={audioSource(a, am)} from={a.in} to={a.out} width={Math.max(6, a.dur * zoom)} left={a.start * zoom} view={view} height={H_AUDIO - 12} gain={(t.volume ?? 1) * (a.volume ?? 1)} gainFn={gainFn} shapeKey={JSON.stringify([a.env, a.fadeIn, a.fadeOut])} />
                    {sel.has(a.id) && (
                      <VolumeEdit
                        width={Math.max(6, a.dur * zoom) - 2}
                        height={H_AUDIO - 12}
                        dur={a.dur}
                        env={a.env || []}
                        fadeIn={a.fadeIn || 0}
                        fadeOut={a.fadeOut || 0}
                        toX={(s) => (s - a.in) * zoom}
                        toKey={(x) => a.in + x / zoom}
                        onStart={() => dispatch({ type: 'checkpoint' })}
                        onChange={(patch, live) => dispatch({ type: 'setClipAudio', ids: [a.id], patch, live })}
                      />
                    )}
                    <div className="handle left" onPointerDown={(e) => startTrimAudio(e, a, 'in')} />
                    <span>{a.groupId && <Icon name="link" size={11} />}{clipAudioName(a)}</span>
                    <div className="handle right" onPointerDown={(e) => startTrimAudio(e, a, 'out')} />
                  </div>
                )
              })}
          </div>
        </div>
      </div>
    )
  }

  const renderRow = (key) => {
    if (key === 'main') return renderMain(key)
    if (key.startsWith('v:')) return renderOverlay(key)
    if (key.startsWith('s:')) return renderStream(key)
    return renderAudioTrack(key)
  }

  return (
    <div className="timeline" style={height ? { height } : undefined}>
      <div className="tl-toolbar">
        <span className="tb-group">
          <button disabled={!state.past.length} onClick={() => dispatch({ type: 'undo' })} title="Undo (Ctrl+Z)"><Icon name="undo" /></button>
          <button disabled={!state.future.length} onClick={() => dispatch({ type: 'redo' })} title="Redo (Ctrl+Y)"><Icon name="redo" /></button>
        </span>
        <span className="tb-group">
          <button onClick={() => dispatch({ type: 'split', t: state.playhead })} title={'Split at the playhead' + (splitKey ? ' (' + splitKey + ')' : '')}><Icon name="scissors" /></button>
          <button onClick={onFreeze} title={'Freeze: save the frame under the playhead as an image and insert it' + (freezeKey ? ' (' + freezeKey + ')' : '')}><Icon name="snowflake" /></button>
          <button disabled={!state.selection.length} onClick={() => dispatch({ type: 'deleteSelection', keepGap: !rippleOn })} title="Delete selected (Del)"><Icon name="trash" /></button>
        </span>
        <span className="tb-group">
          <button disabled={!state.selection.length} onClick={onCopy} title="Copy the selected clips (Ctrl+C)"><Icon name="copy" size={14} /></button>
          <button disabled={!hasClipboard()} onClick={() => dispatch({ type: 'paste', t: state.playhead })} title="Paste at the playhead (Ctrl+V). A new track is made if no track has room there."><Icon name="paste" size={14} /></button>
          <button disabled={!state.selection.length} onClick={() => dispatch({ type: 'duplicate' })} title="Duplicate the selected clips (Ctrl+D)"><Icon name="duplicate" size={14} /></button>
        </span>
        <span className="tb-group">
          <button disabled={!groupOk} onClick={() => dispatch({ type: 'group' })} title="Group the selected clips so they move together. Detached audio in the selection is attached back to its video."><Icon name="link" /></button>
          <button disabled={!ungroupOk} onClick={() => dispatch({ type: 'ungroup' })} title="Ungroup the selected group. With no group selected: detach the selected audio (or all the audio of a selected video clip) so it can be moved, trimmed or deleted on its own."><Icon name="unlink" /></button>
        </span>
        <span className="tb-group">
          <button onClick={() => dispatch({ type: 'addText', t: state.playhead })} title="Add text or a title at the playhead (T)"><Icon name="type" size={14} /> Text</button>
          <button onClick={onCaptions} title="Captions from speech: the words in your video become text clips (needs a one-time model download)"><Icon name="captions" size={14} /></button>
          <button className={'rec-btn' + (rec ? ' on' : '')} disabled={rec && rec.phase === 'saving'} onClick={onRecord} title="Record a voice-over from your microphone while the video plays (R). Use headphones so the microphone does not hear the project's sound.">
            <Icon name="mic" size={14} />
            {!rec ? '' : rec.phase === 'count' ? 'Starting in ' + rec.n + '…' : rec.phase === 'saving' ? 'Saving…' : 'Stop ' + fmtTime((performance.now() - rec.t0) / 1000).slice(0, 5)}
          </button>
          <button onClick={() => dispatch({ type: 'addMarker', t: state.playhead })} title="Put a marker at the playhead (M)"><Icon name="flag" size={14} /></button>
        </span>
        <span className="spacer" />
        <span className="tb-group">
          <button className={(snapOn ? 'on' : '') + (snapLine != null ? ' snapped' : '')} onClick={() => setSnapOn(!snapOn)} title={'Snapping is ' + (snapOn ? 'on' : 'off') + ': dragged clips stick to clip edges, markers and the playhead, and a line shows where (N)'}><Icon name="magnet" size={14} /></button>
          <button className={rippleOn ? 'on' : ''} onClick={() => setRippleOn(!rippleOn)} title={'Close gaps is ' + (rippleOn ? 'on: when you delete a clip, the clips after it slide back to fill the space' : 'off: when you delete a clip, the clips after it stay where they are and a gap is left') + ' (G)'}><Icon name="ripple" size={14} /></button>
          <button className={miniOn ? 'on' : ''} onClick={() => setMiniOn(!miniOn)} title="Show or hide the mini timeline (an overview of the whole project under the timeline)"><Icon name="map" size={14} /></button>
        </span>
        <span className="tb-group">
          <button onClick={() => setShowAdd(true)} title="Add an overlay video track or an audio track"><Icon name="plus" size={14} /> Track</button>
          <button onClick={fit} title="Zoom so the whole project fits (Shift+F)"><Icon name="fit" size={14} /></button>
          <label className="zoom" title="Zoom the timeline in and out">
            <input type="range" min="0" max="100" value={Math.round((100 * Math.log(Math.max(zoom, 0.2) / 0.2)) / Math.log(2000))} onChange={(e) => setZoom(0.2 * Math.pow(2000, +e.target.value / 100))} />
          </label>
          <button onClick={onKeybinds} title="Keyboard shortcuts"><Icon name="keyboard" /></button>
        </span>
      </div>

      <div className="tl-scroll" ref={scrollRef} onWheel={onWheel}>
        <div className="tl-inner" ref={innerRef} style={{ width }} onPointerDown={startMarquee}>
          {/* ruler: stays pinned to the top while you scroll through the tracks */}
          <div className="tl-row ruler-row" style={{ height: 26 }}>
            <div className="tl-label ruler-label" style={{ width: LABEL }} />
            <div className="lane ruler" ref={trackRef} onPointerDown={scrub}>
              <div className="lane-inner" style={{ left: TRACK_PAD }}>
                {ticks.map((s) => (
                  <div key={s} className="tick" style={{ left: s * zoom }}>
                    <span>{fmtTime(s).slice(0, 5)}</span>
                  </div>
                ))}
                <div className="ruler-knob" style={{ left: Math.min(state.playhead, total + 15) * zoom }} />
                {state.markers.map((m) => (
                  <div key={m.id} className="marker" style={{ left: m.t * zoom }} onPointerDown={(e) => startMarkerDrag(e, m)} onDoubleClick={() => setEditMarker(m.id)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); dispatch({ type: 'removeMarker', id: m.id }) }} title="Marker: click to jump, drag to move, double-click to name it, right-click to delete">
                    <Icon name="flag" size={12} />
                    {editMarker === m.id ? (
                      <input
                        autoFocus
                        defaultValue={m.label}
                        onBlur={(e) => {
                          dispatch({ type: 'renameMarker', id: m.id, label: e.target.value })
                          setEditMarker(null)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === 'Escape') e.target.blur()
                        }}
                      />
                    ) : (
                      m.label && <span>{m.label}</span>
                    )}
                    <button className="marker-x" onClick={() => dispatch({ type: 'removeMarker', id: m.id })} title="Remove this marker">×</button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {keys.map(renderRow)}

          {state.markers.map((m) => (
            <div key={'ml' + m.id} className="marker-line" style={{ left: LABEL + TRACK_PAD + m.t * zoom }} />
          ))}
          {snapLine != null && <div key={snapLine.toFixed(3)} className="snap-line" style={{ left: LABEL + TRACK_PAD + snapLine * zoom }}><span>{fmtTime(snapLine)}</span></div>}
          <div className="playhead" style={{ left: LABEL + TRACK_PAD + Math.min(state.playhead, total + 15) * zoom }} />
          {marquee && (
            <div
              className="marquee"
              style={{
                left: Math.min(marquee.x0, marquee.x1),
                top: Math.min(marquee.y0, marquee.y1),
                width: Math.abs(marquee.x1 - marquee.x0),
                height: Math.abs(marquee.y1 - marquee.y0),
              }}
            />
          )}
        </div>
      </div>

      {miniOn && <MiniMap rows={miniRows} markers={state.markers} total={total} playhead={state.playhead} zoom={zoom} scrollRef={scrollRef} labelW={LABEL} pad={TRACK_PAD} />}

      {showAdd && (
        <div className="modal-bg" onPointerDown={() => setShowAdd(false)}>
          <div className="modal add-track" onPointerDown={(e) => e.stopPropagation()}>
            <h3>Add a track</h3>
            <div className="add-choices">
              <button
                onClick={() => {
                  dispatch({ type: 'addVideoTrack', id: uid() })
                  setShowAdd(false)
                }}
              >
                <Icon name="film" size={22} />
                <b>Video track</b>
              </button>
              <button
                onClick={() => {
                  dispatch({ type: 'addAudioTrack', id: uid() })
                  setShowAdd(false)
                }}
              >
                <Icon name="music" size={22} />
                <b>Audio track</b>
              </button>
            </div>
            <div className="modal-foot">
              <button onClick={() => setShowAdd(false)}>Cancel</button>
              <span />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
