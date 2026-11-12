// Bundled runtime: portable Python/Node/ffmpeg + an offline copy of the OpenMontage engine.
// Provisioning copies the engine to a writable folder and builds its venv from local wheels,
// so a fresh install needs no internet and no system tools. Updates come from GitHub tarballs.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');
const { run, IS_WIN } = require('./util');

const REPO = 'calesthio/OpenMontage';
const OS = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
const KEEP = new Set(['projects', '.env', '.venv', '.studio-engine.json', 'node_modules']); // never overwritten by updates

function bundleDir() {
  const packed = path.join(process.resourcesPath || '', 'bundle');
  if (app.isPackaged && fs.existsSync(packed)) return packed;
  const dev = path.join(__dirname, '..', '..', 'vendor', `${OS}-${process.arch}`);
  return fs.existsSync(path.join(dev, 'bundle.json')) ? dev : null;
}

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

class Runtime {
  constructor() {
    this.dir = bundleDir();
    this.meta = this.dir ? readJSON(path.join(this.dir, 'bundle.json')) : null;
    this.systemPath = process.env.PATH;
  }

  get available() { return !!(this.dir && this.meta); }
  p(...a) { return path.join(this.dir, ...a); }
  pythonBin() { return IS_WIN ? this.p('runtime', 'python', 'python.exe') : this.p('runtime', 'python', 'bin', 'python3'); }
  binDirs() {
    if (!this.available) return [];
    return IS_WIN
      ? [this.p('runtime', 'node'), this.p('runtime', 'bin'), this.p('runtime', 'python'), this.p('runtime', 'python', 'Scripts')]
      : [this.p('runtime', 'node', 'bin'), this.p('runtime', 'bin'), this.p('runtime', 'python', 'bin')];
  }

  /** Put the engine venv + bundled tools in front of PATH for the app and every agent it starts. */
  applyEnv(engineRoot) {
    const sep = IS_WIN ? ';' : ':';
    const venvBin = engineRoot ? path.join(engineRoot, '.venv', IS_WIN ? 'Scripts' : 'bin') : null;
    const front = [venvBin, ...this.binDirs()].filter(p => p && fs.existsSync(p));
    process.env.PATH = [...front, ...this.systemPath.split(sep)].filter((v, i, a) => v && a.indexOf(v) === i).join(sep);
    if (engineRoot && fs.existsSync(path.join(engineRoot, '.venv'))) process.env.VIRTUAL_ENV = path.join(engineRoot, '.venv');
    if (this.available) {
      // Remotion/HyperFrames should use the bundled ffmpeg too
      process.env.FFMPEG_BINARY = path.join(this.p('runtime', 'bin'), IS_WIN ? 'ffmpeg.exe' : 'ffmpeg');
      process.env.FFPROBE_BINARY = path.join(this.p('runtime', 'bin'), IS_WIN ? 'ffprobe.exe' : 'ffprobe');
    }
  }

  engineMeta(root) { return readJSON(path.join(root, '.studio-engine.json')); }

  needsProvision(root) {
    if (!this.available) return false;
    const ok = fs.existsSync(path.join(root, 'AGENT_GUIDE.md')) && this.venvWorks(root);
    return !ok;
  }

  venvWorks(root) {
    const py = path.join(root, '.venv', IS_WIN ? 'Scripts\\python.exe' : 'bin/python');
    if (!fs.existsSync(py)) return false;
    // venv points at the bundled interpreter; if the app moved, the link breaks
    const cfg = fs.existsSync(path.join(root, '.venv', 'pyvenv.cfg')) ? fs.readFileSync(path.join(root, '.venv', 'pyvenv.cfg'), 'utf8') : '';
    const home = (cfg.match(/^home\s*=\s*(.+)$/m) || [])[1];
    return !home || fs.existsSync(home.trim());
  }

  /** Offline install from the bundle into `root`. Idempotent; keeps projects/ and .env. */
  async provision(root, log) {
    if (!this.available) throw new Error('No bundled engine in this build');
    const src = this.p('engine');
    fs.mkdirSync(root, { recursive: true });
    if (!fs.existsSync(path.join(root, 'AGENT_GUIDE.md'))) {
      log(`▶ Copying OpenMontage (${(this.meta.engine && this.meta.engine.sha || '').slice(0, 7)}) to ${root}\n`);
      copyTree(src, root, { keepExisting: true });
      fs.writeFileSync(path.join(root, '.studio-engine.json'), JSON.stringify({ ...this.meta.engine, source: 'bundle', installedAt: new Date().toISOString() }, null, 2));
    } else if (!fs.existsSync(path.join(root, 'remotion-composer', 'node_modules')) && fs.existsSync(path.join(src, 'remotion-composer', 'node_modules'))) {
      log('▶ Copying Remotion composer dependencies\n');
      copyTree(path.join(src, 'remotion-composer', 'node_modules'), path.join(root, 'remotion-composer', 'node_modules'), { keepExisting: true });
    }
    await this.buildVenv(root, log);
    const env = path.join(root, '.env');
    if (!fs.existsSync(env) && fs.existsSync(path.join(root, '.env.example'))) fs.copyFileSync(path.join(root, '.env.example'), env);
    fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
    this.applyEnv(root);
    log('\n✅ OpenMontage is ready — no downloads needed.\n');
  }

  async buildVenv(root, log, { force } = {}) {
    const venv = path.join(root, '.venv');
    if (force || !this.venvWorks(root)) {
      fs.rmSync(venv, { recursive: true, force: true });
      log(`▶ Creating Python environment (${this.meta.python})\n`);
      const r = await run(this.pythonBin(), ['-m', 'venv', venv], { onData: log });
      if (r.code !== 0) throw new Error('venv creation failed');
    }
    const vpy = path.join(venv, IS_WIN ? 'Scripts\\python.exe' : 'bin/python');
    log('▶ Installing Python packages from the bundle (offline)\n');
    const wheels = this.p('wheels');
    const r = await run(vpy, ['-m', 'pip', 'install', '--no-index', '--find-links', wheels, '--disable-pip-version-check', '-q',
      '-r', path.join(root, 'requirements.txt'), 'piper-tts'], { onData: log, cwd: root });
    if (r.code !== 0) {
      log('⚠ Offline install incomplete — fetching the missing packages online\n');
      const r2 = await run(vpy, ['-m', 'pip', 'install', '--find-links', wheels, '-q', '-r', path.join(root, 'requirements.txt'), 'piper-tts'], { onData: log, cwd: root });
      if (r2.code !== 0) throw new Error('Python packages failed to install');
    }
    // Voice input + OpenMontage's transcriber (optional; never blocks setup)
    const fw = await run(vpy, ['-m', 'pip', 'install', '--no-index', '--find-links', wheels, '-q', 'faster-whisper'], { cwd: root });
    log(fw.code === 0 ? '✓ faster-whisper (voice input) installed\n' : 'ℹ faster-whisper not in bundle — enable voice input later in Settings\n');
  }

  // ---------------- updates (no git needed) ----------------
  async latestCommit() {
    const r = await fetch(`https://api.github.com/repos/${REPO}/commits/HEAD`, { headers: { 'User-Agent': 'openmontage-studio' } });
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    const j = await r.json();
    return { sha: j.sha, date: j.commit.committer.date, message: j.commit.message.split('\n')[0] };
  }

  async compareCommits(base, head) {
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/compare/${base}...${head}`, { headers: { 'User-Agent': 'openmontage-studio' } });
      if (!r.ok) return null;
      const j = await r.json();
      return { behind: j.ahead_by, commits: (j.commits || []).slice(-8).reverse().map(c => c.commit.message.split('\n')[0]) };
    } catch { return null; }
  }

  async checkUpdate(root) {
    const local = this.engineMeta(root);
    if (!local || !local.sha) return { available: false, reason: 'unknown-version' };
    const latest = await this.latestCommit();
    if (latest.sha === local.sha) return { available: false, current: local, latest, checkedAt: Date.now() };
    const cmp = await this.compareCommits(local.sha, latest.sha);
    return { available: true, current: local, latest, behind: cmp ? cmp.behind : null, commits: cmp ? cmp.commits : [latest.message], checkedAt: Date.now() };
  }

  /** Download the newest engine tarball and apply it over `root`, keeping user data. */
  async update(root, log) {
    const latest = await this.latestCommit();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'om-update-'));
    try {
      log(`▶ Downloading OpenMontage ${latest.sha.slice(0, 7)} — ${latest.message}\n`);
      const r = await fetch(`https://codeload.github.com/${REPO}/tar.gz/${latest.sha}`, { headers: { 'User-Agent': 'openmontage-studio' } });
      if (!r.ok) throw new Error(`download failed (${r.status})`);
      const tgz = path.join(tmp, 'engine.tar.gz');
      fs.writeFileSync(tgz, Buffer.from(await r.arrayBuffer()));
      const x = await run('tar', ['-xf', tgz, '-C', tmp]);
      if (x.code !== 0) throw new Error('could not extract update');
      const top = path.join(tmp, fs.readdirSync(tmp).find(f => f !== 'engine.tar.gz'));
      const oldReq = safeRead(path.join(root, 'requirements.txt'));
      const oldPkg = safeRead(path.join(root, 'remotion-composer', 'package.json'));
      log('▶ Applying update (your projects and .env are kept)\n');
      copyTree(top, root, { keepExisting: false, skip: KEEP });
      fs.writeFileSync(path.join(root, '.studio-engine.json'), JSON.stringify({ sha: latest.sha, date: latest.date, repo: REPO, source: 'update', installedAt: new Date().toISOString() }, null, 2));
      if (safeRead(path.join(root, 'requirements.txt')) !== oldReq) {
        log('▶ Python requirements changed — updating packages\n');
        const vpy = path.join(root, '.venv', IS_WIN ? 'Scripts\\python.exe' : 'bin/python');
        await run(vpy, ['-m', 'pip', 'install', '--find-links', this.p('wheels'), '-q', '-r', path.join(root, 'requirements.txt')], { onData: log, cwd: root });
      }
      if (safeRead(path.join(root, 'remotion-composer', 'package.json')) !== oldPkg) {
        log('▶ Remotion dependencies changed — npm install\n');
        await run('npm', ['install', '--no-audit', '--no-fund'], { onData: log, cwd: path.join(root, 'remotion-composer') });
      }
      log('\n✅ OpenMontage updated.\n');
      return { sha: latest.sha };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  info() {
    return { available: this.available, dir: this.dir, meta: this.meta };
  }
}

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

/** Copy a tree. keepExisting: don't overwrite files already present. skip: top-level names to leave alone. */
function copyTree(src, dest, { keepExisting, skip } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip && skip.has(ent.name)) continue;
    const s = path.join(src, ent.name), d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyTree(s, d, { keepExisting });
    else if (ent.isSymbolicLink()) {
      if (fs.existsSync(d) || isLink(d)) { if (keepExisting) continue; fs.rmSync(d, { force: true }); }
      fs.symlinkSync(fs.readlinkSync(s), d);
    } else {
      if (keepExisting && fs.existsSync(d)) continue;
      fs.copyFileSync(s, d);
      try { fs.chmodSync(d, fs.statSync(s).mode); } catch {}
    }
  }
}
function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }

module.exports = { Runtime };
