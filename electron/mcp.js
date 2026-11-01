// The AI connection: an MCP server inside the editor, so an AI app on this PC can use it (Settings > AI connection).
//
//  AI app -> mcp-bridge.cjs (started by the AI app, talks over stdin / stdout) -> this server -> the page, which does the work
//
// Off by default. The server only listens on 127.0.0.1, wants the key in mcp.json on every request, and turns away anything a
// web page could send (a browser always sends Origin). The list of what can be done is in mcpTools.js.
const { app, ipcMain } = require('electron')
const http = require('http')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { Server } = require('@modelcontextprotocol/sdk/server/index.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js')
const { TOOLS } = require('./mcpTools.js')

const FIRST_PORT = 48123
const NAME = 'vibe-editing-suite'
let server = null
let port = 0
let token = ''
let lastError = ''
let getWindow = () => null
const activity = [] // the last things the AI did, shown in the settings
const waiting = new Map() // call id -> {resolve, reject}
const asking = new Map() // question id -> resolve(true or false), while the person is being asked
let nextCall = 1

const statePath = () => path.join(app.getPath('userData'), 'mcp.json')
const bridgePath = () => path.join(app.getPath('userData'), 'mcp-bridge.cjs')

// The small program the AI app starts. It passes messages along, and says what is wrong when the editor cannot be reached.
const BRIDGE = `// Made by Vibe Editing Suite. It passes messages between an AI app and the editor.
const http = require('http')
const fs = require('fs')
const path = require('path')
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const failed = (msg, text) => msg.id != null && say({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: text } })
const CLOSED = 'Vibe Editing Suite is not reachable. Open it and turn on Settings > AI connection, then try again.'
function send(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'mcp.json'), 'utf8'))
  } catch {
    return failed(msg, CLOSED)
  }
  const req = http.request({ host: '127.0.0.1', port: cfg.port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + cfg.token, 'Content-Length': Buffer.byteLength(line) } }, (res) => {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', (d) => (body += d))
    res.on('end', () => {
      if (!body.trim()) return
      try {
        say(JSON.parse(body))
      } catch {
        failed(msg, 'The editor gave an answer that could not be read.')
      }
    })
  })
  req.on('error', () => failed(msg, CLOSED))
  req.end(line)
}
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  for (let i = buf.indexOf('\\n'); i >= 0; i = buf.indexOf('\\n')) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (line) send(line)
  }
})
process.stdin.on('end', () => setTimeout(() => process.exit(0), 500))
`

const note = (tool, outcome) => {
  activity.unshift({ tool, outcome, at: Date.now() })
  activity.length = Math.min(activity.length, 12)
}

// the page does the work
function askPage(name, args) {
  const win = getWindow()
  if (!win || win.isDestroyed()) return Promise.reject(new Error('The editor window is closed.'))
  const id = nextCall++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id)
      reject(new Error('The editor did not answer in time.'))
    }, 60000)
    waiting.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    })
    win.webContents.send('mcp:call', { id, name, args })
  })
}

// the person says yes or no, in the editor, whatever the AI app shows
async function allowed(tool, args) {
  if (process.env.VIBE_SELFTEST && process.env.VIBE_MCP_AUTO) return process.env.VIBE_MCP_AUTO === 'allow'
  let names = ''
  if (tool.name === 'delete_clips') names = await askPage('describe_clips', args).then((r) => r.text).catch(() => '')
  const win = getWindow()
  if (!win || win.isDestroyed()) return false
  if (win.isMinimized()) win.restore()
  win.show()
  win.moveTop()
  win.focus()
  if (!win.isFocused()) {
    win.flashFrame(true)
    win.once('focus', () => win.flashFrame(false))
  }
  const id = nextCall++
  return new Promise((resolve) => {
    asking.set(id, resolve)
    win.webContents.send('mcp:ask', { id, detail: tool.says(args, names) })
  })
}

async function callTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name)
  const text = (t, isError) => ({ content: [{ type: 'text', text: t }], isError: !!isError })
  if (!tool) return text(`There is no tool called ${name}.`, true)
  if (tool.ask && !(await allowed(tool, args))) {
    note(name, 'refused by you')
    return text('The person using the editor did not allow this.', true)
  }
  try {
    const r = await askPage(name, args)
    note(name, 'done')
    if (r.image) return { content: [{ type: 'image', data: r.image, mimeType: r.mime || 'image/jpeg' }, { type: 'text', text: r.text || '' }] }
    return text(r.text || 'Done.')
  } catch (e) {
    note(name, 'failed')
    return text(String((e && e.message) || e), true)
  }
}

// a fresh MCP server for every request: nothing is kept between them
async function answer(req, res) {
  const s = new Server({ name: NAME, version: app.getVersion() }, { capabilities: { tools: {} } })
  s.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }))
  s.setRequestHandler(CallToolRequestSchema, (r) => callTool(r.params.name, r.params.arguments || {}))
  const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    t.close().catch(() => {})
    s.close().catch(() => {})
  })
  await s.connect(t)
  await t.handleRequest(req, res)
}

const refuse = (res, code) => {
  res.writeHead(code)
  res.end()
}
function onRequest(req, res) {
  const key = Buffer.from(String(req.headers.authorization || ''))
  const want = Buffer.from('Bearer ' + token)
  if (req.headers.origin) return refuse(res, 403) // a web page
  if (!new RegExp(`^(127\\.0\\.0\\.1|localhost):${port}$`).test(req.headers.host || '')) return refuse(res, 403)
  if (key.length !== want.length || !crypto.timingSafeEqual(key, want)) return refuse(res, 401)
  if (req.url !== '/mcp') return refuse(res, 404)
  if (req.method !== 'POST') return refuse(res, 405)
  answer(req, res).catch(() => !res.headersSent && refuse(res, 500))
}

function listen(p, tries = 20) {
  return new Promise((resolve, reject) => {
    const s = http.createServer(onRequest)
    s.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && tries > 1) resolve(listen(p + 1, tries - 1))
      else reject(e)
    })
    s.listen(p, '127.0.0.1', () => resolve(s))
  })
}

async function start() {
  if (server) return
  lastError = ''
  try {
    token = crypto.randomBytes(24).toString('hex')
    const s = await listen(FIRST_PORT)
    server = s
    port = s.address().port
    fs.writeFileSync(bridgePath(), BRIDGE, 'utf8')
    fs.writeFileSync(statePath(), JSON.stringify({ port, token }), { encoding: 'utf8', mode: 0o600 })
  } catch (e) {
    lastError = String((e && e.message) || e)
  }
}
function stop() {
  if (server) server.close()
  server = null
  port = 0
  try {
    fs.rmSync(statePath(), { force: true })
  } catch {}
  for (const w of waiting.values()) w.reject(new Error('The AI connection was turned off.'))
  waiting.clear()
  for (const say of asking.values()) say(false)
  asking.clear()
}

// on or off, as the settings say
const sync = (on) => (on ? start() : Promise.resolve(stop()))

function info() {
  fs.writeFileSync(bridgePath(), BRIDGE, 'utf8')
  const entry = { command: process.execPath, args: [bridgePath()], env: { ELECTRON_RUN_AS_NODE: '1' } }
  return {
    running: !!server,
    port,
    error: lastError,
    activity,
    desktopConfig: JSON.stringify({ mcpServers: { [NAME]: entry } }, null, 2),
    codeCommand: `claude mcp add --transport stdio --scope user ${NAME} --env ELECTRON_RUN_AS_NODE=1 -- "${process.execPath}" "${bridgePath()}"`, // --env takes every word after it, so the name goes first
  }
}

function register({ getWindow: gw }) {
  getWindow = gw
  ipcMain.on('mcp:result', (_e, { id, result, error }) => {
    const w = waiting.get(id)
    if (!w) return
    waiting.delete(id)
    if (error) w.reject(new Error(error))
    else w.resolve(result || {})
  })
  ipcMain.on('mcp:answer', (_e, { id, allow }) => {
    const say = asking.get(id)
    if (!say) return
    asking.delete(id)
    say(allow === true)
  })
  ipcMain.handle('mcp:info', () => info())
  app.on('before-quit', stop)
}

module.exports = { register, sync }
