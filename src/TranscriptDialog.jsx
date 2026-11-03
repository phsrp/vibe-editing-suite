import { useMemo, useState } from 'react'
import { layout, speedOf } from './state.js'

// "Edit by text": the words of the video on the main track, in order. Select words and delete them (the video is cut
// and the gap closes), or remove every filler word ("um", "uh") or long pause in one go.
const FILLER = /^(u+m+|u+h+|e+r+m*|a+h+|e+h+|h+m+|m+h*m+|uhm+)$/i
const plain = (w) => String(w).toLowerCase().replace(/[^a-z']/g, '')

// the words of the main track at their place on the timeline
export function sequenceWords(state) {
  const out = []
  for (const c of layout(state.clips)) {
    const tr = state.transcripts && state.transcripts[c.mediaId]
    if (!tr || !tr.words || c.reverse) continue
    const sp = speedOf(c)
    for (const w of tr.words) {
      if (w.s < c.in - 1e-6 || w.e > c.out + 1e-6) continue
      out.push({ text: w.text, start: c.start + (w.s - c.in) / sp, end: c.start + (w.e - c.in) / sp, clip: c.id, filler: FILLER.test(plain(w.text)) })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

// the time to cut for a run of words: from just before the first to just after the last, never into the neighbours
export function wordsRange(words, i0, i1) {
  const prev = words[i0 - 1]
  const next = words[i1 + 1]
  const t0 = Math.max(words[i0].start - 0.03, prev ? (prev.end + words[i0].start) / 2 : 0)
  const t1 = Math.min(words[i1].end + 0.03, next ? (words[i1].end + next.start) / 2 : Infinity)
  return [t0, t1]
}
// filler words: neighbours that are both fillers are one cut
export function fillerRanges(words) {
  const out = []
  for (let i = 0; i < words.length; i++) {
    if (!words[i].filler) continue
    let j = i
    while (words[j + 1] && words[j + 1].filler && words[j + 1].clip === words[i].clip) j++
    out.push(wordsRange(words, i, j))
    i = j
  }
  return out
}
// pauses: the silence between two words, longer than minPause; a little air is kept
const KEEP = 0.15
export function pauseRanges(words, minPause) {
  const out = []
  for (let i = 0; i + 1 < words.length; i++) {
    const p = words[i]
    const q = words[i + 1]
    const gap = q.start - p.end
    if (gap > minPause && gap > 2 * KEEP + 0.05) out.push([p.end + KEEP, q.start - KEEP])
  }
  return out
}

export default function TranscriptDialog({ state, dispatch, onClose }) {
  const words = useMemo(() => sequenceWords(state), [state.clips, state.transcripts])
  const [a, setA] = useState(null) // selected run of words: indexes a..b
  const [b, setB] = useState(null)
  const [minPause, setMinPause] = useState(0.8)
  const [msg, setMsg] = useState('')
  const lo = a == null ? null : Math.min(a, b == null ? a : b)
  const hi = a == null ? null : Math.max(a, b == null ? a : b)
  const picked = lo == null ? [] : words.slice(lo, hi + 1)

  const click = (i, e) => {
    if (e.shiftKey && a != null) setB(i)
    else {
      setA(i)
      setB(i)
      dispatch({ type: 'setPlayhead', t: Math.max(0, words[i].start), user: true })
    }
  }

  const cut = (ranges, what) => {
    if (!ranges.length) {
      setMsg('Nothing to remove.')
      return
    }
    const secs = ranges.reduce((s, r) => s + (r[1] - r[0]), 0)
    dispatch({ type: 'rippleDelete', ranges })
    setA(null)
    setB(null)
    setMsg(`Removed ${what} (${secs.toFixed(1)} seconds). Undo (Ctrl+Z) brings it back.`)
  }
  const deleteSelected = () => {
    if (lo == null) return
    cut([wordsRange(words, lo, hi)], picked.length === 1 ? 'the word' : `${picked.length} words`)
  }
  const fillers = words.filter((w) => w.filler).length
  const pauses = pauseRanges(words, minPause).length

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal tr-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Edit by text</h3>
        <div className="hint left">
          Click a word to jump there. Click one word and shift-click another to select a run of words. Deleting words cuts that part out of the whole video and closes the gap.
        </div>
        {!words.length ? (
          <div className="hint">There are no words for the video on the main track yet. Use Captions to listen to it first.</div>
        ) : (
          <div className="tr-text">
            {words.map((w, i) => (
              <span
                key={i}
                className={'tr-word' + (lo != null && i >= lo && i <= hi ? ' sel' : '') + (w.filler ? ' filler' : '') + (words[i - 1] && w.start - words[i - 1].end > minPause ? ' after-pause' : '')}
                onClick={(e) => click(i, e)}
                title={w.start.toFixed(2) + ' s'}
              >
                {w.text}{' '}
              </span>
            ))}
          </div>
        )}
        <div className="tr-tools">
          <button className="primary" disabled={lo == null} onClick={deleteSelected}>
            Delete {picked.length > 1 ? `${picked.length} words` : 'word'}
          </button>
          <button disabled={!fillers} onClick={() => cut(fillerRanges(words), `${fillers} filler word${fillers === 1 ? '' : 's'}`)} title="Removes every um, uh, erm, hmm">
            Remove filler words ({fillers})
          </button>
          <span className="tr-pause">
            <button disabled={!pauses} onClick={() => cut(pauseRanges(words, minPause), `${pauses} pause${pauses === 1 ? '' : 's'}`)} title="Shortens every silence between words that is longer than this">
              Shorten pauses ({pauses})
            </button>
            <span>longer than</span>
            <input type="number" min="0.3" max="5" step="0.1" value={minPause} onChange={(e) => setMinPause(Math.max(0.3, +e.target.value || 0.8))} />
            <span>s</span>
          </span>
        </div>
        {msg && <div className="hint left">{msg}</div>}
        <div className="modal-foot">
          <span />
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
