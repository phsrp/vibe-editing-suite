// Reading Krita brush packs.
//   .bundle  = a zip file with brushes/ (the tip pictures: png, gbr, gih, svg) and paintoppresets/ (the .kpp presets)
//   .kpp     = a PNG picture whose text chunk "preset" holds the settings as XML
// Only the normal "paintbrush" engine (and the colour smudge engine, approximately) is turned into a brush here; the other
// Krita engines (hairy, sketch, particle, ...) are reported as not supported.
//
// A BrushDef (what the brush engine in engine.js draws with):
//   { id, name, from: 'krita', approximate, note,
//     tip: { kind: 'auto' | 'image', ...}, angle, spacing, autoSpacing, autoSpacingCoeff, density,
//     size (default diameter in px), opacity, flow, comp,
//     dyn: { size, opacity, flow, rotation, scatter, ratio, spacing, ... } each = null | { sensors: [{id, curve}], useCurve, value }
//     scatter: {amount, x, y}, texture: null | {...}, preview (small canvas) }

// ------------------------------------------------------------------------------------------------ zip
const utf8 = new TextDecoder('utf-8')

async function inflate(u8, format) {
  const ds = new DecompressionStream(format)
  const stream = new Blob([u8]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function readZip(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  let e = u8.length - 22
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--
  if (e < 0) throw new Error('This is not a zip file.')
  const count = dv.getUint16(e + 10, true)
  let p = dv.getUint32(e + 16, true)
  const entries = new Map()
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break
    const method = dv.getUint16(p + 10, true)
    const csize = dv.getUint32(p + 20, true)
    const nlen = dv.getUint16(p + 28, true)
    const elen = dv.getUint16(p + 30, true)
    const clen = dv.getUint16(p + 32, true)
    const lho = dv.getUint32(p + 42, true)
    const name = utf8.decode(u8.subarray(p + 46, p + 46 + nlen))
    entries.set(name, { method, csize, lho })
    p += 46 + nlen + elen + clen
  }
  return {
    names: [...entries.keys()],
    async read(name) {
      const en = entries.get(name)
      if (!en) return null
      const lp = en.lho
      const start = lp + 30 + dv.getUint16(lp + 26, true) + dv.getUint16(lp + 28, true)
      const data = u8.subarray(start, start + en.csize)
      if (en.method === 0) return data.slice()
      if (en.method === 8) return inflate(data, 'deflate-raw')
      throw new Error('Unsupported zip compression')
    },
  }
}

// ------------------------------------------------------------------------------------------------ png text chunks
async function pngText(u8, wantKey) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  let p = 8
  while (p + 12 <= u8.length) {
    const len = dv.getUint32(p)
    const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7])
    const data = u8.subarray(p + 8, p + 8 + len)
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const z = data.indexOf(0)
      const key = String.fromCharCode(...data.subarray(0, z))
      if (key === wantKey) {
        if (type === 'tEXt') return utf8.decode(data.subarray(z + 1))
        if (type === 'zTXt') return utf8.decode(await inflate(data.subarray(z + 2), 'deflate'))
        // iTXt: key\0 flag method lang\0 translated\0 text
        const compressed = data[z + 1] === 1
        let q = z + 3
        while (data[q] !== 0) q++
        q++
        while (data[q] !== 0) q++
        q++
        const body = data.subarray(q)
        return utf8.decode(compressed ? await inflate(body, 'deflate') : body)
      }
    }
    if (type === 'IEND') break
    p += 12 + len
  }
  return null
}

// ------------------------------------------------------------------------------------------------ the preset xml
function parsePreset(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const root = doc.documentElement
  const params = {}
  for (const el of root.getElementsByTagName('param')) params[el.getAttribute('name')] = el.textContent
  return { name: root.getAttribute('name') || '', paintop: root.getAttribute('paintopid') || params.paintop || '', params }
}
const num = (v, d) => {
  const x = parseFloat(v)
  return isFinite(x) ? x : d
}
const bool = (v, d) => (v == null ? d : String(v).trim().toLowerCase() === 'true' || v === '1')

// "x,y;x,y;" -> [[x, y], ...]
function parseCurve(s) {
  const out = []
  for (const part of String(s || '').split(';')) {
    const [x, y] = part.split(',').map(parseFloat)
    if (isFinite(x) && isFinite(y)) out.push([x, y])
  }
  return out
}
// the sensors of one dynamic: [{id, curve}] (a single sensor, or a list of them)
function parseSensors(xml) {
  if (!xml) return []
  const doc = new DOMParser().parseFromString(String(xml).replace(/<!DOCTYPE[^>]*>/, ''), 'text/xml')
  const params = doc.documentElement
  if (!params || params.nodeName !== 'params') return []
  const id = params.getAttribute('id')
  if (id === 'sensorslist') {
    return [...params.getElementsByTagName('ChildSensor')].map((c) => ({ id: c.getAttribute('id'), curve: parseCurve((c.getElementsByTagName('curve')[0] || {}).textContent) }))
  }
  const c = params.getElementsByTagName('curve')[0]
  return [{ id, curve: parseCurve(c && c.textContent) }]
}
// one dynamic option: size, opacity, flow, ...
function dynamic(P, name, checkFlag) {
  if (checkFlag !== null && !bool(P['Pressure' + checkFlag], false)) return null
  const sensors = parseSensors(P[name + 'Sensor']).filter((s) => s.id)
  return { sensors, useCurve: bool(P[name + 'UseCurve'], true), value: num(P[name + 'Value'], 1) }
}

// ------------------------------------------------------------------------------------------------ tips
const loadImage = async (u8, mime = 'image/png') => {
  const bmp = await createImageBitmap(new Blob([u8], { type: mime }))
  const cv = document.createElement('canvas')
  cv.width = bmp.width
  cv.height = bmp.height
  cv.getContext('2d').drawImage(bmp, 0, 0)
  return cv
}
// GIMP brush (.gbr): header, then w*h*bytes pixels. bytes = 1 (grey mask) or 4 (colour with alpha)
function parseGbr(u8, at = 0) {
  const dv = new DataView(u8.buffer, u8.byteOffset + at, u8.byteLength - at)
  const header = dv.getUint32(0)
  const version = dv.getUint32(4)
  const w = dv.getUint32(8)
  const h = dv.getUint32(12)
  const bytes = dv.getUint32(16)
  let spacing = 25
  let off = 20
  if (version >= 2) {
    // v2: magic "GIMP", spacing, name
    spacing = dv.getUint32(24)
    off = 28
  }
  const pix = new Uint8Array(u8.buffer, u8.byteOffset + at + header, w * h * bytes)
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const id = cv.getContext('2d').createImageData(w, h)
  for (let i = 0; i < w * h; i++) {
    if (bytes === 1) {
      // a grey mask: the value is the opacity (255 = paint, 0 = nothing; checked on Krita's own bundles)
      id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = 0
      id.data[i * 4 + 3] = pix[i]
    } else if (bytes === 4) {
      id.data[i * 4] = pix[i * 4]
      id.data[i * 4 + 1] = pix[i * 4 + 1]
      id.data[i * 4 + 2] = pix[i * 4 + 2]
      id.data[i * 4 + 3] = pix[i * 4 + 3]
    } else if (bytes === 2) {
      id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = pix[i * 2]
      id.data[i * 4 + 3] = pix[i * 2 + 1]
    } else {
      id.data[i * 4] = pix[i * 3]
      id.data[i * 4 + 1] = pix[i * 3 + 1]
      id.data[i * 4 + 2] = pix[i * 3 + 2]
      id.data[i * 4 + 3] = 255
    }
  }
  cv.getContext('2d').putImageData(id, 0, 0)
  void off
  return { canvas: cv, colour: bytes === 4, spacing: spacing / 100, size: header + w * h * bytes }
}
// animated brush (.gih): a text header, then one .gbr after the other
function parseGih(u8) {
  let p = 0
  const line = () => {
    let s = p
    while (u8[p] !== 10 && p < u8.length) p++
    const t = utf8.decode(u8.subarray(s, p))
    p++
    return t
  }
  line() // the name
  const second = line() // "<ncells> <params...>" in text form: e.g. "9 ncells:9 dim:1 ..."
  const cells = parseInt(second, 10) || 1
  const sel = /sel0?:(\w+)/.exec(second) || /placement:(\w+)/.exec(second)
  const out = []
  for (let i = 0; i < cells && p < u8.length; i++) {
    const g = parseGbr(u8, p)
    out.push(g)
    p += g.size
  }
  return { cells: out, mode: sel ? sel[1] : 'incremental' }
}

async function svgTip(u8) {
  const url = URL.createObjectURL(new Blob([u8], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    await new Promise((res, rej) => {
      img.onload = res
      img.onerror = rej
      img.src = url
    })
    const s = 256 / Math.max(img.width || 256, img.height || 256)
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, Math.round((img.width || 256) * s))
    cv.height = Math.max(1, Math.round((img.height || 256) * s))
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height)
    return cv
  } finally {
    URL.revokeObjectURL(url)
  }
}

// A picture used as a mask: dark on white (or on transparent) paints, white shapes on transparent paint too.
function maskFromPicture(cv) {
  const g = cv.getContext('2d')
  const id = g.getImageData(0, 0, cv.width, cv.height)
  const d = id.data
  // how bright are the visible pixels? (white shapes on transparent are a mask by their alpha)
  let sum = 0
  let n = 0
  let hasAlpha = false
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 250) hasAlpha = true
    if (d[i + 3] > 128) {
      sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255
      n++
    }
  }
  const whiteShapes = hasAlpha && n > 0 && sum / n > 0.75
  for (let i = 0; i < d.length; i += 4) {
    const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255
    const a = d[i + 3] / 255
    const v = whiteShapes ? a : (1 - lum) * a
    d[i] = d[i + 1] = d[i + 2] = 0
    d[i + 3] = Math.round(255 * Math.max(0, Math.min(1, v)))
  }
  g.putImageData(id, 0, 0)
  return cv
}
// ------------------------------------------------------------------------------------------------ one preset -> BrushDef
// getTip(filename) -> Promise<Uint8Array|null>
export async function brushFromPreset(preset, getTip) {
  const P = preset.params
  const paintop = preset.paintop
  if (!['paintbrush', 'colorsmudge', 'roundmarker'].includes(paintop)) {
    return { unsupported: true, name: preset.name, engine: paintop }
  }
  const def = {
    id: 'k:' + preset.name,
    name: preset.name.replace(/^[a-z0-9]{1,2}\)_?/i, '').replace(/_/g, ' ').trim() || preset.name,
    from: 'krita',
    engine: paintop,
    approximate: paintop === 'colorsmudge',
    note: paintop === 'colorsmudge' ? 'Krita\'s colour smudge engine is approximated with a normal brush' : '',
    angle: 0,
    spacing: num(P.spacing, 0.1),
    autoSpacing: false,
    autoSpacingCoeff: 1,
    density: 1,
    scale: 1,
    size: num(P.diameter, 20),
    opacity: 1,
    flow: 1,
    comp: bool(P.EraserMode, false) ? 'erase' : String(P.CompositeOp || 'normal').trim(),
    tip: { kind: 'auto', shape: 'circle', ratio: 1, hfade: 1, vfade: 1, softness: 0, mode: 'default', diameter: 20 },
    dyn: {},
    scatter: { amount: num(P.ScatterValue, 0), x: bool(P['Scattering/AxisX'], true), y: bool(P['Scattering/AxisY'], true) },
    texture: null,
  }
  // opacity, flow: always dynamic ("UseCurve" switches the curve on; otherwise the value is fixed)
  def.dyn.opacity = dynamic(P, 'Opacity', null)
  def.dyn.flow = dynamic(P, 'Flow', null)
  for (const [key, flag] of [['size', 'Size'], ['spacing', 'Spacing'], ['rotation', 'Rotation'], ['scatter', 'Scatter'], ['ratio', 'Ratio'], ['softness', 'Softness']]) {
    def.dyn[key] = dynamic(P, flag, flag)
  }
  def.dyn.opacity && !def.dyn.opacity.useCurve && (def.opacity = def.dyn.opacity.value)
  def.dyn.flow && !def.dyn.flow.useCurve && (def.flow = def.dyn.flow.value)
  if (def.dyn.opacity && !def.dyn.opacity.useCurve) def.dyn.opacity = null
  if (def.dyn.flow && !def.dyn.flow.useCurve) def.dyn.flow = null
  if (paintop === 'roundmarker') {
    def.tip.diameter = def.size
    return def
  }
  // the tip
  const bd = P.brush_definition
  if (bd) {
    const bx = new DOMParser().parseFromString(bd, 'text/xml').documentElement
    const type = bx.getAttribute('type')
    def.spacing = num(bx.getAttribute('spacing'), def.spacing)
    def.angle = num(bx.getAttribute('angle'), 0)
    def.density = num(bx.getAttribute('density'), 1)
    def.scale = num(bx.getAttribute('scale'), 1)
    def.autoSpacing = bool(bx.getAttribute('useAutoSpacing'), false)
    def.autoSpacingCoeff = num(bx.getAttribute('autoSpacingCoeff'), 1)
    const asMask = bool(bx.getAttribute('ColorAsMask'), true)
    if (type === 'auto_brush') {
      const mg = bx.getElementsByTagName('MaskGenerator')[0]
      def.tip = {
        kind: 'auto',
        shape: mg ? mg.getAttribute('type') || 'circle' : 'circle',
        mode: mg ? mg.getAttribute('id') || 'default' : 'default',
        diameter: mg ? num(mg.getAttribute('diameter'), 20) : 20,
        ratio: mg ? num(mg.getAttribute('ratio'), 1) : 1,
        hfade: mg ? num(mg.getAttribute('hfade'), 1) : 1,
        vfade: mg ? num(mg.getAttribute('vfade'), 1) : 1,
        spikes: mg ? num(mg.getAttribute('spikes'), 2) : 2,
        softness: mg ? num(mg.getAttribute('softness'), 1) : 1,
        curve: mg ? parseCurve(mg.getAttribute('softness_curve')) : [],
      }
      def.size = def.tip.diameter
    } else {
      const fn = bx.getAttribute('filename') || ''
      const data = await getTip(fn)
      if (!data) {
        def.note = (def.note ? def.note + '. ' : '') + `its tip picture "${fn}" is not in the pack, a round tip is used`
        def.approximate = true
      } else {
        const ext = fn.split('.').pop().toLowerCase()
        let cells = []
        let colour = false
        let mode = 'incremental'
        if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'bmp') {
          const cv = await loadImage(data, ext === 'png' ? 'image/png' : 'image/jpeg')
          cells = [asMask ? maskFromPicture(cv) : cv]
          colour = !asMask
        } else if (ext === 'gbr') {
          const g = parseGbr(data)
          cells = [g.canvas]
          colour = g.colour && !asMask
          if (!colour && g.colour) cells = [maskFromPicture(g.canvas)]
        } else if (ext === 'gih') {
          const g = parseGih(data)
          cells = g.cells.map((c) => c.canvas)
          colour = g.cells[0] && g.cells[0].colour && !asMask
          mode = g.mode
        } else if (ext === 'svg') {
          cells = [maskFromPicture(await svgTip(data))]
        } else if (ext === 'abr') {
          cells = []
        }
        if (!cells.length) {
          def.note = 'its tip picture format is not supported, a round tip is used'
          def.approximate = true
        } else {
          def.tip = { kind: 'image', cells, colour, mode, diameter: Math.max(cells[0].width, cells[0].height) }
          def.size = Math.max(1, Math.round(def.tip.diameter * def.scale))
        }
      }
    }
  }
  def.size = Math.max(1, Math.min(1000, def.size))
  // a pattern that makes the stroke grainy (kept in the preset itself, as base64 of a base64 PNG)
  if (bool(P['Texture/Pattern/Enabled'], false) && P['Texture/Pattern/Pattern']) {
    try {
      let b64 = P['Texture/Pattern/Pattern'].trim()
      const inner = atob(b64)
      const png = /^[A-Za-z0-9+/=\s]+$/.test(inner) && inner.length > 80 ? atob(inner.trim()) : inner
      const bytes = Uint8Array.from(png, (c) => c.charCodeAt(0))
      const cv = await loadImage(bytes)
      def.texture = {
        canvas: cv,
        scale: num(P['Texture/Pattern/Scale'], 1),
        strength: num(P['Texture/Pattern/Strength'], 1),
        brightness: num(P['Texture/Pattern/Brightness'], 0),
        contrast: num(P['Texture/Pattern/Contrast'], 1),
        invert: bool(P['Texture/Pattern/Invert'], false),
        mode: num(P['Texture/Pattern/TexturingMode'], 0),
        dyn: dynamic(P, 'Texture/Strength/', 'Texture/Strength/'),
      }
    } catch {
      def.note = (def.note ? def.note + '. ' : '') + 'its texture could not be read'
    }
  }
  return def
}

// ------------------------------------------------------------------------------------------------ a whole pack
// bytes = the .bundle (zip) or a single .kpp. Returns {brushes: [BrushDef], skipped: [{name, engine}], title}
export async function loadKritaPack(bytes, fileName = '') {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const brushes = []
  const skipped = []
  const isZip = u8[0] === 0x50 && u8[1] === 0x4b
  if (!isZip) {
    // a single .kpp (a PNG)
    const xml = await pngText(u8, 'preset')
    if (!xml) throw new Error('This file has no Krita brush in it.')
    const pre = parsePreset(xml)
    const def = await brushFromPreset(pre, async () => null)
    if (def.unsupported) skipped.push(def)
    else {
      def.preview = await loadImage(u8).catch(() => null)
      brushes.push(def)
    }
    return { brushes, skipped, title: fileName }
  }
  const zip = await readZip(u8)
  const lower = new Map(zip.names.map((n) => [n.toLowerCase(), n]))
  const tipCache = new Map()
  const getTip = async (fn) => {
    if (!fn) return null
    const base = fn.split(/[\\/]/).pop().toLowerCase()
    if (tipCache.has(base)) return tipCache.get(base)
    const hit = lower.get('brushes/' + base) || [...lower.keys()].map((k) => lower.get(k)).find((n) => n.toLowerCase().endsWith('/' + base))
    const data = hit ? await zip.read(hit) : null
    tipCache.set(base, data)
    return data
  }
  let title = fileName
  const meta = zip.names.find((n) => n.toLowerCase() === 'meta.xml')
  if (meta) {
    try {
      const m = new DOMParser().parseFromString(utf8.decode(await zip.read(meta)), 'text/xml')
      const t = m.getElementsByTagName('dc:title')[0] || m.getElementsByTagName('meta:bundle-title')[0]
      if (t && t.textContent.trim()) title = t.textContent.trim()
    } catch {}
  }
  for (const n of zip.names.filter((x) => /(^|\/)paintoppresets\/[^/]+\.kpp$/i.test(x)).sort()) {
    try {
      const data = await zip.read(n)
      const xml = await pngText(data, 'preset')
      if (!xml) continue
      const def = await brushFromPreset(parsePreset(xml), getTip)
      if (def.unsupported) skipped.push(def)
      else {
        try {
          def.preview = await loadImage(data)
        } catch {}
        brushes.push(def)
      }
    } catch (e) {
      skipped.push({ name: n.split('/').pop(), engine: 'unreadable' })
    }
  }
  return { brushes, skipped, title }
}
