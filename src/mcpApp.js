// The AI connection, the editor as a whole: projects, settings, files, AI models and the library. None of these need a project open.
import { toUrl, ASPECTS } from './state.js'
import { currentJob, cancelJob, startJob, jobRunning } from './mcpJobs.js'
import { openedVideo } from './followSubject.js'
import { EASES, PROPS } from './motion.js'
import { FX_SLIDERS, CC_SLIDERS, CC_PRESETS } from './effects.js'
import { TEXT_FONTS, TEXT_ANIMS, TEXT_PRESETS, TEXT_DEFAULTS } from './textRender.js'
import { BLEND_LIST } from './glRenderer.js'
import { LABELS } from './labels.js'
import { LANGUAGES } from './whisper.js'
import { ACTIONS } from './keybinds.js'
import { allThemes, TOKENS } from './themes.js'
import { PRESET_LIST } from './ExportTab.jsx'
import { loadImageUrl } from './paint/raster.js'
import { builtinBrushes } from './paint/builtinBrushes.js'
import { loadPacks } from './paint/usePaintKit.js'
import { transitionError } from './mcpPicture.js'

// a shortcut as the editor writes it: Ctrl, Alt, Shift in that order, then one key
const NAMED = ['Space', 'Delete', 'Home', 'End', 'Enter', 'Escape', 'Tab', 'PageUp', 'PageDown', 'Insert', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ...Array.from({ length: 12 }, (_, i) => 'F' + (i + 1))]
function shortcutOf(text) {
  const parts = String(text).split('+').map((p) => p.trim()).filter(Boolean)
  const key = parts.pop() || ''
  const mods = parts.map((m) => ({ ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', shift: 'Shift' })[m.toLowerCase()])
  if (mods.some((m) => !m) || new Set(mods).size !== mods.length) return null
  const k = key.length === 1 ? key.toUpperCase() : NAMED.find((n) => n.toLowerCase() === key.toLowerCase())
  if (!k || (k.length === 1 && !/^[A-Z0-9,.;'/=[\]-]$/.test(k))) return null
  return [...['Ctrl', 'Alt', 'Shift'].filter((m) => mods.includes(m)), k].join('+')
}

const wait = (ms = 90) => new Promise((r) => setTimeout(r, ms))
const json = (o) => ({ text: JSON.stringify(o) })
const need = (ok, msg) => {
  if (!ok) throw new Error(msg)
}
const SETTINGS = { autoUpdate: 'boolean', discordPresence: 'boolean', discordShowName: 'boolean', proxyMode: ['auto', 'always', 'off'] }

// a picture of `el` (no bigger than `most` pixels), as the AI app wants it
function photo(el, w, h, most = 1280) {
  const k = Math.min(1, most / Math.max(w, h))
  const cv = document.createElement('canvas')
  cv.width = Math.max(1, Math.round(w * k))
  cv.height = Math.max(1, Math.round(h * k))
  const g = cv.getContext('2d')
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, cv.width, cv.height)
  g.drawImage(el, 0, 0, cv.width, cv.height)
  return cv.toDataURL('image/jpeg', 0.85).split(',')[1]
}
// a new tab takes a moment before it can be worked on
async function tabReady(ctx, was) {
  for (let i = 0; i < 40; i++) {
    await wait(100)
    const p = ctx.current.project()
    if (p && p.id !== was) return p
  }
  throw new Error('The project did not open.')
}
const lastId = (ctx) => {
  const p = ctx.current.project()
  return p ? p.id : null
}
function modelJob(which) {
  const speech = which === 'speech'
  startJob({ title: speech ? 'Downloading the speech model' : 'Downloading the tracking AI model', text: 'Downloading…', cancellable: false }, async ({ progress }) => {
    const off = (speech ? window.api.onWhisperProgress : window.api.onModelsProgress)((d) => progress(d.received, d.total, `${Math.round(d.received / 1048576)} of ${Math.round(d.total / 1048576)} MB.`))
    try {
      const r = await (speech ? window.api.whisperDownload() : window.api.modelsDownload())
      if (r.error) throw new Error(r.error)
      return { downloaded: true }
    } finally {
      off()
    }
  })
}

// returns undefined for a tool that needs a project
export async function appTool(name, args, ctxRef) {
  const ctx = ctxRef.current
  switch (name) {
    case 'list_projects': {
      const recent = await window.api.recentList()
      return json({ open: ctx.projects(), recent: recent.map((r) => ({ name: r.name, path: r.path, kind: r.kind === 'image' ? 'picture' : 'video' })) })
    }
    case 'switch_project':
      need(ctx.projects().some((t) => t.id === args.id), `There is no open project with the id ${args.id}.`)
      ctx.focus(args.id)
      await wait(300)
      return { text: 'Done.' }
    case 'new_video_project': {
      const was = lastId(ctxRef)
      ctx.newProject()
      const p = await tabReady(ctxRef, was)
      return { text: `A new empty video project is open. Its id is ${p.id}.` }
    }
    case 'new_picture_project': {
      const was = lastId(ctxRef)
      const w = Math.round(+args.width)
      const h = Math.round(+args.height)
      need(w >= 16 && h >= 16 && w <= 16384 && h <= 16384, 'width and height are 16 to 16384 pixels.')
      ctx.newPicture({ w, h, bg: args.background || '#ffffff' })
      const p = await tabReady(ctxRef, was)
      return { text: `A new picture project of ${w} x ${h} is open. Its id is ${p.id}.` }
    }
    case 'open_project': {
      const was = lastId(ctxRef)
      const res = await window.api.readProject(String(args.path))
      ctx.openFile(res.file, res.json)
      await wait(300)
      if (lastId(ctxRef) === was) await tabReady(ctxRef, was).catch(() => {})
      return { text: `Opened. Its id is ${lastId(ctxRef)}.` }
    }
    case 'open_picture': {
      const was = lastId(ctxRef)
      const [item] = await window.api.describeFiles([String(args.path)])
      need(item && item.type === 'image', 'That is not a picture that can be read.')
      ctx.openPicture(item)
      const p = await tabReady(ctxRef, was)
      return { text: `Opened as a new picture project. Its id is ${p.id}.` }
    }
    case 'close_project': {
      const id = args.id || lastId(ctxRef)
      need(ctx.projects().some((t) => t.id === id), 'That project is not open.')
      await ctx.closeTab(id)
      await wait(200)
      // with unsaved changes the person is asked, and may keep it open
      if (ctxRef.current.projects().some((t) => t.id === id)) return { text: 'It is still open: it has unsaved changes, and the person chose to keep it.' }
      return { text: 'Closed.' }
    }
    case 'editor_info': {
      const { gpuInfo } = await import('./smartMask.js')
      const [version, gpu, tracking, speech, storage, encoders, library] = await Promise.all([window.api.appVersion(), gpuInfo(), window.api.modelsStatus(), window.api.whisperStatus(), window.api.storageInfo(), window.api.exportEncoders(), window.api.libraryList()])
      return json({
        version,
        update: ctx.update.state,
        graphicsCard: gpu,
        models: { tracking: tracking.ready, speech: speech.ready },
        storage,
        exportEncoders: ['cpu', ...encoders.available],
        exportPresets: PRESET_LIST.filter((p) => p.id !== 'custom').map((p) => ({ id: p.id, label: p.label, fileType: p.s.container || 'mp4', shape: p.aspect })),
        libraryFiles: library.length,
        settings: Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, ctx.settings[k]])),
        themes: allThemes(ctx.themes).map((t) => ({ id: t.id, name: t.name, inUse: t.id === ctx.theme || undefined, madeByYou: !t.builtin || undefined })),
        themeColours: TOKENS.flatMap((g) => g.items.map((i) => ({ key: i.key, label: i.label }))),
        shortcuts: ACTIONS.map((a) => ({ action: a.id, label: a.label, keys: ctx.binds[a.id] })),
        reference: {
          shapes: ASPECTS.map((a) => a.id),
          easings: Object.keys(EASES),
          values: PROPS.filter((p) => !p.mask).map((p) => ({ id: p.id, label: p.label, default: p.def })),
          effects: FX_SLIDERS.map((f) => f.id),
          colour: CC_SLIDERS.map((c) => ({ id: c.id, default: c.def, min: c.min, max: c.max })),
          colourPresets: CC_PRESETS.map((c) => c.name),
          blendModes: BLEND_LIST.map(([id]) => id),
          labels: Object.keys(LABELS),
          fonts: TEXT_FONTS,
          textAnimations: TEXT_ANIMS.map((a) => a.id),
          textPresets: TEXT_PRESETS.map((p) => p.name),
          textStyle: TEXT_DEFAULTS,
          captionLanguages: LANGUAGES.map(([id]) => id).filter(Boolean),
        },
      })
    }
    case 'set_setting': {
      if (args.name === 'theme') {
        need(allThemes(ctx.themes).some((t) => t.id === args.value), `There is no theme ${args.value}. See editor_info.`)
        ctx.setTheme(args.value)
        return { text: 'Done.' }
      }
      const kind = SETTINGS[args.name]
      need(kind, `${args.name} is not a setting that can be changed here.`)
      need(Array.isArray(kind) ? kind.includes(args.value) : typeof args.value === kind, `${args.name} must be ${Array.isArray(kind) ? kind.join(', ') : kind}.`)
      await ctx.setSettings({ [args.name]: args.value })
      return { text: 'Done.' }
    }
    case 'save_theme': {
      const keys = TOKENS.flatMap((g) => g.items.map((i) => i.key))
      const vars = {}
      for (const [k, v] of Object.entries(args.colours || {})) {
        need(keys.includes(k), `${k} is not one of the theme colours. See editor_info.`)
        need(/^#[0-9a-f]{6}$/i.test(v), `${k} must be a colour like #1a2b3c.`)
        vars[k] = v
      }
      need(['dark', 'dawn'].includes(args.base), 'base is dark or dawn.')
      const theme = { id: 'u' + Date.now().toString(36), name: String(args.name || 'My theme').slice(0, 40), base: args.base, vars }
      await ctx.setSettings({ themes: [...ctx.themes, theme] })
      ctx.setTheme(theme.id)
      return { text: `Saved and in use. Its id is ${theme.id}.` }
    }
    case 'set_shortcut': {
      need(ACTIONS.some((a) => a.id === args.action), `There is no action ${args.action}. See editor_info.`)
      const keys = shortcutOf(args.keys)
      need(keys, 'keys is like Ctrl+Shift+K, F5 or M: Ctrl, Alt and Shift, then one letter, digit, sign, F1 to F12 or a key such as Space, Delete, Home or ArrowLeft.')
      const taken = Object.entries(ctx.binds).find(([a, k]) => k === keys && a !== args.action)
      need(!taken, `${keys} is already used for "${(ACTIONS.find((a) => a.id === (taken || [])[0]) || {}).label}". Change that one first, or pick other keys.`)
      ctx.setBinds({ ...ctx.binds, [args.action]: keys })
      return { text: `Set to ${keys}.` }
    }
    case 'delete_theme': {
      const t = ctx.themes.find((x) => x.id === args.id)
      need(t, 'There is no theme of yours with that id. The two that come with the editor cannot be deleted.')
      if (ctx.theme === t.id) ctx.setTheme('dark')
      await ctx.setSettings({ themes: ctx.themes.filter((x) => x.id !== t.id) })
      return { text: `Deleted "${t.name}".` }
    }
    case 'list_brushes': {
      const one = (b) => ({ id: b.id, name: b.name, size: b.size })
      return json({ builtIn: builtinBrushes().map(one), packs: (await loadPacks()).map((k) => ({ file: k.file, title: k.title, brushes: k.brushes.map(one), error: k.error })) })
    }
    case 'check_for_updates':
      ctx.checkNow()
      await wait(1500)
      return json({ state: ctxRef.current.update.state, version: ctxRef.current.update.version })
    case 'download_model': {
      need(['tracking', 'speech'].includes(args.which), 'which is tracking or speech.')
      need(!jobRunning(), 'Something else is running. Use check_job, or wait for it to finish.')
      modelJob(args.which)
      return json({ state: 'started', next: 'Call check_job until it says done.' })
    }
    case 'clear_storage': {
      const known = await window.api.storageInfo()
      need(args.what in known, `what is one of: ${Object.keys(known).join(', ')}.`)
      return { text: (await window.api.storageClear(args.what)) ? 'Cleared.' : 'It could not be cleared right now.' }
    }
    case 'view_file': {
      const file = String(args.path)
      if (/\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(file)) {
        const v = await openedVideo(toUrl(file), +args.time || 0).catch(() => {
          throw new Error(`${file} could not be opened. Is the path right?`)
        })
        const image = photo(v, v.videoWidth, v.videoHeight)
        v.removeAttribute('src')
        v.load()
        return { image, mime: 'image/jpeg', text: `A frame of ${file}.` }
      }
      const img = await loadImageUrl(toUrl(file)).catch(() => {
        throw new Error(`${file} could not be opened as a picture. Is the path right?`)
      })
      return { image: photo(img, img.naturalWidth, img.naturalHeight), mime: 'image/jpeg', text: `${file}, ${img.naturalWidth} x ${img.naturalHeight} pixels.` }
    }
    case 'list_library':
      return json(await window.api.libraryList())
    case 'add_to_library': {
      need(Array.isArray(args.paths) && args.paths.length, 'Give at least one file path.')
      return { text: `Added ${await window.api.libraryAddPaths(args.paths)} to the library.` }
    }
    case 'delete_from_library':
      return { text: (await window.api.libraryDelete(String(args.path))) ? 'Moved to the Recycle Bin.' : 'That file is not in the library.' }
    case 'list_transitions':
      return json((await window.api.listTransitions()).map((t) => t.name))
    case 'get_transition': {
      const t = (await window.api.listTransitions()).find((x) => x.name === args.name)
      need(t, `There is no transition called ${args.name}.`)
      return { text: t.source }
    }
    case 'write_transition': {
      // tried first: a transition with a mistake in it would just show nothing
      const err = transitionError(String(args.source))
      need(!err, `It was not saved: the shader has a mistake.\n${err}`)
      const saved = await window.api.writeTransition({ name: args.name, source: args.source })
      const p = ctx.project()
      if (p && p.handle.kind === 'video') await p.handle.live().reloadTransitions()
      return { text: `Saved as ${saved}. Use set_transition, then get_preview in the middle of it, to see if it works.` }
    }
    case 'check_job': {
      const j = currentJob()
      need(j, 'Nothing has been started yet.')
      if (j.state === 'running') return json({ state: 'running', what: j.title, done: j.done, total: j.total })
      if (j.state === 'done') return json({ state: 'done', what: j.title, ...j.result })
      if (j.state === 'cancelled') return json({ state: 'cancelled', what: j.title, message: 'It was cancelled. Nothing was changed.' })
      return json({ state: 'failed', what: j.title, message: j.error })
    }
    case 'cancel_job':
      return { text: cancelJob() ? 'Cancelling.' : 'Nothing that can be cancelled is running.' }
    default:
      return undefined
  }
}
