// Rebindable keyboard shortcuts, saved in localStorage.
// group = the section it is listed under in the Keyboard shortcuts window
export const ACTIONS = [
  { group: 'Project', id: 'save', label: 'Save project', def: 'Ctrl+S' },
  { group: 'Project', id: 'saveAs', label: 'Save project as…', def: 'Ctrl+Shift+S' },
  { group: 'Project', id: 'open', label: 'Open project…', def: 'Ctrl+O' },
  { group: 'Project', id: 'exportSel', label: 'Export the selected clips', def: 'Ctrl+E' },
  { group: 'Playback', id: 'playPause', label: 'Play / pause', def: 'Space' },
  { group: 'Playback', id: 'shuttleBack', label: 'Play backwards (press again: faster; hold K: one frame back)', def: 'J' },
  { group: 'Playback', id: 'shuttleStop', label: 'Stop (J / K / L)', def: 'K' },
  { group: 'Playback', id: 'shuttleForward', label: 'Play forwards (press again: faster; hold K: one frame on)', def: 'L' },
  { group: 'Playback', id: 'stepBack', label: 'Step back 1 frame', def: 'ArrowLeft' },
  { group: 'Playback', id: 'stepForward', label: 'Step forward 1 frame', def: 'ArrowRight' },
  { group: 'Playback', id: 'goStart', label: 'Go to start', def: 'Home' },
  { group: 'In and Out', id: 'markIn', label: 'Mark In at the playhead', def: 'I' },
  { group: 'In and Out', id: 'markOut', label: 'Mark Out at the playhead', def: 'O' },
  { group: 'In and Out', id: 'goIn', label: 'Go to the In mark', def: 'Shift+I' },
  { group: 'In and Out', id: 'goOut', label: 'Go to the Out mark', def: 'Shift+O' },
  { group: 'In and Out', id: 'clearMarks', label: 'Clear the In and Out marks', def: 'Ctrl+Shift+X' },
  { group: 'In and Out', id: 'playInOut', label: 'Play from In to Out', def: 'Ctrl+Shift+Space' },
  { group: 'In and Out', id: 'lift', label: 'Lift: remove between In and Out, leave the space empty', def: ';' },
  { group: 'In and Out', id: 'extract', label: 'Extract: remove between In and Out and close the space', def: "'" },
  { group: 'Timeline tools', id: 'toolSelect', label: 'Tool: select and move (normal)', def: 'V' },
  { group: 'Timeline tools', id: 'toolRipple', label: 'Tool: ripple trim (what comes after moves along)', def: 'B' },
  { group: 'Timeline tools', id: 'toolRoll', label: 'Tool: roll (move the cut between two clips)', def: 'Shift+B' },
  { group: 'Timeline tools', id: 'toolSlip', label: 'Tool: slip (show another part of the file in the same place)', def: 'Y' },
  { group: 'Timeline tools', id: 'toolSlide', label: 'Tool: slide (move a clip between its neighbours)', def: 'U' },
  { group: 'Editing', id: 'undo', label: 'Undo', def: 'Ctrl+Z' },
  { group: 'Editing', id: 'redo', label: 'Redo', def: 'Ctrl+Y' },
  { group: 'Editing', id: 'split', label: 'Split / cut at playhead', def: 'S' },
  { group: 'Editing', id: 'delete', label: 'Delete selected clip', def: 'Delete' },
  { group: 'Editing', id: 'copy', label: 'Copy selected clips', def: 'Ctrl+C' },
  { group: 'Editing', id: 'paste', label: 'Paste at the playhead', def: 'Ctrl+V' },
  { group: 'Editing', id: 'duplicate', label: 'Duplicate selected clips', def: 'Ctrl+D' },
  { group: 'Clips', id: 'freeze', label: 'Freeze frame at playhead', def: 'F' },
  { group: 'Clips', id: 'group', label: 'Group selected', def: 'Ctrl+G' },
  { group: 'Clips', id: 'ungroup', label: 'Ungroup selected / detach audio', def: 'Ctrl+Shift+G' },
  { group: 'Clips', id: 'nest', label: 'Nest the selected clips (make them one clip)', def: 'Alt+N' },
  { group: 'Adding', id: 'text', label: 'Add text / a title at the playhead', def: 'T' },
  { group: 'Adding', id: 'record', label: 'Record a voice-over (press again to stop)', def: 'R' },
  { group: 'Adding', id: 'marker', label: 'Put a marker at the playhead', def: 'M' },
  { group: 'Timeline view', id: 'snap', label: 'Turn snapping on / off', def: 'N' },
  { group: 'Timeline view', id: 'ripple', label: 'Close gaps after deleting: on / off', def: 'G' },
  { group: 'Timeline view', id: 'fit', label: 'Zoom to fit the whole project', def: 'Shift+F' },
  { group: 'Timeline view', id: 'videoTaller', label: 'Make the video tracks taller', def: 'Ctrl+=' },
  { group: 'Timeline view', id: 'videoShorter', label: 'Make the video tracks shorter', def: 'Ctrl+-' },
  { group: 'Timeline view', id: 'audioTaller', label: 'Make the sound tracks taller', def: 'Alt+=' },
  { group: 'Timeline view', id: 'audioShorter', label: 'Make the sound tracks shorter', def: 'Alt+-' },
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
