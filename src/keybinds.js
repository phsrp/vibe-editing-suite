// Rebindable keyboard shortcuts, saved in localStorage.
export const ACTIONS = [
  { id: 'save', label: 'Save project', def: 'Ctrl+S' },
  { id: 'saveAs', label: 'Save project as…', def: 'Ctrl+Shift+S' },
  { id: 'open', label: 'Open project…', def: 'Ctrl+O' },
  { id: 'split', label: 'Split / cut at playhead', def: 'S' },
  { id: 'text', label: 'Add text / a title at the playhead', def: 'T' },
  { id: 'record', label: 'Record a voice-over (press again to stop)', def: 'R' },
  { id: 'copy', label: 'Copy selected clips', def: 'Ctrl+C' },
  { id: 'paste', label: 'Paste at the playhead', def: 'Ctrl+V' },
  { id: 'duplicate', label: 'Duplicate selected clips', def: 'Ctrl+D' },
  { id: 'marker', label: 'Put a marker at the playhead', def: 'M' },
  { id: 'snap', label: 'Turn snapping on / off', def: 'N' },
  { id: 'ripple', label: 'Close gaps after deleting: on / off', def: 'G' },
  { id: 'fit', label: 'Zoom to fit the whole project', def: 'Shift+F' },
  { id: 'freeze', label: 'Freeze frame at playhead', def: 'F' },
  { id: 'group', label: 'Group selected', def: 'Ctrl+G' },
  { id: 'ungroup', label: 'Ungroup selected / detach audio', def: 'Ctrl+Shift+G' },
  { id: 'playPause', label: 'Play / pause', def: 'Space' },
  { id: 'delete', label: 'Delete selected clip', def: 'Delete' },
  { id: 'undo', label: 'Undo', def: 'Ctrl+Z' },
  { id: 'redo', label: 'Redo', def: 'Ctrl+Y' },
  { id: 'stepBack', label: 'Step back 1 frame', def: 'ArrowLeft' },
  { id: 'stepForward', label: 'Step forward 1 frame', def: 'ArrowRight' },
  { id: 'goStart', label: 'Go to start', def: 'Home' },
]

const KEY = 'vibe.keybinds'

export function loadBinds() {
  const binds = Object.fromEntries(ACTIONS.map((a) => [a.id, a.def]))
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}')
    // only shortcuts that still exist (the old Export shortcut is gone: Export is its own tab now)
    for (const id of Object.keys(binds)) if (saved[id]) binds[id] = saved[id]
  } catch {}
  return binds
}

export function saveBinds(binds) {
  try {
    localStorage.setItem(KEY, JSON.stringify(binds))
  } catch {}
}

// Turns a keydown event into a string like "Ctrl+Shift+S". Returns null for bare modifier presses.
export function comboOf(e) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null
  let k = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key
  if (k === 'Backspace') k = 'Delete'
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean)
  return [...mods, k].join('+')
}

export function actionFor(binds, e) {
  const c = comboOf(e)
  if (!c) return null
  const hit = Object.entries(binds).find(([, v]) => v === c)
  // Ctrl+Shift+Z is a common alternative redo
  if (!hit && c === 'Ctrl+Shift+Z') return 'redo'
  return hit ? hit[0] : null
}
