import { useEffect, useRef, useState } from 'react'
import Icon from '../Icon.jsx'
import { Stroke, hexToRgb, rgbToHex, hsvToRgb, rgbToHsv } from './engine.js'
import { brushPreview } from './builtinBrushes.js'

// ------------------------------------------------------------------------------------------------ colour
const SWATCHES = ['#000000', '#ffffff', '#6e6a86', '#eb6f92', '#f6c177', '#ebbcba', '#31748f', '#9ccfd8', '#c4a7e7', '#26233a', '#e0def4', '#907aa9', '#b4637a', '#ea9d34', '#56949f', '#286983']

export function ColourPicker({ fg, bg, setFg, setBg, swap, recent }) {
  const [editing, setEditing] = useState('fg') // which of the two colours the picker changes
  const cur = editing === 'fg' ? fg : bg
  const set = editing === 'fg' ? setFg : setBg
  const [hsv, setHsv] = useState(() => rgbToHsv(...hexToRgb(cur)))
  const svRef = useRef(null)
  const drag = useRef(null)
  // follow outside changes (eyedropper, swapping)
  const lastOwn = useRef(cur)
  useEffect(() => {
    if (cur.toLowerCase() !== lastOwn.current.toLowerCase()) {
      const [r, g, b] = hexToRgb(cur)
      const n = rgbToHsv(r, g, b)
      setHsv(n[1] === 0 || n[2] === 0 ? [hsv[0], n[1], n[2]] : n)
      lastOwn.current = cur
    }
  }, [cur])
  const apply = (h, s, v) => {
    setHsv([h, s, v])
    const hex = rgbToHex(...hsvToRgb(h, s, v))
    lastOwn.current = hex
    set(hex)
  }
  // the saturation / brightness square
  useEffect(() => {
    const cv = svRef.current
    if (!cv) return
    const g = cv.getContext('2d')
    const w = cv.width
    const h = cv.height
    g.fillStyle = `hsl(${hsv[0]}, 100%, 50%)`
    g.fillRect(0, 0, w, h)
    const gw = g.createLinearGradient(0, 0, w, 0)
    gw.addColorStop(0, '#fff')
    gw.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = gw
    g.fillRect(0, 0, w, h)
    const gb = g.createLinearGradient(0, 0, 0, h)
    gb.addColorStop(0, 'rgba(0,0,0,0)')
    gb.addColorStop(1, '#000')
    g.fillStyle = gb
    g.fillRect(0, 0, w, h)
  }, [hsv[0]])
  const pickSv = (e) => {
    const r = svRef.current.getBoundingClientRect()
    const s = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
    const v = 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))
    apply(hsv[0], s, v)
  }
  return (
    <div className="dr-colour">
      <div className="dr-sv-wrap">
        <canvas
          ref={svRef}
          width={220}
          height={150}
          className="dr-sv"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = true
            pickSv(e)
          }}
          onPointerMove={(e) => drag.current && pickSv(e)}
          onPointerUp={() => (drag.current = false)}
        />
        <span className="dr-sv-dot" style={{ left: hsv[1] * 100 + '%', top: (1 - hsv[2]) * 100 + '%' }} />
      </div>
      <input type="range" className="dr-hue" min="0" max="360" step="1" value={Math.round(hsv[0])} onChange={(e) => apply(+e.target.value, hsv[1], hsv[2])} />
      <div className="dr-colour-row">
        <div className="dr-swatches2">
          <button className={'dr-big' + (editing === 'bg' ? ' on' : '')} style={{ background: bg }} title="Background colour (click to edit it)" onClick={() => setEditing('bg')} />
          <button className={'dr-big front' + (editing === 'fg' ? ' on' : '')} style={{ background: fg }} title="Brush colour (click to edit it)" onClick={() => setEditing('fg')} />
        </div>
        <button className="mini" onClick={swap} title="Swap the two colours (X)">⇄</button>
        <input
          className="dr-hex"
          value={cur}
          spellCheck={false}
          onChange={(e) => {
            const v = e.target.value
            if (/^#[0-9a-fA-F]{6}$/.test(v)) {
              lastOwn.current = v
              set(v)
              setHsv(rgbToHsv(...hexToRgb(v)))
            }
          }}
        />
      </div>
      <div className="dr-swatches">
        {SWATCHES.map((c) => (
          <button key={c} style={{ background: c }} title={c} onClick={() => (setFg(c), setEditing('fg'))} />
        ))}
      </div>
      {recent.length > 0 && (
        <div className="dr-swatches recent" title="Colours you used lately">
          {recent.map((c) => (
            <button key={c} style={{ background: c }} title={c} onClick={() => setFg(c)} />
          ))}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ brushes
function BrushThumb({ brush }) {
  const ref = useRef(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const g = cv.getContext('2d')
    g.clearRect(0, 0, cv.width, cv.height)
    try {
      if (!brush._thumb) brush._thumb = brushPreview(brush, Stroke, cv.width, cv.height)
      g.drawImage(brush._thumb, 0, 0)
    } catch {}
  }, [brush])
  return <canvas ref={ref} width={120} height={38} className="dr-bthumb" />
}

export function BrushList({ builtin, packs, current, onPick, onImport, onRemovePack, busy }) {
  const [open, setOpen] = useState({})
  const [filter, setFilter] = useState('')
  const f = filter.trim().toLowerCase()
  const match = (b) => !f || b.name.toLowerCase().includes(f)
  const group = (key, title, list, extra) => {
    const shown = list.filter(match)
    if (f && !shown.length) return null
    const isOpen = f ? true : open[key] !== false
    return (
      <div className="dr-group" key={key}>
        <button className="dr-group-head" onClick={() => setOpen({ ...open, [key]: !isOpen })}>
          <Icon name="right" size={11} className={isOpen ? 'rot' : ''} />
          <span>{title}</span>
          <em>{shown.length}</em>
          {extra}
        </button>
        {isOpen &&
          shown.map((b) => (
            <button key={b.id} className={'dr-brush' + (current && current.id === b.id ? ' on' : '')} onClick={() => onPick(b)} title={b.note || b.name}>
              <BrushThumb brush={b} />
              <span className="dr-bname">{b.name}{b.approximate ? ' ≈' : ''}</span>
            </button>
          ))}
      </div>
    )
  }
  return (
    <div className="dr-brushes">
      <div className="btn-row" style={{ marginBottom: 6 }}>
        <input className="dr-filter" placeholder="Find a brush…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="mini" onClick={onImport} disabled={busy} title="Add Krita brush packs (.bundle or .kpp files)">+ Krita pack</button>
      </div>
      {group('builtin', 'Built-in', builtin)}
      {packs.map((p) =>
        group(
          'p:' + p.file,
          p.title || p.file,
          p.brushes,
          <span className="dr-pack-x" role="button" title={`Remove this pack from the editor${p.skipped && p.skipped.length ? ` (${p.skipped.length} brushes of it use engines that are not supported)` : ''}`} onClick={(e) => { e.stopPropagation(); onRemovePack(p) }}>
            <Icon name="x" size={11} />
          </span>
        )
      )}
      {!packs.length && <div className="hint-sm">Krita brush packs (.bundle) and single brushes (.kpp) can be added with “+ Krita pack”. Brushes marked ≈ are close copies.</div>}
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ the tool panel
// a labelled slider; log = the middle of the slider is a small value (for sizes)
function Slider({ label, value, min, max, unit = '', onChange, log = false }) {
  const toPos = (v) => (log ? Math.round((Math.log(v / min) / Math.log(max / min)) * 1000) : v)
  const fromPos = (p) => (log ? Math.max(min, Math.min(max, Math.round(min * Math.pow(max / min, p / 1000)))) : p)
  return (
    <div className="mtop dr-slider">
      <span className="mlabel">{label} <b>{value}{unit}</b></span>
      <input type="range" min={log ? 0 : min} max={log ? 1000 : max} value={toPos(value)} onChange={(e) => onChange(fromPos(+e.target.value))} />
    </div>
  )
}

// What the right-hand panel of the picture editor shows while a painting, fill, eyedropper or selection tool is chosen:
// colours, the tool's settings and the brushes. `sel` / `selActions` = the selection and what can be done with it.
export function PaintPanel({ tool, kit, sel, selActions }) {
  const { opts, setOpts, gpu, models, dl, dlErr, downloadModel } = kit
  const shapeTool = ['line', 'rect', 'ellipse'].includes(tool)
  const showSize = ['brush', 'eraser', 'smudge', 'line', 'rect', 'ellipse'].includes(tool)
  const selButtons = (
    <div className="btn-row" style={{ flexWrap: 'wrap' }}>
      <button className="mini" onClick={selActions.all}>Select all</button>
      <button className="mini" onClick={selActions.none} disabled={!sel}>Deselect</button>
      <button className="mini" onClick={selActions.invert} disabled={!sel}>Invert</button>
    </div>
  )
  return (
    <div className="paint-panel">
      <ColourPicker fg={kit.fg} bg={kit.bg} setFg={kit.setFg} setBg={kit.setBg} swap={kit.swap} recent={kit.recent} />
      {showSize && (
        <div className="dr-opts">
          <Slider label="Size" value={opts.size} min={1} max={1000} unit=" px" onChange={(v) => setOpts({ size: v })} log />
          {tool !== 'smudge' && <Slider label="Opacity" value={Math.round(opts.opacity * 100)} min={1} max={100} unit="%" onChange={(v) => setOpts({ opacity: v / 100 })} />}
          {tool === 'smudge' ? (
            <Slider label="Strength" value={Math.round(opts.flow * 100)} min={5} max={100} unit="%" onChange={(v) => setOpts({ flow: v / 100 })} />
          ) : (
            <Slider label="Flow" value={Math.round(opts.flow * 100)} min={1} max={100} unit="%" onChange={(v) => setOpts({ flow: v / 100 })} />
          )}
          {tool !== 'smudge' && !shapeTool && <Slider label="Smoothing" value={Math.round(opts.smoothing * 100)} min={0} max={100} unit="%" onChange={(v) => setOpts({ smoothing: v / 100 })} />}
          {tool !== 'smudge' && <Slider label="Spacing" value={Math.round(opts.spacing * 100)} min={25} max={400} unit="%" onChange={(v) => setOpts({ spacing: v / 100 })} />}
          <div className="mtop">
            <label className="chk"><input type="checkbox" checked={opts.mirrorX} onChange={(e) => setOpts({ mirrorX: e.target.checked })} /> Mirror left–right</label>
          </div>
          <div className="mtop">
            <label className="chk"><input type="checkbox" checked={opts.mirrorY} onChange={(e) => setOpts({ mirrorY: e.target.checked })} /> Mirror up–down</label>
          </div>
        </div>
      )}
      {(tool === 'rect' || tool === 'ellipse') && (
        <div className="mtop">
          <span className="mlabel">Fill</span>
          <select value={opts.shapeFill} onChange={(e) => setOpts({ shapeFill: e.target.value })}>
            <option value="none">Outline only</option>
            <option value="fg">Fill with the brush colour</option>
            <option value="bg">Fill with the background colour</option>
          </select>
        </div>
      )}
      {shapeTool && <div className="hint-sm">Drag to draw. Shift = straight / square / circle. Alt = from the centre (rectangle, ellipse).</div>}
      {tool === 'fill' && (
        <div className="dr-opts">
          <Slider label="Tolerance" value={Math.round(opts.fillTol * 100)} min={0} max={100} unit="%" onChange={(v) => setOpts({ fillTol: v / 100 })} />
          <div className="mtop">
            <label className="chk"><input type="checkbox" checked={opts.fillAll} onChange={(e) => setOpts({ fillAll: e.target.checked })} /> Look at all layers</label>
          </div>
          <div className="hint-sm">Fills the area you click, up to the lines on the layer (or on all layers).</div>
        </div>
      )}
      {tool === 'select' && (
        <div className="dr-opts">
          <div className="mtop">
            <span className="mlabel">Shape</span>
            <select value={opts.selShape} onChange={(e) => setOpts({ selShape: e.target.value })}>
              <option value="rect">Rectangle</option>
              <option value="ellipse">Ellipse</option>
              <option value="lasso">Freehand</option>
            </select>
          </div>
          {selButtons}
          <div className="hint-sm">
            <b>Click a line or shape</b> on a paint layer to select it. Drag in empty space to select an area. Then drag the selection to <b>move</b> what is in it (hold Alt to move a copy), or use the arrow keys.
            Ctrl+C / Ctrl+X / Ctrl+V copy, cut and paste. Painting and fills stay inside the selection. Shift adds to it, Alt takes away.
          </div>
        </div>
      )}
      {tool === 'lasso' && (
        <div className="dr-opts">
          <div className="hint-sm">Draw around what you want and let go. Then drag inside the selection to <b>move those pixels</b> (hold Alt to move a copy). Shift adds another area, Alt takes one away.</div>
          {selButtons}
        </div>
      )}
      {tool === 'smart' && (
        <div className="dr-opts">
          <div className="hint-sm">Click the thing you want, or draw a <b>rough</b> box (or loop) around it: the AI finds its exact edge. Then drag it to move it. Shift adds, Alt takes away.</div>
          <div className="mtop">
            <span className="mlabel">Drag draws</span>
            <select value={opts.smartShape} onChange={(e) => setOpts({ smartShape: e.target.value })}>
              <option value="box">A box</option>
              <option value="loop">A loose loop</option>
            </select>
          </div>
          <div className="mtop">
            <label className="chk"><input type="checkbox" checked={!!opts.smartLayerOnly} onChange={(e) => setOpts({ smartLayerOnly: e.target.checked })} /> Look at this paint layer only</label>
          </div>
          {gpu && !gpu.ok && <div className="hint warn">This computer does not seem to have a usable graphics card, so smart select cannot run here. The lasso and the select tool still work.</div>}
          {gpu && gpu.ok && gpu.weak && <div className="hint warn">This computer’s graphics ({gpu.name || 'basic integrated graphics'}) look basic: smart select will run, but slowly.</div>}
          {gpu && gpu.ok && !(models && models.ready) && (
            <>
              <div className="hint-sm">Smart select uses an AI model (about {models ? Math.round(models.totalBytes / 1e6) : 112} MB). It is downloaded once from the internet and then works without it.</div>
              {dl ? (
                <>
                  <div className="bar"><div className="bar-fill" style={{ width: Math.min(100, (dl.received / Math.max(1, dl.total)) * 100) + '%' }} /></div>
                  <div className="hint-sm">Downloading… {Math.round((dl.received / Math.max(1, dl.total)) * 100)}%</div>
                </>
              ) : (
                <button className="mini wide" onClick={downloadModel}><Icon name="download" size={13} /> Download the AI model</button>
              )}
              {dlErr && <div className="hint warn">{dlErr}</div>}
            </>
          )}
          {gpu && gpu.ok && models && models.ready && <div className="hint-sm">The AI model is ready.</div>}
          {selButtons}
        </div>
      )}
      {tool === 'eyedropper' && <div className="hint-sm">Click to take a colour from the picture. With any brush, hold Alt and click to do the same.</div>}
      {tool !== 'eyedropper' && tool !== 'fill' && !['select', 'lasso', 'smart'].includes(tool) && (
        <>
          <div className="dr-sec">Brushes</div>
          <BrushList builtin={kit.builtin} packs={kit.packs} current={kit.brush} onPick={kit.pickBrush} onImport={kit.importPacks} onRemovePack={kit.removePack} busy={kit.busy} />
          <div className="dr-sec">Pen</div>
          <Slider label="Mouse pressure" value={Math.round(opts.mousePressure * 100)} min={10} max={100} unit="%" onChange={(v) => setOpts({ mousePressure: v / 100 })} />
          <div className="hint-sm">A pen tablet gives real pressure and tilt. A mouse has none, so this is the pressure used instead.</div>
        </>
      )}
    </div>
  )
}