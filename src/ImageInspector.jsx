import Icon from './Icon.jsx'
import { soleVideoClip, overlayLayout, aspectRatio, clipPicture, isLocked } from './state.js'
import { PROPS, evalProp } from './motion.js'
import { CC_SLIDERS, CC_DEFAULTS, CC_PRESETS } from './effects.js'
import { TextPanel, MaskPanel, EffectsPanel, FxSlider, Section } from './Inspector.jsx'
import { PaintPanel } from './paint/PaintPanels.jsx'
import { BLEND_LIST } from './glRenderer.js'
import { PIXEL_TOOLS } from './paint/usePaintKit.js'

const SIZES = [
  { label: 'Square 1080', w: 1080, h: 1080 },
  { label: 'Full HD 1920×1080', w: 1920, h: 1080 },
  { label: 'Phone 1080×1920', w: 1080, h: 1920 },
  { label: 'Portrait 1080×1350', w: 1080, h: 1350 },
  { label: '4K 3840×2160', w: 3840, h: 2160 },
  { label: 'A4 2480×3508', w: 2480, h: 3508 },
]

// Position, scale, stretch, rotation and opacity of a layer (no keyframes in the image editor)
function TransformPanel({ clip, dispatch, mode, setMode, freeMode, setFreeMode, fill }) {
  const warped = !!clip.warp && (clip.warp.fixed || []).some((v) => v !== 0)
  return (
    <Section id="transform" title="Transform">
      <div className="mtop btnrow">
        <button className={'mini wide' + (mode === 'transform' ? ' on' : '')} onClick={() => setMode(mode === 'transform' ? 'none' : 'transform')} title="Show the box on the picture: drag inside to move, drag a corner to resize, drag the round handle to rotate">
          {mode === 'transform' ? 'Hide box' : 'Show box'}
        </button>
        <button className={'mini wide' + (freeMode ? ' on' : '')} onClick={() => setFreeMode(!freeMode)} title="Free transform: the corners stretch the picture wider or taller instead of keeping its shape">
          Free transform
        </button>
        <button className={'mini wide' + (mode === 'warp' ? ' on' : '')} onClick={() => setMode(mode === 'warp' ? 'transform' : 'warp')} title="Funny warp: drag the four corners of the picture anywhere to bend it">
          Funny warp
        </button>
      </div>
      {fill && Math.abs(fill - 100) > 0.5 && (
        <div className="mtop btnrow">
          <button className="mini wide" onClick={() => dispatch({ type: 'setProp', id: clip.id, prop: 'scale', value: Math.round(fill * 10) / 10, t: 0 })} title="Make the picture big enough to cover the whole canvas (the edges are cropped)">Fill the canvas</button>
          <button className="mini wide" onClick={() => dispatch({ type: 'setProp', id: clip.id, prop: 'scale', value: 100, t: 0 })} title="Show the whole picture inside the canvas">Fit in the canvas</button>
        </div>
      )}
      {PROPS.filter((p) => !p.mask).map((p) => {
        const val = evalProp(clip, p.id, 0)
        const set = (v) => dispatch({ type: 'setProp', id: clip.id, prop: p.id, value: v, t: 0 })
        return (
          <div className="mrow" key={p.id}>
            <div className="mtop"><span className="mlabel">{p.label}</span></div>
            <div className="minput">
              <input type="range" min={p.min} max={p.max} step={p.step} value={Math.min(p.max, Math.max(p.min, val))} onPointerDown={() => dispatch({ type: 'checkpoint' })} onChange={(e) => set(+e.target.value)} />
              <input type="number" step={p.step} value={Math.round(val * 100) / 100} onFocus={() => dispatch({ type: 'checkpoint' })} onChange={(e) => e.target.value !== '' && set(+e.target.value)} />
              <span className="unit">{p.unit}</span>
            </div>
          </div>
        )
      })}
      <div className="mtop btnrow">
        <button className="mini wide" onClick={() => PROPS.filter((p) => !p.mask).forEach((p) => dispatch({ type: 'clearProp', id: clip.id, prop: p.id }))} title="Put position, size, rotation and opacity back">Reset transform</button>
        {warped && <button className="mini wide" onClick={() => dispatch({ type: 'warpReset', id: clip.id })} title="Remove the warp">Reset warp</button>}
      </div>
    </Section>
  )
}

// brightness, contrast, saturation, warmth and so on, right here (the video editor has a Colour tab for this)
function ColourPanel({ clip, dispatch }) {
  const cc = { ...CC_DEFAULTS, ...((clip.fx && clip.fx.cc) || {}) }
  const start = () => dispatch({ type: 'checkpoint' })
  const set = (patch) => dispatch({ type: 'setFx', id: clip.id, patch: { cc: patch }, live: true })
  const changed = CC_SLIDERS.some((s) => cc[s.id] !== s.def)
  return (
    <Section id="colour" title="Colour correction">
      <div className="mtop btnrow">
        {CC_PRESETS.map((p) => (
          <button key={p.name} className="mini wide" onClick={() => dispatch({ type: 'setFx', id: clip.id, patch: { cc: { ...CC_DEFAULTS, ...p.cc } } })}>{p.name}</button>
        ))}
      </div>
      {CC_SLIDERS.map((s) => (
        <FxSlider key={s.id} label={s.label} value={cc[s.id]} min={s.min} max={s.max} onStart={start} onChange={(v) => set({ [s.id]: v })} />
      ))}
      {changed && <button className="mini wide" onClick={() => dispatch({ type: 'resetFx', id: clip.id, only: 'cc' })}>Reset colours</button>}
    </Section>
  )
}

export default function ImageInspector({ state, dispatch, mode, setMode, freeMode, setFreeMode, tool, kit, sel, selActions, layerActions, open = true, setOpen }) {
  const id = soleVideoClip(state)
  const clip = id && overlayLayout(state.overlayClips).find((c) => c.id === id)
  const ratio = aspectRatio(state)
  const pic = clip && clipPicture(state, clip, ratio)
  const pw = pic && pic.width && pic.height ? pic.width / pic.height : null
  const fill = pw ? 100 * Math.max(ratio / pw, pw / ratio) : null
  const set = (patch) => dispatch({ type: 'setCanvas', patch })
  const locked = !!clip && isLocked(state, clip.id)
  const paintTool = PIXEL_TOOLS.includes(tool) || tool === 'eyedropper'

  return (
    <aside className={'inspector' + (open ? '' : ' collapsed')}>
      {!open && (
        <button className="collapse-strip" onClick={() => setOpen(true)} title="Show the inspector">
          <Icon name="left" size={14} />
          <span>Inspector</span>
        </button>
      )}
      <div className="panel-title">
        <span className="title-left">
          <button className="mini" onClick={() => setOpen(false)} title="Hide the inspector"><Icon name="right" size={12} /></button>
          Inspector
        </span>
      </div>
      <div className="insp-body">
        {paintTool && <PaintPanel tool={tool} kit={kit} sel={sel} selActions={selActions} />}
        {!paintTool && !clip && (
          <Section id="canvas" title="Canvas">
            <div className="mtop btnrow">
              <label className="mlabel">Width</label>
              <input type="number" min="16" max="16384" value={state.canvas.w} onChange={(e) => e.target.value !== '' && set({ w: +e.target.value })} />
              <label className="mlabel">Height</label>
              <input type="number" min="16" max="16384" value={state.canvas.h} onChange={(e) => e.target.value !== '' && set({ h: +e.target.value })} />
            </div>
            <div className="mtop">
              <span className="mlabel">Quick sizes</span>
              <select value="" onChange={(e) => { const z = SIZES[+e.target.value]; if (z) set({ w: z.w, h: z.h }) }}>
                <option value="">Pick a size…</option>
                {SIZES.map((z, i) => (
                  <option key={z.label} value={i}>{z.label}</option>
                ))}
              </select>
            </div>
            <div className="mtop">
              <span className="mlabel">Background</span>
              <input type="color" value={state.canvas.bg === 'transparent' ? '#ffffff' : state.canvas.bg} onChange={(e) => set({ bg: e.target.value })} disabled={state.canvas.bg === 'transparent'} />
              <label className="chk">
                <input type="checkbox" checked={state.canvas.bg === 'transparent'} onChange={(e) => set({ bg: e.target.checked ? 'transparent' : '#ffffff' })} />
                Transparent
              </label>
            </div>
            <div className="hint left">Pictures keep their shape inside the canvas. Click a layer on the left to edit it.</div>
          </Section>
        )}
        {!paintTool && state.selection.length > 1 && !clip && <div className="hint">{state.selection.length} layers selected.</div>}
        {!paintTool && clip && (
          <fieldset disabled={locked} className="lock-fs">
            <div className="insp-clip">{clip.text ? 'Text layer' : clip.raster || clip.paint ? 'Paint layer' : 'Picture layer'}</div>
            {locked && <div className="hint warn">This layer is locked. Unlock it in the Layers panel to change it.</div>}
            <div className="mtop">
              <span className="mlabel">Blend mode</span>
              <select value={clip.blend || 'normal'} onChange={(e) => dispatch({ type: 'setBlend', id: clip.id, blend: e.target.value })} title="How this layer mixes with the layers under it">
                {BLEND_LIST.map(([id, label]) => (
                  <option key={id} value={id}>{label}</option>
                ))}
              </select>
            </div>
            {clip.text && <TextPanel clip={clip} dispatch={dispatch} noAnim />}
            {clip.raster && (
              <Section id="rasterlayer" title="Paint layer" defaultOpen>
                <div className="hint left">A layer of pixels: paint on it with the brush, eraser, smudge, shapes and fill. It can still be moved, resized, turned, masked and given effects like any other layer.</div>
                <label className="chk">
                  <input type="checkbox" checked={!!clip.raster.alphaLock} onChange={(e) => dispatch({ type: 'setRaster', id: clip.id, patch: { alphaLock: e.target.checked } })} />
                  Alpha lock (paint only where there already is paint)
                </label>
                <button className="mini wide" onClick={() => layerActions.clear(clip)}>Clear this layer</button>
              </Section>
            )}
            {!clip.raster && !clip.paint && (
              <Section id="makepixels" title="Paint on this layer">
                <div className="hint left">To smudge, fill or select parts of {clip.text ? 'this text' : 'this picture'}, turn it into pixels first. Its move, size, mask and effects are baked in, and it cannot be edited as {clip.text ? 'text' : 'a picture'} afterwards.</div>
                <button className="mini wide" onClick={() => layerActions.rasterize(clip)}>Turn into pixels</button>
              </Section>
            )}
            {clip.paint && (
              <Section id="paintlayer" title="Paint layer">
                <div className="hint left">{clip.paint.strokes.length} stroke{clip.paint.strokes.length === 1 ? '' : 's'}. Choose a brush, the eraser or a shape on the left, then paint on the picture.</div>
                <button className="mini wide" disabled={!clip.paint.strokes.length} onClick={() => dispatch({ type: 'paintClear', id: clip.id })}>Clear this layer</button>
              </Section>
            )}
            <TransformPanel clip={clip} dispatch={dispatch} mode={mode} setMode={setMode} freeMode={freeMode} setFreeMode={setFreeMode} fill={clip.paint || clip.raster || clip.text ? null : fill} />
            <MaskPanel clip={clip} dispatch={dispatch} mode={mode} setMode={setMode} still />
            <EffectsPanel clip={clip} dispatch={dispatch} />
            <ColourPanel clip={clip} dispatch={dispatch} />
          </fieldset>
        )}
      </div>
    </aside>
  )
}
