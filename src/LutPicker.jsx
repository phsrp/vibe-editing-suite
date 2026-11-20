import { useEffect, useState } from 'react'
import Icon from './Icon.jsx'
import { BUILTIN_LUTS, loadLut, lutError, forgetLut } from './luts.js'

// Choose a LUT (a colour look from a .cube file, or one of the built-in looks) and how strong it is.
// value = fx.lut or undefined; onChange(patch) gets {file, mix} or null (no LUT); onStart before a live slider drag.
export default function LutPicker({ value, onChange, onStart, onLive }) {
  const [files, setFiles] = useState([])
  const [err, setErr] = useState(null)
  const refresh = () => window.api.listLuts().then(setFiles).catch(() => setFiles([]))
  useEffect(() => {
    refresh()
  }, [])
  const file = value && value.file
  const mix = value ? value.mix ?? 100 : 100
  useEffect(() => {
    if (!file) return setErr(null)
    loadLut(file).then(() => setErr(lutError(file)))
  }, [file])
  const add = async () => {
    const names = await window.api.importLuts()
    if (!names || !names.length) return
    names.forEach(forgetLut)
    await refresh()
    onChange({ file: names[0], mix })
  }
  return (
    <div className="lut-picker">
      <div className="lut-row">
        <select value={file || ''} onChange={(e) => onChange(e.target.value ? { file: e.target.value, mix } : null)} title="A colour look. Built-in looks come with the editor; add your own .cube files with the + button.">
          <option value="">No LUT</option>
          <optgroup label="Built in">
            {BUILTIN_LUTS.map((l) => (
              <option key={l.file} value={l.file}>{l.name}</option>
            ))}
          </optgroup>
          {files.length > 0 && (
            <optgroup label="Your LUTs">
              {files.map((l) => (
                <option key={l.file} value={l.file}>{l.name}</option>
              ))}
            </optgroup>
          )}
          {file && !file.startsWith('builtin:') && !files.some((l) => l.file === file) && <option value={file}>{file} (missing)</option>}
        </select>
        <button className="mini" onClick={add} title="Add .cube LUT files (they are copied into the editor's LUT folder)"><Icon name="plus" size={12} /></button>
        <button className="mini" onClick={() => window.api.lutsFolder()} title="Open the LUT folder"><Icon name="folder" size={12} /></button>
      </div>
      {file && (
        <label className="lut-mix">
          <span>Strength</span>
          <input type="range" min="0" max="100" value={mix} onPointerDown={onStart} onChange={(e) => (onLive || onChange)({ file, mix: +e.target.value })} />
          <span className="lut-val">{mix}%</span>
        </label>
      )}
      {err && <div className="hint warn">{err}</div>}
    </div>
  )
}
