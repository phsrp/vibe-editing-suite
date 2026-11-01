import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import { TOKENS, allThemes, baseValues, themeStyle, valuesOf } from './themes.js'

// ---------------------------------------------------------------------------------------------------------------
// ThemeSample: a small picture of the editor that wears the theme (it is a stand-in, not the real thing).
// KEEP IT IN STEP WITH THE REAL EDITORS: when the video editor or the image editor gets a new kind of part (a new
// panel, a new kind of clip, a new button style), add a stand-in for it here. The two buttons under the sample
// show the real editors with the theme on, so a change that is missing here is easy to spot.
// ---------------------------------------------------------------------------------------------------------------
export function ThemeSample({ theme, kind = 'video' }) {
  return (
    <div className="theme-sample" data-theme={theme.base} style={themeStyle(theme)}>
      <div className="ts-top">
        <button>New</button>
        <button>Save</button>
        <span className="ts-name">My project</span>
        <span className="ts-spacer" />
        <button className="primary">{kind === 'video' ? 'Export video…' : 'Export picture…'}</button>
      </div>
      <div className="ts-body">
        {kind === 'video' ? (
          <div className="ts-bin">
            <div className="ts-item"><span className="ts-thumb" /><span><b>beach.mp4</b><i>00:12 · 1920×1080</i></span></div>
            <div className="ts-item"><span className="ts-thumb alt" /><span><b>logo.png</b><i>image</i></span></div>
          </div>
        ) : (
          <div className="ts-bin">
            <div className="ts-tool on">✎</div>
            <div className="ts-tool">◌</div>
            <div className="ts-tool">▭</div>
            <div className="ts-tool">T</div>
          </div>
        )}
        <div className="ts-stage">
          <div className="ts-picture">
            <span className="ts-handle" style={{ left: 8, top: 8 }} />
            <span className="ts-handle" style={{ right: 8, top: 8 }} />
            <span className="ts-handle" style={{ left: 8, bottom: 8 }} />
            <span className="ts-handle" style={{ right: 8, bottom: 8 }} />
          </div>
          <div className="ts-transport">
            <button className="primary">Play</button>
            <span className="ts-dim">00:03 / 00:12</span>
          </div>
        </div>
        {kind === 'image' ? (
          <div className="ts-insp">
            <div className="ts-colour" />
            <div className="ts-row"><span>Size</span><input type="range" defaultValue="40" tabIndex={-1} /></div>
            <div className="ts-row"><span>Opacity</span><input type="range" defaultValue="80" tabIndex={-1} /></div>
            <div className="ts-sect">Brushes <i /></div>
            <div className="ts-item"><span className="ts-thumb" /><span><b>Pencil</b></span></div>
            <div className="ts-item"><span className="ts-thumb alt" /><span><b>Ink pen</b></span></div>
          </div>
        ) : (
          <div className="ts-insp">
            <div className="ts-tabs">
              <span className="on">Clip</span>
              <span>Look</span>
              <span>Audio</span>
            </div>
            <div className="ts-sect">Transform <i /></div>
            <div className="ts-row"><span>Scale</span><input type="range" defaultValue="60" tabIndex={-1} /></div>
            <div className="ts-row"><span>Opacity</span><input type="text" defaultValue="100" readOnly tabIndex={-1} /></div>
            <div className="ts-warn">Move the playhead over this clip to edit it.</div>
          </div>
        )}
      </div>
      <div className="ts-timeline">
        {kind === 'video' ? (
          <>
            <div className="ts-lane">
              <span className="ts-clip video" style={{ left: '2%', width: '34%' }}>beach.mp4</span>
              <span className="ts-clip image" style={{ left: '37%', width: '14%' }}>logo.png</span>
              <span className="ts-clip video sel" style={{ left: '52%', width: '30%' }}>selected</span>
              <span className="ts-playhead" style={{ left: '44%' }} />
            </div>
            <div className="ts-lane">
              <span className="ts-clip stream" style={{ left: '2%', width: '34%' }}>sound</span>
              <span className="ts-clip free" style={{ left: '40%', width: '28%' }}>music.mp3</span>
              <span className="ts-clip detached" style={{ left: '70%', width: '14%' }}>detached</span>
            </div>
          </>
        ) : (
          <>
            <div className="ts-layer sel"><span className="ts-thumb" /> Photo <i>100%</i></div>
            <div className="ts-layer"><span className="ts-thumb alt" /> Paint 1 <i>80%</i></div>
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// The theme editor: the list of themes, the colours of the chosen one, and the sample.
// themes = the custom themes (settings.themes); onSave(list) keeps them; theme = id of the theme in use
// ---------------------------------------------------------------------------------------------------------------
export default function ThemeEditor({ themes, onSave, theme, setTheme, onPreview }) {
  const list = allThemes(themes)
  const [sel, setSel] = useState(theme)
  const [kind, setKind] = useState('video')
  const cur = list.find((t) => t.id === sel) || list[0]
  const [name, setName] = useState(cur.name)
  const save = useRef(null)
  useEffect(() => setName(cur.name), [cur.id])

  // changes are kept a moment after the last one (a colour picker sends many while it is dragged)
  const [draft, setDraft] = useState(null) // the custom themes, with the change that is waiting to be kept
  const customs = draft || themes || []
  const keep = (next) => {
    setDraft(next)
    clearTimeout(save.current)
    save.current = setTimeout(() => {
      onSave(next)
      setDraft(null)
    }, 350)
  }
  useEffect(() => () => clearTimeout(save.current), [])
  const theNow = allThemes(customs).find((t) => t.id === sel) || cur

  const newTheme = (from) => {
    const base = from || theNow
    const id = 'c' + Date.now().toString(36)
    let n = 1
    const names = new Set(allThemes(customs).map((t) => t.name))
    let nm = from ? `${base.name} copy` : 'My theme'
    while (names.has(nm)) nm = (from ? `${base.name} copy ` : 'My theme ') + ++n
    const t = { id, name: nm, base: base.base, vars: { ...valuesOf(base) } }
    keep([...customs, t])
    setSel(id)
  }
  const patchTheme = (patch) => keep(customs.map((t) => (t.id === theNow.id ? { ...t, ...patch } : t)))
  const setColour = (key, val) => patchTheme({ vars: { ...theNow.vars, [key]: val } })
  const resetColour = (key) => {
    const v = { ...theNow.vars }
    delete v[key]
    patchTheme({ vars: v })
  }
  const remove = () => {
    if (!window.confirm(`Delete the theme "${theNow.name}"?`)) return
    const next = customs.filter((t) => t.id !== theNow.id)
    keep(next)
    if (theme === theNow.id) setTheme('dark')
    setSel('dark')
  }
  const rename = () => {
    const v = name.trim()
    if (v && v !== theNow.name) patchTheme({ name: v.slice(0, 40) })
    else setName(theNow.name)
  }
  const values = valuesOf(theNow)
  const base = baseValues(theNow.base)
  const custom = !theNow.builtin

  return (
    <div className="theme-ed">
      <div className="te-list">
        <div className="te-list-title">Themes</div>
        {allThemes(customs).map((t) => (
          <button key={t.id} className={'te-item' + (sel === t.id ? ' on' : '')} onClick={() => setSel(t.id)}>
            <span className="te-dots">
              {['--bg', '--panel', '--accent', '--text'].map((k) => (
                <i key={k} style={{ background: valuesOf(t)[k] }} />
              ))}
            </span>
            <span className="te-name">{t.name}</span>
            {theme === t.id && <span className="te-use" title="The theme in use"><Icon name="star" size={12} /></span>}
          </button>
        ))}
        <button className="mini wide" onClick={() => newTheme(null)} title="Starts a new theme from the one that is selected">
          <Icon name="plus" size={13} /> New theme
        </button>
      </div>

      <div className="te-mid">
        <div className="te-head">
          {custom ? (
            <input className="te-title" value={name} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} title="Rename this theme" />
          ) : (
            <b className="te-title-static">{theNow.name}</b>
          )}
          <span className="te-actions">
            <button className={theme === theNow.id ? 'on' : 'primary'} disabled={theme === theNow.id} onClick={() => setTheme(theNow.id)}>
              {theme === theNow.id ? 'In use' : 'Use this theme'}
            </button>
            <button onClick={() => newTheme(theNow)} title="Make a copy you can change">Duplicate</button>
            {custom && <button onClick={remove}>Delete</button>}
          </span>
        </div>
        {!custom && <div className="hint left">This theme comes with the editor and cannot be changed. Press Duplicate (or New theme) to make your own from it.</div>}
        {custom && (
          <div className="te-mode">
            <span className="mlabel">Light or dark controls</span>
            <span className="seg">
              <button className={theNow.base === 'dark' ? 'on' : ''} onClick={() => patchTheme({ base: 'dark' })}><Icon name="moon" /> Dark</button>
              <button className={theNow.base === 'dawn' ? 'on' : ''} onClick={() => patchTheme({ base: 'dawn' })}><Icon name="sun" /> Light</button>
            </span>
          </div>
        )}
        <div className="te-colours">
          {TOKENS.map((g) => (
            <div key={g.group} className="te-group">
              <div className="te-group-title">{g.group}</div>
              {g.items.map((it) => {
                const changed = custom && theNow.vars && theNow.vars[it.key] != null && theNow.vars[it.key].toLowerCase() !== (base[it.key] || '').toLowerCase()
                return (
                  <label key={it.key} className="te-row">
                    <input type="color" value={values[it.key] || '#000000'} disabled={!custom} onChange={(e) => setColour(it.key, e.target.value)} />
                    <span className="te-label">{it.label}</span>
                    <code>{(values[it.key] || '').toLowerCase()}</code>
                    {changed ? (
                      <button className="mini" title="Back to the colour of the base theme" onClick={(e) => (e.preventDefault(), resetColour(it.key))}>↺</button>
                    ) : (
                      <span className="te-nobtn" />
                    )}
                  </label>
                )
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="te-preview">
        <div className="te-prev-title">Preview</div>
        <div className="seg">
          <button className={kind === 'video' ? 'on' : ''} onClick={() => setKind('video')}>Video editor</button>
          <button className={kind === 'image' ? 'on' : ''} onClick={() => setKind('image')}>Picture editor</button>
        </div>
        <ThemeSample theme={theNow} kind={kind} />
        <div className="hint left">A small stand-in for the editor. To see the real thing with this theme on:</div>
        <div className="te-prev-btns">
          <button onClick={() => onPreview('video', theNow)}>See it in the video editor</button>
          <button onClick={() => onPreview('image', theNow)}>See it in the picture editor</button>
        </div>
      </div>
    </div>
  )
}
