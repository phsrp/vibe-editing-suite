// Recordings that open slowly in the preview, and the fix.
//
// An MP4 has an index (the "moov" box) that says where every frame is. Recorders write it last, after the video, and some
// (Vibe Clip, for one) write the video as thousands of small boxes. Chromium's player (FFmpeg's MP4 reader) reads the head of
// every top-level box of a file it can seek in, even after it has found the index: one request each, about 18 s for a
// 2-hour recording (7027 pieces), and again each time the file is opened.
// So the preview gets the same file through vibe-media:// as three boxes: ftyp, a copy of the index, and ONE mdat around all
// the rest of the file as it is (the old box heads inside it are just data). The index's pointers move along by what now
// comes before the data. Nothing is copied on disk. Files that do not need it are served as they are.
const fs = require('fs')
const { Readable } = require('stream')

const plans = new Map() // path -> { mtime, size, plan } (plan null = serve the file as it is)
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl'])

// the top-level boxes of a file: [{type, start, size, header}]
function topBoxes(fd, size) {
  const out = []
  const b = Buffer.alloc(16)
  let pos = 0
  while (pos + 8 <= size) {
    fs.readSync(fd, b, 0, 16, pos)
    let len = b.readUInt32BE(0)
    const type = b.toString('latin1', 4, 8)
    let header = 8
    if (len === 1) {
      len = Number(b.readBigUInt64BE(8))
      header = 16
    } else if (len === 0) len = size - pos
    if (len < header) return null // damaged
    out.push({ type, start: pos, size: len, header })
    pos += len
  }
  return out
}

// the boxes inside a buffer: [{type, start, size, header}]
function children(buf, from, to) {
  const out = []
  let pos = from
  while (pos + 8 <= to) {
    let len = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    let header = 8
    if (len === 1) {
      len = Number(buf.readBigUInt64BE(pos + 8))
      header = 16
    } else if (len === 0) len = to - pos
    if (len < header || pos + len > to) throw new Error('damaged index')
    out.push({ type, start: pos, size: len, header })
    pos += len
  }
  return out
}

const box = (type, body) => {
  const h = Buffer.alloc(8)
  h.writeUInt32BE(8 + body.length, 0)
  h.write(type, 4, 'latin1')
  return Buffer.concat([h, body])
}

// The index with every chunk position moved by `delta`. Chunk tables of 32-bit positions (stco) become 64-bit (co64), so a
// moved position always fits; that makes the result's size independent of delta.
function moved(buf, b, delta) {
  if (CONTAINERS.has(b.type)) return box(b.type, Buffer.concat(children(buf, b.start + b.header, b.start + b.size).map((c) => moved(buf, c, delta))))
  if (b.type === 'stco' || b.type === 'co64') {
    const p = b.start + b.header
    const n = buf.readUInt32BE(p + 4)
    const body = Buffer.alloc(8 + n * 8)
    buf.copy(body, 0, p, p + 4) // version and flags
    body.writeUInt32BE(n, 4)
    for (let i = 0; i < n; i++) {
      const o = b.type === 'stco' ? buf.readUInt32BE(p + 8 + i * 4) : Number(buf.readBigUInt64BE(p + 8 + i * 8))
      body.writeBigUInt64BE(BigInt(o + delta), 8 + i * 8)
    }
    return box('co64', body)
  }
  return buf.subarray(b.start, b.start + b.size)
}

// what to serve for a file: null (as it is), or { head, from, to, total }: head, then the file's bytes from..to
function planFor(file) {
  const st = fs.statSync(file)
  const known = plans.get(file)
  if (known && known.mtime === st.mtimeMs && known.size === st.size) return known.plan
  let plan = null
  const fd = fs.openSync(file, 'r')
  try {
    const top = topBoxes(fd, st.size)
    const moovs = top ? top.filter((b) => b.type === 'moov') : []
    const firstData = top ? top.findIndex((b) => b.type === 'mdat') : -1
    const at = top ? top.indexOf(moovs[0]) : -1
    // only plain MP4s with one index after the video, and nothing but padding after it
    if (top && top[0].type === 'ftyp' && moovs.length === 1 && firstData >= 0 && firstData < at && !top.some((b) => b.type === 'moof') && top.slice(at + 1).every((b) => b.type === 'free' || b.type === 'skip') && moovs[0].size < 512 * 1024 * 1024 && top.length > 50) {
      const moov = Buffer.alloc(moovs[0].size)
      fs.readSync(fd, moov, 0, moov.length, moovs[0].start)
      const whole = { type: 'moov', start: 0, size: moov.length, header: moovs[0].header }
      const size = moved(moov, whole, 0).length
      const ftyp = Buffer.alloc(top[0].size)
      fs.readSync(fd, ftyp, 0, ftyp.length, 0)
      const from = top[0].size
      const to = moovs[0].start
      // one mdat (64-bit size) around everything between ftyp and the index
      const mdat = Buffer.alloc(16)
      mdat.writeUInt32BE(1, 0)
      mdat.write('mdat', 4, 'latin1')
      mdat.writeBigUInt64BE(BigInt(16 + (to - from)), 8)
      // everything after ftyp moves along by the index and that mdat head, which now come before it
      const head = Buffer.concat([ftyp, moved(moov, whole, size + 16), mdat])
      plan = { head, from, to, total: head.length + (to - from) }
    }
  } catch {
    plan = null
  } finally {
    fs.closeSync(fd)
  }
  plans.set(file, { mtime: st.mtimeMs, size: st.size, plan })
  return plan
}

const needsIt = (file) => {
  try {
    return !!planFor(file)
  } catch {
    return false
  }
}

// the bytes start..end (inclusive) of what is served, as a stream
function rangeStream(file, plan, start, end) {
  const parts = []
  if (!plan) parts.push({ file: true, a: start, b: end })
  else {
    if (start < plan.head.length) parts.push({ buf: plan.head.subarray(start, Math.min(end + 1, plan.head.length)) })
    const a = Math.max(start, plan.head.length)
    if (end >= a) parts.push({ file: true, a: plan.from + (a - plan.head.length), b: plan.from + (end - plan.head.length) })
  }
  return Readable.from(
    (async function* () {
      for (const p of parts) {
        if (p.buf) yield p.buf
        else if (p.b >= p.a) for await (const chunk of fs.createReadStream(file, { start: p.a, end: p.b, highWaterMark: 1 << 20 })) yield chunk
      }
    })(),
  )
}

// vibe-media://file/<path, URI-encoded>
async function serve(request) {
  const file = decodeURIComponent(new URL(request.url).pathname.slice(1))
  let plan
  let size
  try {
    plan = planFor(file)
    size = plan ? plan.total : fs.statSync(file).size
  } catch {
    return new Response('not found', { status: 404 })
  }
  const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' }
  const m = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '')
  let start = 0
  let end = size - 1
  if (m) {
    if (m[1] === '' && m[2] !== '') start = Math.max(0, size - +m[2])
    else {
      start = +m[1]
      if (m[2] !== '') end = Math.min(+m[2], size - 1)
    }
    if (start >= size) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
  }
  if (process.env.VIBE_FAST_LOG) console.log(`FAST ${Date.now() % 100000} ${m ? m[0] : 'all'} -> ${start}-${end}`) // (developer test)
  headers['Content-Length'] = String(end - start + 1)
  if (m) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  return new Response(Readable.toWeb(rangeStream(file, plan, start, end)), { status: m ? 206 : 200, headers })
}

module.exports = { planFor, needsIt, serve }
