import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import { rowKeys, overlayLayout, toUrl, uid } from './state.js'
import { rasterEntry } from './paint/raster.js'

// a small picture of a layer of pixels (looked at again when its pixels change)
function RasterThumb({ clip }) {
  const ref = useRef(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const e = rasterEntry(clip)
    const g = cv.getContext('2d')
    g.clearRect(0, 0, cv.width, cv.height)
    const k = Math.min(cv.width / e.w, cv.height / e.h)
    g.drawImage(e.canvas, (cv.width - e.w * k) / 2, (cv.height - e.h * k) / 2, e.w * k, e.h * k)
  }, [clip.raster.rev, clip.raster.id])
  return <canvas ref={ref} width={44} height={30} className="dr-lthumb" />
}

// The layers of an image project, top layer first. Click to choose, drag to reorder, double-click a name to rename.
export default function LayersPanel({ state, dispatch, open, setOpen, onAddPicture, busy }) {
  const [edit, setEdit] = useState(null) // layer id whose name is being typed
  const [drag, setDrag] = useState(null) // { id, over }
  const over = useRef(null)
  const clips = overlayLayout(state.overlayClips)
  const rows = rowKeys(state)
    .filter((k) => k.startsWith('v:'))
    .map((k) => ({ key: k, clip: clips.find((c) => 'v:' + c.trackId === k), track: state.videoTracks.find((t) => 'v:' + t.id === k) }))
    .filter((r) => r.clip && r.track)
  const sel = new Set(state.selection)

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
        <button className="mini wide" onClick={onAddPicture} disabled={busy} title="Add a picture from your computer as a new layer">+ Picture</button>
        <button className="mini wide" onClick={() => dispatch({ type: 'imgAddRaster', id: uid(), rasterId: uid() })} title="Add an empty layer of pixels to paint on">+ Layer</button>
        <button className="mini wide" onClick={() => dispatch({ type: 'imgAddText' })} title="Add a text layer">+ Text</button>
      </div>
      <div className="bin-list">
        {rows.length === 0 && <div className="hint">No layers yet. Add a picture, a paint layer or some text.</div>}
        {rows.map(({ key, clip, track }, i) => {
          const m = state.media.find((x) => x.id === clip.mediaId)
          const hidden = (state.hiddenRows || []).includes(key)
          const locked = (state.lockedRows || []).includes(key)
          const kind = clip.text ? 'T' : clip.paint || clip.raster ? 'pen' : 'img'
          return (
            <div
              key={key}
              className={'layer-row' + (sel.has(clip.id) ? ' selected' : '') + (hidden ? ' off' : '') + (drag && drag.over === i && drag.id !== clip.id ? ' drop' : '')}
              draggable={!locked}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/vibe-layer', clip.id)
                setDrag({ id: clip.id, over: i })
              }}
              onDragOver={(e) => {
                if (!drag) return
                e.preventDefault()
                over.current = i
                if (drag.over !== i) setDrag({ ...drag, over: i })
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (drag) dispatch({ type: 'imgMoveTo', id: drag.id, index: i })
                setDrag(null)
              }}
              onDragEnd={() => setDrag(null)}
              onClick={(e) => dispatch({ type: 'select', id: clip.id, additive: e.ctrlKey || e.shiftKey })}
            >
              <button className={'lyr-btn' + (hidden ? ' on' : '')} title={hidden ? 'Show this layer' : 'Hide this layer'} onClick={(e) => { e.stopPropagation(); dispatch({ type: 'toggleRowHide', key }) }}>
                <Icon name={hidden ? 'eyeOff' : 'eye'} size={13} />
              </button>
              {clip.raster ? (
                <RasterThumb clip={clip} />
              ) : (
                <div className="lyr-thumb" style={{ backgroundImage: m && m.thumb ? `url("${toUrl(m.thumb)}")` : undefined }}>
                  {kind === 'T' && <b>T</b>}
                  {kind === 'pen' && <Icon name="wand" size={14} />}
                </div>
              )}
              {edit === clip.id ? (
                <input
                  className="lyr-name-in"
                  autoFocus
                  defaultValue={track.name}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    dispatch({ type: 'renameRow', key, name: e.target.value })
                    setEdit(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.target.blur()
                    if (e.key === 'Escape') setEdit(null)
                  }}
                />
              ) : (
                <span className="lyr-name" onDoubleClick={() => setEdit(clip.id)} title="Double-click to rename">{track.name}</span>
              )}
              <span className="lyr-op" title="Opacity">{Math.round(clip.tf && clip.tf.opacity != null ? clip.tf.opacity : 100)}%</span>
              <button className={'lyr-btn' + (locked ? ' on' : '')} title={locked ? 'Unlock this layer' : 'Lock this layer (it cannot be changed)'} onClick={(e) => { e.stopPropagation(); dispatch({ type: 'toggleRowLock', key }) }}>
                <Icon name={locked ? 'lock' : 'unlock'} size={13} />
              </button>
            </div>
          )
        })}
      </div>
      <div className="btn-row layer-foot">
        <button className="mini" disabled={!state.selection.length} onClick={() => state.selection.forEach((id) => dispatch({ type: 'imgMove', id, to: 'up' }))} title="Move the layer up">▲</button>
        <button className="mini" disabled={!state.selection.length} onClick={() => state.selection.forEach((id) => dispatch({ type: 'imgMove', id, to: 'down' }))} title="Move the layer down">▼</button>
        <button className="mini" disabled={!state.selection.length} onClick={() => state.selection.forEach((id) => dispatch({ type: 'imgDuplicate', id }))} title="Duplicate the layer">Duplicate</button>
        <button className="mini" disabled={!state.selection.length} onClick={() => state.selection.forEach((id) => dispatch({ type: 'imgRemove', id }))} title="Delete the layer (Delete key)">Delete</button>
      </div>
    </aside>
  )
}
