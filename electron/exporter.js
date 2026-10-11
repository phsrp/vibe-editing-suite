// Video export, main-process side.
//
// How export works:
//  1. The renderer works out a "plan": the timeline cut into pieces. Plain clip pieces are
//     read straight from the source files by FFmpeg. Transition pieces are rendered by the app
//     itself (with the same WebGL shaders as the preview): this file extracts the source frames
//     and receives the rendered frames, encoding them into a short temporary video.
//  2. One final FFmpeg run joins all pieces, mixes the audio and encodes the chosen format.
const { app, dialog, shell, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { cleanChain, estimateFloor } = require('./audioClean.js')

let job = null // {dir, procs:Set, cancelled, seg}

function track(proc) {
  job.procs.add(proc)
  proc.on('close', () => job && job.procs.delete(proc))
  return proc
}

// Runs ffmpeg to completion. Resolves with stderr; rejects with the tail of stderr on failure.
function runFfmpeg(ffmpegPath, args, onStdout, cwd) {
  return new Promise((resolve, reject) => {
    const proc = track(spawn(ffmpegPath, args, { windowsHide: true, cwd }))
    let err = ''
    proc.stderr.on('data', (d) => (err = (err + d).slice(-6000)))
    if (onStdout) proc.stdout.on('data', onStdout)
    else proc.stdout.resume()
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (job && job.cancelled) return reject(new Error('Export cancelled'))
      if (code === 0) resolve(err)
      else reject(new Error(err.trim().split('\n').slice(-6).join('\n') || `ffmpeg exited with code ${code}`))
    })
  })
}

const fit = (w, h) => `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`

// ---- is the finished file what it should be? Length, picture, sound, and every frame can be decoded.
async function checkOutput(ffmpegPath, file, plan) {
  const problems = []
  const warnings = []
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {}
  if (size < 1000) return { ok: false, problems: ['The file is empty or missing.'], warnings, duration: 0, expected: plan.totalSec, size }
  const info = await new Promise((resolve) => require('child_process').execFile(ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true, maxBuffer: 8e6 }, (_e, _o, se) => resolve(String(se || ''))))
  const dm = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(info)
  const duration = dm ? +dm[1] * 3600 + +dm[2] * 60 + +dm[3] : 0
  const expected = plan.totalSec + (process.env.VIBE_SELFTEST && process.env.VIBE_TEST_BADCHECK ? 10 : 0) // (the test makes the check fail on purpose)
  const hasVideo = /Stream #0:\d+[^\n]*: Video:/.test(info)
  const hasAudio = /Stream #0:\d+[^\n]*: Audio:/.test(info)
  if (!plan.audioOnly && !hasVideo) problems.push('The file has no picture.')
  if (plan.audio && plan.audio.length && !hasAudio) problems.push('The sound is missing from the file.')
  const tol = Math.max(0.3, expected * 0.015)
  if (Math.abs(duration - expected) > tol) problems.push(`The file is ${duration.toFixed(1)} seconds long, but it should be ${expected.toFixed(1)} seconds.`)
  // decode all of it: damaged data shows up as messages here
  const msgs = await new Promise((resolve) => require('child_process').execFile(ffmpegPath, ['-v', 'error', '-nostats', '-i', file, '-f', 'null', '-'], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (_e, _o, se) => resolve(String(se || '').split('\n').map((l) => l.trim()).filter(Boolean))))
  if (msgs.length) warnings.push(`Decoding the file gave ${msgs.length} warning${msgs.length === 1 ? '' : 's'}: ${msgs[0].slice(0, 160)}`)
  return { ok: problems.length === 0, problems, warnings, duration, expected, size, hasVideo, hasAudio }
}

// ---- the final ffmpeg command: join pieces, mix audio, encode
// Every source file is opened inside the filter script (movie / amovie), not with "-i" on the command line.
// Windows only allows about 32,000 characters for a command, so a long timeline (one piece per clip) would not fit,
// while the script file has no such limit. (Checked: same frames and same audio samples as -ss / -t inputs.)
// A filter value is escaped twice: once for the option, once for the filter graph.
const fq = (s) =>
  String(s)
    .replace(/\\/g, '/')
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:')
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[[\],;]/g, (m) => '\\' + m)
const num = (v) => (+v).toFixed(6)

// what ffmpeg says about a file: where its timestamps start, and the numbers of its audio streams
const probeCache = new Map()
function probeFile(ffmpegPath, file) {
  if (!probeCache.has(file)) {
    probeCache.set(
      file,
      new Promise((resolve) => {
        require('child_process').execFile(ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true, maxBuffer: 8e6 }, (_err, _out, text) => {
          text = String(text || '')
          const start = /start: (-?[\d.]+)/.exec(text)
          const audio = []
          for (const m of text.matchAll(/Stream #0:(\d+)[^\n]*?: Audio/g)) audio.push(+m[1])
          resolve({ start: start ? +start[1] : 0, audio })
        })
      })
    )
  }
  return probeCache.get(file)
}
async function probePlan(ffmpegPath, plan) {
  const files = new Set()
  plan.segments.forEach((s) => s.kind !== 'trans' && !s.isImage && s.file && files.add(s.file))
  plan.audio.forEach((t) => t.clips.forEach((c) => files.add(c.file)))
  const info = new Map()
  for (const f of files) info.set(f, await probeFile(ffmpegPath, f))
  return info
}

// Two ways to feed the files to ffmpeg:
//  - info == null: "-i" inputs on the command line (the usual way)
//  - info given:   movie / amovie inside the script file (for projects with so many pieces that the command would be too long)
function buildFinal(plan, dir, info) {
  const inputs = []
  const filters = []
  const script = !!info
  const meta = (f) => (info && info.get(f)) || { start: 0, audio: [] }
  let n = 0
  const addInput = (...a) => {
    inputs.push(...a)
    return n++
  }

  // video pieces
  const vlabels = []
  plan.segments.forEach((s, k) => {
    let head // how the piece starts: the input stream, or a movie source
    let pre
    if (s.kind === 'trans') {
      head = script ? `movie=filename=${fq(path.join(dir, `seg_${s.k}.mp4`))}:streams=dv,tpad=stop=3:stop_mode=clone,` : `[${addInput('-i', path.join(dir, `seg_${s.k}.mp4`))}:v:0]`
      pre = `setpts=PTS-STARTPTS,fps=${plan.fps},format=yuv420p`
    } else if (s.isImage) {
      // one picture, repeated for as long as the piece lasts
      head = script ? `movie=filename=${fq(s.file)}:streams=dv,loop=loop=-1:size=1,setpts=N/(${plan.fps}*TB),` : `[${addInput('-loop', '1', '-framerate', String(plan.fps), '-t', String(s.frames / plan.fps + 1), '-i', s.file)}:v:0]`
      pre = `fps=${plan.fps},${fit(plan.w, plan.h)},format=yuv420p`
    } else {
      if (script) {
        const a = s.srcStart + meta(s.file).start
        // (tpad before fps: otherwise fps loses the last frame of a file; the extra copies are cut off below)
        head = `movie=filename=${fq(s.file)}:seek_point=${num(s.srcStart)}:streams=dv,trim=start=${num(a)}:end=${num(a + s.srcDur)},setpts=PTS-STARTPTS,tpad=stop=3:stop_mode=clone,`
      } else head = `[${addInput('-ss', String(s.srcStart), '-t', String(s.srcDur), '-i', s.file)}:v:0]`
      // setpts makes the clip play faster or slower (speed 2 = twice as fast)
      pre = `setpts=PTS/${s.speed || 1},fps=${plan.fps},${fit(plan.w, plan.h)},format=yuv420p`
    }
    // exactly s.frames frames per piece, so audio and video stay in sync over the whole timeline
    filters.push(`${head}${pre},setpts=PTS-STARTPTS,tpad=stop=4:stop_mode=clone,trim=end_frame=${s.frames},setpts=PTS-STARTPTS[v${k}]`)
    vlabels.push(`[v${k}]`)
  })
  // the picture is also saved as a small preview image twice a second, which the Export tab shows while it works
  if (vlabels.length) {
    filters.push(`${vlabels.join('')}concat=n=${vlabels.length}:v=1:a=0[vcat]`)
    filters.push('[vcat]split=2[vout][vprev]')
    filters.push('[vprev]fps=2,scale=640:-2[vpv]')
  }

  // audio: one chain per clip, mixed per track
  const tlabels = []
  plan.audio.forEach((t, ti) => {
    const clipLabels = []
    t.clips.forEach((c, ci) => {
      let chain
      if (script) {
        const m = meta(c.file)
        const abs = m.audio[c.stream] != null ? m.audio[c.stream] : m.audio[0] != null ? m.audio[0] : 0 // this audio stream's number in the file
        const a = c.srcStart + m.start
        chain = `amovie=filename=${fq(c.file)}:seek_point=${num(c.srcStart)}:streams=${abs},atrim=start=${num(a)}:end=${num(a + (c.srcDur || c.dur))},asetpts=PTS-STARTPTS`
      } else {
        const i = addInput('-ss', String(c.srcStart), '-t', String(c.srcDur || c.dur), '-i', c.file)
        chain = `[${i}:a:${c.stream}]`
      }
      chain += `${script ? ',' : ''}aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS`
      const cc = cleanChain(c.clean, c.cleanNf) // noise reduction / rumble / voice preset of this clip
      if (cc) chain += ',' + cc
      if (c.reverse) chain += ',areverse'
      // speed: atempo only takes 0.5 to 2 at a time, so a bigger change is a chain of them
      let sp = c.speed || 1
      while (sp > 2) {
        chain += ',atempo=2'
        sp /= 2
      }
      while (sp < 0.5) {
        chain += ',atempo=0.5'
        sp /= 0.5
      }
      if (Math.abs(sp - 1) > 1e-6) chain += `,atempo=${sp.toFixed(5)}`
      chain += `,volume=${c.vol}`
      // the volume curve: piecewise straight lines between the keyframes (seconds from the start of the clip)
      if (c.env && c.env.length) {
        const k = c.env.slice(0, 40).map((p) => ({ t: Math.max(0, +p.t.toFixed(3)), v: Math.max(0, Math.min(2, +p.v.toFixed(3))) }))
        let expr = String(k[k.length - 1].v)
        for (let i = k.length - 2; i >= 0; i--) {
          const a = k[i]
          const b = k[i + 1]
          const seg = b.t - a.t < 0.001 ? String(b.v) : `(${a.v}+(${(b.v - a.v).toFixed(4)})*(t-${a.t})/${(b.t - a.t).toFixed(4)})`
          expr = `if(lt(t\,${b.t})\,${seg}\,${expr})`
        }
        chain += `,volume='if(lt(t\,${k[0].t})\,${k[0].v}\,${expr})':eval=frame`
      }
      if (c.fadeIn > 0) chain += `,afade=t=in:st=0:d=${c.fadeIn}`
      if (c.fadeOut > 0) chain += `,afade=t=out:st=${Math.max(0, c.dur - c.fadeOut)}:d=${c.fadeOut}`
      // the fade handles of the clip itself (the two above are the crossfades of transitions)
      if (c.ufIn > 0) chain += `,afade=t=in:st=0:d=${(+c.ufIn).toFixed(3)}`
      if (c.ufOut > 0) chain += `,afade=t=out:st=${Math.max(0, c.dur - c.ufOut).toFixed(3)}:d=${(+c.ufOut).toFixed(3)}`
      // (script mode: adelay leaves odd timestamps on movie sources, which made a later atrim cut the sound short)
      if (c.at > 0.0005) chain += `,adelay=${Math.round(c.at * 1000)}:all=1${script ? ',asetpts=N/SR/TB' : ''}`
      const label = `[a${ti}_${ci}]`
      filters.push(chain + label)
      clipLabels.push(label)
    })
    if (clipLabels.length === 1) tlabels.push(clipLabels[0])
    else {
      filters.push(`${clipLabels.join('')}amix=inputs=${clipLabels.length}:duration=longest:normalize=0[t${ti}]`)
      tlabels.push(`[t${ti}]`)
    }
  })
  const aouts = []
  const tot = plan.totalSec.toFixed(4)
  if (tlabels.length) {
    if (plan.audioMode === 'mix' || tlabels.length === 1) {
      const mix = tlabels.length > 1 ? `${tlabels.join('')}amix=inputs=${tlabels.length}:duration=longest:normalize=0,` : `${tlabels[0]}`
      // loudness: bring the whole mix to a target loudness (LUFS), like streaming services do
      const ln = plan.loudness && plan.loudness !== 'off' ? `loudnorm=I=${plan.loudness}:TP=-1.5:LRA=11,` : ''
      filters.push(`${mix}${ln}alimiter=limit=0.97,apad=whole_dur=${tot},atrim=end=${tot}[aout0]`)
      aouts.push('[aout0]')
    } else {
      tlabels.forEach((l, i) => {
        filters.push(`${l}apad=whole_dur=${tot},atrim=end=${tot}[aout${i}]`)
        aouts.push(`[aout${i}]`)
      })
    }
  }

  const scriptPath = path.join(dir, 'filters.txt')
  fs.writeFileSync(scriptPath, filters.join(';\n'))

  const br = plan.bitrateMbps
  const args = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', ...inputs, '-filter_complex_script', scriptPath]
  if (!plan.audioOnly) args.push('-map', '[vout]')
  aouts.forEach((l) => args.push('-map', l))
  if (plan.audioOnly) {
    // audio only: MP3, M4A (AAC) or WAV
    if (!aouts.length) throw new Error('There is no sound to export: every audio track is muted or empty.')
    const kb = `${plan.audioKbps || 192}k`
    if (plan.audioFormat === 'wav') args.push('-c:a', 'pcm_s16le', '-ar', '48000')
    else if (plan.audioFormat === 'm4a') args.push('-c:a', 'aac', '-b:a', kb, '-ar', '48000', '-movflags', '+faststart')
    else args.push('-c:a', 'libmp3lame', '-b:a', kb, '-ar', '48000')
    args.push(plan.out)
    return args
  }
  // the video encoder: the processor (x264 / x265), or a graphics card (NVIDIA NVENC, AMD AMF, Intel Quick Sync)
  const hevc = plan.codec === 'h265'
  const speed = plan.speed || 'balanced'
  const enc = plan.encoder || 'cpu'
  if (enc === 'nvenc') {
    args.push('-c:v', hevc ? 'hevc_nvenc' : 'h264_nvenc', '-preset', { fast: 'p3', balanced: 'p5', best: 'p7' }[speed] || 'p5', '-rc', 'vbr')
    if (hevc) args.push('-tag:v', 'hvc1')
  } else if (enc === 'amf') {
    args.push('-c:v', hevc ? 'hevc_amf' : 'h264_amf', '-quality', { fast: 'speed', balanced: 'balanced', best: 'quality' }[speed] || 'balanced', '-rc', 'vbr_peak')
    if (hevc) args.push('-tag:v', 'hvc1')
  } else if (enc === 'qsv') {
    args.push('-c:v', hevc ? 'hevc_qsv' : 'h264_qsv', '-preset', { fast: 'veryfast', balanced: 'medium', best: 'slow' }[speed] || 'medium')
    if (hevc) args.push('-tag:v', 'hvc1')
  } else if (hevc) {
    args.push('-c:v', 'libx265', '-preset', plan.preset, '-tag:v', 'hvc1', '-x265-params', 'log-level=error')
  } else {
    args.push('-c:v', 'libx264', '-preset', plan.preset, '-profile:v', 'high')
  }
  args.push('-b:v', `${br}M`, '-maxrate', `${(br * 1.5).toFixed(2)}M`, '-bufsize', `${(br * 3).toFixed(2)}M`, '-pix_fmt', 'yuv420p', '-r', String(plan.fps))
  if (aouts.length) {
    args.push('-c:a', 'aac', '-b:a', `${plan.audioKbps || 192}k`, '-ar', '48000')
    // MP4 keeps a track's name in "handler_name" (players show it when you switch audio tracks)
    if (aouts.length > 1)
      plan.audio.forEach((t, i) => args.push(`-metadata:s:a:${i}`, `title=${t.name}`, `-metadata:s:a:${i}`, `handler_name=${t.name}`))
  }
  if (/\.(mp4|mov)$/i.test(plan.out)) args.push('-movflags', '+faststart')
  args.push(plan.out)
  args.push('-map', '[vpv]', '-q:v', '6', '-update', '1', '-f', 'image2', path.join(dir, 'preview.jpg'))
  return args
}

// Which graphics-card encoders really work on this PC: each one is tried on a few test frames.
let encoderInfo = null
async function detectEncoders(ffmpegPath) {
  const gpus = await new Promise((resolve) => {
    require('child_process').execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }'],
      { windowsHide: true, timeout: 15000 },
      (err, out) => resolve(err ? [] : String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
    )
  })
  const tryEnc = (codec) =>
    new Promise((resolve) => {
      const p = spawn(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30', '-frames:v', '5', '-c:v', codec, '-pix_fmt', 'yuv420p', '-f', 'null', '-'], { windowsHide: true })
      p.on('error', () => resolve(false))
      p.on('close', (code) => resolve(code === 0))
    })
  const [nvenc, amf, qsv] = await Promise.all([tryEnc('h264_nvenc'), tryEnc('h264_amf'), tryEnc('h264_qsv')])
  return { gpus, available: [nvenc && 'nvenc', amf && 'amf', qsv && 'qsv'].filter(Boolean) }
}

function register({ ffmpegPath, getWindow }) {
  ipcMain.handle('export:encoders', async () => {
    if (!encoderInfo) encoderInfo = await detectEncoders(ffmpegPath)
    return encoderInfo
  })

  ipcMain.handle('export:chooseOutput', async (_e, name, ext) => {
    if (process.env.VIBE_SELFTEST && process.env.VIBE_TEST_OUT) return process.env.VIBE_TEST_OUT // developer self-test: no dialog
    const kind = { mp4: 'MP4 video', mkv: 'MKV video', mov: 'MOV video', mp3: 'MP3 audio', m4a: 'M4A audio', wav: 'WAV audio' }[ext] || 'MP4 video'
    const r = await dialog.showSaveDialog(getWindow(), {
      title: 'Export video',
      defaultPath: name,
      filters: [{ name: kind, extensions: [ext || 'mp4'] }],
    })
    return r.canceled ? null : r.filePath
  })

  ipcMain.handle('export:begin', () => {
    const dir = fs.mkdtempSync(path.join(app.getPath('temp'), 'vibe-export-'))
    job = { dir, procs: new Set(), cancelled: false, seg: null }
    return dir
  })

  // Extract the source frames a transition needs, already fitted to the export size.
  ipcMain.handle('export:extract', async (_e, o) => {
    const outDir = path.join(job.dir, o.name)
    fs.mkdirSync(outDir, { recursive: true })
    // noPad: keep the picture's own shape (the renderer letterboxes it, so layers can be see-through)
    const vf = o.noPad ? `scale=${o.w}:${o.h}:force_original_aspect_ratio=decrease,setsar=1` : `${fit(o.w, o.h)}`
    const args = ['-y', '-v', 'error']
    if (o.isImage) args.push('-i', o.file, '-vf', vf, '-frames:v', '1')
    else args.push('-ss', String(o.start), '-t', String(o.dur), '-i', o.file, '-vf', `setpts=PTS/${o.speed || 1},fps=${o.fps},${vf}`, '-frames:v', String(o.maxFrames))
    args.push('-compression_level', '1', path.join(outDir, '%05d.png'))
    await runFfmpeg(ffmpegPath, args)
    const count = fs.readdirSync(outDir).length
    return { dir: outDir, count }
  })

  // Rendered transition frames arrive one at a time and are piped into an encoder.
  ipcMain.handle('export:segBegin', (_e, { k, w, h, fps, yuv }) => {
    const out = path.join(job.dir, `seg_${k}.mp4`)
    const proc = track(
      spawn(
        ffmpegPath,
        yuv
          ? // frames come as planar YUV from the graphics card, top row first
            ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${w}x${h}`, '-r', String(fps), '-i', 'pipe:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', out]
          : ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-r', String(fps), '-i', 'pipe:0', '-vf', 'vflip', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', out],
        { windowsHide: true }
      )
    )
    let err = ''
    proc.stderr.on('data', (d) => (err = (err + d).slice(-4000)))
    proc.stdout.resume()
    const done = new Promise((resolve, reject) => {
      proc.on('error', reject)
      proc.stdin.on('error', () => {}) // surfaced through the exit code
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || 'segment encode failed'))))
    })
    job.seg = { proc, done }
  })

  ipcMain.handle('export:frame', async (_e, buf) => {
    const { proc } = job.seg
    const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
    if (!proc.stdin.write(b)) await new Promise((r) => proc.stdin.once('drain', r))
  })

  ipcMain.handle('export:segEnd', async () => {
    const { proc, done } = job.seg
    proc.stdin.end()
    await done
    job.seg = null
  })

  ipcMain.handle('export:final', async (e, plan) => {
    // The file is written under a temporary name next to the final one. Only a finished file that passed the check takes the real name,
    // so a failed or cancelled export can never replace a good file with a broken one.
    const finalOut = plan.out
    const ext = path.extname(finalOut)
    const partial = path.join(path.dirname(finalOut), path.basename(finalOut, ext) + '.partial' + ext)
    plan.out = partial
    // Usually the files are given to ffmpeg as "-i" inputs. Windows allows about 32,000 characters for a command, so when
    // the project has too many pieces for that, the files are opened from the script file instead (no limit).
    // clips with noise reduction: measure how loud their noise is first (the same way the preview does)
    for (const t of plan.audio) {
      for (const c of t.clips) {
        if (c.clean && c.clean.nr > 0) c.cleanNf = await estimateFloor(ffmpegPath, c.file, c.stream, c.srcStart, c.srcDur || c.dur)
      }
    }
    let args = buildFinal(plan, job.dir, null)
    const tooLong = args.reduce((sum, a) => sum + String(a).length + 3, 0) > 28000
    if (tooLong || process.env.VIBE_FORCE_SCRIPT) args = buildFinal(plan, job.dir, await probePlan(ffmpegPath, plan))
    let buf = ''
    try {
    await runFfmpeg(ffmpegPath, args, (d) => {
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const l of lines) {
        const m = /^frame=(\d+)/.exec(l.trim())
        if (m && !plan.audioOnly) e.sender.send('export:progress', { frame: +m[1] })
        // audio only has no frames: ffmpeg reports how many seconds are done instead
        const sm = /^out_time_(?:ms|us)=(\d+)/.exec(l.trim())
        if (sm && plan.audioOnly) e.sender.send('export:progress', { frame: Math.round((+sm[1] / 1e6) * plan.fps) })
      }
    }, job.dir)
    } catch (err) {
      try {
        fs.rmSync(partial, { force: true })
      } catch {}
      throw err
    }
    e.sender.send('export:progress', { label: 'Checking the finished file…' })
    const check = await checkOutput(ffmpegPath, partial, plan)
    let outPath = finalOut
    if (check.ok) fs.renameSync(partial, finalOut) // (replaces an older file of the same name only now)
    else {
      // keep what was made, but under its own name: never on top of the file that was there
      let bad = path.join(path.dirname(finalOut), path.basename(finalOut, ext) + ' (check failed)' + ext)
      for (let i = 2; fs.existsSync(bad); i++) bad = path.join(path.dirname(finalOut), path.basename(finalOut, ext) + ' (check failed ' + i + ')' + ext)
      try {
        fs.renameSync(partial, bad)
        outPath = bad
      } catch {
        outPath = partial
      }
    }
    return { path: outPath, check }
  })

  ipcMain.handle('export:cancel', () => {
    if (!job) return
    job.cancelled = true
    for (const p of job.procs) {
      try {
        p.kill()
      } catch {}
    }
  })

  ipcMain.handle('export:cleanup', async () => {
    if (!job) return
    const dir = job.dir
    job = null
    // give killed processes a moment to release their files
    await new Promise((r) => setTimeout(r, 300))
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  })

  ipcMain.handle('export:reveal', (_e, file) => shell.showItemInFolder(file))
}

module.exports = { register }
