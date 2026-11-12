// OpenMontage integration: locate/install the repo, check deps, .env, pipelines, skills.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { IS_WIN, which, run } = require('./util');

const REPO_URL = 'https://github.com/calesthio/OpenMontage.git';

class OpenMontage {
  constructor(store, defaultRoot) {
    this.store = store;
    this.defaultRoot = defaultRoot;
  }

  get root() { return this.store.get('openmontageRoot', this.defaultRoot); }
  setRoot(p) { this.store.set('openmontageRoot', p); }

  isRepo(p = this.root) {
    return !!p && fs.existsSync(path.join(p, 'AGENT_GUIDE.md')) && fs.existsSync(path.join(p, 'pipeline_defs'));
  }

  projectsDir() {
    return this.store.get('projectsDir', '') || path.join(this.root, 'projects');
  }

  python() {
    const v = IS_WIN ? path.join(this.root, '.venv', 'Scripts', 'python.exe') : path.join(this.root, '.venv', 'bin', 'python');
    if (fs.existsSync(v)) return v;
    return which('python3') ? 'python3' : (which('python') ? 'python' : (which('py') ? 'py' : 'python3'));
  }

  hasVenv() {
    return fs.existsSync(IS_WIN ? path.join(this.root, '.venv', 'Scripts', 'python.exe') : path.join(this.root, '.venv', 'bin', 'python'));
  }

  async deps() {
    const checks = [
      ['git', ['--version']], ['python', [], 'python'], ['node', ['--version']], ['npm', ['--version']], ['ffmpeg', ['-version']],
    ];
    const res = {};
    for (const [name, args, special] of checks) {
      let cmd = name;
      let a = args;
      if (special === 'python') { cmd = which('python3') ? 'python3' : (which('python') ? 'python' : 'py'); a = ['--version']; }
      if (!which(cmd)) { res[name] = { ok: false }; continue; }
      const r = await run(cmd, a, { timeout: 10000 });
      const line = (r.out || r.err).trim().split('\n')[0];
      res[name] = { ok: r.code === 0, version: line.slice(0, 70) };
    }
    // Node >= 22 is needed by the HyperFrames render runtime.
    if (res.node && res.node.ok) {
      const major = parseInt((res.node.version.match(/v(\d+)/) || [])[1] || '0', 10);
      res.node.hyperframesReady = major >= 22;
    }
    return res;
  }

  async status() {
    const root = this.root;
    const repo = this.isRepo(root);
    return {
      root, repo,
      venv: repo && this.hasVenv(),
      env: repo && fs.existsSync(path.join(root, '.env')),
      remotion: repo && fs.existsSync(path.join(root, 'remotion-composer', 'node_modules')),
      projectsDir: this.projectsDir(),
    };
  }

  /** Pick a Python >= 3.10 (macOS ships 3.9 with the CLT, which OpenMontage can't use). */
  async findPython() {
    const cands = IS_WIN ? ['py', 'python', 'python3'] : ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'];
    for (const c of cands) {
      if (!which(c)) continue;
      const r = await run(c, c === 'py' ? ['-3', '--version'] : ['--version'], { timeout: 8000 });
      const m = (r.out + r.err).match(/Python (\d+)\.(\d+)/);
      if (m && (+m[1] > 3 || (+m[1] === 3 && +m[2] >= 10))) return { cmd: c, version: `${m[1]}.${m[2]}` };
    }
    return null;
  }

  /** Install missing system tools with the platform package manager when one is available. */
  async ensureSystemDeps(log) {
    const need = [];
    if (!which('git')) need.push('git');
    if (!(await this.findPython())) need.push('python');
    if (!which('ffmpeg')) need.push('ffmpeg');
    if (!need.length) { log('✓ git, Python 3.10+ and ffmpeg are installed\n'); return; }
    log(`Missing: ${need.join(', ')}\n`);
    if (process.platform === 'darwin') {
      const brew = which('brew') || ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(p => fs.existsSync(p));
      if (!brew) throw new Error(`Homebrew is not installed, so ${need.join(', ')} can't be installed automatically. Install Homebrew from https://brew.sh then press Install again.`);
      const pkgs = need.map(n => ({ git: 'git', python: 'python@3.12', ffmpeg: 'ffmpeg' }[n]));
      log(`\n▶ Installing ${pkgs.join(' ')} with Homebrew (this can take a few minutes)\n`);
      const r = await run(brew, ['install', ...pkgs], { onData: log, env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1' } });
      if (r.code !== 0) throw new Error('brew install failed');
    } else if (IS_WIN) {
      if (!which('winget')) throw new Error(`winget is not available. Install manually: ${need.join(', ')}`);
      const ids = need.map(n => ({ git: 'Git.Git', python: 'Python.Python.3.12', ffmpeg: 'Gyan.FFmpeg' }[n]));
      for (const id of ids) {
        log(`\n▶ winget install ${id}\n`);
        await run('winget', ['install', '-e', '--id', id, '--accept-source-agreements', '--accept-package-agreements', '--silent'], { onData: log });
      }
      log('\nℹ Windows may need the app restarted so the new tools appear on PATH.\n');
    } else {
      const apt = 'sudo apt install -y git python3 python3-venv python3-pip ffmpeg';
      throw new Error(`Please install the missing tools (${need.join(', ')}), e.g.:\n${apt}`);
    }
    // refresh PATH lookups for freshly installed tools
    require('./util').fixPath();
    if (need.includes('python') && !(await this.findPython())) throw new Error('Python 3.10+ still not found after install');
  }

  /** Clone (if needed) and run the same steps as `make setup`, cross-platform. Idempotent. */
  async setup(log) {
    const root = this.root;
    const step = async (title, cmd, args, cwd, opts = {}) => {
      log(`\n▶ ${title}\n$ ${cmd} ${args.join(' ')}\n`);
      const r = await run(cmd, args, { cwd, onData: log, ...opts });
      if (r.code !== 0 && !opts.optional) throw new Error(`${title} failed (exit ${r.code})`);
      if (r.code !== 0) log(`⚠ ${title} failed — optional, continuing\n`);
      return r;
    };
    await this.ensureSystemDeps(log);
    if (!this.isRepo(root)) {
      fs.mkdirSync(root, { recursive: true });
      const entries = fs.readdirSync(root).filter(f => f !== '.DS_Store');
      if (!entries.length) {
        await step('Cloning OpenMontage', 'git', ['clone', '--depth', '1', REPO_URL, root], path.dirname(root));
      } else {
        // Folder already has things (e.g. projects/). Clone beside it, then move the repo in.
        const tmp = root + '.clone-' + Date.now();
        await step('Cloning OpenMontage', 'git', ['clone', '--depth', '1', REPO_URL, tmp], path.dirname(root));
        for (const f of fs.readdirSync(tmp)) {
          const dest = path.join(root, f);
          if (fs.existsSync(dest)) {
            if (f === 'projects' && fs.statSync(dest).isDirectory()) {
              for (const g of fs.readdirSync(path.join(tmp, f))) if (!fs.existsSync(path.join(dest, g))) fs.renameSync(path.join(tmp, f, g), path.join(dest, g));
              continue;
            }
            throw new Error(`Can't install: ${dest} already exists. Move it away or choose another folder.`);
          }
          fs.renameSync(path.join(tmp, f), dest);
        }
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
    const py = await this.findPython();
    if (!py) throw new Error('Python 3.10+ is required');
    if (!this.hasVenv()) await step(`Creating Python ${py.version} virtual env`, py.cmd, py.cmd === 'py' ? ['-3', '-m', 'venv', '.venv'] : ['-m', 'venv', '.venv'], root);
    await this.installDeps(step, log);
    const env = path.join(root, '.env');
    if (!fs.existsSync(env) && fs.existsSync(path.join(root, '.env.example'))) {
      fs.copyFileSync(path.join(root, '.env.example'), env);
      log('\n▶ Created .env from .env.example\n');
    }
    fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
    log('\n✅ OpenMontage is ready.\n');
    return this.status();
  }

  /** Python + Node dependencies. Run on setup and after every engine update. */
  async installDeps(step, log) {
    const root = this.root;
    const vpy = this.python();
    await step('Upgrading pip', vpy, ['-m', 'pip', 'install', '--upgrade', 'pip', '-q'], root, { optional: true });
    await step('Installing Python requirements', vpy, ['-m', 'pip', 'install', '-r', 'requirements.txt'], root);
    await step('Installing Piper TTS (free narration)', vpy, ['-m', 'pip', 'install', 'piper-tts', '-q'], root, { optional: true });
    const rc = path.join(root, 'remotion-composer');
    if (fs.existsSync(path.join(rc, 'package.json'))) {
      await step('Installing Remotion composer (npm)', 'npm', ['install', '--no-audit', '--no-fund'], rc);
      // npm 12 skips dependency install scripts; esbuild's only verifies/optimizes its binary.
      const esb = path.join(rc, 'node_modules', 'esbuild', 'install.js');
      if (fs.existsSync(esb)) await step('Finishing esbuild', process.execPath, [esb], path.dirname(esb), { optional: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    }
    log('');
  }

  /** Is the engine behind its upstream branch? */
  async checkUpdate() {
    if (!this.isRepo()) return { available: false, reason: 'not-installed' };
    const root = this.root;
    const f = await run('git', ['fetch', '--quiet', 'origin'], { cwd: root, timeout: 60000 });
    if (f.code !== 0) return { available: false, error: (f.err || 'git fetch failed').trim().slice(0, 200) };
    const behind = await run('git', ['rev-list', '--count', 'HEAD..@{u}'], { cwd: root, timeout: 10000 });
    const dirty = await run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, timeout: 10000 });
    const head = await run('git', ['log', '-1', '--format=%h %cr'], { cwd: root, timeout: 10000 });
    const n = parseInt(behind.out.trim(), 10) || 0;
    return { available: n > 0, behind: n, localChanges: !!dirty.out.trim(), head: head.out.trim(), checkedAt: Date.now() };
  }

  async update(log) {
    const root = this.root;
    const step = async (title, cmd, args, cwd, opts = {}) => {
      log(`\n▶ ${title}\n`);
      const r = await run(cmd, args, { cwd, onData: log, ...opts });
      if (r.code !== 0 && !opts.optional) throw new Error(`${title} failed (exit ${r.code})`);
      return r;
    };
    // shallow clones need --unshallow-free pulls; fetch then fast-forward
    await step('Pulling OpenMontage updates', 'git', ['pull', '--ff-only'], root);
    await this.installDeps(step, log);
    log('\n✅ OpenMontage updated.\n');
    return this.checkUpdate();
  }

  /** Read .env.example as a schema (keys + comment above) merged with current .env values. */
  readEnv() {
    const root = this.root;
    const parse = (file) => {
      const out = [];
      if (!fs.existsSync(file)) return out;
      let comment = [];
      let section = '';
      for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) { comment = []; continue; }
        const kv = line.match(/^#?\s*([A-Z][A-Z0-9_]+)\s*=\s*(.*)$/);
        if (kv && !/\s/.test(kv[1])) {
          out.push({ key: kv[1], value: kv[2].replace(/^["']|["']$/g, ''), commented: line.startsWith('#'), help: comment.join(' '), section });
          comment = [];
        } else if (line.startsWith('#')) {
          const t = line.replace(/^#+\s?/, '');
          if (/^[=\-#\s]+$/.test(t)) continue;
          if (/^[-=]{2,}|^[A-Z][A-Za-z /&()]+$/.test(t) && t.length < 60) section = t.replace(/[-=]/g, '').trim();
          else comment.push(t);
        }
      }
      return out;
    };
    const schema = parse(path.join(root, '.env.example'));
    const current = Object.fromEntries(parse(path.join(root, '.env')).filter(e => !e.commented).map(e => [e.key, e.value]));
    const keys = new Set(schema.map(s => s.key));
    const entries = schema.map(s => ({ ...s, value: current[s.key] !== undefined ? current[s.key] : '' }));
    for (const [k, v] of Object.entries(current)) if (!keys.has(k)) entries.push({ key: k, value: v, help: '', section: 'Other' });
    return entries;
  }

  /** Update only the given keys inside .env, preserving everything else. */
  writeEnv(values) {
    const file = path.join(this.root, '.env');
    let lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
    const done = new Set();
    lines = lines.map((l) => {
      const m = l.match(/^#?\s*([A-Z][A-Z0-9_]+)\s*=/);
      if (m && Object.prototype.hasOwnProperty.call(values, m[1]) && !done.has(m[1])) {
        done.add(m[1]);
        const v = values[m[1]];
        return v === '' ? (l.startsWith('#') ? l : `# ${m[1]}=`) : `${m[1]}=${/\s|#/.test(v) ? JSON.stringify(v) : v}`;
      }
      return l;
    });
    for (const [k, v] of Object.entries(values)) if (!done.has(k) && v !== '') lines.push(`${k}=${v}`);
    fs.writeFileSync(file, lines.join('\n'));
    return true;
  }

  pipelines() {
    const dir = path.join(this.root, 'pipeline_defs');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).map((f) => {
      try {
        const d = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8')) || {};
        const stages = (d.stages || []).map(s => (typeof s === 'string' ? s : s.name || s.stage)).filter(Boolean);
        return {
          id: d.name || f.replace(/\.ya?ml$/, ''), description: String(d.description || '').trim(),
          category: d.category || '', stability: d.stability || '', stages,
        };
      } catch { return { id: f.replace(/\.ya?ml$/, ''), description: '', stages: [] }; }
    }).filter(p => p.stability !== 'internal' && !/smoke/.test(p.id));
  }

  skills() {
    const base = path.join(this.root, 'skills');
    const out = [];
    const walk = (dir, rel) => {
      let items = [];
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        const p = path.join(dir, it.name);
        const r = rel ? rel + '/' + it.name : it.name;
        if (it.isDirectory()) walk(p, r);
        else if (it.name.endsWith('.md') && out.length < 1500) {
          let title = it.name.replace(/\.md$/, '');
          try {
            const head = fs.readFileSync(p, 'utf8').slice(0, 600);
            const h = head.match(/^#\s+(.+)$/m);
            if (h) title = h[1].trim();
          } catch {}
          out.push({ path: 'skills/' + r, group: r.split('/')[0], title });
        }
      }
    };
    walk(base, '');
    return out;
  }
}

module.exports = { OpenMontage, REPO_URL };
