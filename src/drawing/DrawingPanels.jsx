import { useEffect, useRef, useState } from 'react'
import Icon from '../Icon.jsx'
import { BLEND_MODES } from './doc.js'
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

// ------------------------------------------------------------------------------------------------ layers
function LayerThumb({ layer, rev }) {
  const ref = useRef(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const g = cv.getContext('2d')
    g.clearRect(0, 0, cv.width, cv.height)
    const k = Math.min(cv.width / layer.canvas.width, cv.height / layer.canvas.height)
    const w = layer.canvas.width * k
    const h = layer.canvas.height * k
    g.drawImage(layer.canvas, (cv.width - w) / 2, (cv.height - h) / 2, w, h)
  }, [layer, rev])
  return <canvas ref={ref} width={44} height={30} className="dr-lthumb" />
}

export function LayersPanel({ doc, rev, open, setOpen, onAddPicture, busy }) {
  const [edit, setEdit] = useState(null)
  const [drag, setDrag] = useState(null)
  const rows = doc.layers.slice().reverse()
  const act = doc.active
  return (
    <aside className={'bin layers' + (open ? '' : ' collapsed')}>
      {!open && (
        <button className="collapse-strip" onClick={() => setOpen(true)} title="Show the layers">
          <Icon name="right" size={14} />
          <span>Layers</span>
        </button>
      )}
      <div className="panel-title">
        <span className="title-left">
          <button className="mini" onClick={() => setOpen(false)} title="Hide the layers"><Icon name="left" size={12} /></button>
          Layers
        </span>
      </div>
      <div className="btn-row layer-add">
        <button className="mini wide" onClick={() => doc.addLayer(null, { above: doc.activeId })} title="Add an empty layer above the chosen one">+ Layer</button>
        <button className="mini wide" onClick={onAddPicture} disabled={busy} title="Add a picture from your computer as a new layer (a reference, a photo to paint over...). You can also drop pictures onto the window.">+ Picture</button>
        <button className="mini wide" disabled={!act} onClick={() => act && doc.duplicateLayer(act.id)} title="Copy the chosen layer">Duplicate</button>
      </div>
      {act && (
        <div className="dr-layer-set">
          <div className="mtop">
            <span className="mlabel">Opacity {Math.round(act.opacity * 100)}%</span>
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round(act.opacity * 100)}
              onChange={(e) => doc.setLayer(act.id, { opacity: +e.target.value / 100 }, true)}
              onPointerUp={() => doc.endLive()}
              onKeyUp={() => doc.endLive()}
            />
          </div>
          <div className="mtop">
            <select value={act.blend} onChange={(e) => doc.setLayer(act.id, { blend: e.target.value })} title="How the layer mixes with the layers under it">
              {BLEND_MODES.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
            <button className={'mini' + (act.alphaLock ? ' on' : '')} onClick={() => doc.setLayer(act.id, { alphaLock: !act.alphaLock })} title="Alpha lock: painting only changes what is already painted on this layer">α lock</button>
          </div>
        </div>
      )}
      <div className="bin-list">
        {rows.map((l, i) => (
          <div
            key={l.id}
            className={'layer-row' + (l.id === doc.activeId ? ' selected' : '') + (!l.visible ? ' off' : '') + (drag && drag.over === l.id && drag.id !== l.id ? ' drop' : '')}
            draggable
            onDragStart={() => setDrag({ id: l.id, over: l.id })}
            onDragOver={(e) => {
              if (!drag) return
              e.preventDefault()
              if (drag.over !== l.id) setDrag({ ...drag, over: l.id })
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (drag && drag.id !== l.id) doc.moveLayerTo(drag.id, doc.layers.indexOf(doc.layer(l.id)))
              setDrag(null)
            }}
            onDragEnd={() => setDrag(null)}
            onClick={() => doc.setActive(l.id)}
          >
            <button className={'lyr-btn' + (!l.visible ? ' on' : '')} title={l.visible ? 'Hide this layer' : 'Show this layer'} onClick={(e) => (e.stopPropagation(), doc.setLayer(l.id, { visible: !l.visible }))}>
              <Icon name={l.visible ? 'eye' : 'eyeOff'} size={13} />
            </button>
            <LayerThumb layer={l} rev={rev} />
            {edit === l.id ? (
              <input
                className="lyr-name-in"
                autoFocus
                defaultValue={l.name}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  doc.setLayer(l.id, { name: e.target.value || l.name })
                  setEdit(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.target.blur()
                  if (e.key === 'Escape') setEdit(null)
                }}
              />
            ) : (
              <span className="lyr-name" onDoubleClick={() => setEdit(l.id)} title="Double-click to rename">{l.name}</span>
            )}
            <span className="lyr-op">{Math.round(l.opacity * 100)}%</span>
            <button className={'lyr-btn' + (l.locked ? ' on' : '')} title={l.locked ? 'Unlock this layer' : 'Lock this layer (it cannot be painted on)'} onClick={(e) => (e.stopPropagation(), doc.setLayer(l.id, { locked: !l.locked }))}>
              <Icon name={l.locked ? 'lock' : 'unlock'} size={13} />
            </button>
          </div>
        ))}
      </div>
      <div className="btn-row layer-foot">
        <button className="mini" disabled={!act} onClick={() => act && doc.moveLayer(act.id, 1)} title="Move the layer up">▲</button>
        <button className="mini" disabled={!act} onClick={() => act && doc.moveLayer(act.id, -1)} title="Move the layer down">▼</button>
        <button className="mini" disabled={!act || doc.layers.indexOf(act) === 0} onClick={() => act && doc.mergeDown(act.id)} title="Join the layer with the one under it">Merge down</button>
        <button className="mini" disabled={!act} onClick={() => act && doc.flipLayer(act.id, true)} title="Mirror the layer left to right">Flip</button>
        <button className="mini" disabled={!act} onClick={() => act && doc.removeLayer(act.id)} title="Delete the layer">Delete</button>
      </div>
    </aside>
  )
}

// ------------------------------------------------------------------------------------------------ export
export function ExportDrawingDialog({ doc, name, onClose, flash }) {
  const [fmt, setFmt] = useState('png')
  const [scale, setScale] = useState(1)
  const [quality, setQuality] = useState(92)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const go = async () => {
    setBusy(true)
    setErr('')
    try {
      const type = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[fmt]
      const data = await doc.exportBytes({ type, quality: quality / 100, scale })
      const file = await window.api.saveImage({ data, name, ext: fmt })
      if (file) {
        flash('Picture saved.')
        onClose()
      }
    } catch (e) {
      setErr(String((e && e.message) || e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="modal-bg">
      <div className="modal">
        <h3>Export picture</h3>
        <div className="mtop">
          <span className="mlabel">Format</span>
          <select value={fmt} onChange={(e) => setFmt(e.target.value)}>
            <option value="png">PNG (best quality, keeps see-through)</option>
            <option value="jpg">JPG (smaller file)</option>
            <option value="webp">WebP (small, keeps see-through)</option>
          </select>
        </div>
        <div className="mtop">
          <span className="mlabel">Size</span>
          <select value={scale} onChange={(e) => setScale(+e.target.value)}>
            {[0.25, 0.5, 1, 2].map((k) => (
              <option key={k} value={k}>{k === 1 ? 'Original' : `${k * 100}%`}</option>
            ))}
          </select>
          <span className="hint-sm">{Math.round(doc.w * scale)} × {Math.round(doc.h * scale)}</span>
        </div>
        {fmt !== 'png' && (
          <div className="mtop">
            <span className="mlabel">Quality {quality}%</span>
            <input type="range" min="40" max="100" value={quality} onChange={(e) => setQuality(+e.target.value)} />
          </div>
        )}
        {fmt === 'jpg' && doc.bg === 'transparent' && <p className="hint-sm">JPG cannot be see-through: the transparent parts become white.</p>}
        {err && <p className="hint-sm" style={{ color: 'var(--love, #eb6f92)' }}>{err}</p>}
        <div className="btn-row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={go} disabled={busy}>{busy ? 'Working…' : 'Save picture…'}</button>
        </div>
      </div>
    </div>
  )
}
