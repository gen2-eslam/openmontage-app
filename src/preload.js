const { contextBridge, ipcRenderer } = require('electron');

const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (fn) => {
  const h = (_, p) => fn(p);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('om', {
  chat: {
    history: inv('chat:history'), clear: inv('chat:clear'), send: inv('chat:send'),
    stop: inv('chat:stop'), running: inv('chat:running'), onEvent: on('chat:event'),
  },
  agents: { detect: inv('agents:detect'), save: inv('agents:save'), remove: inv('agents:remove'), checkUpdates: inv('agents:checkUpdates'), update: inv('agents:update') },
  repo: {
    status: inv('om:status'), deps: inv('om:deps'), setRoot: inv('om:setRoot'), setup: inv('om:setup'),
    update: inv('om:update'), env: inv('om:env'), saveEnv: inv('om:saveEnv'), pipelines: inv('om:pipelines'),
    skills: inv('om:skills'), readFile: inv('om:readFile'), backlot: inv('om:backlot'), onLog: on('om:log'),
    engineState: inv('om:engineState'), checkUpdate: inv('om:checkUpdate'), onEngine: on('om:engine'), onReady: on('om:ready'), onUpdated: on('om:updated'),
  },
  projects: {
    list: inv('projects:list'), state: inv('projects:state'), create: inv('projects:create'),
    saveLayout: inv('projects:saveLayout'), patch: inv('projects:patch'), readText: inv('projects:readText'),
    writeText: inv('projects:writeText'), import: inv('projects:import'), reveal: inv('projects:reveal'),
    onChanged: on('project:changed'),
  },
  settings: { get: inv('settings:get'), set: inv('settings:set') },
  addons: { state: inv('addons:state'), ensure: inv('addons:ensure'), ttsPreview: inv('addons:ttsPreview'), ttsVoices: inv('addons:ttsVoices') },
  stt: {
    status: inv('stt:status'), transcribe: inv('stt:transcribe'), enableLocal: inv('stt:enableLocal'),
    setKey: inv('stt:setKey'), permission: inv('stt:permission'), openMicSettings: inv('stt:openMicSettings'),
  },
  pickFolder: inv('dialog:folder'),
  openExternal: inv('shell:open'),
  which: inv('which'),
  term: {
    available: inv('term:available'), start: inv('term:start'), kill: inv('term:kill'),
    input: (id, data) => ipcRenderer.send('term:input', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
    onData: on('term:data'), onExit: on('term:exit'),
  },
  media: (projectId, rel) => `om://media/${encodeURIComponent(projectId)}/${String(rel).split('/').map(encodeURIComponent).join('/')}`,
});
