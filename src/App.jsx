import { useEffect, useRef, useState } from 'react'
import Editor from './Editor.jsx'
import ImageEditor from './ImageEditor.jsx'
import DrawingEditor from './DrawingEditor.jsx'
import NewProjectDialog from './NewProjectDialog.jsx'
import { kindOf } from './project.js'
import Home from './Home.jsx'
import Icon from './Icon.jsx'
import SettingsDialog from './SettingsDialog.jsx'
import UpdateDialog from './UpdateDialog.jsx'
import ExportTab from './ExportTab.jsx'
import ColourTab from './ColourTab.jsx'
import { cancelExport } from './exporter.js'
import { loadBinds, saveBinds } from './keybinds.js'
import { applyTheme, findTheme } from './themes.js'
import { setDevices } from './audioDevices.js'

let tabCounter = 0
const newId = () => `p${Date.now().toString(36)}${tabCounter++}`

// The window: a tab bar (Home + one tab per open project), and the global things
// (theme, settings, updates). Each open project is its own <Editor>.
export default function App() {
  const [tabs, setTabs] = useState([]) // [{id, title, path, dirty, initial, kind: 'video' | 'image'}]
  const [chooser, setChooser] = useState(false) // the "New project" question: video or image
  const [activeId, setActiveId] = useState('home')
  const handles = useRef({})
  const [exports, setExports] = useState([]) // Export tabs: [{id, projectId, running, pct, done}]
  const [colours, setColours] = useState([]) // Colour tabs: [{id, projectId, clipId}]
  const [binds, setBinds] = useState(loadBinds)
  const [showSettings, setShowSettings] = useState(false)
  const [version, setVersion] = useState('')
  const [settings, setSettingsState] = useState({ autoUpdate: true })
  const [update, setUpdate] = useState({ state: 'idle' })
  const [hidden, setHidden] = useState(false) // update popup dismissed for now
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('vibe.theme') || 'dark'
    } catch {
      return 'dark'
    }
  })

  // the theme in use: one of the two that come with the editor, or one the user made (kept in the settings)
  const customThemes = settings.themes || []
  const activeTheme = findTheme(theme, customThemes)
  const [preview, setPreview] = useState(null) // {theme, kind}: a theme being tried out in the real editors
  useEffect(() => {
    applyTheme(preview ? preview.theme : activeTheme)
    try {
      localStorage.setItem('vibe.theme', theme)
    } catch {}
  }, [preview, theme, JSON.stringify(activeTheme)])
  // what is shown on Discord ("Playing ..."): the kind of project in front, and its name if the settings allow it
  useEffect(() => {
    let p = { kind: 'home' }
    const t = tabs.find((x) => x.id === activeId)
    if (t) p = { kind: t.kind, name: t.title }
    else if (activeId !== 'home') {
      const pid = (exports.find((x) => x.id === activeId) || colours.find((x) => x.id === activeId) || {}).projectId
      const pt = tabs.find((x) => x.id === pid)
      p = { kind: exports.some((x) => x.id === activeId) ? 'export' : 'video', name: pt ? pt.title : '' }
    }
    window.api.setPresence(p).catch(() => {})
  }, [activeId, tabs.find((x) => x.id === activeId)?.title, tabs.find((x) => x.id === activeId)?.kind, exports.length])
  // the microphone and speakers chosen in the settings
  useEffect(() => {
    setDevices({ out: settings.audioOutputId, inp: settings.audioInputId })
  }, [settings.audioOutputId, settings.audioInputId])
  useEffect(() => {
    saveBinds(binds)
  }, [binds])

  // ---- settings & updates
  useEffect(() => {
    window.api.appVersion().then(setVersion)
    window.api.getSettings().then(setSettingsState)
    return window.api.onUpdateStatus((s) => {
      setUpdate(s)
      if (s.state === 'available' || s.state === 'ready' || s.state === 'error') setHidden(false)
    })
  }, [])
  const setSettings = async (patch) => setSettingsState(await window.api.setSettings(patch))
  const checkNow = () => window.api.checkForUpdates()
  // try a theme in the real video editor / image editor (the settings close, a bar offers the way back)
  const previewTheme = (kind, t) => {
    setPreview({ theme: t, kind })
    setShowSettings(false)
    const tab = tabs.find((x) => x.kind === kind)
    if (tab) setActiveId(tab.id)
    else if (kind === 'image' || kind === 'drawing') newTab({ canvas: { w: 1280, h: 720, bg: '#ffffff' } }, kind)
    else newTab(null, 'video')
  }
  const showPopup = !hidden && (['available', 'downloading', 'ready'].includes(update.state) || (update.state === 'error' && update.during === 'download'))
  const updatePending = ['snoozed'].includes(update.state) || (hidden && ['available', 'downloading', 'ready'].includes(update.state))

  // ---- tabs
  const newTab = (initial = null, kind = 'video') => {
    const id = newId()
    setTabs((t) => [...t, { id, title: 'Untitled', path: initial && initial.file, dirty: false, initial, kind }])
    setActiveId(id)
  }
  // the "New project" answer: video, or image with its canvas
  const createProject = async (kind, canvas) => {
    setChooser(false)
    // "Edit a picture": choose a picture file; it opens in the drawing editor, on a canvas of its own size
    if (kind === 'picture') {
      const items = await window.api.importMedia('image')
      const it = (items || []).find((x) => x.type === 'image')
      if (it) newTab({ picture: { path: it.path, name: it.name, w: it.width, h: it.height } }, 'drawing')
      return
    }
    newTab(kind === 'image' || kind === 'drawing' ? { canvas } : null, kind)
  }
  useEffect(() => {
    window.__newTab = createProject // developer self-test
    window.__openPicture = (pic) => newTab({ picture: pic }, 'drawing')
  })
  // each project can have an Export tab next to it (settings, and the video as it is being made)
  const openExport = (projectId) => {
    const id = 'x' + projectId
    setExports((e) => (e.some((x) => x.id === id) ? e : [...e, { id, projectId, running: false, pct: 0, done: false }]))
    setActiveId(id)
  }
  // a Colour tab for one clip of a project (colour correction with an Apply button)
  const openColour = (projectId, clipId) => {
    const id = 'c' + projectId
    setColours((c) => (c.some((x) => x.id === id) ? c.map((x) => (x.id === id ? { ...x, clipId } : x)) : [...c, { id, projectId, clipId }]))
    setActiveId(id)
  }
  const closeColour = (id) => {
    const x = colours.find((c) => c.id === id)
    setColours((c) => c.filter((y) => y.id !== id))
    if (x && activeId === id) setActiveId(tabs.some((t) => t.id === x.projectId) ? x.projectId : 'home')
  }
  const exportStatus = (id, st) => setExports((e) => e.map((x) => (x.id === id ? { ...x, ...st } : x)))
  const closeExport = (id) => {
    const x = exports.find((e) => e.id === id)
    if (!x) return
    if (x.running) {
      if (!window.confirm('An export is still running. Cancel it and close this tab?')) return
      cancelExport()
    }
    setExports((e) => e.filter((y) => y.id !== id))
    if (activeId === id) setActiveId(tabs.some((t) => t.id === x.projectId) ? x.projectId : 'home')
  }
  const onMeta = (id, meta) => setTabs((t) => t.map((x) => (x.id === id ? { ...x, ...meta } : x)))
  const registerHandle = (id, h) => {
    if (h) handles.current[id] = h
    else delete handles.current[id]
  }

  const openFile = (file, json) => {
    const existing = tabs.find((t) => t.path === file)
    if (existing) setActiveId(existing.id)
    else newTab({ file, json }, kindOf(json))
  }
  const openDialog = async () => {
    const res = await window.api.openProject()
    if (res) openFile(res.file, res.json)
  }
  const openRecent = async (r) => {
    try {
      const res = await window.api.readProject(r.path)
      openFile(res.file, res.json)
    } catch {
      window.alert('That project file could not be opened. It may have been moved or deleted.')
      window.api.recentRemove(r.path)
    }
  }

  // quick = middle-click: save without asking, then close (it stays in Recent projects on Home)
  const closeTab = async (id, quick = false) => {
    const tab = tabs.find((t) => t.id === id)
    const h = handles.current[id]
    if (tab && h && h.isDirty()) {
      if (quick) {
        if (!(await h.save())) return // save window cancelled: keep the tab open
      } else {
        const choice = await window.api.askSave(tab.title)
        if (choice === 2) return
        if (choice === 0 && !(await h.save())) return
      }
    }
    // closing a project also closes its Export tab (an export that is running is cancelled)
    const ex = exports.find((e) => e.projectId === id)
    if (ex) {
      if (ex.running) {
        if (!window.confirm('An export of this project is still running. Cancel it and close the project?')) return
        cancelExport()
      }
      setExports((e) => e.filter((y) => y.projectId !== id))
    }
    setColours((c) => c.filter((y) => y.projectId !== id))
    window.api.clearAutosave(id)
    const idx = tabs.findIndex((t) => t.id === id)
    const rest = tabs.filter((t) => t.id !== id)
    setTabs(rest)
    if (activeId === id) setActiveId(rest.length ? rest[Math.max(0, idx - 1)].id : 'home')
  }

  // the window warns on close if any project has unsaved changes
  useEffect(() => {
    window.api.setDirty(tabs.some((t) => t.dirty))
  }, [tabs])

  const activeTab = tabs.find((t) => t.id === activeId)
  useEffect(() => {
    document.title = activeTab ? `${activeTab.dirty ? '• ' : ''}${activeTab.title} - Vibe Editing Suite` : 'Vibe Editing Suite'
  }, [activeTab && activeTab.title, activeTab && activeTab.dirty, activeId])

  // start-up: bring back projects that were open but never saved
  useEffect(() => {
    ;(async () => {
      if (await window.api.isTest()) {
        newTab() // tests drive a project directly
        return
      }
      // Projects that were open but never saved come back by themselves (no question that could be
      // answered wrongly). Their recovery copies are kept until the tab is saved or closed.
      const all = await window.api.listAutosaves()
      const saved = []
      for (const a of all) {
        let useful = false
        try {
          const d = JSON.parse(a.json)
          useful = (d.clips || []).length || (d.audioClips || []).length || (d.overlayClips || []).length || (d.kind === 'drawing' && (d.layers || []).length)
        } catch {}
        if (useful) saved.push(a)
        else window.api.clearAutosave(a.id)
      }
      saved.forEach((a, i) => {
        setTabs((t) => [...t, { id: a.id, title: 'Untitled', path: null, dirty: true, initial: { file: null, json: a.json }, kind: kindOf(a.json) }])
        if (i === 0) setActiveId(a.id)
      })
    })()
  }, [])

  return (
    <div className="shell">
      <div className="tabbar">
        <button className={'tab home-tab' + (activeId === 'home' ? ' on' : '')} onClick={() => setActiveId('home')} title="Home">
          <Icon name="home" /> Home
        </button>
        {tabs.map((t) => (
          <div key={t.id} className={'tab' + (activeId === t.id ? ' on' : '')} onClick={() => setActiveId(t.id)}
            onMouseDown={(e) => e.button === 1 && e.preventDefault()}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                closeTab(t.id, true)
              }
            }}
            title={(t.path || 'Not saved yet') + '\nMiddle-click to save and close'}>
            <span className="tab-kind" title={t.kind === 'drawing' ? 'Drawing project' : t.kind === 'image' ? 'Image project' : 'Video project'}><Icon name={t.kind === 'drawing' ? 'pen' : t.kind === 'image' ? 'image' : 'film'} size={12} /></span>
            <span className="tab-title">{t.title}</span>
            {t.dirty && <span className="tab-dot" title="Unsaved changes" />}
            <button
              className="tab-x"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(t.id)
              }}
              title="Close this project"
            >
              <Icon name="x" size={11} />
            </button>
          </div>
        ))}
        {exports.map((x) => {
          const pt = tabs.find((t) => t.id === x.projectId)
          return (
            <div
              key={x.id}
              className={'tab export-tab' + (activeId === x.id ? ' on' : '')}
              onClick={() => setActiveId(x.id)}
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  closeExport(x.id)
                }
              }}
              title="Export"
            >
              <Icon name="upload" size={12} />
              <span className="tab-title">Export · {pt ? pt.title : ''}</span>
              {x.running && <span className="tab-pct">{Math.round(x.pct)}%</span>}
              {x.done && !x.running && <span className="tab-pct done">done</span>}
              <button
                className="tab-x"
                onClick={(e) => {
                  e.stopPropagation()
                  closeExport(x.id)
                }}
                title="Close this tab"
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          )
        })}
        {colours.map((x) => {
          const pt = tabs.find((t) => t.id === x.projectId)
          return (
            <div
              key={x.id}
              className={'tab export-tab' + (activeId === x.id ? ' on' : '')}
              onClick={() => setActiveId(x.id)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  closeColour(x.id)
                }
              }}
              title="Colour correction"
            >
              <Icon name="palette" size={12} />
              <span className="tab-title">Colour · {pt ? pt.title : ''}</span>
              <button
                className="tab-x"
                onClick={(e) => {
                  e.stopPropagation()
                  closeColour(x.id)
                }}
                title="Close this tab"
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          )
        })}
        <button className="tab-plus" onClick={() => setChooser(true)} title="New project">
          <Icon name="plus" size={14} />
        </button>

        <span className="spacer" />
        {updatePending && (
          <button className="primary upd-badge" onClick={() => {
              setHidden(false)
              if (update.state === 'snoozed') window.api.checkForUpdates()
            }} title="A new version is available">
            <Icon name="download" size={13} /> Update {update.version}
          </button>
        )}
        <button className="ver" onClick={() => setShowSettings(true)} title="Settings">
          v{version}
        </button>
        <button onClick={() => setShowSettings(true)} title="Settings">
          <Icon name="sliders" /> Settings
        </button>
      </div>

      <div className="host">
        <Home active={activeId === 'home'} onNew={() => setChooser(true)} onOpen={openDialog} onOpenRecent={openRecent} />
        {tabs.map((t) =>
          t.kind === 'drawing' ? (
            <DrawingEditor
              key={t.id}
              tabId={t.id}
              active={activeId === t.id}
              initial={t.initial}
              binds={binds}
              onMeta={onMeta}
              onNew={() => setChooser(true)}
              onOpen={openDialog}
              registerHandle={registerHandle}
            />
          ) : t.kind === 'image' ? (
            <ImageEditor
              key={t.id}
              tabId={t.id}
              active={activeId === t.id}
              initial={t.initial}
              binds={binds}
              onMeta={onMeta}
              onNew={() => setChooser(true)}
              onOpen={openDialog}
              registerHandle={registerHandle}
            />
          ) : (
            <Editor
              key={t.id}
              tabId={t.id}
              active={activeId === t.id}
              initial={t.initial}
              binds={binds}
              setBinds={setBinds}
              onMeta={onMeta}
              onNew={() => setChooser(true)}
              onOpen={openDialog}
              onExport={() => openExport(t.id)}
              onOpenColour={(clipId) => openColour(t.id, clipId)}
              onOpenJson={(json) => newTab({ file: null, json })}
              registerHandle={registerHandle}
            />
          ),
        )}
        {colours.map((x) => (
          <ColourTab
            key={x.id + x.clipId}
            active={activeId === x.id}
            clipId={x.clipId}
            getProject={() => ({ state: handles.current[x.projectId].getState() })}
            dispatchProject={(a) => handles.current[x.projectId].dispatch(a)}
            onClose={() => closeColour(x.id)}
          />
        ))}
        {exports.map((x) => (
          <ExportTab
            key={x.id}
            active={activeId === x.id}
            getProject={() => {
              const h = handles.current[x.projectId]
              const pt = tabs.find((t) => t.id === x.projectId)
              return { state: h.getState(), name: pt && pt.title !== 'Untitled' ? pt.title : 'My video' }
            }}
            onStatus={(st) => exportStatus(x.id, st)}
          />
        ))}
      </div>

      {chooser && <NewProjectDialog onCreate={createProject} onClose={() => setChooser(false)} />}
      {showPopup && (
        <UpdateDialog
          update={update}
          onDownload={() => window.api.downloadUpdate()}
          onLater={() => {
            window.api.snoozeUpdate()
            setHidden(true)
          }}
          onHide={() => setHidden(true)}
          onInstall={() => window.api.installUpdate()}
        />
      )}
      {showSettings && (
        <SettingsDialog
          settings={settings}
          setSettings={setSettings}
          theme={theme}
          setTheme={setTheme}
          themes={customThemes}
          saveThemes={(list) => setSettings({ themes: list })}
          onPreviewTheme={previewTheme}
          version={version}
          onCheck={checkNow}
          update={update}
          onClose={() => setShowSettings(false)}
        />
      )}
      {preview && (
        <div className="theme-previewbar">
          <span>
            Trying <b>{preview.theme.name}</b> in the {preview.kind === 'image' ? 'image' : preview.kind === 'drawing' ? 'drawing' : 'video'} editor
          </span>
          <button className={preview.kind === 'video' ? 'on' : ''} onClick={() => previewTheme('video', preview.theme)}>Video editor</button>
          <button className={preview.kind === 'image' ? 'on' : ''} onClick={() => previewTheme('image', preview.theme)}>Image editor</button>
          <button className={preview.kind === 'drawing' ? 'on' : ''} onClick={() => previewTheme('drawing', preview.theme)}>Drawing editor</button>
          <button className="primary" onClick={() => { setPreview(null); setShowSettings(true) }}>Back to settings</button>
          <button onClick={() => setPreview(null)} title="Go back to the theme that is in use">Stop</button>
        </div>
      )}
    </div>
  )
}
