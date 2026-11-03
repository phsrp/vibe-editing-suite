// Titles and text. A text clip lives on a video track like any overlay clip; its picture is drawn here onto a
// transparent canvas the size of the video frame, so it moves, scales, fades, warps and animates like a clip.

export const TEXT_FONTS = ['Montserrat', 'Arial', 'Verdana', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Impact', 'Courier New', 'Comic Sans MS', 'Segoe UI']

export const TEXT_ANIMS = [
  { id: 'none', label: 'None' },
  { id: 'fade', label: 'Fade' },
  { id: 'pop', label: 'Pop' },
  { id: 'slide', label: 'Slide up' },
  { id: 'type', label: 'Typewriter' },
]

export const TEXT_DEFAULTS = {
  content: 'Your text',
  font: 'Montserrat',
  size: 9, // % of the frame height
  color: '#ffffff',
  bold: true,
  italic: false,
  align: 'center',
  outline: { on: false, color: '#000000', width: 6 },
  shadow: { on: true, color: '#000000', blur: 10 },
  bg: { on: false, color: '#000000', opacity: 60 },
  animIn: 'none',
  animOut: 'none',
  animDur: 0.4,
}

// ready-made looks: they set the text style and where the text sits (y in % of the frame, like the Position Y slider)
export const TEXT_PRESETS = [
  { name: 'Title', text: { size: 12, bold: true, shadow: { on: true, color: '#000000', blur: 14 }, animIn: 'pop', animOut: 'fade' }, y: 0 },
  { name: 'Subtitle', text: { size: 5.5, bold: true, color: '#ffffff', outline: { on: true, color: '#000000', width: 7 }, shadow: { on: false, color: '#000000', blur: 0 }, animIn: 'none', animOut: 'none' }, y: 36 },
  { name: 'Lower third', text: { size: 6, bold: true, align: 'left', bg: { on: true, color: '#191724', opacity: 80 }, shadow: { on: false, color: '#000000', blur: 0 }, animIn: 'slide', animOut: 'fade' }, y: 30 },
  { name: 'Neon', text: { size: 10, bold: true, color: '#9ccfd8', outline: { on: true, color: '#31748f', width: 5 }, shadow: { on: true, color: '#9ccfd8', blur: 28 }, animIn: 'fade', animOut: 'fade' }, y: 0 },
  { name: 'Typed', text: { size: 7, bold: false, font: 'Courier New', color: '#f6c177', shadow: { on: false, color: '#000000', blur: 0 }, animIn: 'type', animOut: 'none' }, y: 0 },
]

// Montserrat comes with the editor, where the browser knows it as "Montserrat Variable" (Windows does not have it)
const family = (font) => (font === 'Montserrat' ? '"Montserrat Variable", "Montserrat"' : `"${font}"`)

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const easeOutBack = (u) => 1 + 2.70158 * Math.pow(u - 1, 3) + 1.70158 * Math.pow(u - 1, 2)

// break the text into lines that fit the width (it also keeps the lines you typed)
function wrapLines(ctx, content, maxW) {
  const out = []
  for (const para of String(content).split('\n')) {
    const words = para.split(' ')
    let line = ''
    for (const w of words) {
      const test = line ? line + ' ' + w : w
      if (line && ctx.measureText(test).width > maxW) {
        out.push(line)
        line = w
      } else line = test
    }
    out.push(line)
  }
  return out
}

// Draw the text of a clip onto cv (which is cleared first). t = seconds since the clip started, dur = its length.
export function drawText(cv, text, t, dur) {
  const W = cv.width
  const H = cv.height
  const ctx = cv.getContext('2d')
  ctx.clearRect(0, 0, W, H)
  const tx = { ...TEXT_DEFAULTS, ...text }
  const px = (tx.size / 100) * H
  ctx.font = `${tx.italic ? 'italic ' : ''}${tx.bold ? '700' : '400'} ${px}px ${family(tx.font)}, sans-serif`
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'

  // animation in / out
  const ad = Math.max(0.05, tx.animDur)
  const ai = clamp01(t / ad)
  const ao = clamp01((dur - t) / ad)
  let alpha = 1
  let scale = 1
  let dy = 0
  let chars = Infinity
  if (tx.animIn === 'fade') alpha *= ai
  else if (tx.animIn === 'pop') {
    alpha *= clamp01(ai * 2)
    scale *= ai >= 1 ? 1 : Math.max(0.01, easeOutBack(ai))
  } else if (tx.animIn === 'slide') {
    alpha *= ai
    dy += (1 - ai) * 0.07 * H
  } else if (tx.animIn === 'type') chars = Math.floor(ai * String(tx.content).length)
  if (tx.animOut === 'fade') alpha *= ao
  else if (tx.animOut === 'pop') {
    alpha *= clamp01(ao * 2)
    scale *= Math.max(0.01, ao)
  } else if (tx.animOut === 'slide') {
    alpha *= ao
    dy -= (1 - ao) * 0.07 * H
  }
  if (alpha <= 0.001) return

  let shown = String(tx.content)
  if (chars < shown.length) shown = shown.slice(0, chars)
  const lines = wrapLines(ctx, shown, W * 0.88)
  const lh = px * 1.2
  const blockH = lh * lines.length
  const widths = lines.map((l) => ctx.measureText(l).width)
  const blockW = Math.max(1, ...widths)
  const cx = W / 2
  const cy = H / 2 + dy

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(cx, cy)
  ctx.scale(scale, scale)
  const x0 = tx.align === 'left' ? -blockW / 2 : tx.align === 'right' ? blockW / 2 : 0
  ctx.textAlign = tx.align === 'left' ? 'left' : tx.align === 'right' ? 'right' : 'center'

  if (tx.bg && tx.bg.on) {
    const pad = px * 0.35
    ctx.save()
    ctx.globalAlpha = alpha * (tx.bg.opacity / 100)
    ctx.fillStyle = tx.bg.color
    const bx = -blockW / 2 - pad
    const by = -blockH / 2 - pad * 0.6
    const bw = blockW + pad * 2
    const bh = blockH + pad * 1.2
    const r = pad * 0.5
    ctx.beginPath()
    ctx.moveTo(bx + r, by)
    ctx.arcTo(bx + bw, by, bx + bw, by + bh, r)
    ctx.arcTo(bx + bw, by + bh, bx, by + bh, r)
    ctx.arcTo(bx, by + bh, bx, by, r)
    ctx.arcTo(bx, by, bx + bw, by, r)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  lines.forEach((l, i) => {
    const y = -blockH / 2 + lh * i + lh / 2
    if (tx.shadow && tx.shadow.on) {
      ctx.shadowColor = tx.shadow.color
      ctx.shadowBlur = (tx.shadow.blur / 100) * px * 2
      ctx.shadowOffsetY = px * 0.04
    }
    if (tx.outline && tx.outline.on) {
      ctx.strokeStyle = tx.outline.color
      ctx.lineWidth = (tx.outline.width / 100) * px
      ctx.strokeText(l, x0, y)
    }
    ctx.fillStyle = tx.color
    ctx.fillText(l, x0, y)
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
  })
  ctx.restore()
}

// make sure the font is ready before the first draw
export function loadFont(text) {
  const tx = { ...TEXT_DEFAULTS, ...text }
  try {
    return document.fonts.load(`${tx.bold ? '700' : '400'} 40px ${family(tx.font)}`)
  } catch {
    return Promise.resolve()
  }
}