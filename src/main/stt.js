// Speech-to-text for the prompt composer.
// Local: faster-whisper in the engine venv (persistent worker, model loaded once, offline).
// Cloud: Groq / OpenAI / ElevenLabs using keys from OpenMontage's .env.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { run, IS_WIN } = require('./util');

const MODELS = {
  tiny: 'Systran/faster-whisper-tiny', base: 'Systran/faster-whisper-base', small: 'Systran/faster-whisper-small',
  medium: 'Systran/faster-whisper-medium', 'large-v3': 'Systran/faster-whisper-large-v3',
};
const KEYS = { groq: 'GROQ_API_KEY', openai: 'OPENAI_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY' };
// Vocabulary hint: helps Whisper with mixed Egyptian Arabic + English production terms.
const PROMPT = 'OpenMontage, Claude, Codex, Gemini, Remotion, HyperFrames, render, scene, script, storyboard, pipeline, voiceover, B-roll, 9:16, TikTok, Reels. ده فيديو، المشهد، السكريبت.';

const WORKER = `
import sys, json, time
from faster_whisper import WhisperModel
model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8", cpu_threads=0)
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    try:
        req = json.loads(line)
    except Exception:
        continue
    try:
        t = time.time()
        segs, info = model.transcribe(req["path"], language=req.get("language") or None, vad_filter=True,
                                      beam_size=5, initial_prompt=req.get("prompt") or None)
        text = "".join(s.text for s in segs).strip()
        print(json.dumps({"id": req["id"], "text": text, "language": info.language, "ms": int((time.time() - t) * 1000)}), flush=True)
    except Exception as e:
        print(json.dumps({"id": req["id"], "error": str(e)}), flush=True)
`;

class STT {
  constructor({ om, runtime, settings, userData }) {
    this.om = om; this.runtime = runtime; this.settings = settings;
    this.modelsDir = path.join(userData, 'models');
    this.workerFile = path.join(userData, 'stt_worker.py');
    this.worker = null; this.pending = new Map(); this.seq = 0; this.workerModel = null;
  }

  venvPython() {
    const p = path.join(this.om.root, '.venv', IS_WIN ? 'Scripts\\python.exe' : 'bin/python');
    return fs.existsSync(p) ? p : null;
  }

  modelDir(name) {
    const dirs = [];
    if (this.runtime.available) dirs.push(this.runtime.p('models', 'faster-whisper-' + name));
    dirs.push(path.join(this.modelsDir, 'faster-whisper-' + name));
    return dirs.find(d => fs.existsSync(path.join(d, 'model.bin'))) || null;
  }

  keys() {
    const env = Object.fromEntries((this.om.isRepo() ? this.om.readEnv() : []).map(e => [e.key, e.value]));
    const out = {};
    for (const [p, k] of Object.entries(KEYS)) out[p] = (env[k] || process.env[k] || '').trim();
    return out;
  }

  async localInstalled() {
    const py = this.venvPython();
    if (!py) return false;
    const r = await run(py, ['-c', 'import faster_whisper'], { timeout: 20000 });
    return r.code === 0;
  }

  async status() {
    const model = this.settings.get('sttModel', 'small');
    const keys = this.keys();
    const installed = await this.localInstalled();
    const local = { installed, model, modelPath: this.modelDir(model), models: Object.keys(MODELS), available: Object.keys(MODELS).filter(m => this.modelDir(m)) };
    local.ready = installed && !!local.modelPath;
    return {
      engine: this.settings.get('sttEngine', 'auto'), language: this.settings.get('sttLanguage', ''),
      autoSend: this.settings.get('sttAutoSend', false), local,
      cloud: { groq: !!keys.groq, openai: !!keys.openai, elevenlabs: !!keys.elevenlabs },
      resolved: await this.pick(local, keys),
    };
  }

  async pick(local, keys) {
    const engine = this.settings.get('sttEngine', 'auto');
    if (engine !== 'auto') return engine;
    if (local.ready) return 'local';
    for (const p of ['groq', 'openai', 'elevenlabs']) if (keys[p]) return p;
    return null;
  }

  /** pip install faster-whisper (offline from the bundle when possible) + download the model. */
  async enableLocal(log, model = this.settings.get('sttModel', 'small')) {
    const py = this.venvPython();
    if (!py) throw new Error('OpenMontage engine is not set up yet');
    if (!(await this.localInstalled())) {
      log('▶ Installing faster-whisper\n');
      const wheels = this.runtime.available ? this.runtime.p('wheels') : null;
      let r = wheels ? await run(py, ['-m', 'pip', 'install', '--no-index', '--find-links', wheels, '-q', 'faster-whisper'], { onData: log }) : { code: 1 };
      if (r.code !== 0) r = await run(py, ['-m', 'pip', 'install', '-q', 'faster-whisper'], { onData: log });
      if (r.code !== 0) throw new Error('Could not install faster-whisper');
    }
    if (!this.modelDir(model)) {
      const repo = MODELS[model];
      if (!repo) throw new Error('Unknown model ' + model);
      const dest = path.join(this.modelsDir, 'faster-whisper-' + model);
      fs.mkdirSync(dest, { recursive: true });
      log(`▶ Downloading Whisper "${model}" model (${repo}) — one time\n`);
      const code = `from huggingface_hub import snapshot_download\nsnapshot_download(${JSON.stringify(repo)}, local_dir=${JSON.stringify(dest)})\nprint("done")`;
      const r = await run(py, ['-c', code], { onData: log, timeout: 3600000 });
      if (r.code !== 0 || !fs.existsSync(path.join(dest, 'model.bin'))) throw new Error('Model download failed');
    }
    this.settings.set('sttModel', model);
    this.stopWorker();
    log('✅ Local voice input is ready.\n');
    return this.status();
  }

  // ---------------- local worker ----------------
  startWorker(model) {
    const py = this.venvPython();
    const dir = this.modelDir(model);
    if (!py || !dir) throw new Error('Local voice input is not set up');
    if (this.worker && this.workerModel === model) return this.workerReady;
    this.stopWorker();
    fs.writeFileSync(this.workerFile, WORKER);
    const child = spawn(py, [this.workerFile, dir], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1' } });
    this.worker = child; this.workerModel = model;
    let buf = '', err = '';
    this.workerReady = new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.ready) { resolve(); continue; }
          const p = this.pending.get(m.id);
          if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m); }
        }
      });
      child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
      child.on('close', (code) => {
        const e = new Error('Voice worker stopped' + (err ? ': ' + err.trim().split('\n').pop() : ` (exit ${code})`));
        reject(e);
        for (const p of this.pending.values()) p.reject(e);
        this.pending.clear();
        if (this.worker === child) { this.worker = null; this.workerModel = null; }
      });
    });
    return this.workerReady;
  }

  stopWorker() { if (this.worker) { try { this.worker.kill(); } catch {} this.worker = null; this.workerModel = null; } }

  async local(file, language) {
    await this.startWorker(this.settings.get('sttModel', 'small'));
    const id = ++this.seq;
    let timer;
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('Transcription timed out')); } }, 180000);
    });
    this.worker.stdin.write(JSON.stringify({ id, path: file, language, prompt: PROMPT }) + '\n');
    const r = await p;
    return r.text;
  }

  // ---------------- cloud ----------------
  async cloud(provider, file, mime, language) {
    const key = this.keys()[provider];
    if (!key) throw new Error(`${KEYS[provider]} is not set (Settings → Voice input)`);
    const blob = new Blob([fs.readFileSync(file)], { type: mime || 'audio/webm' });
    const name = 'speech.' + (/(ogg)/.test(mime) ? 'ogg' : /mp4|m4a/.test(mime) ? 'm4a' : /wav/.test(mime) ? 'wav' : 'webm');
    const form = new FormData();
    let url, headers;
    if (provider === 'elevenlabs') {
      url = 'https://api.elevenlabs.io/v1/speech-to-text';
      headers = { 'xi-api-key': key };
      form.append('model_id', this.settings.get('sttElevenModel', 'scribe_v1'));
      form.append('file', blob, name);
      if (language) form.append('language_code', language);
    } else {
      url = provider === 'groq' ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions';
      headers = { Authorization: `Bearer ${key}` };
      const model = provider === 'groq' ? this.settings.get('sttGroqModel', 'whisper-large-v3-turbo') : this.settings.get('sttOpenAIModel', 'gpt-4o-mini-transcribe');
      form.append('model', model);
      form.append('file', blob, name);
      form.append('prompt', PROMPT);
      if (language) form.append('language', language);
    }
    let res = await fetch(url, { method: 'POST', headers, body: form });
    if (!res.ok && provider === 'openai' && res.status === 400) {
      // fall back to whisper-1 if the configured model isn't available on this account
      const f2 = new FormData();
      f2.append('model', 'whisper-1'); f2.append('file', blob, name); f2.append('prompt', PROMPT);
      if (language) f2.append('language', language);
      res = await fetch(url, { method: 'POST', headers, body: f2 });
    }
    const body = await res.text();
    if (!res.ok) throw new Error(`${provider} ${res.status}: ${body.slice(0, 200)}`);
    const j = JSON.parse(body);
    return (j.text || '').trim();
  }

  async transcribe(bytes, mime) {
    const st = await this.status();
    const provider = st.resolved;
    if (!provider) {
      const e = new Error('Voice input is not set up. Open Settings → Voice input to enable the free local model or add an API key.');
      e.code = 'STT_NOT_CONFIGURED';
      throw e;
    }
    const ext = /ogg/.test(mime) ? '.ogg' : /mp4|m4a/.test(mime) ? '.m4a' : /wav/.test(mime) ? '.wav' : '.webm';
    const file = path.join(os.tmpdir(), `om-stt-${Date.now()}${ext}`);
    fs.writeFileSync(file, Buffer.from(bytes));
    const t = Date.now();
    try {
      const language = st.language || null;
      const text = provider === 'local' ? await this.local(file, language) : await this.cloud(provider, file, mime, language);
      return { text, provider, ms: Date.now() - t };
    } finally {
      fs.rm(file, { force: true }, () => {});
    }
  }
}

module.exports = { STT, MODELS };
