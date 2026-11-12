// Shared helpers: login-shell PATH, command lookup, cross-platform spawn, JSON store.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IS_WIN = process.platform === 'win32';

/**
 * GUI apps on macOS/Linux don't inherit the user's shell PATH, so CLIs installed
 * through npm/nvm/brew/pipx (claude, codex, gemini...) are invisible. Ask the
 * login shell once and merge its PATH with a few well-known locations.
 */
function fixPath() {
  const extra = [];
  const home = os.homedir();
  if (IS_WIN) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    extra.push(path.join(appData, 'npm'), path.join(home, '.local', 'bin'),
      path.join(local, 'Programs', 'Python', 'Python312'), path.join(local, 'Programs', 'Python', 'Python311'));
  } else {
    try {
      const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
      const out = execFileSync(shell, ['-ilc', 'printf "__OMPATH__%s__OMPATH__" "$PATH"'], {
        encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = out.match(/__OMPATH__(.*)__OMPATH__/s);
      if (m && m[1]) extra.push(...m[1].split(':'));
    } catch { /* fall back to static list */ }
    extra.push('/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'),
      path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'),
      path.join(home, '.cargo', 'bin'), path.join(home, '.claude', 'local'));
  }
  const sep = IS_WIN ? ';' : ':';
  const parts = [...(process.env.PATH || '').split(sep), ...extra].filter(Boolean);
  process.env.PATH = [...new Set(parts)].join(sep);
}

/** Resolve a command name to an absolute path using PATH (+PATHEXT on Windows). */
function which(cmd) {
  if (!cmd) return null;
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;
  const sep = IS_WIN ? ';' : ':';
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map(e => e.toLowerCase()) : [''];
  for (const dir of (process.env.PATH || '').split(sep)) {
    if (!dir) continue;
    for (const ext of IS_WIN ? ['', ...exts] : exts) {
      const p = path.join(dir, cmd + ext);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) {
          if (IS_WIN && ext === '' && !exts.includes(path.extname(p).toLowerCase())) continue;
          return p;
        }
      } catch { /* not here */ }
    }
  }
  return null;
}

/** Quote one argument for cmd.exe (only used for .cmd/.bat shims on Windows). */
function winQuote(arg) {
  const s = String(arg);
  if (/^[\w\-./:=@\\]+$/.test(s)) return s;
  return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1').replace(/[%^&|<>!]/g, '^$&') + '"';
}

/**
 * Spawn a program with an argument array, safe on every OS.
 * npm-installed CLIs on Windows are .cmd shims, which need a shell.
 */
function spawnCmd(cmd, args, opts = {}) {
  const resolved = which(cmd) || cmd;
  if (IS_WIN && /\.(cmd|bat)$/i.test(resolved)) {
    const line = [winQuote(resolved), ...args.map(winQuote)].join(' ');
    return spawn(line, [], { ...opts, shell: true, windowsHide: true });
  }
  return spawn(resolved, args, { ...opts, windowsHide: true });
}

/** Run to completion and collect output. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try { child = spawnCmd(cmd, args, opts); } catch (e) { return resolve({ code: -1, out: '', err: String(e) }); }
    const timer = opts.timeout ? setTimeout(() => { try { child.kill(); } catch {} }, opts.timeout) : null;
    child.stdout && child.stdout.on('data', d => { out += d; if (opts.onData) opts.onData(String(d)); });
    child.stderr && child.stderr.on('data', d => { err += d; if (opts.onData) opts.onData(String(d)); });
    child.on('error', e => { if (timer) clearTimeout(timer); resolve({ code: -1, out, err: err + String(e) }); });
    child.on('close', code => { if (timer) clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/** Tiny JSON file store. */
class Store {
  constructor(file, defaults = {}) {
    this.file = file;
    this.data = { ...defaults };
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* fresh */ }
  }
  get(k, d) { return this.data[k] === undefined ? d : this.data[k]; }
  set(k, v) { this.data[k] = v; this.save(); }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

function readJSON(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function slugify(s) {
  const base = String(s || 'project').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return (/^[a-z0-9-]+$/.test(base) && base) ? base : 'project';
}

module.exports = { IS_WIN, fixPath, which, spawnCmd, run, Store, readJSON, slugify };
