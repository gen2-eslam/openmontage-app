// HyperFrames integration: in-app preview server (+ runtime injection), composition discovery,
// draft cut builder and MP4 export (full film or a single scene) with progress.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { which, run, IS_WIN } = require('./util');
const { writeDraft, buildModel } = require('./composer');

const APP_ROOT = path.join(__dirname, '..', '..');
const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const mod = (...p) => unpacked(path.join(APP_ROOT, 'node_modules', ...p));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.lottie': 'application/zip',
};

class HyperFrames {
  constructor({ projects, runtime, log }) {
    this.projects = projects; this.runtime = runtime; this.log = log || (() => {});
    this.port = null; this.server = null; this.jobs = new Map(); this.browserPath = null;
  }

  vendor() {
    return { gsap: mod('gsap', 'dist', 'gsap.min.js'), runtime: mod('hyperframes', 'dist', 'hyperframe.runtime.iife.js') };
  }
  cliPath() { const d = mod('hyperframes', 'dist', 'cli.js'); return fs.existsSync(d) ? d : mod('hyperframes', 'bin', 'hyperframes.mjs'); }
  playerScript() { return mod('@hyperframes/player', 'dist', 'hyperframes-player.global.js'); }

  /** HyperFrames needs Node >= 22 (Electron's own Node is 20). */
  async node() {
    if (this._node) return this._node;
    const cands = [];
    if (this.runtime.available) cands.push(IS_WIN ? this.runtime.p('runtime', 'node', 'node.exe') : this.runtime.p('runtime', 'node', 'bin', 'node'));
    const sys = which('node'); if (sys) cands.push(sys);
    for (const c of cands) {
      if (!fs.existsSync(c)) continue;
      const r = await run(c, ['--version'], { timeout: 8000 });
      const major = parseInt((r.out.match(/v(\d+)/) || [])[1] || '0', 10);
      if (major >= 22) return (this._node = c);
    }
    throw new Error('HyperFrames needs Node.js 22 or newer. Rebuild the bundle (npm run bundle) or install Node 22+.');
  }

  /** Chrome for rendering: env → bundled → Remotion's headless shell → hyperframes browser ensure (downloads once). */
  async browser(onLog) {
    if (process.env.HYPERFRAMES_BROWSER_PATH && fs.existsSync(process.env.HYPERFRAMES_BROWSER_PATH)) return process.env.HYPERFRAMES_BROWSER_PATH;
    if (this.browserPath && fs.existsSync(this.browserPath)) return this.browserPath;
    const exe = IS_WIN ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
    const roots = [];
    if (this.runtime.available) roots.push(this.runtime.p('runtime', 'chrome'));
    const om = this.projects.om;
    if (om && om.isRepo()) roots.push(path.join(om.root, 'remotion-composer', 'node_modules', '.remotion'));
    for (const r of roots) { const f = findFile(r, exe, 6); if (f) return (this.browserPath = f); }
    const node = await this.node();
    (onLog || this.log)('▶ Preparing the render browser (one-time download)\n');
    const r = await run(node, [this.cliPath(), 'browser', 'ensure'], { timeout: 900000, onData: onLog || this.log });
    const p = await run(node, [this.cliPath(), 'browser', 'path'], { timeout: 60000 });
    const line = (p.out || '').trim().split('\n').map(s => s.trim()).reverse().find(s => s && fs.existsSync(s));
    if (r.code !== 0 && !line) throw new Error('Could not prepare Chrome for rendering');
    return (this.browserPath = line || null);
  }

  // ---------------- preview server ----------------
  async start() {
    if (this.port) return this.port;
    this.server = http.createServer((req, res) => this._serve(req, res));
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    return this.port;
  }
  stop() { try { this.server && this.server.close(); } catch {} for (const j of this.jobs.values()) try { j.child.kill(); } catch {} }

  url(projectId, rel) {
    return `http://127.0.0.1:${this.port}/p/${encodeURIComponent(projectId)}/${rel.split('/').map(encodeURIComponent).join('/')}?preview=1`;
  }

  _serve(req, res) {
    try {
      const u = new URL(req.url, 'http://x');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache');
      if (u.pathname === '/hf/runtime.js') return this._file(req, res, this.vendor().runtime);
      const m = u.pathname.match(/^\/p\/([^/]+)\/(.+)$/);
      if (!m) { res.writeHead(404); return res.end(); }
      const base = path.resolve(this.projects.dir, decodeURIComponent(m[1]));
      const file = path.resolve(base, decodeURIComponent(m[2]));
      if (!file.startsWith(base + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      if (file.endsWith('.html') && u.searchParams.get('preview') === '1') {
        // Inject the local runtime so preview works offline (the player would otherwise fetch it from a CDN).
        let html = fs.readFileSync(file, 'utf8');
        const tag = `<script src="http://127.0.0.1:${this.port}/hf/runtime.js"></script>`;
        html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, tag + '</head>') : tag + html;
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        return res.end(html);
      }
      return this._file(req, res, file);
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  }

  _file(req, res, file) {
    const size = fs.statSync(file).size;
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/);
    if (range) {
      let start = range[1] ? +range[1] : 0, end = range[2] ? +range[2] : size - 1;
      if (!range[1]) { start = Math.max(0, size - +range[2]); end = size - 1; }
      end = Math.min(end, size - 1);
      res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  }

  // ---------------- compositions ----------------
  /** A HyperFrames workspace the agent built (hyperframes.json + index.html), newest first. */
  agentComposition(projectDir) {
    const found = [];
    const walk = (d, depth) => {
      if (depth > 4) return;
      let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      if (ents.some(e => e.name === 'hyperframes.json') && ents.some(e => e.name === 'index.html')) {
        found.push({ dir: d, mtime: fs.statSync(path.join(d, 'index.html')).mtimeMs });
      }
      for (const e of ents) if (e.isDirectory() && !['.studio', 'node_modules', 'history', 'assets', '.git'].includes(e.name)) walk(path.join(d, e.name), depth + 1);
    };
    walk(projectDir, 0);
    found.sort((a, b) => b.mtime - a.mtime);
    return found[0] ? found[0].dir : null;
  }

  /** What the player should show: the agent's composition if it exists, else a fresh draft cut. */
  async preview(projectId, { prefer } = {}) {
    await this.start();
    const st = await this.projects.state(projectId);
    const agentDir = this.agentComposition(st.dir);
    if (agentDir && prefer !== 'draft') {
      const rel = path.relative(st.dir, path.join(agentDir, 'index.html')).split(path.sep).join('/');
      return { source: 'composition', url: this.url(projectId, rel), rel, model: await safeModel(st), hasDraftAlternative: true };
    }
    const d = await writeDraft(st, { vendor: this.vendor() });
    return { source: 'draft', url: this.url(projectId, d.rel + '/index.html'), rel: d.rel, model: d.model, hasComposition: !!agentDir };
  }

  // ---------------- export ----------------
  /**
   * opts: { projectId, sceneId?, source: 'auto'|'draft'|'composition', quality: 'draft'|'standard'|'high', format: 'mp4'|'webm'|'gif' }
   * emit({jobId, phase, pct, message, done, output, error})
   */
  async exportVideo(opts, emit) {
    const { projectId, sceneId } = opts;
    const quality = opts.quality || 'standard';
    const format = opts.format || 'mp4';
    const jobId = Math.random().toString(36).slice(2, 10);
    const st = await this.projects.state(projectId);
    const agentDir = opts.source === 'draft' ? null : this.agentComposition(st.dir);
    const outDir = path.join(st.dir, 'renders');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2');
    const name = `${projectId}${sceneId ? '_' + sceneId.replace(/[^\w-]/g, '') : ''}_${stamp}.${format}`;
    const output = path.join(outDir, name);
    const job = { jobId, child: null, cancelled: false };
    this.jobs.set(jobId, job);
    const say = (p) => emit({ jobId, projectId, sceneId, ...p });

    (async () => {
      try {
        say({ phase: 'prepare', pct: 1, message: 'Preparing' });
        const node = await this.node();
        const browser = await this.browser((t) => say({ phase: 'browser', message: t.trim().slice(-160) }));
        let dir, trim = null;
        if (agentDir) {
          dir = agentDir;
          if (sceneId) {
            const m = await buildModel(st);
            const s = m.scenes.find(x => x.id === sceneId);
            if (s) trim = { start: s.start, end: s.end };
          }
        } else {
          dir = (await writeDraft(st, { sceneId, vendor: this.vendor() })).dir;
        }
        const target = trim ? output.replace(/(\.\w+)$/, '.full$1') : output;
        const args = [this.cliPath(), 'render', dir, '--output', target, '--quality', quality, '--format', format];
        say({ phase: 'render', pct: 3, message: agentDir ? 'Rendering the composition' : 'Rendering the draft cut' });
        await new Promise((resolve, reject) => {
          const env = { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', NO_COLOR: '1' };
          if (browser) env.HYPERFRAMES_BROWSER_PATH = browser;
          const child = spawn(node, args, { cwd: dir, env, windowsHide: true });
          job.child = child;
          let tail = '';
          const onData = (d) => {
            const s = String(d);
            tail = (tail + s).slice(-4000);
            for (const line of s.split(/\r?\n|\r/)) {
              const pm = line.match(/@hf-progress\s+(\{.*\})/);
              if (pm) { try { const j = JSON.parse(pm[1]); say({ phase: j.code, pct: Math.min(trim ? 95 : 99, Math.max(3, j.pct || 0)), message: titleOf(j.code) }); } catch {} }
            }
          };
          child.stdout.on('data', onData); child.stderr.on('data', onData);
          child.on('error', reject);
          child.on('close', (code) => {
            job.child = null;
            if (job.cancelled) return reject(new Error('Cancelled'));
            if (code === 0 && fs.existsSync(target)) resolve();
            else reject(new Error(lastError(tail) || `Render failed (exit ${code})`));
          });
        });
        if (trim) {
          say({ phase: 'trim', pct: 96, message: 'Cutting the scene' });
          const r = await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(trim.start), '-to', String(trim.end), '-i', target,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output], { timeout: 600000 });
          try { fs.rmSync(target, { force: true }); } catch {}
          if (r.code !== 0) throw new Error('ffmpeg trim failed: ' + r.err.slice(-300));
        }
        const rel = path.relative(st.dir, output).split(path.sep).join('/');
        say({ phase: 'done', pct: 100, done: true, output, rel, message: 'Exported' });
      } catch (e) {
        say({ phase: 'error', done: true, error: e.message });
      } finally { this.jobs.delete(jobId); }
    })();
    return { jobId, output };
  }

  cancel(jobId) {
    const j = this.jobs.get(jobId);
    if (!j) return false;
    j.cancelled = true;
    try { if (IS_WIN && j.child) spawn('taskkill', ['/pid', String(j.child.pid), '/T', '/F']); else j.child && j.child.kill('SIGTERM'); } catch {}
    return true;
  }
}

async function safeModel(st) { try { return await buildModel(st); } catch { return null; } }

function titleOf(code) {
  return ({ compile: 'Compiling', extract_video: 'Preparing video', audio: 'Mixing audio', capture: 'Rendering frames', encode: 'Encoding', mux: 'Finishing' })[code]
    || String(code || '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

function lastError(tail) {
  const lines = tail.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const err = lines.reverse().find(l => /error|failed|✗|Error:/i.test(l) && !/\[INFO\]/.test(l));
  return err ? err.replace(/^.*?(Error:|✗)\s*/, '').slice(0, 300) : null;
}

function findFile(root, name, depth) {
  if (!root || depth < 0 || !fs.existsSync(root)) return null;
  let ents = []; try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const e of ents) if (e.isFile() && e.name === name) return path.join(root, e.name);
  for (const e of ents) if (e.isDirectory()) { const f = findFile(path.join(root, e.name), name, depth - 1); if (f) return f; }
  return null;
}

module.exports = { HyperFrames };
