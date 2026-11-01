import { useEffect, useState } from 'react'
import Icon from './Icon.jsx'
import { toUrl } from './state.js'

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} day${d > 1 ? 's' : ''} ago`
  return new Date(t).toLocaleDateString()
}
const len = (s) => {
  s = Math.round(s || 0)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function Home({ active, onNew, onOpen, onOpenPicture, onOpenRecent }) {
  const [recents, setRecents] = useState(null)
  const load = () => window.api.recentList().then(setRecents)
  useEffect(() => {
    if (active) load()
  }, [active])

  const remove = async (e, r) => {
    e.stopPropagation()
    await window.api.recentRemove(r.path)
    load()
  }

  return (
    <div className="home" style={{ display: active ? undefined : 'none' }}>
      <div className="home-inner">
        <div className="home-hero">
          <img className="home-logo" src="./icon.png" alt="" />
          <div>
            <h1>Vibe Editing Suite</h1>
            <div className="home-sub">Start something new or pick up where you left off. You can keep several projects open at once.</div>
          </div>
        </div>

        <div className="home-actions">
          <button className="primary big" onClick={onNew}>
            <Icon name="plus" size={16} /> New project
          </button>
          <button className="big" onClick={onOpen}>
            <Icon name="folder" size={16} /> Open project…
          </button>
          <button className="big" onClick={onOpenPicture} title="Open a picture from your computer in the picture editor">
            <Icon name="image" size={16} /> Open picture…
          </button>
          <button className="big" onClick={() => window.api.openProjectsFolder()} title="Where your projects are saved by default (Documents > Vibe Editing Suite Projects)">
            <Icon name="folder" size={16} /> Projects folder
          </button>
        </div>

        <h2>Recent projects</h2>
        {recents && recents.length === 0 && <div className="hint left home-empty">Nothing here yet. Projects you save or open will show up here. New projects are saved in your Documents folder, in Vibe Editing Suite Projects.</div>}
        <div className="cards">
          {(recents || []).map((r) => (
            <div key={r.path} className="card" onClick={() => onOpenRecent(r)} title={r.path}>
              <div className="card-thumb" style={{ backgroundImage: r.thumb ? `url("${toUrl(r.thumb)}")` : undefined }}>
                {!r.thumb && <Icon name={r.kind === 'image' || r.kind === 'drawing' ? 'image' : 'play'} size={28} />}
                <span className={'card-badge ' + (r.kind === 'image' || r.kind === 'drawing' ? 'image' : 'video')}>{r.kind === 'image' || r.kind === 'drawing' ? 'picture' : 'video'}</span>
                <button className="card-x" onClick={(e) => remove(e, r)} title="Remove from this list (the file is not deleted)">
                  <Icon name="x" size={12} />
                </button>
              </div>
              <div className="card-name">{r.name}</div>
              <div className="card-sub">
                {r.kind === 'image' || r.kind === 'drawing'
                  ? `${r.clips} layer${r.clips === 1 ? '' : 's'} · ${r.size || ''} · ${ago(r.modified)}`
                  : `${r.clips} clip${r.clips === 1 ? '' : 's'} · ${len(r.duration)} · ${ago(r.modified)}`}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
