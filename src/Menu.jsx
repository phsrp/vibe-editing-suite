import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'

// Menus: the menu bar at the top of an editor (File, Edit, ...) and the right-click menu on the timeline.
// An item is { label, keys, run, disabled, checked, hint } or { sep: true }. Items that are null / false are left out,
// so lists can be written with conditions inline. checked = true | false shows a tick column (a setting that is on or off).

function MenuList({ items, onDone, style, listRef }) {
  const list = items.filter(Boolean)
  // no separator at the start, at the end, or two in a row
  const clean = list.filter((it, i) => !it.sep || (i > 0 && i < list.length - 1 && !list[i - 1].sep))
  const ticks = clean.some((it) => it.checked != null)
  return (
    <div className="menu-list" role="menu" style={style} ref={listRef} onPointerDown={(e) => e.stopPropagation()}>
      {clean.map((it, i) =>
        it.sep ? (
          <div key={'s' + i} className="menu-sep" />
        ) : it.head ? (
          <div key={'h' + i} className="menu-head">{it.head}</div>
        ) : (
          <button
            key={it.label}
            role="menuitem"
            className="menu-item"
            disabled={!!it.disabled}
            title={it.hint || undefined}
            onClick={() => {
              onDone()
              it.run && it.run()
            }}
          >
            {ticks && <span className="menu-tick">{it.checked ? <Icon name="check" size={13} /> : null}</span>}
            <span className="menu-label">{it.label}</span>
            {it.keys ? <span className="menu-keys">{it.keys}</span> : null}
          </button>
        )
      )}
    </div>
  )
}

// the menu bar: click a name to open its menu; while one is open, moving over another name opens that one
export function MenuBar({ menus }) {
  const [open, setOpen] = useState(null)
  const barRef = useRef(null)
  useEffect(() => {
    if (open == null) return
    const close = (e) => {
      if (barRef.current && barRef.current.contains(e.target)) return
      setOpen(null)
    }
    const key = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(null)
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault()
        e.stopPropagation()
        setOpen((o) => (o + (e.key === 'ArrowRight' ? 1 : menus.length - 1)) % menus.length)
      }
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', () => setOpen(null), { once: true })
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', key, true)
    }
  }, [open, menus.length])
  return (
    <nav className="menubar" ref={barRef}>
      {menus.map((m, i) => (
        <span key={m.label} className="menu-root">
          <button
            className={'menu-name' + (open === i ? ' on' : '')}
            data-menu={m.label}
            onPointerDown={(e) => {
              e.preventDefault() // keep the keyboard where it was
              setOpen(open === i ? null : i)
            }}
            onPointerEnter={() => open != null && open !== i && setOpen(i)}
          >
            {m.label}
          </button>
          {open === i && <MenuList items={m.items} onDone={() => setOpen(null)} />}
        </span>
      ))}
    </nav>
  )
}

// a menu at the mouse (right-click); stays inside the window
export function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ left: x, top: y, visibility: 'hidden' })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) })
  }, [x, y])
  useEffect(() => {
    const close = () => onClose()
    const key = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    // (a moment later, so the click that opened it does not close it)
    const t = setTimeout(() => {
      window.addEventListener('pointerdown', close)
      window.addEventListener('blur', close)
      window.addEventListener('wheel', close, { passive: true })
    }, 0)
    window.addEventListener('keydown', key, true)
    return () => {
      clearTimeout(t)
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('wheel', close)
      window.removeEventListener('keydown', key, true)
    }
  }, [onClose])
  return <MenuList items={items} onDone={onClose} listRef={ref} style={{ position: 'fixed', ...pos }} />
}
