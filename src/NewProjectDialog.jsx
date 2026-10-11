import { useState } from 'react'
import Icon from './Icon.jsx'

const SIZES = [
  { label: 'Full HD (1920 × 1080)', w: 1920, h: 1080 },
  { label: 'Square (1080 × 1080)', w: 1080, h: 1080 },
  { label: 'Phone (1080 × 1920)', w: 1080, h: 1920 },
  { label: 'Portrait (1080 × 1350)', w: 1080, h: 1350 },
  { label: '4K (3840 × 2160)', w: 3840, h: 2160 },
  { label: 'A4 page (2480 × 3508)', w: 2480, h: 3508 },
]

// "New project": a video project or an image project. An image project also asks for the size of the canvas.
export default function NewProjectDialog({ onCreate, onClose }) {
  const [step, setStep] = useState('kind')
  const [size, setSize] = useState(0)
  const [w, setW] = useState(1920)
  const [h, setH] = useState(1080)
  const [bg, setBg] = useState('white')
  const [what, setWhat] = useState('image') // which project the size question is for: 'image' | 'drawing'
  const pick = (i) => {
    setSize(i)
    if (SIZES[i]) {
      setW(SIZES[i].w)
      setH(SIZES[i].h)
    }
  }
  const create = () => {
    const color = bg === 'white' ? '#ffffff' : bg === 'black' ? '#000000' : 'transparent'
    onCreate(what, { w: Math.min(16384, Math.max(16, Math.round(w) || 1920)), h: Math.min(16384, Math.max(16, Math.round(h) || 1080)), bg: color })
  }
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal newproj">
        {step === 'kind' ? (
          <>
            <h3>New project</h3>
            <div className="kind-cards">
              <button className="kind-card" onClick={() => onCreate('video')}>
                <Icon name="film" size={34} />
                <b>Video project</b>
                <span>A timeline with clips, transitions, audio, text and export to video.</span>
              </button>
              <button className="kind-card" onClick={() => (setWhat('image'), setStep('image'))}>
                <Icon name="image" size={34} />
                <b>Image project</b>
                <span>Layers, painting, text, masks and effects, exported as a picture.</span>
              </button>
              <button className="kind-card" onClick={() => onCreate('picture')}>
                <Icon name="image" size={34} />
                <b>Edit a picture</b>
                <span>Open a picture from your computer to paint on, add layers to, and save again.</span>
              </button>
              <button className="kind-card" onClick={() => (setWhat('drawing'), setStep('image'))}>
                <Icon name="pen" size={34} />
                <b>Drawing</b>
                <span>Draw and paint with pen pressure, brushes (Krita packs too), shapes and layers.</span>
              </button>
            </div>
            <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button onClick={onClose}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <h3>{what === 'drawing' ? 'New drawing' : 'New image project'}</h3>
            <div className="mtop">
              <span className="mlabel">Size</span>
              <select value={size} onChange={(e) => pick(+e.target.value)}>
                {SIZES.map((z, i) => (
                  <option key={z.label} value={i}>{z.label}</option>
                ))}
                <option value={-1}>Custom…</option>
              </select>
            </div>
            <div className="mtop">
              <span className="mlabel">Width</span>
              <input type="number" min="16" max="16384" value={w} onChange={(e) => { setW(+e.target.value); setSize(-1) }} />
              <span className="mlabel">Height</span>
              <input type="number" min="16" max="16384" value={h} onChange={(e) => { setH(+e.target.value); setSize(-1) }} />
            </div>
            <div className="mtop">
              <span className="mlabel">Background</span>
              <select value={bg} onChange={(e) => setBg(e.target.value)}>
                <option value="white">White</option>
                <option value="black">Black</option>
                <option value="transparent">Transparent</option>
              </select>
            </div>
            <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
              <button onClick={() => setStep('kind')}>Back</button>
              <button className="primary" onClick={create}>Create</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
