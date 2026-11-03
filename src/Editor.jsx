import { useEffect, useReducer, useRef, useState } from 'react'
import { reducer, initialState, layout, projectDuration, fmtTime, toUrl, copySelection, srcAt, ASPECTS, uid } from './state.js'
import Preview from './Preview.jsx'
import Timeline from './Timeline.jsx'
import KeybindDialog from './KeybindDialog.jsx'
import HistoryDialog from './HistoryDialog.jsx'
import CaptionDialog from './CaptionDialog.jsx'
import { openMicrophone } from './audioDevices.js'
import TranscriptDialog from './TranscriptDialog.jsx'
import Inspector from './Inspector.jsx'
import LibraryPanel from './LibraryPanel.jsx'
import Icon from './Icon.jsx'
import { serialize, restore } from './project.js'
import { actionFor } from './keybinds.js'
import Tour, { tourSeen, markTourSeen } from './Tour.jsx'
import { VIDEO_STEPS } from './tourSteps.js'

// One open project. Several of these can exist at once (one per tab); only the active one is shown
// and reacts to the keyboard, the others keep their state and wait.
export default function Editor({ tabId, active, initial, binds, setBinds, onMeta, onNew, onOpen, onExport, onOpenColour, onOpenJson, registerHandle }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const stateRef = useRef(state)
  stateRef.current = state
  const activeRef = useRef(active)
  activeRef.current = active
  const [zoom, setZoom] = useState(80)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [transitions, setTransitions] = useState([])
  const [trErrors, setTrErrors] = useState({})
  const loadTransitions = async () => setTransitions(await window.api.listTransitions())
  useEffect(() => {
    loadTransitions()
  }, [])
  const [showKeys, setShowKeys] = useState(false)
  const [projectPath, setProjectPath] = useState(null)
  const projectRef = useRef(null)
  projectRef.current = projectPath
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const savedJson = useRef(serialize(initialState)) // what is on disk (or the empty project)
  const autosavedJson = useRef('')
  const projectName = projectPath ? projectPath.split(/[\\/]/).pop().replace(/\.json$/i, '') : 'Untitled'
  const total = projectDuration(state)
  const [miniOn, setMiniOnState] = useState(() => {
    try {
      return localStorage.getItem('vibe.minimap') === '1' // off until you turn it on
    } catch {
      return false
    }
  })
  const setMiniOn = (v) => {
    setMiniOnState(v)
    try {
      localStorage.setItem('vibe.minimap', v ? '1' : '0')
    } catch {}
  }
  const fitRef = useRef(null) // set by the timeline: zooms to fit the whole project
  const [snapOn, setSnapOnState] = useState(() => {
    try {
      return localStorage.getItem('vibe.snap') !== '0'
    } catch {
      return true
    }
  })
  const setSnapOn = (v) => {
    setSnapOnState(v)
    try {
      localStorage.setItem('vibe.snap', v ? '1' : '0')
    } catch {}
  }
  // deleting a clip: the clips after it slide back (on), or stay where they are and leave a gap (off)
  const [rippleOn, setRippleOnState] = useState(() => {
    try {
      return localStorage.getItem('vibe.ripple') !== '0'
    } catch {
      return true
    }
  })
  const setRippleOn = (v) => {
    setRippleOnState(v)
    try {
      localStorage.setItem('vibe.ripple', v ? '1' : '0')
    } catch {}
    flash(v ? 'Close gaps on: the clips after a deleted clip slide back.' : 'Close gaps off: a deleted clip leaves a gap.')
  }
  const [mode, setMode] = useState('transform') // what is drawn over the preview: 'transform' box, 'warp' handles or 'none'
  const [freeMode, setFreeMode] = useState(false) // Free transform: corners stretch instead of resize
  const flag = (key) => {
    try {
      return localStorage.getItem(key) !== '0'
    } catch {
      return true
    }
  }
  const [binOpen, setBinOpenState] = useState(() => flag('vibe.binOpen'))
  const [inspOpen, setInspOpenState] = useState(() => flag('vibe.inspOpen'))
  const [libOpen, setLibOpenState] = useState(() => {
    try {
      return localStorage.getItem('vibe.libOpen') === '1' // folded away until you open it
    } catch {
      return false
    }
  })
  const setLibOpen = (v) => {
    setLibOpenState(v)
    try {
      localStorage.setItem('vibe.libOpen', v ? '1' : '0')
    } catch {}
  }
  const setBinOpen = (v) => {
    setBinOpenState(v)
    try {
      localStorage.setItem('vibe.binOpen', v ? '1' : '0')
    } catch {}
  }
  const setInspOpen = (v) => {
    setInspOpenState(v)
    try {
      localStorage.setItem('vibe.inspOpen', v ? '1' : '0')
    } catch {}
  }

  // Add imported files to the project, then prepare their audio streams in the background.
  const extractPending = (items) => {
    for (const it of items) {
      window.api.extractAudio(it.path, it.id, it.audioStreams).then((files) => dispatch({ type: 'updateMedia', id: it.id, patch: { audioFiles: files, audioPending: false } }))
    }
  }
  const addMedia = (items) => {
    const fresh = items.filter((i) => !stateRef.current.media.some((m) => m.id === i.id))
    dispatch({ type: 'addMedia', items })
    extractPending(fresh.filter((i) => i.audioPending))
  }

  if (active) window.__vibe = { dispatch, state, addMedia, historyKey: () => historyKey() } // used by the developer self-test

  const flash = (msg) => {
    setNote(msg)
    setTimeout(() => setNote((n) => (n === msg ? '' : n)), 3500)
  }

  // a project that is not on screen must not keep playing
  useEffect(() => {
    if (!active) dispatch({ type: 'setPlaying', value: false })
  }, [active])

  const importFiles = async (kind) => {
    setBusy(true)
    try {
      const items = await window.api.importMedia(kind)
      if (items.length) addMedia(items)
    } finally {
      setBusy(false)
    }
  }

  // dropping files from Explorer onto the window
  const onDropFiles = async (e) => {
    if (!e.dataTransfer.files.length) return
    e.preventDefault()
    const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f))
    setBusy(true)
    try {
      const items = await window.api.describeFiles(paths)
      if (items.length) addMedia(items)
    } finally {
      setBusy(false)
    }
  }

  // Freeze frame: save the exact frame under the playhead as an image and insert it.
  const freezeFrame = async () => {
    const s = stateRef.current
    const lay = layout(s.clips)
    const t = s.playhead
    const hit = lay.filter((c) => t >= c.start && t < c.start + c.dur)
    const c = hit.length ? hit[hit.length - 1] : lay[lay.length - 1]
    const m = c && s.media.find((x) => x.id === c.mediaId)
    if (!m || m.type !== 'video') return flash('Move the playhead over a video clip to freeze a frame.')
    const src = Math.max(0, Math.min(srcAt(c, t), c.out - 0.01))
    setBusy(true)
    try {
      const item = await window.api.freezeFrame(m.path, src, `Freeze ${m.name} @${fmtTime(src).slice(0, 5)}`)
      dispatch({ type: 'insertFreeze', item, t })
      flash('Frame frozen. Drag its right edge (or use "Show for") to make it longer.')
    } catch {
      flash('Could not capture that frame.')
    } finally {
      setBusy(false)
    }
  }

  // ---- saving, opening, autosave
  const rememberRecent = (file, s) => {
    const first = s.clips.map((c) => s.media.find((m) => m.id === c.mediaId)).find((m) => m && m.thumb)
    window.api.recentAdd({ path: file, name: file.split(/[\\/]/).pop().replace(/\.json$/i, ''), kind: 'video', thumb: first ? first.thumb : null, clips: s.clips.length, duration: projectDuration(s) })
  }

  const loadFromJson = async (json, file) => {
    setBusy(true)
    try {
      const r = await restore(json)
      dispatch({ type: 'loadProject', media: r.media, clips: r.clips, audioClips: r.audioClips, audioTracks: r.audioTracks, streamSettings: r.streamSettings, transcripts: r.transcripts, overlayClips: r.overlayClips, videoTracks: r.videoTracks, mainName: r.mainName, rowOrder: r.rowOrder, markers: r.markers, lockedRows: r.lockedRows, hiddenRows: r.hiddenRows, aspect: r.aspect })
      setProjectPath(file)
      // a project opened from a file starts "clean"; one restored from autosave still needs saving
      savedJson.current = file ? serialize(r) : serialize(initialState)
      autosavedJson.current = ''
      extractPending(r.pending)
      if (file) rememberRecent(file, r)
      if (r.missing.length) flash(`Some files could not be found: ${r.missing.join(', ')}`)
      else flash(file ? 'Project opened.' : 'Previous session restored.')
    } catch (e) {
      window.alert('Could not open that project:\n' + (e.message || e))
    } finally {
      setBusy(false)
    }
  }

  // version history: a copy of the project is kept on every save and every few minutes of work
  const [showHistory, setShowHistory] = useState(false)
  const lastSnap = useRef(0)
  const historyKey = () => projectRef.current || 'tab:' + tabId
  const snapshot = (label, json) => {
    lastSnap.current = Date.now()
    window.api.historyAdd({ key: historyKey(), json: json || serialize(stateRef.current), label }).catch(() => {})
  }
  const restoreJson = async (json) => {
    snapshot('Before restoring an older version')
    setBusy(true)
    try {
      const r = await restore(json)
      dispatch({ type: 'loadProject', media: r.media, clips: r.clips, audioClips: r.audioClips, audioTracks: r.audioTracks, streamSettings: r.streamSettings, transcripts: r.transcripts, overlayClips: r.overlayClips, videoTracks: r.videoTracks, mainName: r.mainName, rowOrder: r.rowOrder, markers: r.markers, lockedRows: r.lockedRows, hiddenRows: r.hiddenRows, aspect: r.aspect })
      extractPending(r.pending)
      setShowHistory(false)
      flash('Older version restored. Save to keep it.')
    } catch (e) {
      window.alert('Could not restore that version:\n' + (e.message || e))
    } finally {
      setBusy(false)
    }
  }

  const saveProject = async (asNew, to) => {
    const s = stateRef.current
    const json = serialize(s)
    const file = await window.api.saveProject(to || (asNew ? null : projectRef.current), json, `${projectName === 'Untitled' ? 'My project' : projectName}.json`)
    if (!file) return false
    setProjectPath(file)
    savedJson.current = json
    setDirty(false)
    window.api.clearAutosave(tabId)
    rememberRecent(file, s)
    window.api.historyAdd({ key: file, json, label: 'Saved' }).catch(() => {})
    lastSnap.current = Date.now()
    flash('Project saved.')
    return true
  }

  // load the project this tab was opened with
  useEffect(() => {
    if (initial && initial.json) loadFromJson(initial.json, initial.file)
  }, [])

  // let the tab bar ask this project to save (when closing a tab)
  useEffect(() => {
    registerHandle(tabId, { kind: 'video', save: () => saveProject(false), saveAs: (to) => saveProject(false, to), isDirty: () => dirtyRef.current, getState: () => stateRef.current, dispatch, addMedia, live: () => liveRef.current })
    return () => registerHandle(tabId, null)
  }, [])

  // tell the tab bar about the project's name and whether it has unsaved changes
  useEffect(() => {
    onMeta(tabId, { title: projectName, path: projectPath, dirty })
  }, [projectName, projectPath, dirty])

  // work out whether there are unsaved changes
  useEffect(() => {
    const t = setTimeout(() => setDirty(serialize(state) !== savedJson.current), 600)
    return () => clearTimeout(t)
  }, [state.media, state.clips, state.audioClips, state.audioTracks, state.streamSettings, state.overlayClips, state.videoTracks, state.mainName, state.rowOrder, state.markers, state.lockedRows, state.hiddenRows, state.aspect, projectPath])

  // autosave every 15 seconds: into the project file if it has one, otherwise a recovery copy
  useEffect(() => {
    const id = setInterval(async () => {
      const json = serialize(stateRef.current)
      if (json === savedJson.current) return
      if (Date.now() - lastSnap.current > 3 * 60 * 1000) snapshot('Automatic copy', json)
      if (projectRef.current) {
        await window.api.saveProject(projectRef.current, json)
        savedJson.current = json
        setDirty(false)
      } else if (json !== autosavedJson.current) {
        await window.api.autosave(tabId, json)
        autosavedJson.current = json
      }
    }, 15000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const onKey = (e) => {
      if (!activeRef.current) return
      const tag = e.target.tagName
      // sliders, colour boxes and tick boxes keep the focus after a click: shortcuts must still work then
      const typing = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !['range', 'checkbox', 'color', 'radio', 'button'].includes(e.target.type))
      if (showKeys || typing) return
      const action = actionFor(binds, e)
      if (!action) return
      e.preventDefault()
      const h = {
        split: () => dispatch({ type: 'split', t: state.playhead }),
        freeze: freezeFrame,
        playPause: () => dispatch({ type: 'setPlaying', value: !state.playing }),
        delete: () => dispatch({ type: 'deleteSelection', keepGap: !rippleOn }),
        text: () => dispatch({ type: 'addText', t: state.playhead }),
        record: () => startRecording(),
        copy: () => doCopy(),
        paste: () => dispatch({ type: 'paste', t: state.playhead }),
        duplicate: () => dispatch({ type: 'duplicate' }),
        marker: () => dispatch({ type: 'addMarker', t: state.playhead }),
        snap: () => setSnapOn(!snapOn),
        ripple: () => setRippleOn(!rippleOn),
        fit: () => fitRef.current && fitRef.current(),
        group: () => dispatch({ type: 'group' }),
        ungroup: () => dispatch({ type: 'ungroup' }),
        save: () => saveProject(false),
        saveAs: () => saveProject(true),
        open: onOpen,
        undo: () => dispatch({ type: 'undo' }),
        redo: () => dispatch({ type: 'redo' }),
        stepBack: () => dispatch({ type: 'setPlayhead', t: state.playhead - 1 / 30, user: true }),
        stepForward: () => dispatch({ type: 'setPlayhead', t: Math.min(total, state.playhead + 1 / 30), user: true }),
        goStart: () => dispatch({ type: 'setPlayhead', t: 0, user: true }),
      }
      if (h[action]) h[action]()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state.playing, state.playhead, total, binds, showKeys, snapOn, rippleOn])

  const doCopy = () => {
    const n = copySelection(stateRef.current)
    flash(n ? `Copied ${n} clip${n === 1 ? '' : 's'}. Press Ctrl+V to paste at the playhead.` : 'Select a clip first, then copy it.')
  }

  // ---- voice-over: record from the microphone while the project plays, then the recording becomes an audio clip
  const recRef = useRef(null) // {mr, stream, startAt}
  const cancelCount = useRef(false)
  const [rec, setRec] = useState(null) // null | {phase: 'count', n} | {phase: 'rec', t0} | {phase: 'saving'}
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!rec || rec.phase !== 'rec') return
    const id = setInterval(() => setTick((n) => n + 1), 500)
    return () => clearInterval(id)
  }, [rec && rec.phase])
  const stopRecording = () => {
    const r = recRef.current
    if (r) {
      recRef.current = null
      dispatch({ type: 'setPlaying', value: false })
      r.mr.stop()
    } else if (rec && rec.phase === 'count') {
      cancelCount.current = true
    }
  }
  const startRecording = async () => {
    if (recRef.current || rec) return stopRecording()
    let stream
    try {
      stream = await openMicrophone() // the microphone chosen in Settings
    } catch {
      return flash('Could not use the microphone. In Windows open Settings > Privacy & security > Microphone and allow desktop apps to use it.')
    }
    cancelCount.current = false
    for (let n = 3; n > 0 && !cancelCount.current; n--) {
      setRec({ phase: 'count', n })
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (cancelCount.current) {
      stream.getTracks().forEach((t) => t.stop())
      setRec(null)
      return
    }
    const startAt = stateRef.current.playhead
    const chunks = []
    const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      setRec({ phase: 'saving' })
      try {
        const buf = await new Blob(chunks, { type: 'audio/webm' }).arrayBuffer()
        const file = await window.api.saveVoiceOver(buf)
        const [item] = await window.api.describeFiles([file])
        addMedia([item])
        let track = stateRef.current.audioTracks.find((x) => x.name === 'Voice-over')
        let tid = track && track.id
        if (!tid) {
          tid = uid()
          dispatch({ type: 'addAudioTrack', id: tid })
          dispatch({ type: 'renameRow', key: 'a:' + tid, name: 'Voice-over' })
        }
        dispatch({ type: 'addAudioClip', mediaId: item.id, trackId: tid, start: startAt })
        flash('Voice-over added. It is saved in Documents > Vibe Editing Suite Projects > Voice-overs.')
      } catch {
        flash('The recording could not be saved.')
      }
      setRec(null)
    }
    recRef.current = { mr, stream, startAt }
    mr.start()
    setRec({ phase: 'rec', t0: performance.now() })
    dispatch({ type: 'setPlaying', value: true })
  }

  // what the AI connection works with (fresh on every render)
  const liveRef = useRef(null)
  liveRef.current = {
    freezeFrame,
    startRecording,
    stopRecording,
    recording: !!rec,
    snapOn,
    setSnapOn,
    rippleOn,
    setRippleOn,
    restoreJson,
    historyKey,
    reloadTransitions: loadTransitions,
  }

  // take a file out of this project (the file itself on the computer is not touched)
  const removeMedia = (m) => {
    const n = [...state.clips, ...state.overlayClips, ...state.audioClips].filter((c) => c.mediaId === m.id).length
    const nl = '\n\n'
    const msg = n
      ? `"${m.name}" is used ${n} time${n === 1 ? '' : 's'} on the timeline. Remove it from the project and delete those clips too?${nl}This cannot be undone. The file itself on your computer is not touched.`
      : `Remove "${m.name}" from this project?${nl}The file itself on your computer is not touched.`
    if (window.confirm(msg)) dispatch({ type: 'removeMedia', id: m.id })
  }
  const addMediaToTimeline = (m) => {
    if (m.type === 'audio') dispatch({ type: 'addAudioClip', mediaId: m.id, trackId: null, start: state.playhead })
    else dispatch({ type: 'addClip', mediaId: m.id })
  }

  // the timeline's height: drag the bar above it (the preview and the panels get smaller to make room); remembered
  const [tlHeight, setTlHeightState] = useState(() => {
    try {
      const v = +localStorage.getItem('vibe.tlHeight')
      return v >= 140 ? v : 340
    } catch {
      return 340
    }
  })
  const setTlHeight = (h) => {
    const v = Math.round(Math.max(140, Math.min(h, window.innerHeight - 260)))
    setTlHeightState(v)
    try {
      localStorage.setItem('vibe.tlHeight', String(v))
    } catch {}
  }
  const startResize = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const y0 = e.clientY
    const h0 = tlHeight
    const move = (ev) => setTlHeight(h0 + (y0 - ev.clientY))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'ns-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const [showCaptions, setShowCaptions] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)
  // smooth preview copies of big videos are made in the background: show how far they are, use them once they exist
  const [proxyPct, setProxyPct] = useState({})
  useEffect(
    () =>
      window.api.onProxy((d) => {
        if (d.path || d.failed) {
          if (d.path) dispatch({ type: 'updateMedia', id: d.id, patch: { proxy: d.path, proxyPending: false } })
          else dispatch({ type: 'updateMedia', id: d.id, patch: { proxyPending: false } })
          setProxyPct((p) => {
            const n = { ...p }
            delete n[d.id]
            return n
          })
        } else setProxyPct((p) => ({ ...p, [d.id]: d.pct }))
      }),
    []
  )

  // (a safety net: also look now and then whether a copy that was announced before this project was listening is ready)
  const pendingKey = state.media.filter((m) => m.proxyPending && !m.proxy).map((m) => m.id).join(',')
  useEffect(() => {
    if (!pendingKey) return
    const ids = pendingKey.split(',')
    const tick = async () => {
      const found = await window.api.proxyStatus(ids)
      for (const [id, path] of Object.entries(found)) if (path) dispatch({ type: 'updateMedia', id, patch: { proxy: path, proxyPending: false } })
    }
    tick()
    const t = setInterval(tick, 2500)
    return () => clearInterval(t)
  }, [pendingKey])

  // the tutorial: shown by itself the first time the video editor is opened, and again from the Tutorial button
  const appRef = useRef(null)
  const [tour, setTour] = useState(false)
  useEffect(() => {
    if (!active || tourSeen('video')) return
    let dead = false
    const t = setTimeout(async () => {
      if (dead || (await window.api.isTest())) return
      setTour(true)
    }, 900)
    return () => {
      dead = true
      clearTimeout(t)
    }
  }, [active])
  const closeTour = () => {
    markTourSeen('video')
    setTour(false)
  }

  return (
    <div className="app" ref={appRef} style={{ display: active ? undefined : 'none' }} onDragOver={(e) => e.preventDefault()} onDrop={onDropFiles}>
      <header className="topbar">
        <span className="tb-group">
          <button onClick={onNew} title="Start another project in a new tab">New</button>
          <button onClick={onOpen} title="Open a project in a new tab">Open…</button>
        </span>
        <span className="tb-group">
          <button onClick={() => saveProject(false)} title="Save (Ctrl+S)">Save</button>
          <button onClick={() => saveProject(true)}>Save as…</button>
          <button onClick={() => setShowHistory(true)} title="Version history: earlier copies of this project"><Icon name="history" size={14} /></button>
        </span>
        <span className="proj-name">{projectName}{dirty ? ' •' : ''}</span>
        <select className="aspect-select" value={state.aspect} onChange={(e) => dispatch({ type: 'setAspect', aspect: e.target.value })} title="The shape of your video: landscape, vertical (phones), square and more">
          {ASPECTS.map((x) => (
            <option key={x.id} value={x.id}>{x.label}</option>
          ))}
        </select>
        <span className="spacer" />
        <button onClick={() => setTour(true)} title="Tutorial: a short tour of the main features"><Icon name="help" size={15} /></button>
        <button className="primary" onClick={() => onExport()} disabled={!state.clips.length && !state.overlayClips.length}>
          <Icon name="upload" /> Export video…
        </button>
      </header>
      <div className="top">
        <aside className={'bin' + (binOpen ? '' : ' collapsed')}>
          {!binOpen && (
            <button className="collapse-strip" onClick={() => setBinOpen(true)} title="Show the media panel">
              <Icon name="right" size={14} />
              <span>Media</span>
            </button>
          )}
          <div className="panel-title">
            <span className="title-left">
              <button className="mini" onClick={() => setBinOpen(false)} title="Hide the media panel"><Icon name="left" size={12} /></button>
              Media
            </span>
            <span className="btn-row">
              <button className="primary" onClick={() => importFiles('video')} disabled={busy}>
                {busy ? 'Working…' : '+ Video / image'}
              </button>
              <button onClick={() => importFiles('audio')} disabled={busy} title="Import extra audio files (music, voice, sound effects)">
                + Audio
              </button>
            </span>
          </div>
          <div className="bin-list">
            {state.media.length === 0 && <div className="empty-box"><Icon name="film" size={26} /><span>Import video, images or audio, or drop files here.</span></div>}
            {state.media.map((m) => (
              <div
                key={m.id}
                className="bin-item"
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/vibe-media', m.id)}
                onDoubleClick={() => addMediaToTimeline(m)}
                title={m.type === 'audio' ? 'Drag onto an audio track, or double-click to add at the playhead' : 'Drag to the timeline, or double-click to add at the end'}
              >
                <div className="thumb" style={{ backgroundImage: m.thumb ? `url("${toUrl(m.thumb)}")` : undefined }}>
                  {m.type === 'audio' && <span className="note"><Icon name="music" size={22} /></span>}
                  <span className="badge">{m.type}</span>
                </div>
                <button className="bin-x" title="Remove from this project" onClick={(e) => { e.stopPropagation(); removeMedia(m) }}>×</button>
                <div className="meta">
                  <div className="name">{m.name}</div>
                  <div className="sub">
                    {m.type !== 'image' ? fmtTime(m.duration).slice(0, 5) : ''}
                    {m.type === 'video' || m.type === 'image' ? ` · ${m.width}×${m.height}` : ''}
                    {m.type === 'video' && m.audioStreams.length ? ` · ${m.audioStreams.length} audio` : ''}
                    {m.audioPending ? ' · preparing audio…' : ''}
                    {proxyPct[m.id] != null ? ` · smooth copy ${proxyPct[m.id]}%` : m.proxy ? ' · smooth copy' : m.proxyPending ? ' · smooth copy queued' : ''}
                    {m.missing ? ' · file missing' : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </aside>

        <LibraryPanel
          open={libOpen}
          setOpen={setLibOpen}
          onAddMedia={addMedia}
          usedPaths={state.media.map((m) => m.path)}
          onUse={(m) => {
            addMedia([m])
            addMediaToTimeline(m)
          }}
        />

        <main className="stage">
          <Preview state={state} dispatch={dispatch} transitions={transitions} onCompiled={setTrErrors} active={active} mode={mode} setMode={setMode} freeMode={freeMode} />
          <div className="transport">
            <button onClick={() => dispatch({ type: 'setPlayhead', t: 0, user: true })} title="Go to start"><Icon name="skipBack" fill /></button>
            <button className="primary play" onClick={() => dispatch({ type: 'setPlaying', value: !state.playing })}>
              {state.playing ? <><Icon name="pause" fill /> Pause</> : <><Icon name="play" fill /> Play</>}
            </button>
            <span className="timecode">
              {fmtTime(state.playhead)} / {fmtTime(total)}
            </span>
          </div>
          <div className="note-line">{note}</div>
        </main>

        <Inspector
          state={state}
          dispatch={dispatch}
          transitions={transitions}
          errors={trErrors}
          onReload={loadTransitions}
          onOpenFolder={() => window.api.openTransitionsFolder()}
          mode={mode}
          setMode={setMode}
          freeMode={freeMode}
          setFreeMode={setFreeMode}
          open={inspOpen}
          setOpen={setInspOpen}
          onOpenColour={onOpenColour}
        />
      </div>

      <div className="tl-split" onPointerDown={startResize} onDoubleClick={() => setTlHeight(340)} title="Drag up or down to make the timeline bigger or smaller (double-click to reset)" />
      <Timeline
        onCaptions={() => setShowCaptions(true)}
        height={tlHeight}
        state={state}
        dispatch={dispatch}
        zoom={zoom}
        setZoom={setZoom}
        splitKey={binds.split}
        freezeKey={binds.freeze}
        groupKey={binds.group}
        ungroupKey={binds.ungroup}
        onFreeze={freezeFrame}
        snapOn={snapOn}
        setSnapOn={setSnapOn}
        rippleOn={rippleOn}
        setRippleOn={setRippleOn}
        onCopy={doCopy}
        fitRef={fitRef}
        rec={rec}
        onRecord={startRecording}
        miniOn={miniOn}
        setMiniOn={setMiniOn}
        onKeybinds={() => setShowKeys(true)}
      />
      {showHistory && <HistoryDialog projectKey={historyKey()} onClose={() => setShowHistory(false)} onRestore={restoreJson} onOpenNew={(json) => {
        setShowHistory(false)
        onOpenJson(json)
      }} />}
      {showKeys && <KeybindDialog binds={binds} setBinds={setBinds} onClose={() => setShowKeys(false)} />}
      {showCaptions && <CaptionDialog state={state} dispatch={dispatch} onClose={() => setShowCaptions(false)} onEditByText={() => { setShowCaptions(false); setShowTranscript(true) }} />}
      {showTranscript && <TranscriptDialog state={state} dispatch={dispatch} onClose={() => setShowTranscript(false)} />}
      {tour && active && (
        <Tour
          steps={VIDEO_STEPS}
          rootRef={appRef}
          onClose={closeTour}
          onStep={(step) => {
            // the tour picks a clip so the Inspector has something to show ('second' = one that has a clip before it, for Transition)
            const lay = layout(state.clips)
            const want = step.select === 'second' ? lay[1] || lay[0] : lay[0]
            if (want) dispatch({ type: 'select', id: want.id })
          }}
        />
      )}
    </div>
  )
}
