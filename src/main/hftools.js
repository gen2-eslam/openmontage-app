// HyperFrames tool belt inside the studio: Kokoro voices (HyperFrames' local TTS model), captions
// (transcribe), background removal, beat detection, snapshots, composition check, the block/component
// catalog, website capture, and the HyperFrames skills + a `hyperframes` command for the user's agents.
// Everything runs locally through the bundled HyperFrames CLI. Cloud/paid commands are left out.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { run, IS_WIN } = require('./util');
const { addonsDir } = require('./addons');

const KOKORO_FILES = {
  model: { name: 'kokoro-v1.0.onnx', url: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx' },
  voices: { name: 'voices-v1.0.bin', url: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin' },
};

// All 54 Kokoro-82M v1.0 voices. Grade from the model card where it matters (A/B best).
const LANGS = {
  a: { lang: 'en-us', label: 'English (US)' }, b: { lang: 'en-gb', label: 'English (UK)' }, e: { lang: 'es', label: 'Spanish' },
  f: { lang: 'fr-fr', label: 'French' }, h: { lang: 'hi', label: 'Hindi' }, i: { lang: 'it', label: 'Italian' },
  j: { lang: 'ja', label: 'Japanese' }, p: { lang: 'pt-br', label: 'Portuguese (BR)' }, z: { lang: 'cmn', label: 'Chinese' },
};
const TOP = new Set(['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'am_fenrir', 'am_puck', 'bf_emma', 'bm_george', 'bm_fable', 'ff_siwis']);
const KOKORO_VOICES = ('af_alloy af_aoede af_bella af_heart af_jessica af_kore af_nicole af_nova af_river af_sarah af_sky am_adam am_echo am_eric am_fenrir am_liam am_michael am_onyx am_puck am_santa bf_alice bf_emma bf_isabella bf_lily bm_daniel bm_fable bm_george bm_lewis ef_dora em_alex em_santa ff_siwis hf_alpha hf_beta hm_omega hm_psi if_sara im_nicola jf_alpha jf_gongitsune jf_nezumi jf_tebukuro jm_kumo pf_dora pm_alex pm_santa zf_xiaobei zf_xiaoni zf_xiaoxiao zf_xiaoyi zm_yunjian zm_yunxi zm_yunxia zm_yunyang')
  .split(' ').map((id) => {
    const L = LANGS[id[0]];
    const name = id.slice(3).replace(/^./, c => c.toUpperCase());
    return { id, name, lang: L.lang, language: L.label, gender: id[1] === 'f' ? 'female' : 'male', top: TOP.has(id) };
  });

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿ]/;

class HFTools {
  constructor({ hf, om, runtime, projects, addons, userData, log }) {
    Object.assign(this, { hf, om, runtime, projects, addons, userData, log: log || (() => {}) });
    this.catalogCache = null;
  }

  // ---------------- plumbing ----------------
  cacheDir(...p) { return path.join(process.env.HYPERFRAMES_CACHE_DIR || path.join(os.homedir(), '.cache', 'hyperframes'), ...p); }
  kokoroPaths() {
    return { model: this.cacheDir('tts', 'models', KOKORO_FILES.model.name), voices: this.cacheDir('tts', 'voices', KOKORO_FILES.voices.name) };
  }
  python() { return this.addons.venvPython(); }

  async env(needsBrowser) {
    const env = { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', NO_COLOR: '1', FORCE_COLOR: '0', PYTHONIOENCODING: 'utf-8' };
    const py = this.python(); if (py) env.HYPERFRAMES_PYTHON = py;
    if (needsBrowser) { try { const b = await this.hf.browser(() => {}); if (b) env.HYPERFRAMES_BROWSER_PATH = b; } catch {} }
    return env;
  }

  /** Run `hyperframes <args>`; resolves {code, out, err, json} (json = last JSON document printed). */
  async cli(args, { cwd, timeout = 600000, onLine, needsBrowser } = {}) {
    const node = await this.hf.node();
    const env = await this.env(needsBrowser);
    return await new Promise((resolve) => {
      const child = spawn(node, [this.hf.cliPath(), ...args], { cwd: cwd || os.tmpdir(), env, windowsHide: true });
      let out = '', err = '';
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeout);
      const feed = (buf, which) => {
        const s = String(buf);
        if (which === 'out') out += s; else err += s;
        if (onLine) for (const line of s.split(/\r?\n|\r/)) if (line.trim()) onLine(line);
      };
      child.stdout.on('data', d => feed(d, 'out'));
      child.stderr.on('data', d => feed(d, 'err'));
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err + e.message, json: null }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err, json: lastJSON(out) }); });
    });
  }

  async projectDir(projectId) { return (await this.projects.state(projectId)).dir; }
  safeIn(dir, rel) {
    const p = path.resolve(dir, rel);
    if (!p.startsWith(path.resolve(dir) + path.sep) && p !== path.resolve(dir)) throw new Error('Path outside the project');
    return p;
  }
  rel(dir, p) { return path.relative(dir, p).split(path.sep).join('/'); }
  note(projectId, text) {
    this.projects.notes = this.projects.notes || {};
    (this.projects.notes[projectId] = this.projects.notes[projectId] || []).push(text);
  }

  // ---------------- status ----------------
  async status() {
    const py = this.python();
    const k = this.kokoroPaths();
    let pkgs = false;
    if (py) pkgs = (await run(py, ['-c', 'import kokoro_onnx, soundfile'], { timeout: 30000 })).code === 0;
    let node = null; try { node = await this.hf.node(); } catch {}
    const root = this.om.root;
    return {
      cli: !!node && fs.existsSync(this.hf.cliPath()),
      kokoro: { packages: pkgs, model: fs.existsSync(k.model) && fs.existsSync(k.voices), ready: pkgs && fs.existsSync(k.model) && fs.existsSync(k.voices), installing: !!this._kokoroInstall },
      skills: !!root && fs.existsSync(path.join(root, '.claude', 'skills', 'hyperframes', 'SKILL.md')),
      shim: fs.existsSync(this.shimPath()),
    };
  }

  // ---------------- Kokoro voices ----------------
  voices() { return KOKORO_VOICES; }

  installKokoro(log = () => {}) {
    if (!this._kokoroInstall) this._kokoroInstall = this._installKokoro(log).finally(() => { this._kokoroInstall = null; });
    return this._kokoroInstall;
  }

  async _installKokoro(log) {
    const py = this.python();
    if (!py) throw new Error('OpenMontage is not set up yet');
    if ((await run(py, ['-c', 'import kokoro_onnx, soundfile'], { timeout: 30000 })).code !== 0) {
      log({ step: 'packages', message: 'Installing kokoro-onnx' });
      const wheels = this.runtime.available ? this.runtime.p('wheels') : null;
      let r = wheels ? await run(py, ['-m', 'pip', 'install', '--no-index', '--find-links', wheels, '-q', 'kokoro-onnx', 'soundfile'], { timeout: 900000 }) : { code: 1 };
      if (r.code !== 0) r = await run(py, ['-m', 'pip', 'install', '-q', 'kokoro-onnx', 'soundfile'], { timeout: 900000 });
      if (r.code !== 0) throw new Error('pip install kokoro-onnx soundfile failed: ' + (r.err || r.out).trim().split('\n').pop());
    }
    const k = this.kokoroPaths();
    const bundled = this.runtime.available ? this.runtime.p('models', 'kokoro') : null;
    for (const [key, f] of Object.entries(KOKORO_FILES)) {
      const dest = k[key];
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const src = bundled && path.join(bundled, f.name);
      if (src && fs.existsSync(src)) { log({ step: 'model', message: 'Copying ' + f.name + ' from the bundle' }); fs.copyFileSync(src, dest); continue; }
      log({ step: 'model', message: `Downloading ${f.name} (${key === 'model' ? '310' : '27'} MB, one time)` });
      await downloadTo(f.url, dest, (pct) => log({ step: 'model', message: `Downloading ${f.name}`, pct }));
    }
    log({ step: 'done', message: 'Kokoro voices ready' });
    return this.status();
  }

  /** items: [{text, out(abs), voice, speed}] → [{ok, out, duration, error}] */
  async kokoro(items, onItem = () => {}) {
    const st = await this.status();
    if (!st.kokoro.ready) await this.installKokoro();
    const py = this.python();
    const k = this.kokoroPaths();
    const script = path.join(addonsDir(), 'kokoro', 'kokoro_tts.py');
    const job = { model: k.model, voices: k.voices, items: items.map(i => ({ ...i, lang: (KOKORO_VOICES.find(v => v.id === i.voice) || {}).lang })) };
    return await new Promise((resolve, reject) => {
      const child = spawn(py, [script], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, windowsHide: true });
      const results = []; let buf = '', err = '';
      child.stdout.on('data', (d) => {
        buf += d; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          try { const j = JSON.parse(line); results.push(j); onItem(j, results.length, items.length); } catch {}
        }
      });
      child.stderr.on('data', d => { err = (err + d).slice(-3000); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (!results.length && code !== 0) reject(new Error('Kokoro failed: ' + err.trim().split('\n').pop()));
        else resolve(results);
      });
      child.stdin.end(JSON.stringify(job));
    });
  }

  /** Voice preview → WAV bytes. */
  async preview({ text, voice, speed }) {
    const out = path.join(os.tmpdir(), `om-kokoro-${Date.now()}.wav`);
    const [r] = await this.kokoro([{ text: String(text || '').slice(0, 400), out, voice: voice || 'af_heart', speed: speed || 1 }]);
    if (!r || !r.ok) throw new Error((r && r.error) || 'Kokoro failed');
    const bytes = fs.readFileSync(out);
    for (const f of [out, out + '.words.json', out.replace(/\.wav$/, '.srt')]) fs.rm(f, { force: true }, () => {});
    return bytes;
  }

  /** Engine for a narration line: Arabic → Edge TTS (Kokoro has no Arabic), else what the user picked. */
  pickEngine(text, engine, kokoroReady) {
    if (engine === 'edge') return 'edge';
    if (ARABIC.test(text || '')) return 'edge';
    if (engine === 'kokoro') return 'kokoro';
    return kokoroReady ? 'kokoro' : 'edge';
  }

  /** Text → narration file inside the project (assets/audio/…), with word timings. */
  async speak(projectId, { text, voice, speed, name }) {
    const dir = await this.projectDir(projectId);
    const base = (name || 'voice-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)).replace(/[^\w.-]+/g, '-');
    const out = path.join(dir, 'assets', 'audio', base + '.wav');
    const [r] = await this.kokoro([{ text, out, voice, speed }]);
    if (!r || !r.ok) throw new Error((r && r.error) || 'Kokoro failed');
    this.note(projectId, `The user generated a narration clip with Kokoro (${voice}): ${this.rel(dir, out)} (${r.duration}s, word timings in ${this.rel(dir, out)}.words.json). Use it where it fits.`);
    return { rel: this.rel(dir, out), duration: r.duration };
  }

  // ---------------- captions ----------------
  async transcribe(projectId, rel, { language, model } = {}, onLine) {
    const dir = await this.projectDir(projectId);
    const file = this.safeIn(dir, rel);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'om-trx-'));
    const args = ['transcribe', file, '-d', work, '--json', '--to', 'srt', '-o', file.replace(/\.[^.]+$/, '') + '.srt'];
    if (language) args.push('-l', language);
    args.push('-m', model || (language && language !== 'en' ? 'small' : 'base.en'));
    const r = await this.cli(args, { cwd: work, timeout: 1800000, onLine });
    const j = r.json;
    if (!j || j.ok === false) throw new Error((j && j.error && j.error.message) || lastLine(r.err || r.out) || 'Transcription failed');
    let words = [];
    try {
      const t = JSON.parse(fs.readFileSync(j.transcriptPath || path.join(work, 'transcript.json'), 'utf8'));
      words = (Array.isArray(t) ? t : (t.words || t.segments || [])).map(w => ({ text: w.text || w.word, start: w.start, end: w.end })).filter(w => w.text != null);
    } catch {}
    if (words.length) fs.writeFileSync(file + '.words.json', JSON.stringify({ engine: 'hyperframes-transcribe', words }, null, 1));
    fs.rmSync(work, { recursive: true, force: true });
    return { words: words.length, srt: this.rel(dir, file.replace(/\.[^.]+$/, '') + '.srt'), wordsFile: words.length ? this.rel(dir, file + '.words.json') : null };
  }

  // ---------------- media ----------------
  async removeBackground(projectId, rel, { format } = {}, onLine) {
    const dir = await this.projectDir(projectId);
    const file = this.safeIn(dir, rel);
    const isImg = /\.(png|jpe?g|webp)$/i.test(file);
    const ext = format || (isImg ? 'png' : 'webm');
    const out = path.join(dir, 'assets', 'cutouts', path.basename(file).replace(/\.[^.]+$/, '') + '-cutout.' + ext);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const r = await this.cli(['remove-background', file, '-o', out, '--json'], { cwd: dir, timeout: 3600000, onLine });
    if (!fs.existsSync(out)) throw new Error(errOf(r) || 'Background removal failed');
    this.note(projectId, `The user removed the background of ${rel} → ${this.rel(dir, out)} (transparent ${ext}).`);
    return { rel: this.rel(dir, out) };
  }

  async beats(projectId, rel) {
    const dir = await this.projectDir(projectId);
    const file = this.safeIn(dir, rel);
    const r = await this.cli(['beats', file, '--json'], { cwd: dir, timeout: 600000 });
    if (r.code !== 0 && !r.json) throw new Error(errOf(r) || 'Beat detection failed');
    const j = r.json || {};
    const beats = j.beats || (j.results && j.results[0] && j.results[0].beats) || [];
    const bpm = j.bpm || (j.results && j.results[0] && j.results[0].bpm) || null;
    return { bpm, beats: Array.isArray(beats) ? beats.length : 0, raw: j };
  }

  async compositionDir(projectId, { create } = {}) {
    const dir = await this.projectDir(projectId);
    let comp = this.hf.agentComposition(dir);
    if (!comp && create) {
      comp = path.join(dir, 'hyperframes');
      fs.mkdirSync(comp, { recursive: true });
      if (!fs.existsSync(path.join(comp, 'index.html'))) {
        fs.writeFileSync(path.join(comp, 'index.html'), '<!doctype html>\n<html><head><meta charset="utf-8"></head><body>\n<div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="10"></div>\n</body></html>\n');
      }
      if (!fs.existsSync(path.join(comp, 'hyperframes.json'))) fs.writeFileSync(path.join(comp, 'hyperframes.json'), JSON.stringify({ name: path.basename(dir) }, null, 2));
    }
    return { dir, comp };
  }

  /** Key frames of what the player shows (agent composition, else the draft cut). */
  async snapshot(projectId, { frames = 6 } = {}) {
    const { dir } = await this.compositionDir(projectId);
    const pv = await this.hf.preview(projectId);
    const compDir = path.join(dir, path.dirname(pv.rel.endsWith('.html') ? pv.rel : pv.rel + '/index.html'));
    const out = path.join(dir, '.studio', 'snapshots', String(Date.now()));
    const r = await this.cli(['snapshot', compDir, '-o', out, '--frames', String(frames), '--json'], { cwd: compDir, timeout: 600000, needsBrowser: true });
    const files = fs.existsSync(out) ? fs.readdirSync(out).filter(f => /\.(png|jpe?g)$/i.test(f)).sort(naturally) : [];
    if (!files.length) throw new Error(errOf(r) || 'Snapshot failed');
    return { files: files.map(f => this.rel(dir, path.join(out, f))) };
  }

  /** Lint + runtime validation + layout inspection on the agent's composition. */
  async check(projectId) {
    const { comp } = await this.compositionDir(projectId);
    if (!comp) return { ok: true, none: true, issues: [] };
    const r = await this.cli(['check', comp, '--json'], { cwd: comp, timeout: 600000, needsBrowser: true });
    const j = r.json || {};
    const issues = [];
    const walk = (x) => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) return x.forEach(walk);
      if ((x.message || x.msg) && (x.severity || x.level || x.code || x.rule)) issues.push({ severity: x.severity || x.level || 'error', code: x.code || x.rule || '', message: x.message || x.msg, fix: x.fix || x.hint || '' });
      for (const v of Object.values(x)) if (v && typeof v === 'object') walk(v);
    };
    walk(j);
    return { ok: j.ok !== false && r.code === 0, issues: issues.slice(0, 80), raw: issues.length ? null : (r.json ? null : lastLine(r.err || r.out)) };
  }

  // ---------------- catalog ----------------
  async catalog() {
    if (this.catalogCache) return this.catalogCache;
    const r = await this.cli(['catalog', '--json'], { timeout: 120000 });
    const list = Array.isArray(r.json) ? r.json : [];
    if (!list.length) throw new Error(errOf(r) || 'Could not load the HyperFrames catalog');
    return (this.catalogCache = list);
  }

  async addBlock(projectId, name) {
    const { dir, comp } = await this.compositionDir(projectId, { create: true });
    const r = await this.cli(['add', name, '--dir', comp, '--no-clipboard', '--json'], { cwd: comp, timeout: 300000 });
    const j = r.json;
    if (!j || j.ok === false) throw new Error((j && j.error && (j.error.message || j.error)) || errOf(r) || 'Install failed');
    const written = (j.written || []).map(f => this.rel(dir, f));
    this.note(projectId, `The user installed the HyperFrames ${j.typeDir === 'components' ? 'component' : 'block'} "${name}" into ${this.rel(dir, comp)} (${written.join(', ')}). `
      + (j.snippet ? `Mount it in the root composition with: ${j.snippet}` : '') + ' Place it where it serves the story, set data-start, and re-check with `hyperframes check`.');
    return { name, written, snippet: j.snippet || null };
  }

  async capture(projectId, url, onLine) {
    if (!/^https?:\/\//i.test(url)) throw new Error('Enter a full http(s) URL');
    const dir = await this.projectDir(projectId);
    const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'site'; } })();
    const out = path.join(dir, 'assets', 'capture', host.replace(/[^\w.-]+/g, '-'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const r = await this.cli(['capture', url, '-o', out, '--json', '--skip-vision'], { cwd: path.dirname(out), timeout: 900000, onLine, needsBrowser: true });
    if (!fs.existsSync(out)) throw new Error(errOf(r) || 'Capture failed');
    const shots = listFiles(out, /\.(png|jpe?g|webp)$/i, 3).slice(0, 24).map(f => this.rel(dir, f));
    this.note(projectId, `The user captured ${url} into ${this.rel(dir, out)} (screenshots, assets, design tokens). Use these real screens and brand assets instead of drawing them.`);
    return { dir: this.rel(dir, out), shots };
  }

  // ---------------- agents: skills + command ----------------
  shimDir() { return path.join(this.userData, 'bin'); }
  shimPath() { return path.join(this.shimDir(), IS_WIN ? 'hyperframes.cmd' : 'hyperframes'); }

  /** A `hyperframes` command for agent shells (bundled Node 22 + CLI, telemetry off, local Python). */
  async ensureShim() {
    let node; try { node = await this.hf.node(); } catch { return null; }
    const cli = this.hf.cliPath();
    fs.mkdirSync(this.shimDir(), { recursive: true });
    const py = this.python();
    let body;
    if (IS_WIN) {
      body = `@echo off\r\nset HYPERFRAMES_NO_TELEMETRY=1\r\n${py ? `if not defined HYPERFRAMES_PYTHON set "HYPERFRAMES_PYTHON=${py}"\r\n` : ''}"${node}" "${cli}" %*\r\n`;
    } else {
      body = `#!/bin/sh\nexport HYPERFRAMES_NO_TELEMETRY=1\n${py ? `: "\${HYPERFRAMES_PYTHON:=${py}}"; export HYPERFRAMES_PYTHON\n` : ''}exec "${node}" "${cli}" "$@"\n`;
    }
    const p = this.shimPath();
    if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== body) { fs.writeFileSync(p, body); if (!IS_WIN) fs.chmodSync(p, 0o755); }
    return this.shimDir();
  }

  /** Env additions for agent runs. */
  agentEnv() {
    const out = { HYPERFRAMES_NO_TELEMETRY: '1' };
    if (fs.existsSync(this.shimPath())) out.PATH = this.shimDir() + (IS_WIN ? ';' : ':') + (process.env.PATH || '');
    const py = this.python(); if (py) out.HYPERFRAMES_PYTHON = py;
    if (this.hf.browserPath) out.HYPERFRAMES_BROWSER_PATH = this.hf.browserPath;
    return out;
  }

  /** Copy the skills that ship inside the HyperFrames package into the engine for every agent. */
  installSkills() {
    const root = this.om.root;
    if (!root || !fs.existsSync(root)) return false;
    const src = path.join(path.dirname(this.hf.cliPath()).replace(/[\\/]bin$/, path.sep + 'dist'), 'skills');
    if (!fs.existsSync(src)) return false;
    for (const d of ['.claude/skills', '.agents/skills']) {
      for (const name of fs.readdirSync(src)) {
        copyTreeRewrite(path.join(src, name), path.join(root, d, name));
      }
    }
    return true;
  }

  async ensure() {
    try { await this.ensureShim(); } catch (e) { this.log(`⚠ hyperframes command: ${e.message}\n`); }
    try { this.installSkills(); } catch (e) { this.log(`⚠ HyperFrames skills: ${e.message}\n`); }
  }
}

// `npx hyperframes` would try the network; the studio puts `hyperframes` on the agent's PATH.
function copyTreeRewrite(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(src)) if (!/\.test\.m?js$/.test(f)) copyTreeRewrite(path.join(src, f), path.join(dest, f));
    return;
  }
  if (/\.(md|mdx)$/i.test(src)) {
    const txt = fs.readFileSync(src, 'utf8').replace(/\bnpx\s+(-y\s+)?hyperframes@?[\w.]*\b/g, 'hyperframes')
      .replace(/run `hyperframes events --skill=[\w-]+` once as this skill starts\.[^\n]*/g, 'telemetry is off in OpenMontage Studio; skip the usage beacon.');
    if (!fs.existsSync(dest) || fs.readFileSync(dest, 'utf8') !== txt) fs.writeFileSync(dest, txt);
  } else if (!fs.existsSync(dest) || fs.statSync(dest).size !== st.size) fs.copyFileSync(src, dest);
}

function lastJSON(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch {}
  // last top-level {...} or [...] block
  for (const open of ['{', '[']) {
    let i = s.lastIndexOf('\n' + open);
    while (i >= 0) { try { return JSON.parse(s.slice(i + 1)); } catch {} i = s.lastIndexOf('\n' + open, i - 1); }
    if (s[0] === open) { try { return JSON.parse(s); } catch {} }
  }
  const lines = s.split('\n').reverse();
  for (const l of lines) { const t = l.trim(); if (/^[{[]/.test(t)) { try { return JSON.parse(t); } catch {} } }
  return null;
}
function lastLine(s) { return String(s || '').trim().split('\n').map(x => x.trim()).filter(Boolean).pop() || ''; }
function errOf(r) {
  const j = r && r.json;
  if (j && j.error) return typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error));
  return lastLine((r && (r.err || r.out)) || '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 300);
}
function naturally(a, b) { return a.localeCompare(b, undefined, { numeric: true }); }
function listFiles(dir, re, depth) {
  const out = [];
  const walk = (d, n) => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && n < depth) walk(p, n + 1); else if (re.test(e.name)) out.push(p);
    }
  };
  walk(dir, 0);
  return out.sort(naturally);
}

async function downloadTo(url, dest, onPct) {
  const tmp = dest + '.part';
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const fh = fs.createWriteStream(tmp);
  let got = 0, last = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!fh.write(Buffer.from(value))) await new Promise(r => fh.once('drain', r));
    const pct = total ? Math.floor(got / total * 100) : 0;
    if (pct !== last) { last = pct; onPct && onPct(pct); }
  }
  await new Promise((r, j) => fh.end((e) => e ? j(e) : r()));
  fs.renameSync(tmp, dest);
}

module.exports = { HFTools, KOKORO_VOICES };
