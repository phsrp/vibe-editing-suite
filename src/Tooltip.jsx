import { useEffect, useLayoutEffect, useRef, useState } from 'react'

// Tooltips in the look of the app, for everything that has a title="...": while the pointer rests on it the title is taken off
// (so Windows does not show its own one too) and put back when the pointer leaves.
export default function Tooltip() {
  const [tip, setTip] = useState(null) // {text, rect}
  const box = useRef(null)
  useEffect(() => {
    let el = null
    let timer = 0
    const clear = () => {
      clearTimeout(timer)
      if (el) {
        if (!el.getAttribute('title') && el.dataset.tip) el.setAttribute('title', el.dataset.tip)
        delete el.dataset.tip
        el = null
      }
      setTip(null)
    }
    const over = (e) => {
      if (el && el.contains(e.target)) return
      clear()
      const t = e.target.closest && e.target.closest('[title]')
      const text = t && t.getAttribute('title')
      if (!text) return
      el = t
      el.dataset.tip = text
      el.removeAttribute('title')
      timer = setTimeout(() => el && setTip({ text, rect: el.getBoundingClientRect() }), 420)
    }
    const press = () => {
      clearTimeout(timer)
      setTip(null)
    }
    document.addEventListener('mouseover', over)
    document.addEventListener('pointerdown', press, true)
    window.addEventListener('blur', clear)
    return () => {
      document.removeEventListener('mouseover', over)
      document.removeEventListener('pointerdown', press, true)
      window.removeEventListener('blur', clear)
      clear()
    }
  }, [])
  // under the item, or above it near the bottom of the window, and never past the sides
  useLayoutEffect(() => {
    const b = box.current
    if (!tip || !b) return
    const w = b.offsetWidth
    const h = b.offsetHeight
    const below = tip.rect.bottom + 8 + h < window.innerHeight
    b.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, tip.rect.left + tip.rect.width / 2 - w / 2)) + 'px'
    b.style.top = (below ? tip.rect.bottom + 8 : tip.rect.top - h - 8) + 'px'
  }, [tip])
  return tip ? <div className="vtip" ref={box}>{tip.text}</div> : null
}
