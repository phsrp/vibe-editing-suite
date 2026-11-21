import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { makeNest, updateNest } from './nest.js'
import Meter from './Meter.jsx'
import { MenuBar, ContextMenu } from './Menu.jsx'
import SourceDialog from './SourceDialog.jsx'
import { reducer, initialState, layout, projectDuration, fmtTime, toUrl, copySelection, srcAt, ASPECTS, uid, markRange, sourceRange, canGroup, canUngroup, hasClipboard, soleVideoClip } from './state.js'
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
export default function Editor({ tabId, active, initial, binds, setBinds, onMeta, onNew, onOpen, onExport, onOpenColour, onOpenJson, registerHandle, outerHandle, onSettings }) {
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
  const tlApi = useRef(null) // set by the timeline: {fit, addTrack, trackHeights} for the menus
  const [ctx, setCtx] = useState(null) // the right-click menu on the timeline: {x, y, id, onRuler}
  const closeCtx = useCallback(() => setCtx(null), [])
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

  // ---- nesting: a nest of the selected clips; a nest opens in its own tab; there, Save (Ctrl+S) = Update the nest
  const nestOf = initial && initial.nestOf // {tabId, mediaId, name}: this tab is the inside of that project's nest
  const [nestMedia, setNestMedia] = useState(nestOf ? nestOf.mediaId : null) // (the nest gets a new file each update)
  const nestMediaRef = useRef(nestMedia)
  nestMediaRef.current = nestMedia
  const doNest = () =>
    makeNest({ getState: () => stateRef.current, dispatch, ids: stateRef.current.selection })
      .then(() => flash('Nested: the clips are one clip now. Double-click it (or use Open the nest) to change what is inside.'))
      .catch((e) => flash(/cancel/i.test(e.message) ? 'Nesting cancelled.' : e.message))
  const openNest = (mediaId) => {
    const m = stateRef.current.media.find((x) => x.id === mediaId)
    if (!m || !m.nest) return
    onOpenJson(m.nest.json, { mediaId, name: m.nest.name || m.name })
  }
  const updateThisNest = async () => {
    const outer = outerHandle && outerHandle()
    if (!outer) {
      flash('The project this nest belongs to is closed, so the nest cannot be updated from here.')
      return false
    }
    try {
      const id = await updateNest({ outer, mediaId: nestMediaRef.current, innerState: stateRef.current })
      setNestMedia(id)
      savedJson.current = serialize(stateRef.current)
      setDirty(false)
      flash('The nest is updated in the project.')
      return true
    } catch (e) {
      flash(/cancel/i.test(e.message) ? 'Update cancelled.' : 'The nest could not be updated: ' + e.message)
      return false
    }
  }
  const [tool, setTool] = useState('select') // the timeline tool: select | ripple | roll | slip | slide
  const [showSource, setShowSource] = useState(null) // the media item open in the source viewer (to mark the part to use)
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
      dispatch({ type: 'loadProject', media: r.media, clips: r.clips, audioClips: r.audioClips, audioTracks: r.audioTracks, streamSettings: r.streamSettings, transcripts: r.transcripts, overlayClips: r.overlayClips, videoTracks: r.videoTracks, mainName: r.mainName, rowOrder: r.rowOrder, markers: r.markers, lockedRows: r.lockedRows, hiddenRows: r.hiddenRows, aspect: r.aspect, rowH: r.rowH, mark: r.mark })
      setProjectPath(file)
      // a project opened from a file starts "clean"; one restored from autosave still needs saving
      savedJson.current = file || (initial && initial.nestOf) ? serialize(r) : serialize(initialState)
      autosavedJson.current = ''
      extractPending(r.pending)
      if (file) rememberRecent(file, r)
      if (r.missing.length) flash(`Some files could not be found: ${r.missing.join(', ')}`)
      else flash(file ? 'Project opened.' : initial && initial.nestOf ? 'Inside the nest. Change what you like, then press Update the nest.' : 'Previous session restored.')
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
    window.api.historyAdd({ key: historyKey(), json: json || serialize(stateRef.current), label, seconds: projectDuration(stateRef.current) }).catch(() => {})
  }
  const restoreJson = async (json) => {
    snapshot('Before restoring an older version')
    setBusy(true)
    try {
      const r = await restore(json)
      dispatch({ type: 'loadProject', media: r.media, clips: r.clips, audioClips: r.audioClips, audioTracks: r.audioTracks, streamSettings: r.streamSettings, transcripts: r.transcripts, overlayClips: r.overlayClips, videoTracks: r.videoTracks, mainName: r.mainName, rowOrder: r.rowOrder, markers: r.markers, lockedRows: r.lockedRows, hiddenRows: r.hiddenRows, aspect: r.aspect, rowH: r.rowH, mark: r.mark })
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
    if (nestOf && !asNew && !to) return updateThisNest()
    const s = stateRef.current
    const json = serialize(s)
    const file = await window.api.saveProject(to || (asNew ? null : projectRef.current), json, `${projectName === 'Untitled' ? 'My project' : projectName}.json`)
    if (!file) return false
    setProjectPath(file)
    savedJson.current = json
    setDirty(false)
    window.api.clearAutosave(tabId)
    rememberRecent(file, s)
    window.api.historyAdd({ key: file, json, label: 'Saved', seconds: projectDuration(s) }).catch(() => {})
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
    registerHandle(tabId, { kind: 'video', save: () => saveProject(false), saveAs: (to) => saveProject(false, to), isDirty: () => serialize(stateRef.current) !== savedJson.current, getState: () => stateRef.current, dispatch, addMedia, live: () => liveRef.current })
    return () => registerHandle(tabId, null)
  }, [])

  // tell the tab bar about the project's name and whether it has unsaved changes
  useEffect(() => {
    onMeta(tabId, { title: nestOf && !projectPath ? (nestOf.name || 'Nest') + ' (inside)' : projectName, path: projectPath, dirty })
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
      if (showKeys || showSource || typing) return
      if (e.key && e.key.toLowerCase() === 'k' && !e.ctrlKey && !e.altKey) kDown.current = true
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
        toolSelect: () => setTool('select'),
        toolRipple: () => setTool('ripple'),
        toolRoll: () => setTool('roll'),
        toolSlip: () => setTool('slip'),
        toolSlide: () => setTool('slide'),
        shuttleBack: () => (kDown.current ? stepFrame(-1) : dispatch({ type: 'shuttle', dir: -1 })),
        shuttleStop: () => dispatch({ type: 'shuttle', dir: 0 }),
        shuttleForward: () => (kDown.current ? stepFrame(1) : dispatch({ type: 'shuttle', dir: 1 })),
        markIn: () => dispatch({ type: 'setMark', which: 'in', t: stateRef.current.playhead }),
        markOut: () => dispatch({ type: 'setMark', which: 'out', t: stateRef.current.playhead }),
        goIn: () => stateRef.current.mark.in != null && dispatch({ type: 'setPlayhead', t: stateRef.current.mark.in, user: true }),
        goOut: () => stateRef.current.mark.out != null && dispatch({ type: 'setPlayhead', t: stateRef.current.mark.out, user: true }),
        clearMarks: () => dispatch({ type: 'clearMarks' }),
        playInOut: () => playInOut(),
        lift: () => cutMarked(false),
        extract: () => cutMarked(true),
        videoTaller: () => dispatch({ type: 'growRows', kind: 'video', by: 12 }),
        videoShorter: () => dispatch({ type: 'growRows', kind: 'video', by: -12 }),
        audioTaller: () => dispatch({ type: 'growRows', kind: 'audio', by: 12 }),
        audioShorter: () => dispatch({ type: 'growRows', kind: 'audio', by: -12 }),
        exportSel: () => stateRef.current.selection.length && onExport('selected'),
        group: () => dispatch({ type: 'group' }),
        ungroup: () => dispatch({ type: 'ungroup' }),
        nest: () => doNest(),
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
  }, [state.playing, state.playhead, total, binds, showKeys, showSource, snapOn, rippleOn])
  // K held down: J and L step one frame instead of playing
  const kDown = useRef(false)
  useEffect(() => {
    const up = (e) => {
      if (e.key && e.key.toLowerCase() === 'k') kDown.current = false
    }
    const blur = () => (kDown.current = false)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])
  const stepFrame = (dir) => {
    const st = stateRef.current
    dispatch({ type: 'setPlaying', value: false })
    dispatch({ type: 'setPlayhead', t: Math.max(0, Math.min(projectDuration(st), st.playhead + dir / 30)), user: true })
  }
  const playInOut = () => {
    const r = markRange(stateRef.current)
    if (!r) return flash('Mark an In and an Out first: I and O at the playhead, or the buttons under the preview.')
    dispatch({ type: 'setPlayhead', t: r[0], user: true })
    dispatch({ type: 'setPlaying', value: true, until: r[1] })
  }
  // lift (leave the space empty) or extract (close it): what lies between the In and Out marks, on every track
  const cutMarked = (close) => {
    const st = stateRef.current
    const r = markRange(st)
    if (!r || st.mark.in == null || st.mark.out == null) return flash('Mark an In and an Out first (I and O at the playhead).')
    dispatch(close ? { type: 'rippleDelete', ranges: [r] } : { type: 'lift', t0: r[0], t1: r[1] })
    dispatch({ type: 'clearMarks' })
    dispatch({ type: 'setPlayhead', t: r[0], user: true })
  }

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
    openNest,
    updateNest: updateThisNest,
    isNest: !!nestOf && !projectPath,
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

  // ---- the menus: every feature in one place, with its shortcut (the toolbars keep only the things used all the time)
  const k = (id) => binds[id] || ''
  const hasSel = state.selection.length > 0
  const ioBoth = state.mark.in != null && state.mark.out != null
  const soleId = soleVideoClip(state)
  const soleClip = soleId && [...state.clips, ...state.overlayClips].find((c) => c.id === soleId)
  const soleMedia = soleClip && state.media.find((m) => m.id === soleClip.mediaId)
  const isNestTab = !!nestOf && !projectPath
  const act = {
    split: { label: 'Split at the playhead', keys: k('split'), run: () => dispatch({ type: 'split', t: stateRef.current.playhead }) },
    freeze: { label: 'Freeze frame', keys: k('freeze'), hint: 'Saves the frame under the playhead as a picture and puts it in', run: freezeFrame },
    del: { label: 'Delete', keys: k('delete'), disabled: !hasSel, run: () => dispatch({ type: 'deleteSelection', keepGap: !rippleOn }) },
    copy: { label: 'Copy', keys: k('copy'), disabled: !hasSel, run: doCopy },
    paste: { label: 'Paste at the playhead', keys: k('paste'), disabled: !hasClipboard(), run: () => dispatch({ type: 'paste', t: stateRef.current.playhead }) },
    duplicate: { label: 'Duplicate', keys: k('duplicate'), disabled: !hasSel, run: () => dispatch({ type: 'duplicate' }) },
    group: { label: 'Group', keys: k('group'), disabled: !canGroup(state), hint: 'Selected clips move together. Detached audio in the selection goes back to its video.', run: () => dispatch({ type: 'group' }) },
    ungroup: { label: 'Ungroup / detach audio', keys: k('ungroup'), disabled: !canUngroup(state), hint: 'Breaks a group, or lets the audio of a video clip be moved on its own', run: () => dispatch({ type: 'ungroup' }) },
    nest: { label: 'Nest (make them one clip)', keys: k('nest'), disabled: !hasSel, run: doNest },
    openNest: soleMedia && soleMedia.nest ? { label: 'Open the nest', run: () => openNest(soleMedia.id) } : null,
    colour: { label: 'Colour…', disabled: !(soleClip && soleMedia && soleMedia.type !== 'audio'), hint: 'Opens the Colour tab for this clip', run: () => onOpenColour(soleId) },
    exportSel: { label: 'Export the selected clips…', keys: k('exportSel'), disabled: !hasSel, run: () => onExport('selected') },
    text: { label: 'Text or title', keys: k('text'), run: () => dispatch({ type: 'addText', t: stateRef.current.playhead }) },
    marker: { label: 'Marker', keys: k('marker'), run: () => dispatch({ type: 'addMarker', t: stateRef.current.playhead }) },
    addTrack: { label: 'Track…', run: () => tlApi.current && tlApi.current.addTrack() },
    markIn: { label: 'Mark In', keys: k('markIn'), run: () => dispatch({ type: 'setMark', which: 'in', t: stateRef.current.playhead }) },
    markOut: { label: 'Mark Out', keys: k('markOut'), run: () => dispatch({ type: 'setMark', which: 'out', t: stateRef.current.playhead }) },
    clearMarks: { label: 'Clear In and Out', keys: k('clearMarks'), disabled: state.mark.in == null && state.mark.out == null, run: () => dispatch({ type: 'clearMarks' }) },
    lift: { label: 'Lift (leave the space)', keys: k('lift'), disabled: !ioBoth, hint: 'Removes everything between In and Out and leaves the space empty', run: () => cutMarked(false) },
    extract: { label: 'Extract (close the space)', keys: k('extract'), disabled: !ioBoth, hint: 'Removes everything between In and Out and closes the space', run: () => cutMarked(true) },
    fit: { label: 'Zoom to fit', keys: k('fit'), run: () => fitRef.current && fitRef.current() },
  }
  const tools = [
    ['select', 'Select and move', 'toolSelect'],
    ['ripple', 'Ripple trim', 'toolRipple'],
    ['roll', 'Roll', 'toolRoll'],
    ['slip', 'Slip', 'toolSlip'],
    ['slide', 'Slide', 'toolSlide'],
  ]
  const menus = [
    {
      label: 'File',
      items: [
        { label: 'New project…', run: onNew },
        { label: 'Open project…', keys: k('open'), run: onOpen },
        { sep: true },
        { label: isNestTab ? 'Update the nest' : 'Save', keys: k('save'), run: () => saveProject(false) },
        { label: 'Save as…', keys: k('saveAs'), run: () => saveProject(true) },
        { label: 'Version history…', hint: 'Earlier copies of this project', run: () => setShowHistory(true) },
        { sep: true },
        { label: 'Import video or picture…', disabled: busy, run: () => importFiles('video') },
        { label: 'Import audio…', disabled: busy, run: () => importFiles('audio') },
        { sep: true },
        { label: 'Export video…', disabled: !state.clips.length && !state.overlayClips.length, run: () => onExport() },
        act.exportSel,
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', keys: k('undo'), disabled: !state.past.length, run: () => dispatch({ type: 'undo' }) },
        { label: 'Redo', keys: k('redo'), disabled: !state.future.length, run: () => dispatch({ type: 'redo' }) },
        { sep: true },
        act.copy,
        act.paste,
        act.duplicate,
        act.del,
        { sep: true },
        { label: 'Keyboard shortcuts…', run: () => setShowKeys(true) },
        onSettings && { label: 'Settings…', run: onSettings },
      ],
    },
    {
      label: 'Clip',
      items: [act.split, act.freeze, { sep: true }, act.group, act.ungroup, act.nest, act.openNest, { sep: true }, act.colour, { sep: true }, act.exportSel],
    },
    {
      label: 'Add',
      items: [
        act.text,
        { label: 'Captions from speech…', hint: 'The words in your video become text clips', run: () => setShowCaptions(true) },
        { label: 'Edit by text…', hint: 'Cut the video by deleting words (makes the captions first if needed)', run: () => setShowTranscript(true) },
        { label: rec ? 'Stop the voice-over' : 'Voice-over', keys: k('record'), run: startRecording },
        act.marker,
        { sep: true },
        act.addTrack,
      ],
    },
    {
      label: 'Play',
      items: [
        { label: state.playing ? 'Pause' : 'Play', keys: k('playPause'), run: () => dispatch({ type: 'setPlaying', value: !stateRef.current.playing }) },
        { label: 'Play backwards', keys: k('shuttleBack'), hint: 'Press again to go faster', run: () => dispatch({ type: 'shuttle', dir: -1 }) },
        { label: 'Play forwards', keys: k('shuttleForward'), hint: 'Press again to go faster', run: () => dispatch({ type: 'shuttle', dir: 1 }) },
        { label: 'Step back one frame', keys: k('stepBack'), run: () => stepFrame(-1) },
        { label: 'Step forward one frame', keys: k('stepForward'), run: () => stepFrame(1) },
        { label: 'Go to start', keys: k('goStart'), run: () => dispatch({ type: 'setPlayhead', t: 0, user: true }) },
        { sep: true },
        act.markIn,
        act.markOut,
        { label: 'Go to In', keys: k('goIn'), disabled: state.mark.in == null, run: () => dispatch({ type: 'setPlayhead', t: stateRef.current.mark.in, user: true }) },
        { label: 'Go to Out', keys: k('goOut'), disabled: state.mark.out == null, run: () => dispatch({ type: 'setPlayhead', t: stateRef.current.mark.out, user: true }) },
        { label: 'Play from In to Out', keys: k('playInOut'), disabled: !markRange(state), run: playInOut },
        act.clearMarks,
      ],
    },
    {
      label: 'Timeline',
      items: [
        ...tools.map(([id, label, key]) => ({ label: label + ' tool', keys: k(key), checked: tool === id, run: () => setTool(id) })),
        { sep: true },
        { label: 'Snapping', keys: k('snap'), checked: snapOn, run: () => setSnapOn(!snapOn) },
        { label: 'Close gaps after deleting', keys: k('ripple'), checked: rippleOn, run: () => setRippleOn(!rippleOn) },
        { sep: true },
        act.lift,
        act.extract,
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Media panel', checked: binOpen, run: () => setBinOpen(!binOpen) },
        { label: 'Library', checked: libOpen, run: () => setLibOpen(!libOpen) },
        { label: 'Inspector', checked: inspOpen, run: () => setInspOpen(!inspOpen) },
        { label: 'Mini timeline', checked: miniOn, hint: 'An overview of the whole project under the timeline', run: () => setMiniOn(!miniOn) },
        { sep: true },
        act.fit,
        { label: 'Track heights…', run: () => tlApi.current && tlApi.current.trackHeights() },
        { label: 'Taller video tracks', keys: k('videoTaller'), run: () => dispatch({ type: 'growRows', kind: 'video', by: 12 }) },
        { label: 'Shorter video tracks', keys: k('videoShorter'), run: () => dispatch({ type: 'growRows', kind: 'video', by: -12 }) },
        { label: 'Taller sound tracks', keys: k('audioTaller'), run: () => dispatch({ type: 'growRows', kind: 'audio', by: 12 }) },
        { label: 'Shorter sound tracks', keys: k('audioShorter'), run: () => dispatch({ type: 'growRows', kind: 'audio', by: -12 }) },
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'Tutorial', hint: 'A short tour of the main features', run: () => setTour(true) },
        { label: 'Keyboard shortcuts…', run: () => setShowKeys(true) },
      ],
    },
  ]
  // the right-click menu: for the clips that are chosen, a gap, the ruler, or an empty part of the timeline
  const ctxItems = (c) => {
    if (!c) return []
    if (c.id && c.id.startsWith('gap:')) return [{ label: 'Close this gap', run: () => dispatch({ type: 'closeGap', id: c.id.slice(4) }) }]
    if (c.onRuler) return [act.markIn, act.markOut, act.clearMarks, { sep: true }, act.lift, act.extract, { sep: true }, { ...act.marker, label: 'Add a marker' }, act.fit]
    if (c.id) return [act.split, act.del, { sep: true }, act.copy, act.duplicate, act.paste, { sep: true }, act.group, act.ungroup, act.nest, act.openNest, { sep: true }, act.colour, act.freeze, { sep: true }, act.exportSel]
    return [act.paste, { sep: true }, { ...act.text, label: 'Add text' }, { ...act.marker, label: 'Add a marker' }, { ...act.addTrack, label: 'Add a track…' }, { sep: true }, act.fit]
  }

  return (
    <div className="app" ref={appRef} style={{ display: active ? undefined : 'none' }} onDragOver={(e) => e.preventDefault()} onDrop={onDropFiles}>
      <header className="topbar">
        <MenuBar menus={menus} />
        <span className="tb-group">
          <button onClick={() => saveProject(false)} title={(isNestTab ? 'Update the nest' : 'Save') + ' (' + k('save') + ')'}>Save</button>
        </span>
        <span className="proj-name">{nestOf && !projectPath ? (nestOf.name || 'Nest') + ' (inside)' : projectName}{dirty ? ' •' : ''}</span>
        {nestOf && !projectPath && (
          <button className="primary nest-update" onClick={updateThisNest} title="Render this again and put it back into the project the nest is in (Ctrl+S)"><Icon name="nest" size={14} /> Update the nest</button>
        )}
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
                {m.type !== 'image' && !m.missing && <button className="bin-trim" title="Watch it and mark the part to use (In and Out) before you add it" onClick={(e) => { e.stopPropagation(); setShowSource(m.id) }}><Icon name="trimSource" size={13} /></button>}
                <div className="meta">
                  <div className="name">{m.name}</div>
                  <div className="sub">
                    {m.type !== 'image' ? fmtTime(m.duration).slice(0, 5) : ''}
                    {m.mark ? ` · uses ${fmtTime(sourceRange(m)[0]).slice(0, 5)}–${fmtTime(sourceRange(m)[1]).slice(0, 5)}` : ''}
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
          {/* the play bar: In / Out marks on the left, playing in the middle, what to do with the marked part on the right */}
          <div className="transport">
            <span className="tr-group">
              <button className={state.mark.in != null ? 'on' : ''} onClick={() => dispatch({ type: 'setMark', which: 'in', t: state.playhead })} onContextMenu={(e) => { e.preventDefault(); dispatch({ type: 'setMark', which: 'in', t: null }) }} title={'Mark In at the playhead (' + binds.markIn + '). Right-click removes it.'}><Icon name="markIn" /></button>
              <button className={state.mark.out != null ? 'on' : ''} onClick={() => dispatch({ type: 'setMark', which: 'out', t: state.playhead })} onContextMenu={(e) => { e.preventDefault(); dispatch({ type: 'setMark', which: 'out', t: null }) }} title={'Mark Out at the playhead (' + binds.markOut + '). Right-click removes it.'}><Icon name="markOut" /></button>
            </span>
            <span className="tr-group">
              <button onClick={() => dispatch({ type: 'setPlayhead', t: 0, user: true })} title={'Go to start (' + binds.goStart + ')'}><Icon name="skipBack" fill /></button>
              <button onClick={() => stepFrame(-1)} title={'One frame back (' + binds.stepBack + ')'}><Icon name="frameBack" /></button>
              <button className="primary play" onClick={() => dispatch({ type: 'setPlaying', value: !state.playing })} title={'Play or pause (' + binds.playPause + '). J, K and L play backwards, stop and play forwards.'}>
                {state.playing ? <><Icon name="pause" fill /> Pause</> : <><Icon name="play" fill /> Play</>}
              </button>
              <button onClick={() => stepFrame(1)} title={'One frame forward (' + binds.stepForward + ')'}><Icon name="frameFwd" /></button>
            </span>
            <span className="tr-group">
              <button disabled={!markRange(state)} onClick={playInOut} title={'Play from the In mark to the Out mark (' + binds.playInOut + ')'}><Icon name="playInOut" /></button>
              <button disabled={!ioBoth} onClick={() => cutMarked(false)} title={'Lift: remove everything between the In and Out marks and leave the space empty (' + binds.lift + ')'}><Icon name="lift" /></button>
              <button disabled={!ioBoth} onClick={() => cutMarked(true)} title={'Extract: remove everything between the In and Out marks and close the space (' + binds.extract + ')'}><Icon name="extract" /></button>
            </span>
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
          onOpenNest={openNest}
        />
      </div>

      <div className="tl-split" onPointerDown={startResize} onDoubleClick={() => setTlHeight(340)} title="Drag up or down to make the timeline bigger or smaller (double-click to reset)" />
      <div className="tl-wrap" style={{ height: tlHeight }}>
      <Timeline
        onCaptions={() => setShowCaptions(true)}
        height={tlHeight}
        onOpenNest={openNest}
        tool={tool}
        setTool={setTool}
        toolKeys={binds}
        state={state}
        dispatch={dispatch}
        zoom={zoom}
        setZoom={setZoom}
        splitKey={binds.split}
        heightKeys={[binds.videoTaller, binds.videoShorter, binds.audioTaller, binds.audioShorter]}
        snapOn={snapOn}
        setSnapOn={setSnapOn}
        rippleOn={rippleOn}
        setRippleOn={setRippleOn}
        fitRef={fitRef}
        tlApi={tlApi}
        onMenu={(x, y, info) => setCtx({ x, y, ...info })}
        rec={rec}
        onRecord={startRecording}
        miniOn={miniOn}
      />
      <Meter playing={state.playing} />
      </div>
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems(ctx)} onClose={closeCtx} />}
      {showSource && <SourceDialog media={state.media.find((m) => m.id === showSource) || null} onClose={() => setShowSource(null)} onSave={(mark) => dispatch({ type: 'setSourceMark', id: showSource, mark })} onAdd={(mark) => { dispatch({ type: 'setSourceMark', id: showSource, mark }); const m = state.media.find((x) => x.id === showSource); setShowSource(null); if (m) setTimeout(() => addMediaToTimeline(m), 0) }} />}
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
