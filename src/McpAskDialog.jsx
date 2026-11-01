import { useEffect, useRef } from 'react'

// An AI app wants to do something that needs a yes first. "Do not allow" has the focus, so a stray Enter or Space says no.
export default function McpAskDialog({ detail, onAnswer }) {
  const no = useRef(null)
  useEffect(() => {
    no.current.focus()
    // the editor's shortcuts stay off while this is open
    const key = (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') onAnswer(false)
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [detail])
  return (
    <div className="modal-bg ask">
      <div className="modal ask-modal">
        <h3>An AI app wants to do this</h3>
        <p className="ask-text">{detail}</p>
        <div className="modal-foot">
          <button ref={no} onClick={() => onAnswer(false)}>Do not allow</button>
          <button className="primary" onClick={() => onAnswer(true)}>Allow</button>
        </div>
      </div>
    </div>
  )
}
