// Stabilise (steady a shaky clip): the clip stores stab = {strength 0..100}. A steadied copy of its range is made in the
// background (electron/stabilize.js); the preview shows the original until the copy is ready, the export waits for a
// full-quality one. This keeps the state of every copy (working / percent / ready / error) for the preview and the Inspector.

const status = new Map() // key -> {pct, ready: {path, from} | null, error}
const listeners = new Set()
const notify = () => listeners.forEach((fn) => fn())
export const onStab = (fn) => (listeners.add(fn), () => listeners.delete(fn))
export const STAB_DEFAULT = 50

const keyOf = (file, from, to, strength, quality) => [file, (+from).toFixed(3), (+to).toFixed(3), Math.round(strength), quality].join('|')
const strengthOf = (clip) => (clip.stab && clip.stab.strength != null ? clip.stab.strength : STAB_DEFAULT)

if (typeof window !== 'undefined' && window.api && window.api.onStabProgress) {
  window.api.onStabProgress((p) => {
    const s = status.get(keyOf(p.file, p.from, p.to, p.strength, p.quality))
    if (!s) return
    if (p.error) s.error = p.error
    else s.pct = p.pct
    notify()
  })
}

function job(file, from, to, strength, quality) {
  const k = keyOf(file, from, to, strength, quality)
  let s = status.get(k)
  if (!s) {
    s = { pct: 0, ready: null, error: null }
    status.set(k, s)
    window.api
      .stabilize({ file, from, to, strength, quality })
      .then((r) => {
        s.ready = r
        s.pct = 100
        notify()
      })
      .catch((e) => {
        s.error = String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
        notify()
      })
  }
  return s
}

// the steadied copy of a clip for the preview ({path, from} = the file and the second of the source where it starts),
// or null while it is being made (the preview then shows the original) or when the clip is not stabilised
export function stabFor(clip, media) {
  if (!clip || !clip.stab || clip.reverse || !media || media.type !== 'video' || media.missing) return null
  return job(media.path, clip.in, clip.out, strengthOf(clip), 'preview').ready
}
// for the Inspector: {pct, ready, error}, or null when the clip is not stabilised
export function stabState(clip, media) {
  if (!clip || !clip.stab || clip.reverse || !media || media.type !== 'video') return null
  return job(media.path, clip.in, clip.out, strengthOf(clip), 'preview')
}
// the export's full-quality copy (waits for it)
export async function stabForExport(file, from, to, strength) {
  const s = job(file, from, to, strength, 'export')
  if (s.ready) return s.ready
  return new Promise((resolve, reject) => {
    const off = onStab(() => {
      if (s.ready) {
        off()
        resolve(s.ready)
      } else if (s.error) {
        off()
        reject(new Error('Stabilising failed: ' + s.error))
      }
    })
  })
}
export const stabStrength = strengthOf
if (typeof window !== 'undefined') window.__stab = { status, stabFor, stabState }
