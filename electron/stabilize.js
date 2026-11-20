// Stabilise: a steadied copy of part of a video, made with FFmpeg's vid.stab in two passes:
//   1. vidstabdetect looks at how the picture moves from frame to frame (camera shake) and writes it to a .trf file
//   2. vidstabtransform smooths that path and moves each frame against the shake; it zooms in just enough that no
//      empty edges show (optzoom=1)
// The copy covers the clip's range [from, to] of the file. A copy that already covers the range (same file, same
// strength) is used again, so trimming a clip shorter does not start over. quality 'preview' is smaller and quicker;
// 'export' is full size and high quality. Progress goes to the window as 'stab:progress'.
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

let ffmpegPath = null
let dirOf = null
let send = () => {}
const jobs = new Map() // key -> promise
const progress = new Map() // key -> 0..100

function setup(opts) {
  ffmpegPath = opts.ffmpegPath
  dirOf = opts.dir
  send = opts.send
}

const indexFile = () => path.join(dirOf(), 'index.json')
function readIndex() {
  try {
    return JSON.parse(fs.readFileSync(indexFile(), 'utf8'))
  } catch {
    return []
  }
}
function addIndex(e) {
  const list = readIndex().filter((x) => fs.existsSync(x.out) && x.out !== e.out)
  list.push(e)
  fs.writeFileSync(indexFile(), JSON.stringify(list))
}

// strength 0..100 -> how many frames the camera path is smoothed over
const smoothing = (s) => Math.round(8 + (Math.max(0, Math.min(100, s)) / 100) * 52)

function ff(args, cwd, dur, onPct) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-v', 'error', '-progress', 'pipe:1', '-nostats', ...args], { cwd, windowsHide: true })
    let err = ''
    let buf = ''
    p.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        const m = /^out_time_us=(\d+)/.exec(line)
        if (m && dur > 0) onPct(Math.min(100, (+m[1] / 1e6 / dur) * 100))
      }
    })
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').slice(-3).join(' ') || 'ffmpeg stopped (' + code + ')'))))
  })
}

// returns {path, from}: the steadied copy and the second of the file where it starts
async function stabilize({ file, from, to, strength = 50, quality = 'preview' }) {
  let mt = 0
  try {
    mt = fs.statSync(file).mtimeMs
  } catch {
    throw new Error('The video file is missing.')
  }
  from = Math.max(0, +from || 0)
  to = Math.max(from + 0.1, +to || 0)
  const st = Math.round(strength)
  // a copy that covers this range already?
  const hit = readIndex().find((x) => x.file === file && x.mt === mt && x.strength === st && (x.quality === quality || x.quality === 'export') && x.from <= from + 0.001 && x.to >= to - 0.001 && fs.existsSync(x.out))
  if (hit) return { path: hit.out, from: hit.from }
  const key = crypto.createHash('sha1').update([file, mt, from.toFixed(3), to.toFixed(3), st, quality].join('|')).digest('hex').slice(0, 16)
  if (jobs.has(key)) return jobs.get(key)
  const dir = dirOf()
  const out = path.join(dir, key + '.mp4')
  const job = (async () => {
    const dur = to - from
    const tell = (pct) => {
      progress.set(key, pct)
      send({ file, from, to, strength: st, quality, pct: Math.round(pct) })
    }
    tell(0)
    const trf = key + '.trf' // a plain name: the filter runs with the folder as its working directory (no drive letter to escape)
    const seek = ['-ss', String(from), '-t', String(dur), '-i', file]
    await ff([...seek, '-an', '-vf', `vidstabdetect=shakiness=6:accuracy=15:stepsize=6:result=${trf}`, '-f', 'null', '-'], dir, dur, (p) => tell(p * 0.45))
    const preview = quality !== 'export'
    const vf = `vidstabtransform=input=${trf}:smoothing=${smoothing(st)}:optzoom=1:interpol=bicubic,unsharp=5:5:0.5:3:3:0` + (preview ? ",scale=-2:'min(720,ih)'" : '')
    const tmp = key + '.part.mp4'
    await ff([...seek, '-an', '-vf', vf, '-c:v', 'libx264', '-preset', preview ? 'veryfast' : 'medium', '-crf', preview ? '22' : '14', '-g', preview ? '12' : '60', '-pix_fmt', 'yuv420p', '-y', tmp], dir, dur, (p) => tell(45 + p * 0.55))
    fs.renameSync(path.join(dir, tmp), out)
    fs.rmSync(path.join(dir, trf), { force: true })
    addIndex({ file, mt, from, to, strength: st, quality, out })
    tell(100)
    return { path: out, from }
  })()
  jobs.set(key, job)
  job.catch((e) => send({ file, from, to, strength: st, quality, error: String(e.message || e) })).finally(() => jobs.delete(key))
  return job
}

module.exports = { setup, stabilize, smoothing }
