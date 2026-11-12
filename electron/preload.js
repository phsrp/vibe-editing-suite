const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('api', {
  importMedia: (kind) => ipcRenderer.invoke('media:import', kind),
  describeFiles: (files) => ipcRenderer.invoke('media:describe', files),
  saveProject: (file, json, defaultName) => ipcRenderer.invoke('project:save', { file, json, defaultName }),
  openProject: () => ipcRenderer.invoke('project:open'),
  autosave: (id, json) => ipcRenderer.invoke('project:autosave', { id, json }),
  listAutosaves: () => ipcRenderer.invoke('project:listAutosaves'),
  clearAutosave: (id) => ipcRenderer.invoke('project:clearAutosave', id),
  readProject: (file) => ipcRenderer.invoke('project:read', file),
  recentList: () => ipcRenderer.invoke('recent:list'),
  recentAdd: (entry) => ipcRenderer.invoke('recent:add', entry),
  recentRepair: () => ipcRenderer.invoke('recent:repair'),
  recentRemove: (file) => ipcRenderer.invoke('recent:remove', file),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  indexAtEnd: (file) => ipcRenderer.sendSync('media:indexAtEnd', file),
  mcpInfo: () => ipcRenderer.invoke('mcp:info'),
  mcpResult: (r) => ipcRenderer.send('mcp:result', r),
  mcpAnswer: (r) => ipcRenderer.send('mcp:answer', r),
  writeTransition: (o) => ipcRenderer.invoke('transitions:write', o),
  libraryAddPaths: (paths) => ipcRenderer.invoke('library:addPaths', paths),
  onMcpAsk: (cb) => {
    const h = (_e, d) => cb(d)
    ipcRenderer.on('mcp:ask', h)
    return () => ipcRenderer.removeListener('mcp:ask', h)
  },
  onMcpCall: (cb) => {
    const h = (_e, d) => cb(d)
    ipcRenderer.on('mcp:call', h)
    return () => ipcRenderer.removeListener('mcp:call', h)
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  snoozeUpdate: () => ipcRenderer.invoke('update:snooze'),
  debugUpdate: (s) => ipcRenderer.invoke('update:debug', s),
  setDirty: (v) => ipcRenderer.invoke('app:setDirty', v),
  askSave: (name) => ipcRenderer.invoke('ui:askSave', name),
  isTest: () => ipcRenderer.invoke('app:isTest'),
  exportChooseOutput: (name, ext) => ipcRenderer.invoke('export:chooseOutput', name, ext),
  exportEncoders: () => ipcRenderer.invoke('export:encoders'),
  exportBegin: () => ipcRenderer.invoke('export:begin'),
  exportExtractDir: (name) => ipcRenderer.invoke('export:extractDir', name),
  exportExtract: (o) => ipcRenderer.invoke('export:extract', o),
  exportSegBegin: (o) => ipcRenderer.invoke('export:segBegin', o),
  exportFrame: (buf) => ipcRenderer.invoke('export:frame', buf),
  exportSegEnd: () => ipcRenderer.invoke('export:segEnd'),
  exportFinal: (plan) => ipcRenderer.invoke('export:final', plan),
  exportCancel: () => ipcRenderer.invoke('export:cancel'),
  exportCleanup: () => ipcRenderer.invoke('export:cleanup'),
  exportReveal: (file) => ipcRenderer.invoke('export:reveal', file),
  onExportProgress: (cb) => {
    const h = (_e, p) => cb(p)
    ipcRenderer.on('export:progress', h)
    return () => ipcRenderer.removeListener('export:progress', h)
  },
  appVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb) => {
    const h = (_e, s) => cb(s)
    ipcRenderer.on('update:status', h)
    return () => ipcRenderer.removeListener('update:status', h)
  },
  audioPeaks: (file) => ipcRenderer.invoke('media:peaks', file),
  openProjectsFolder: () => ipcRenderer.invoke('projects:folder'),
  reverseProxy: (o) => ipcRenderer.invoke('media:reverse', o),
  measureLoudness: (o) => ipcRenderer.invoke('audio:loudness', o),
  modelsStatus: () => ipcRenderer.invoke('models:status'),
  modelsDownload: (set) => ipcRenderer.invoke('models:download', set),
  onModelsProgress: (cb) => {
    const h = (_e, p) => cb(p)
    ipcRenderer.on('models:progress', h)
    return () => ipcRenderer.removeListener('models:progress', h)
  },
  historyAdd: (o) => ipcRenderer.invoke('history:add', o),
  historyList: (key) => ipcRenderer.invoke('history:list', key),
  historyRead: (o) => ipcRenderer.invoke('history:read', o),
  saveVoiceOver: (data) => ipcRenderer.invoke('voice:save', { data }),
  openVoiceFolder: () => ipcRenderer.invoke('voice:folder'),
  libraryFolder: () => ipcRenderer.invoke('library:folder'),
  libraryList: () => ipcRenderer.invoke('library:list'),
  libraryAdd: () => ipcRenderer.invoke('library:add'),
  saveImage: (o) => ipcRenderer.invoke('image:save', o),
  saveThumb: (o) => ipcRenderer.invoke('thumb:save', o),
  savePastedPicture: (o) => ipcRenderer.invoke('picture:savePasted', o),
  cleanAudio: (o) => ipcRenderer.invoke('audio:clean', o),
  brushesList: () => ipcRenderer.invoke('brushes:list'),
  brushesImport: (paths) => ipcRenderer.invoke('brushes:import', paths),
  brushesRead: (name) => ipcRenderer.invoke('brushes:read', name),
  brushesDelete: (name) => ipcRenderer.invoke('brushes:delete', name),
  brushesReadPath: (p) => ipcRenderer.invoke('brushes:readPath', p),
  setPresence: (p) => ipcRenderer.invoke('presence:set', p),
  storageInfo: () => ipcRenderer.invoke('storage:info'),
  storageClear: (what) => ipcRenderer.invoke('storage:clear', what),
  whisperStatus: () => ipcRenderer.invoke('whisper:status'),
  whisperDownload: () => ipcRenderer.invoke('whisper:download'),
  onWhisperProgress: (cb) => {
    const h = (_e, d) => cb(d)
    ipcRenderer.on('whisper:progress', h)
    return () => ipcRenderer.removeListener('whisper:progress', h)
  },
  pcm16k: (o) => ipcRenderer.invoke('audio:pcm16k', o),
  saveSubtitles: (o) => ipcRenderer.invoke('subtitles:save', o),
  proxyInfo: () => ipcRenderer.invoke('proxy:info'),
  proxyStatus: (ids) => ipcRenderer.invoke('proxy:status', ids),
  proxyClear: () => ipcRenderer.invoke('proxy:clear'),
  // smooth-preview copies being made in the background: {id, pct} while working, {id, pct:100, path} when done
  onProxy: (cb) => {
    const h = (_e, d) => cb(d)
    ipcRenderer.on('proxy:event', h)
    return () => ipcRenderer.removeListener('proxy:event', h)
  },
  libraryDelete: (file) => ipcRenderer.invoke('library:delete', file),
  extractAudio: (file, id, streams) => ipcRenderer.invoke('media:extractAudio', { file, id, streams }),
  freezeFrame: (file, time, label) => ipcRenderer.invoke('media:freeze', { file, time, label }),
  listTransitions: () => ipcRenderer.invoke('transitions:list'),
  openTransitionsFolder: () => ipcRenderer.invoke('transitions:openFolder'),
  pathForFile: (file) => webUtils.getPathForFile(file),
})
