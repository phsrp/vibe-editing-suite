// Discord Rich Presence ("Playing Vibe Editing Suite" with what you are doing), spoken straight to the Discord app
// running on this PC through its local pipe. Nothing is sent over the internet by us, and no extra package is needed.
// It only works while the Discord desktop app is open; if it is not, it quietly tries again now and then.
//
// The application ID (Discord Developer Portal > New application > General information > Application ID) goes here,
// or in settings.json as "discordClientId". The name of that application is what people see after "Playing".
// An uploaded art asset named "icon" (Rich Presence > Art assets) is shown as the picture.
const net = require('net')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const DISCORD_CLIENT_ID = '1558516104769441812'

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 }

function pipePath(n) {
  if (process.env.VIBE_DISCORD_PIPE) return process.env.VIBE_DISCORD_PIPE // developer self-test
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${n}`
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || os.tmpdir()
  return path.join(base, `discord-ipc-${n}`)
}

function encode(op, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  const head = Buffer.alloc(8)
  head.writeInt32LE(op, 0)
  head.writeInt32LE(body.length, 4)
  return Buffer.concat([head, body])
}

class Presence {
  constructor() {
    this.clientId = DISCORD_CLIENT_ID
    this.sock = null
    this.ready = false
    this.activity = null // what is wanted right now (null = nothing)
    this.enabled = false
    this.timer = null
    this.buf = Buffer.alloc(0)
    this.connecting = false
    this.startedAt = Date.now()
    this.log = () => {}
  }
  // enabled: show it at all; clientId: which Discord application
  configure({ enabled, clientId }) {
    const id = String(clientId || DISCORD_CLIENT_ID || '').trim()
    const changed = id !== this.clientId
    this.clientId = id
    this.enabled = !!enabled && /^\d{15,25}$/.test(id)
    if (!this.enabled) return this._close(true)
    if (changed) this._close(false)
    this._ensure()
  }
  set(activity) {
    this.activity = activity
    if (!this.enabled) return
    if (this.ready) this._send()
    else this._ensure()
  }
  stop() {
    this.enabled = false
    this._close(true)
  }

  _send() {
    if (!this.sock || !this.ready) return
    const a = this.activity
    const args = { pid: process.pid }
    if (a) {
      args.activity = {
        details: a.details,
        ...(a.state ? { state: a.state } : {}),
        timestamps: { start: Math.floor(this.startedAt / 1000) },
        assets: { large_image: 'icon', large_text: 'Vibe Editing Suite' },
        instance: false,
        buttons: [{ label: 'Get the editor', url: 'https://github.com/phsrp/Vibe-editing-suite' }],
      }
    }
    this.sock.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', args, nonce: crypto.randomUUID() }))
  }
  _ensure() {
    if (this.sock || this.connecting || !this.enabled || !this.clientId) return
    this._connect(0)
  }
  _connect(n) {
    if (n > 9) {
      this.connecting = false
      return this._retry()
    }
    this.connecting = true
    const s = net.createConnection(pipePath(n))
    let opened = false
    s.once('connect', () => {
      opened = true
      this.connecting = false
      this.sock = s
      this.buf = Buffer.alloc(0)
      s.write(encode(OP.HANDSHAKE, { v: 1, client_id: this.clientId }))
    })
    s.on('data', (d) => this._data(d))
    s.on('error', () => {
      if (!opened) {
        s.destroy()
        this._connect(n + 1) // the next pipe number
      }
    })
    s.on('close', () => {
      if (opened) {
        this.sock = null
        this.ready = false
        this._retry()
      }
    })
  }
  _data(d) {
    this.buf = Buffer.concat([this.buf, d])
    while (this.buf.length >= 8) {
      const op = this.buf.readInt32LE(0)
      const len = this.buf.readInt32LE(4)
      if (this.buf.length < 8 + len) break
      let msg = null
      try {
        msg = JSON.parse(this.buf.subarray(8, 8 + len).toString('utf8'))
      } catch {}
      this.buf = this.buf.subarray(8 + len)
      if (op === OP.PING && this.sock) this.sock.write(encode(OP.PONG, msg || {}))
      else if (op === OP.CLOSE) {
        if (this.sock) this.sock.destroy()
      } else if (op === OP.FRAME && msg && msg.evt === 'READY') {
        this.ready = true
        this._send()
      }
    }
  }
  _retry() {
    if (this.timer || !this.enabled) return
    this.timer = setTimeout(() => {
      this.timer = null
      this._ensure()
    }, 30000)
    if (this.timer.unref) this.timer.unref()
  }
  _close(clear) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.sock) {
      try {
        if (clear && this.ready) {
          this.activity && this.sock.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid }, nonce: crypto.randomUUID() }))
        }
        this.sock.destroy()
      } catch {}
    }
    this.sock = null
    this.ready = false
    this.connecting = false
  }
}

// what to say for each part of the app
function activityFor(p, showName) {
  if (!p) return null
  const text = { home: 'Browsing projects', video: 'Editing a video', image: 'Editing a picture', export: 'Exporting a video' }
  const details = text[p.kind] || 'Using the editor'
  const name = showName && p.name && p.name !== 'Untitled' ? String(p.name).slice(0, 100) : ''
  return { details, state: name || undefined }
}

module.exports = { Presence, activityFor, encode, OP }
