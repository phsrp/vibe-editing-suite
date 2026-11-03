// The AI connection, picture projects: layers, painting, shapes and selections. Pixels go through the same brush engine and undo
// steps as the mouse. Coordinates are pixels of the canvas (x right, y down), and they follow a layer that was moved or scaled.
import { uid, overlayLayout, rowKeys, isLocked, clipPicture, aspectRatio, soleVideoClip } from './state.js'
import { evalTransform, frameToRect, PROPS } from './motion.js'
import { createRenderer, BLEND_LIST } from './glRenderer.js'
import { buildLayers, backgroundOf, imagesReady, exportImage } from './imageRender.js'
import { Stroke, Smudge, mergeBuffer, floodMask, maskToCanvas, objectMask, newCanvas, rgbToHex } from './paint/engine.js'
import { rasterEntry, rasterGrab, rasterRect } from './paint/raster.js'
import { makeSelection, makeMaskSelection, invertSelection } from './paint/selection.js'
import { commitPixels, deleteSelected, moveSelected, copyPixels, addPixelLayer, smudgeResult } from './paint/pixelOps.js'
import { loadPacks } from './paint/usePaintKit.js'
import { promptFromLoop } from './smartMask.js'

const round = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)
const wait = (ms = 90) => new Promise((r) => setTimeout(r, ms))
const json = (o) => ({ text: JSON.stringify(o) })
const need = (ok, msg) => {
  if (!ok) throw new Error(msg)
}

// One renderer for everything the AI connection looks at: a browser only keeps a few of them, and making more would cost the
// editor its own preview.
let shared = null
export async function composite(state, w, h, forJpeg) {
  await imagesReady(state)
  if (!shared) {
    const cv = document.createElement('canvas')
    shared = { cv, r: createRenderer(cv) }
  }
  shared.cv.width = w
  shared.cv.height = h
  shared.r.renderLayers(buildLayers(state, w, h), backgroundOf(state, forJpeg))
  return shared.cv
}
function sized(state, most) {
  const k = Math.min(1, most / Math.max(state.canvas.w, state.canvas.h))
  return [Math.max(1, Math.round(state.canvas.w * k)), Math.max(1, Math.round(state.canvas.h * k))]
}

const letterbox = (s, clip) => {
  const ratio = aspectRatio(s)
  const pic = clipPicture(s, clip, ratio)
  const ma = pic.width / pic.height
  return { ratio, pic, sc: [Math.max(1, ratio / ma), Math.max(1, ma / ratio)] }
}
// where a layer sits on the canvas, in % (with no rotation or warp this is its exact box)
export function layerBox(s, clip) {
  const { pic, sc } = letterbox(s, clip)
  if (!pic || !pic.width) return null
  const tf = evalTransform(clip, 0)
  const w = (tf.scale * (tf.sx / 100)) / sc[0]
  const h = (tf.scale * (tf.sy / 100)) / sc[1]
  return { left: round(50 + tf.x - w / 2), top: round(50 + tf.y - h / 2), right: round(50 + tf.x + w / 2), bottom: round(50 + tf.y + h / 2) }
}
// canvas pixels -> pixels of a layer
function toLayer(s, clip) {
  const { ratio, sc } = letterbox(s, clip)
  const tf = evalTransform(clip, 0)
  const W = clip.raster.w
  const H = clip.raster.h
  return (x, y) => {
    const q = frameToRect([x / s.canvas.w, 1 - y / s.canvas.h], sc, tf, ratio)
    return [q[0] * W, (1 - q[1]) * H]
  }
}
function layerName(s, c) {
  const t = s.videoTracks.find((x) => x.id === c.trackId)
  return t ? t.name : 'Layer'
}
export function pictureSummary(s) {
  const clips = overlayLayout(s.overlayClips)
  const layers = rowKeys(s)
    .filter((k) => k.startsWith('v:'))
    .map((k) => clips.find((c) => 'v:' + c.trackId === k))
    .filter(Boolean)
    .map((c) => {
      const m = s.media.find((x) => x.id === c.mediaId)
      const look = {}
      for (const p of PROPS) if (!p.mask && evalTransform(c, 0)[p.id] !== p.def) look[p.id] = round(evalTransform(c, 0)[p.id])
      return {
        id: c.id,
        name: layerName(s, c),
        kind: c.text ? 'text' : c.raster ? 'pixels' : c.paint ? 'old paint' : 'picture',
        file: m ? m.name : undefined,
        text: c.text ? { ...c.text } : undefined,
        box: layerBox(s, c),
        values: Object.keys(look).length ? look : undefined,
        blend: c.blend,
        effects: c.fx,
        mask: c.mask ? c.mask.shape : undefined,
        warped: c.warp ? true : undefined,
        alphaLock: c.raster && c.raster.alphaLock ? true : undefined,
        locked: s.lockedRows.includes('v:' + c.trackId) || undefined,
        hidden: s.hiddenRows.includes('v:' + c.trackId) || undefined,
        selected: s.selection.includes(c.id) || undefined,
      }
    })
  return { kind: 'picture', canvas: s.canvas, layersTopFirst: layers, canUndo: s.past.length > 0, canRedo: s.future.length > 0, pixelSelection: undefined }
}

const layerOf = (s, id) => {
  const c = overlayLayout(s.overlayClips).find((x) => x.id === id)
  need(c, `There is no layer with the id ${id}. Call get_project for the current ids.`)
  return c
}
// the layer of pixels to work on: the one asked for, the chosen one, or a new one
async function pixelLayer(h, id) {
  const s = h.getState()
  const chosen = id ? layerOf(s, id) : soleVideoClip(s) && layerOf(s, soleVideoClip(s))
  if (id) need(chosen.raster, `"${layerName(s, chosen)}" is not a layer of pixels. Use rasterize_layer to turn it into one, or add_pixel_layer for a new one.`)
  if (chosen && chosen.raster) {
    need(!isLocked(s, chosen.id), `"${layerName(s, chosen)}" is locked.`)
    return chosen
  }
  const nid = uid()
  h.dispatch({ type: 'imgAddRaster', id: nid, rasterId: uid() })
  await wait()
  return layerOf(h.getState(), nid)
}
const pickBrush = async (kit, id) => {
  if (!id) return kit.builtin.find((b) => b.id === 'b:hard')
  const all = [...kit.builtin, ...(await loadPacks()).flatMap((p) => p.brushes)]
  const b = all.find((x) => x.id === id || x.name.toLowerCase() === String(id).toLowerCase())
  need(b, `There is no brush called ${id}. Use list_brushes.`)
  return b
}
const pointOf = (map, p) => {
  const [x, y, pressure] = Array.isArray(p) ? p : [p.x, p.y, p.pressure]
  const [lx, ly] = map(+x, +y)
  return { x: lx, y: ly, pressure: pressure == null ? 0.75 : +pressure, tiltX: 0, tiltY: 0, t: 0 }
}
const union = (a, b) => {
  if (!a) return b
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}
// run paint(entry, clip) on a layer, as one undo step. paint returns the changed area (or null for nothing)
async function pixels(h, id, paint) {
  const clip = await pixelLayer(h, id)
  const e = rasterEntry(clip)
  const full = { x: 0, y: 0, w: e.w, h: e.h }
  const before = rasterGrab(e, full)
  const r = await paint(e, clip)
  const rect = r && rasterRect(e, r)
  if (!rect) return { clip, rect: null }
  const crop = newCanvas(rect.w, rect.h)
  crop.getContext('2d').drawImage(before, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
  commitPixels(clip, h.dispatch, rect, crop)
  await wait() // (the state must know the new pixels before the next change)
  return { clip, rect }
}
const opts = (h) => ({ mask: h.live().sel() ? h.live().sel().mask : null })

function paintStrokes(h, args, strokes, make) {
  return pixels(h, args.clipId, async (e, clip) => {
    const map = toLayer(h.getState(), clip)
    let area = null
    for (const list of strokes) {
      need(Array.isArray(list) && list.length, 'Each stroke needs at least one point.')
      const pts = list.map((p) => pointOf(map, p))
      area = union(area, await make(e, clip, pts))
    }
    return area
  })
}
// shapes: drawn with the plain drawing tools of the browser, so they can have gradients, rounded corners and soft edges
function styleOf(g, spec) {
  if (typeof spec === 'string') return spec
  need(spec && Array.isArray(spec.stops) && spec.stops.length >= 2, 'A gradient needs stops, like [[0, "#ff0000"], [1, "#0000ff"]].')
  const gr = spec.type === 'radial' ? g.createRadialGradient(spec.x0, spec.y0, spec.r0 || 0, spec.x0, spec.y0, spec.r1) : g.createLinearGradient(spec.x0, spec.y0, spec.x1, spec.y1)
  for (const [at, colour] of spec.stops) gr.addColorStop(at, colour)
  return gr
}
function traceShape(g, o) {
  g.beginPath()
  if (o.type === 'rect') {
    if (o.radius > 0) g.roundRect(o.x, o.y, o.w, o.h, o.radius)
    else g.rect(o.x, o.y, o.w, o.h)
  } else if (o.type === 'ellipse') g.ellipse(o.x + o.w / 2, o.y + o.h / 2, Math.abs(o.w / 2), Math.abs(o.h / 2), 0, 0, Math.PI * 2)
  else {
    need(Array.isArray(o.points) && o.points.length >= 2, `A ${o.type} needs points.`)
    o.points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
    if (o.type === 'polygon') g.closePath()
  }
}
function drawShapes(cv, shapes, matrix) {
  const g = cv.getContext('2d')
  g.setTransform(...matrix)
  for (const o of shapes) {
    need(['rect', 'ellipse', 'line', 'polygon'].includes(o.type), `Unknown shape ${o.type}.`)
    g.save()
    g.globalAlpha = o.opacity == null ? 1 : Math.max(0, Math.min(100, +o.opacity)) / 100
    if (o.blur > 0) g.filter = `blur(${+o.blur}px)`
    if (o.rotate && o.type !== 'line' && o.type !== 'polygon') {
      const cx = o.x + o.w / 2
      const cy = o.y + o.h / 2
      g.translate(cx, cy)
      g.rotate((o.rotate * Math.PI) / 180)
      g.translate(-cx, -cy)
    }
    traceShape(g, o)
    if (o.fill) {
      g.fillStyle = styleOf(g, o.fill)
      g.fill()
    }
    if (o.stroke) {
      g.lineWidth = o.strokeWidth > 0 ? +o.strokeWidth : 4
      g.lineJoin = 'round'
      g.lineCap = 'round'
      g.strokeStyle = styleOf(g, o.stroke)
      g.stroke()
    }
    g.restore()
  }
}

const PICTURE_ONLY = new Set(['set_canvas', 'add_pixel_layer', 'duplicate_layer', 'set_layer', 'rasterize_layer', 'clear_layer', 'list_brushes', 'paint_stroke', 'smudge_stroke', 'draw_shape', 'flood_fill', 'pick_colour', 'select_area', 'smart_select', 'selection_action', 'export_picture', 'import_brush_pack', 'remove_brush_pack'])
export const isPictureTool = (name) => PICTURE_ONLY.has(name)

// returns undefined for a tool that is not special in a picture project
export async function pictureTool(name, args, { p, h, ctx }) {
  const s = h.getState()
  const D = h.dispatch
  const live = h.live()
  const clip = () => layerOf(h.getState(), args.clipId)
  switch (name) {
    case 'get_project':
      return json({ ...pictureSummary(s), pixelSelection: live.sel() ? live.sel().bounds : null })
    case 'get_preview': {
      ctx.focus(p.id)
      const [w, h2] = sized(s, 1280)
      const cv = await composite(s, w, h2, true)
      return { image: cv.toDataURL('image/jpeg', 0.85).split(',')[1], mime: 'image/jpeg', text: `The picture, shown at ${w} x ${h2}. The canvas is ${s.canvas.w} x ${s.canvas.h} pixels.` }
    }
    case 'import_media': {
      need(Array.isArray(args.paths) && args.paths.length, 'Give at least one file path.')
      const items = (await window.api.describeFiles(args.paths)).filter((i) => i.type === 'image')
      need(items.length, 'None of those are pictures that can be read.')
      live.addPictures(items)
      await wait(200)
      const after = overlayLayout(h.getState().overlayClips)
      return json(items.map((i) => ({ file: i.name, layerId: (after.filter((c) => c.mediaId === i.id).pop() || {}).id, width: i.width, height: i.height })))
    }
    case 'add_text': {
      const id = uid()
      D({ type: 'imgAddText', id, text: { ...args.style, content: String(args.text) }, y: +args.y || 0 })
      await wait()
      return { text: `Added. Its id is ${id}.` }
    }
    case 'delete_clips': {
      const ids = args.clipIds || []
      need(ids.length, 'Give at least one layer id.')
      ids.forEach((id) => layerOf(s, id))
      ids.forEach((id) => D({ type: 'imgRemove', id }))
      return { text: `Deleted ${ids.length}.` }
    }
    case 'set_canvas': {
      const patch = {}
      if (args.width != null) patch.w = +args.width
      if (args.height != null) patch.h = +args.height
      if (args.background != null) patch.bg = String(args.background)
      D({ type: 'setCanvas', patch })
      return { text: 'Done.' }
    }
    case 'add_pixel_layer': {
      const id = uid()
      D({ type: 'imgAddRaster', id, rasterId: uid(), name: args.name })
      await wait()
      return { text: `Added. Its id is ${id}.` }
    }
    case 'duplicate_layer': {
      D({ type: 'imgDuplicate', id: clip().id })
      await wait()
      return { text: `Duplicated. The copy's id is ${h.getState().selection[0]}.` }
    }
    case 'set_layer': {
      const c = clip()
      const key = 'v:' + c.trackId
      if (args.name != null) D({ type: 'renameRow', key, name: args.name })
      if (args.blend != null) {
        need(BLEND_LIST.some(([b]) => b === args.blend), `Unknown blend ${args.blend}. See editor_info.`)
        D({ type: 'setBlend', id: c.id, blend: args.blend })
      }
      if (args.alphaLock != null) {
        need(c.raster, 'Only a layer of pixels has an alpha lock.')
        D({ type: 'setRaster', id: c.id, patch: { alphaLock: !!args.alphaLock } })
      }
      if (args.locked != null && !!args.locked !== s.lockedRows.includes(key)) D({ type: 'toggleRowLock', key })
      if (args.hidden != null && !!args.hidden !== s.hiddenRows.includes(key)) D({ type: 'toggleRowHide', key })
      if (args.order != null) {
        if (typeof args.order === 'number') D({ type: 'imgMoveTo', id: c.id, index: args.order })
        else {
          need(['top', 'bottom', 'up', 'down'].includes(args.order), 'order is top, bottom, up, down or a place in the list (0 = top).')
          D({ type: 'imgMove', id: c.id, to: args.order })
        }
      }
      if (args.select) D({ type: 'select', id: c.id })
      return { text: 'Done.' }
    }
    case 'rasterize_layer': {
      await live.layerActions.rasterize(clip())
      await wait(200)
      need(layerOf(h.getState(), args.clipId).raster, 'The layer could not be turned into pixels.')
      return { text: 'The layer is now pixels.' }
    }
    case 'clear_layer': {
      const c = clip()
      need(c.raster, 'Only a layer of pixels can be cleared.')
      need(!isLocked(s, c.id), 'That layer is locked.')
      live.layerActions.clear(c)
      await wait()
      return { text: 'Cleared.' }
    }
    case 'list_brushes': {
      const packs = await loadPacks()
      const one = (b) => ({ id: b.id, name: b.name, size: b.size })
      return json({ builtIn: live.kit.builtin.map(one), packs: packs.map((k) => ({ file: k.file, title: k.title, brushes: k.brushes.map(one) })) })
    }
    case 'import_brush_pack': {
      need(Array.isArray(args.paths) && args.paths.length, 'Give at least one file path.')
      await live.kit.importPacks(args.paths)
      return { text: 'Imported. See list_brushes.' }
    }
    case 'remove_brush_pack': {
      const k = live.kit.packs.find((x) => x.file === args.file)
      need(k, `There is no pack called ${args.file}.`)
      await live.kit.removePack(k, true)
      return { text: 'Removed.' }
    }
    case 'paint_stroke': {
      const brush = await pickBrush(live.kit, args.brush)
      const strokes = args.strokes || [args.points]
      const size = args.size > 0 ? +args.size : brush.size || 20
      const op = (args.opacity == null ? 1 : Math.max(0, Math.min(100, +args.opacity)) / 100) * (brush.opacity == null ? 1 : brush.opacity)
      const erase = !!args.erase || brush.comp === 'erase'
      const { rect } = await paintStrokes(h, args, strokes, (e, clip2, pts) => {
        const buffer = newCanvas(e.w, e.h)
        const st = new Stroke({ brush, size, flow: args.flow == null ? 1 : +args.flow, colour: args.colour || '#000000', smoothing: 0, spacingMul: 1, mirrorX: !!args.mirrorX, mirrorY: !!args.mirrorY, w: e.w, h: e.h, buffer, erase })
        st.begin(pts[0])
        for (let i = 1; i < pts.length; i++) st.move(pts[i])
        st.finish()
        const r = st.dirty && rasterRect(e, st.dirty)
        if (r) mergeBuffer(e.canvas.getContext('2d'), buffer, r, { opacity: op, erase, comp: brush.comp, alphaLock: !!clip2.raster.alphaLock, ...opts(h) })
        return r
      })
      return { text: rect ? 'Painted.' : 'Nothing was painted: the stroke is outside the layer.' }
    }
    case 'smudge_stroke': {
      const brush = await pickBrush(live.kit, args.brush)
      const strokes = args.strokes || [args.points]
      const { rect } = await paintStrokes(h, args, strokes, (e, _c, pts) => {
        const before = rasterGrab(e, { x: 0, y: 0, w: e.w, h: e.h })
        const sm = new Smudge({ layer: e.canvas, brush, size: args.size > 0 ? +args.size : 40, strength: args.strength == null ? 0.7 : +args.strength, w: e.w, h: e.h })
        sm.begin(pts[0])
        for (let i = 1; i < pts.length; i++) sm.move(pts[i])
        const r = sm.dirty && rasterRect(e, sm.dirty)
        if (r) smudgeResult(e, r, before, live.sel())
        return r
      })
      return { text: rect ? 'Smudged.' : 'Nothing changed.' }
    }
    case 'draw_shape': {
      const shapes = args.shapes
      need(Array.isArray(shapes) && shapes.length, 'Give at least one shape.')
      const { rect } = await pixels(h, args.clipId, (e, c) => {
        const map = toLayer(h.getState(), c)
        const [ox, oy] = map(0, 0)
        const [ax, ay] = map(1, 0)
        const [bx, by] = map(0, 1)
        const buffer = newCanvas(e.w, e.h)
        drawShapes(buffer, shapes, [ax - ox, ay - oy, bx - ox, by - oy, ox, oy])
        const full = { x: 0, y: 0, w: e.w, h: e.h }
        mergeBuffer(e.canvas.getContext('2d'), buffer, full, { opacity: 1, comp: args.blend || 'normal', alphaLock: !!c.raster.alphaLock, ...opts(h) })
        return full
      })
      return { text: rect ? `Drew ${shapes.length} shape${shapes.length === 1 ? '' : 's'}.` : 'Nothing was drawn.' }
    }
    case 'flood_fill': {
      const { rect } = await pixels(h, args.clipId, async (e, c) => {
        const [lx, ly] = toLayer(h.getState(), c)(+args.x, +args.y)
        let src = e.canvas
        if (args.allLayers) {
          src = newCanvas(e.w, e.h)
          src.getContext('2d').drawImage(await composite(h.getState(), e.w, e.h), 0, 0, e.w, e.h)
        }
        const mk = floodMask(src, lx, ly, args.tolerance == null ? 0.12 : +args.tolerance, opts(h).mask)
        if (!mk) return null
        const piece = maskToCanvas(mk, args.colour || '#000000', 1)
        const g = e.canvas.getContext('2d')
        g.save()
        g.globalCompositeOperation = c.raster.alphaLock ? 'source-atop' : 'source-over'
        g.drawImage(piece.canvas, piece.x, piece.y)
        g.restore()
        return { x: piece.x, y: piece.y, w: piece.w, h: piece.h }
      })
      return { text: rect ? 'Filled.' : 'Nothing was filled.' }
    }
    case 'pick_colour': {
      const cv = await composite(s, s.canvas.w, s.canvas.h)
      const t = newCanvas(1, 1)
      const g = t.getContext('2d', { willReadFrequently: true })
      g.drawImage(cv, Math.floor(+args.x), Math.floor(+args.y), 1, 1, 0, 0, 1, 1)
      const d = g.getImageData(0, 0, 1, 1).data
      return json({ colour: rgbToHex(d[0], d[1], d[2]), opacityPercent: Math.round((d[3] / 255) * 100) })
    }
    case 'select_area': {
      const shape = args.shape
      const chosen = soleVideoClip(s) && layerOf(s, soleVideoClip(s))
      const c = chosen && chosen.raster ? chosen : null
      const W = c ? c.raster.w : s.canvas.w
      const H = c ? c.raster.h : s.canvas.h
      const map = c ? toLayer(s, c) : (x, y) => [x, y]
      const mode = args.mode || 'replace'
      need(['replace', 'add', 'subtract'].includes(mode), 'mode is replace, add or subtract.')
      if (shape === 'none') live.setSel(null)
      else if (shape === 'all') live.setSel(makeSelection(W, H, { type: 'all' }, 'replace', null))
      else if (shape === 'invert') {
        need(live.sel(), 'Nothing is selected yet.')
        live.setSel(invertSelection(W, H, live.sel()))
      } else if (shape === 'object') {
        need(c, 'Choose a layer of pixels first (set_layer with select).')
        const [lx, ly] = map(+args.x, +args.y)
        const hit = objectMask(rasterEntry(c).canvas, lx, ly, 8)
        need(hit, 'There is nothing painted there.')
        live.setSel(makeMaskSelection(W, H, hit.canvas, hit.bounds, mode, live.sel()))
      } else if (shape === 'lasso') {
        need(Array.isArray(args.points) && args.points.length >= 3, 'A lasso needs at least three points.')
        const pts = args.points.map(([x, y]) => {
          const [lx, ly] = map(x, y)
          return { x: lx, y: ly }
        })
        live.setSel(makeSelection(W, H, { type: 'lasso', pts }, mode, live.sel()))
      } else {
        need(shape === 'rect' || shape === 'ellipse', 'shape is rect, ellipse, lasso, object, all, none or invert.')
        const [x, y] = map(+args.x, +args.y)
        const [x1, y1] = map(+args.x + +args.w, +args.y + +args.h)
        live.setSel(makeSelection(W, H, { type: shape, x: Math.min(x, x1), y: Math.min(y, y1), w: Math.abs(x1 - x), h: Math.abs(y1 - y) }, mode, live.sel()))
      }
      await wait()
      const cur = h.live().sel()
      return json({ selection: cur ? cur.bounds : null })
    }
    case 'smart_select': {
      const st = await window.api.modelsStatus()
      const { gpuInfo, findSubjectPrompt } = await import('./smartMask.js')
      need(st.ready, 'Smart select needs its AI model. Use download_model with tracking, or ask the person.')
      need((await gpuInfo()).ok, 'Smart select needs a graphics card, and this computer does not seem to have a usable one.')
      const chosen = soleVideoClip(s) && layerOf(s, soleVideoClip(s))
      const c = chosen && chosen.raster ? chosen : null
      const [vw, vh] = sized(s, 1280)
      const src = await composite(s, vw, vh, true)
      const el = newCanvas(vw, vh)
      const eg = el.getContext('2d')
      eg.fillStyle = '#ffffff'
      eg.fillRect(0, 0, vw, vh)
      eg.drawImage(src, 0, 0)
      const cw = s.canvas.w
      const ch = s.canvas.h
      let prompt
      if (args.box) {
        const { left, top, right, bottom } = args.box
        const q = (x, y) => [x / cw, y / ch]
        prompt = promptFromLoop([q(left, top), q(right, top), q(right, bottom), q(left, bottom)])
      } else {
        need(args.x != null && args.y != null, 'Give a box, or x and y on the subject.')
        prompt = [{ x: args.x / cw, y: args.y / ch, label: 1 }]
      }
      const poly = await findSubjectPrompt({ el, w: vw, h: vh, prompt, paths: st.paths })
      need(poly, 'No subject was found there. Try a bigger box, or a point on the subject.')
      const W = c ? c.raster.w : cw
      const H = c ? c.raster.h : ch
      const map = c ? toLayer(s, c) : (x, y) => [x, y]
      const pts = poly.map(([x, y]) => {
        const [lx, ly] = map(x * cw, y * ch)
        return { x: lx, y: ly }
      })
      live.setSel(makeSelection(W, H, { type: 'lasso', pts }, args.mode || 'replace', live.sel()))
      await wait()
      return json({ selection: h.live().sel().bounds })
    }
    case 'selection_action': {
      if (args.clipId) D({ type: 'select', id: args.clipId })
      await wait()
      const st = h.getState()
      const sel = live.sel()
      const act = args.action
      if (act === 'paste') {
        const c = live.pixelClip()
        need(c, 'Nothing has been copied yet.')
        const id = addPixelLayer(st, D, c.canvas, c.x, c.y, 'Pasted')
        await wait()
        return { text: `Pasted as a new layer. Its id is ${id}.` }
      }
      need(sel, 'Nothing is selected: use select_area or smart_select first.')
      if (act === 'delete') need(deleteSelected(st, D, sel), 'Choose a layer of pixels that is not locked first.')
      else if (act === 'copy' || act === 'cut' || act === 'to_new_layer') {
        const c = copyPixels(st, sel)
        need(c, 'Choose a layer of pixels first.')
        if (act === 'to_new_layer') {
          const id = addPixelLayer(st, D, c.canvas, c.x, c.y, args.name || 'Cut out')
          await wait()
          return { text: `Copied to a new layer. Its id is ${id}.` }
        }
        live.setPixelClip(c)
        if (act === 'cut') need(deleteSelected(st, D, sel), 'That layer is locked.')
      } else if (act === 'move') {
        const next = moveSelected(st, D, sel, +args.dx || 0, +args.dy || 0, !!args.copy)
        need(next, 'Choose a layer of pixels that is not locked first.')
        live.setSel(next)
      } else throw new Error('action is delete, copy, cut, paste, move or to_new_layer.')
      await wait()
      return { text: 'Done.' }
    }
    case 'export_picture': {
      const ext = String(args.path || '').split('.').pop().toLowerCase()
      const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[ext]
      need(type, 'The path must end in .png, .jpg or .webp.')
      need(s.overlayClips.length, 'There is nothing on the canvas yet.')
      const data = await exportImage(s, { scale: args.scale > 0 ? +args.scale : 1, type, quality: (args.quality > 0 ? +args.quality : 92) / 100 })
      const file = await window.api.saveImage({ data, ext, file: args.path })
      return { text: `Saved: ${file}` }
    }
    default:
      return undefined
  }
}
