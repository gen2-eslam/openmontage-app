// OpenMontage Studio — Electron main process.
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, Menu, session, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { fixPath, Store, spawnCmd, which } = require('./main/util');
const { AgentManager } = require('./main/agents');
const { OpenMontage } = require('./main/openmontage');
const { Projects } = require('./main/projects');
const { Runtime } = require('./main/runtime');
const { STT } = require('./main/stt');
const { Addons } = require('./main/addons');

fixPath();

protocol.registerSchemesAsPrivileged([
  { scheme: 'om', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const userData = app.getPath('userData');
const settings = new Store(path.join(userData, 'settings.json'), {
  autoApprove: true, defaultAgent: 'claude', language: 'en', autoUpdate: true,
});
const layoutStore = new Store(path.join(userData, 'layouts.json'));
const om = new OpenMontage(settings, path.join(app.getPath('home'), 'OpenMontage'));
const agents = new AgentManager(settings);
const projects = new Projects(om, layoutStore);
const runtime = new Runtime();
runtime.applyEnv(om.root);
const stt = new STT({ om, runtime, settings, userData });
const addons = new Addons({ om, runtime, projects, userData });

// ---------------- engine log (UI + file + stdout in debug) ----------------
const logDir = path.join(userData, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const engineLog = (t) => {
  try { fs.appendFileSync(path.join(logDir, 'engine.log'), t); } catch {}
  if (process.env.OM_DEBUG) process.stdout.write('[engine] ' + t);
  send('om:log', t);
};
let engineState = { busy: null, error: null, update: null };
const setEngine = (patch) => { engineState = { ...engineState, ...patch }; send('om:engine', engineState); };

async function provisionIfNeeded() {
  if (!runtime.needsProvision(om.root)) return false;
  setEngine({ busy: 'provision', error: null });
  try {
    await runtime.provision(om.root, engineLog);
    await addons.ensure(engineLog);
    projects.pyOk = null;
    projects.watch(id => send('project:changed', id));
    setEngine({ busy: null });
    send('om:ready', await om.status());
  } catch (e) {
    engineLog('\n✗ ' + e.message + '\n');
    setEngine({ busy: null, error: e.message });
  }
  return true;
}

async function checkEngineUpdate({ auto } = {}) {
  if (!om.isRepo()) return null;
  let info;
  try {
    info = runtime.engineMeta(om.root) ? await runtime.checkUpdate(om.root) : await om.checkUpdate();
  } catch (e) { info = { available: false, error: e.message }; }
  setEngine({ update: info });
  if (auto && info && info.available && settings.get('autoUpdate', true) && !activeRuns.size && !info.localChanges) {
    await updateEngine();
  }
  return engineState.update;
}

async function updateEngine() {
  setEngine({ busy: 'update', error: null });
  try {
    if (runtime.engineMeta(om.root)) await runtime.update(om.root, engineLog);
    else await om.update(engineLog);
    await addons.ensure(engineLog);
    projects.pyOk = null;
    setEngine({ busy: null, update: { available: false, updatedAt: Date.now() } });
    send('om:updated', true);
  } catch (e) {
    engineLog('\n✗ Update failed: ' + e.message + '\n');
    setEngine({ busy: null, error: e.message });
  }
}

let win;
const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 680,
    backgroundColor: '#101010',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'resources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) { e.preventDefault(); shell.openExternal(url); } });
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
  if (process.env.OM_DEBUG) {
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) console.log(`[renderer:${level === 3 ? 'error' : 'warn'}] ${message} (${source}:${line})`);
    });
    win.webContents.on('render-process-gone', (_e, d) => console.log('[renderer gone]', JSON.stringify(d)));
    win.webContents.on('did-fail-load', (_e, code, desc, url) => console.log('[did-fail-load]', code, desc, url));
  }
}

// --- om://media/<projectId>/<relative path> → file with HTTP Range support (video seeking)
function registerMediaProtocol() {
  protocol.handle('om', async (req) => {
    try {
      const u = new URL(req.url);
      const parts = decodeURIComponent(u.pathname).replace(/^\/+/, '').split('/');
      const projectId = parts.shift();
      const base = path.resolve(projects.dir, projectId);
      const file = path.resolve(base, parts.join('/'));
      if (!file.startsWith(base + path.sep) || !fs.existsSync(file)) return new Response('not found', { status: 404 });
      const size = fs.statSync(file).size;
      const type = mime(file);
      const range = req.headers.get('range');
      if (range) {
        const m = range.match(/bytes=(\d*)-(\d*)/);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
        if (!m || !m[1]) { start = Math.max(0, size - (parseInt(m && m[2], 10) || size)); end = size - 1; }
        end = Math.min(end, size - 1);
        return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
          status: 206,
          headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' },
        });
      }
      return new Response(Readable.toWeb(fs.createReadStream(file)), {
        status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' },
      });
    } catch (e) {
      return new Response(String(e), { status: 500 });
    }
  });
}

function mime(f) {
  const ext = path.extname(f).toLowerCase();
  return ({
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
    '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain', '.html': 'text/html',
  })[ext] || 'application/octet-stream';
}

// ---------------- Chat sessions (one per project, any agent) ----------------
const sessionsDir = path.join(userData, 'sessions');
const sessionFile = (pid) => path.join(sessionsDir, (pid || '_home').replace(/[^\w.-]/g, '_') + '.json');
function loadSession(pid) {
  try { return JSON.parse(fs.readFileSync(sessionFile(pid), 'utf8')); } catch { return { agentIds: {}, messages: [] }; }
}
function saveSession(pid, s) {
  fs.mkdirSync(sessionsDir, { recursive: true });
  s.messages = s.messages.slice(-300);
  fs.writeFileSync(sessionFile(pid), JSON.stringify(s, null, 2));
}

function buildPrompt({ projectId, pipeline, message, focus, firstTurn, title, notes }) {
  const lines = [];
  if (firstTurn) {
    lines.push(
      '[OpenMontage Studio] You are the production agent for this OpenMontage repository.',
      'Follow AGENT_GUIDE.md, PROJECT_CONTEXT.md and the pipeline director skills exactly.',
    );
    if (projectId) {
      lines.push(`Active project id: "${projectId}" (projects/${projectId}/project.json already exists${title ? `, title "${title}"` : ''}).`,
        'Use exactly this project id for every checkpoint, artifact, asset and render.');
    }
    lines.push(pipeline ? `Pipeline: ${pipeline}.` : 'Pick the most suitable pipeline from pipeline_defs/ and record it in project.json.');
    lines.push(
      'The user watches your checkpoints, artifacts, assets and renders live in a desktop canvas; you do NOT need to run `python -m backlot open`.',
      'At every human approval gate: write the checkpoint with status "awaiting_human", summarize the decision clearly, then END your turn. The user replies in the next turn.',
      'Run non-interactively: never wait for keyboard input.',
      'Free voiceover is available with no API key: the `edge_tts` tool (registry / tts_selector) and the MCP server `openmontage-studio` (tts_synthesize). It covers Arabic dialects (Egyptian ar-EG, Saudi, Gulf, Levantine, Maghrebi) and 70+ languages, with word timings for captions — see the edge-tts skill.',
      '',
    );
  } else if (projectId) {
    lines.push(`[OpenMontage Studio] Active project: "${projectId}" (projects/${projectId}/).`);
  }
  if (projectId) {
    lines.push(`Checkpoints: call write_checkpoint/read_checkpoint/get_next_stage with pipeline_dir = lib.checkpoint.PROJECTS_DIR (the projects/ ROOT, never projects/${projectId}) and project_id "${projectId}", so files land at projects/${projectId}/checkpoint_<stage>.json.`);
  }
  if (notes && notes.length) { lines.push('', 'Studio notes:'); for (const n of notes) lines.push('- ' + n); }
  lines.push('');
  if (focus && focus.length) {
    lines.push('The user is pointing at these items on the canvas:');
    for (const f of focus) lines.push(`- ${f}`);
    lines.push('Apply the request to these items only, unless the user says otherwise.', '');
  }
  lines.push(firstTurn ? 'User request:' : 'User:', message);
  return lines.join('\n');
}

const activeRuns = new Map(); // projectKey -> runId

ipcMain.handle('chat:history', (_, pid) => loadSession(pid));
ipcMain.handle('chat:clear', (_, pid) => { saveSession(pid, { agentIds: {}, messages: [] }); return true; });

ipcMain.handle('chat:send', async (_, { projectId, agentId, message, focus, focusLabels, pipeline, title }) => {
  const key = projectId || '_home';
  if (activeRuns.has(key)) throw new Error('The agent is still working on this project. Stop it first or wait.');
  const sess = loadSession(projectId);
  const sessionId = sess.agentIds[agentId];
  const notes = projectId ? projects.takeNotes(projectId) : [];
  const prompt = buildPrompt({ projectId, pipeline, message, focus, title, notes, firstTurn: !sessionId });
  const userMsg = { role: 'user', text: message, focus: focusLabels || [], ts: Date.now() };
  const reply = { role: 'assistant', agent: agentId, parts: [], ts: Date.now(), done: false };
  sess.messages.push(userMsg, reply);
  saveSession(projectId, sess);

  const emit = (ev) => {
    if (ev.type === 'session' && ev.id) sess.agentIds[agentId] = ev.id;
    if (ev.type === 'text' && ev.delta) {
      const last = reply.parts.at(-1);
      if (last && last.type === 'text') last.text += ev.text; else reply.parts.push({ type: 'text', text: ev.text });
    } else if (ev.type !== 'session' && ev.type !== 'exit') {
      if (ev.type === 'stderr') {
        const last = reply.parts.at(-1);
        if (last && last.type === 'stderr') last.text = (last.text + ev.text).slice(-4000); else reply.parts.push({ type: 'stderr', text: ev.text });
      } else reply.parts.push(ev);
    }
    if (ev.type === 'exit') {
      reply.done = true; reply.code = ev.code;
      activeRuns.delete(key);
      saveSession(projectId, sess);
    }
    send('chat:event', { projectId, agentId, ...ev });
  };

  const runId = agents.start({
    agentId, prompt, cwd: om.isRepo() ? om.root : (projectId ? path.join(projects.dir, projectId) : app.getPath('home')),
    session: sessionId, autoApprove: settings.get('autoApprove', true), extraArgs: (a) => addons.agentArgs(a),
    env: { OPENMONTAGE_PROJECTS_DIR: projects.dir },
  }, emit);
  activeRuns.set(key, runId);
  return { runId };
});

ipcMain.handle('chat:stop', (_, projectId) => {
  const id = activeRuns.get(projectId || '_home');
  return id ? agents.stop(id) : false;
});
ipcMain.handle('chat:running', () => [...activeRuns.keys()]);

// ---------------- Agents ----------------
ipcMain.handle('agents:detect', () => agents.detect());
ipcMain.handle('agents:save', (_, a) => agents.saveCustom(a));
ipcMain.handle('agents:remove', (_, id) => agents.removeCustom(id));
ipcMain.handle('agents:checkUpdates', () => agents.checkUpdates(runtime.systemPath));
ipcMain.handle('agents:update', (_, id) => agents.update(id, runtime.systemPath, engineLog));

// ---------------- OpenMontage ----------------
ipcMain.handle('om:status', async () => ({ ...(await om.status()), bundle: runtime.info(), engine: engineState, engineMeta: om.isRepo() ? runtime.engineMeta(om.root) : null }));
ipcMain.handle('om:engineState', () => engineState);
ipcMain.handle('om:checkUpdate', () => checkEngineUpdate());
ipcMain.handle('om:deps', () => om.deps());
ipcMain.handle('om:setRoot', (_, p) => { om.setRoot(p); runtime.applyEnv(p); projects.pyOk = null; projects.watch(id => send('project:changed', id)); return om.status(); });
ipcMain.handle('om:setup', async () => {
  if (runtime.available) {
    setEngine({ busy: 'provision', error: null });
    try { await runtime.provision(om.root, engineLog); } finally { setEngine({ busy: null }); }
  } else {
    setEngine({ busy: 'provision', error: null });
    try { await om.setup(engineLog); runtime.applyEnv(om.root); } finally { setEngine({ busy: null }); }
  }
  await addons.ensure(engineLog);
  projects.pyOk = null;
  projects.watch(id => send('project:changed', id));
  return om.status();
});
ipcMain.handle('om:update', async () => { await updateEngine(); if (engineState.error) throw new Error(engineState.error); return true; });
ipcMain.handle('om:env', () => om.readEnv());
ipcMain.handle('om:saveEnv', (_, v) => om.writeEnv(v));
ipcMain.handle('om:pipelines', () => om.pipelines());
ipcMain.handle('om:skills', () => om.skills());
ipcMain.handle('om:readFile', (_, rel) => {
  const p = path.resolve(om.root, rel);
  if (!p.startsWith(path.resolve(om.root) + path.sep)) throw new Error('outside repo');
  return fs.readFileSync(p, 'utf8');
});

let backlotProc = null;
ipcMain.handle('om:backlot', async (_, pid) => {
  const port = 4750;
  const alive = async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { return false; } };
  if (!(await alive())) {
    if (!backlotProc) {
      let errText = '';
      backlotProc = spawnCmd(om.python(), ['-m', 'backlot', 'serve', '--port', String(port)], {
        cwd: om.root, env: { ...process.env, OPENMONTAGE_PROJECTS_DIR: projects.dir }, stdio: ['ignore', 'ignore', 'pipe'],
      });
      backlotProc.stderr.on('data', d => { errText = (errText + d).slice(-1500); });
      backlotProc.on('close', (code) => { if (code) engineLog(`Backlot exited (${code}): ${errText}\n`); backlotProc = null; });
    }
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) { await new Promise(r => setTimeout(r, 400)); ok = await alive(); }
    if (!ok) throw new Error('Backlot did not start — see the log in Settings');
  }
  const w = new BrowserWindow({ width: 1280, height: 860, backgroundColor: '#0d0d0d', autoHideMenuBar: true, title: 'Backlot' });
  w.loadURL(`http://127.0.0.1:${port}/${pid ? 'p/' + encodeURIComponent(pid) : ''}`).catch(() => {});
  return true;
});

// ---------------- Projects ----------------
ipcMain.handle('projects:list', () => projects.list());
ipcMain.handle('projects:state', (_, id) => { if (!activeRuns.has(id)) projects.repairNested(id); return projects.state(id); });
ipcMain.handle('projects:create', (_, o) => projects.create(o));
ipcMain.handle('projects:saveLayout', (_, id, l) => projects.saveLayout(id, l));
ipcMain.handle('projects:patch', (_, id, file, ptr, v) => projects.patchArtifact(id, file, ptr, v));
ipcMain.handle('projects:readText', (_, id, f) => projects.readText(id, f));
ipcMain.handle('projects:writeText', (_, id, f, t) => projects.writeText(id, f, t));
ipcMain.handle('projects:import', async (_, id) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  if (r.canceled) return [];
  return projects.importFiles(id, r.filePaths);
});
ipcMain.handle('projects:reveal', (_, id, rel) => {
  const p = rel ? path.join(projects.dir, id, rel) : path.join(projects.dir, id || '');
  if (rel) shell.showItemInFolder(p); else shell.openPath(p);
});

// ---------------- Voice input (speech-to-text) ----------------
ipcMain.handle('stt:status', () => stt.status());
ipcMain.handle('stt:transcribe', (_, bytes, mime) => stt.transcribe(bytes, mime));
ipcMain.handle('stt:enableLocal', async (_, model) => {
  try { return await stt.enableLocal(engineLog, model); } catch (e) { engineLog('\n✗ ' + e.message + '\n'); throw e; }
});
ipcMain.handle('stt:setKey', (_, provider, value) => {
  const k = { groq: 'GROQ_API_KEY', openai: 'OPENAI_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY' }[provider];
  if (!k || !om.isRepo()) throw new Error('OpenMontage is not set up yet');
  return om.writeEnv({ [k]: value });
});
ipcMain.handle('stt:permission', async () => {
  if (process.platform !== 'darwin') return 'granted';
  const st = systemPreferences.getMediaAccessStatus('microphone');
  if (st === 'granted') return st;
  if (st === 'not-determined') return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
  return st; // denied / restricted → user must enable it in System Settings
});
ipcMain.handle('stt:openMicSettings', () => {
  if (process.platform === 'darwin') shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
  else if (process.platform === 'win32') shell.openExternal('ms-settings:privacy-microphone');
});

// ---------------- Add-ons ----------------
ipcMain.handle('addons:state', () => addons.state);
ipcMain.handle('addons:ensure', () => addons.ensure(engineLog));
ipcMain.handle('addons:ttsPreview', (_, o) => addons.preview(o));
ipcMain.handle('addons:ttsVoices', (_, lang) => addons.voices(lang));

// ---------------- Settings / misc ----------------
ipcMain.handle('settings:get', () => ({ ...settings.data, platform: process.platform, version: app.getVersion() }));
ipcMain.handle('settings:set', (_, k, v) => {
  settings.set(k, v);
  if (k === 'projectsDir') { projects.pyOk = null; projects.watch(id => send('project:changed', id)); }
  return true;
});
ipcMain.handle('dialog:folder', async (_, title) => {
  const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('shell:open', (_, url) => shell.openExternal(url));
ipcMain.handle('which', (_, c) => which(c));

// ---------------- Interactive terminal (optional, needs node-pty) ----------------
let pty = null;
try { pty = require('node-pty'); } catch { pty = null; }
const terms = new Map();
ipcMain.handle('term:available', () => !!pty);
ipcMain.handle('term:start', (_, { cmd, args, cols, rows }) => {
  if (!pty) throw new Error('Interactive terminal unavailable (node-pty not installed).');
  const shellCmd = cmd || (process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash'));
  const id = Math.random().toString(36).slice(2);
  const p = pty.spawn(which(shellCmd) || shellCmd, args || [], {
    name: 'xterm-256color', cols: cols || 100, rows: rows || 30,
    cwd: om.isRepo() ? om.root : app.getPath('home'), env: { ...process.env, OPENMONTAGE_PROJECTS_DIR: projects.dir },
  });
  p.onData(d => send('term:data', { id, data: d }));
  p.onExit(({ exitCode }) => { terms.delete(id); send('term:exit', { id, code: exitCode }); });
  terms.set(id, p);
  return id;
});
ipcMain.on('term:input', (_, { id, data }) => { const t = terms.get(id); if (t) t.write(data); });
ipcMain.on('term:resize', (_, { id, cols, rows }) => { const t = terms.get(id); if (t) try { t.resize(cols, rows); } catch {} });
ipcMain.handle('term:kill', (_, id) => { const t = terms.get(id); if (t) t.kill(); terms.delete(id); return true; });

// ---------------- App lifecycle ----------------
app.whenReady().then(() => {
  registerMediaProtocol();
  // Allow the app's own page to use the microphone (voice input); nothing else.
  const own = (wc) => wc && wc.getURL().startsWith('file://');
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => {
    cb(perm === 'media' && own(wc) && (!details.mediaTypes || details.mediaTypes.every(t => t === 'audio')));
  });
  session.defaultSession.setPermissionCheckHandler((wc, perm) => perm === 'media' && own(wc));
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
  } else Menu.setApplicationMenu(null);
  createWindow();
  if (om.isRepo()) projects.watch(id => send('project:changed', id));
  // First launch with a bundled engine: install it silently. Then check for updates.
  setTimeout(async () => {
    await provisionIfNeeded();
    await addons.ensure(engineLog);
    setTimeout(() => checkEngineUpdate({ auto: true }), 5000);
    setInterval(() => checkEngineUpdate({ auto: true }), 6 * 3600 * 1000);
  }, 1200);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => {
  agents.stopAll();
  stt.stopWorker();
  for (const t of terms.values()) try { t.kill(); } catch {}
  if (backlotProc) try { backlotProc.kill(); } catch {}
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
