// Add-ons shipped with the app and installed into the OpenMontage engine:
//   Edge TTS — tools/audio/edge_tts.py (registry tool) + skill + MCP server for every agent.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { run, IS_WIN } = require('./util');

const SERVER = 'openmontage-studio';

function addonsDir() {
  // python can't read inside app.asar → files are asar-unpacked in packaged builds
  return path.join(__dirname, '..', 'addons').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

function writeIfChanged(file, content) {
  try { if (fs.readFileSync(file, 'utf8') === content) return false; } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
}

function mergeJSON(file, mutate) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const before = JSON.stringify(data);
  mutate(data);
  if (JSON.stringify(data) !== before) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
}

class Addons {
  constructor({ om, runtime, projects, userData }) {
    this.om = om; this.runtime = runtime; this.projects = projects;
    this.mcpDir = path.join(userData, 'mcp');
    this.state = { edgeTts: { tool: false, packages: false, mcp: false, error: null } };
  }

  venvPython() {
    const p = path.join(this.om.root, '.venv', IS_WIN ? 'Scripts\\python.exe' : 'bin/python');
    return fs.existsSync(p) ? p : null;
  }

  serverSpec() {
    const py = this.venvPython();
    if (!py) return null;
    return { command: py, args: [path.join(addonsDir(), 'edge_tts', 'mcp_server.py'), this.om.root, this.projects.dir] };
  }

  /** Idempotent: run on launch, after setup and after every engine update. */
  ensure(log = () => {}) {
    if (!this._running) this._running = this._ensure(log).finally(() => { this._running = null; });
    return this._running;
  }

  async _ensure(log) {
    const root = this.om.root;
    const st = this.state.edgeTts;
    st.error = null;
    if (!this.om.isRepo()) return this.state;
    try {
      const src = path.join(addonsDir(), 'edge_tts');
      // 1) registry tool + skill (Claude reads .claude/skills, others .agents/skills)
      writeIfChanged(path.join(root, 'tools', 'audio', 'edge_tts.py'), fs.readFileSync(path.join(src, 'edge_tts_tool.py'), 'utf8'));
      const skill = fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8');
      for (const d of ['.claude/skills', '.agents/skills']) writeIfChanged(path.join(root, d, 'edge-tts', 'SKILL.md'), skill);
      st.tool = true;
      // 2) python packages
      const py = this.venvPython();
      if (py) {
        const check = await run(py, ['-c', 'import edge_tts, mcp'], { timeout: 30000 });
        if (check.code !== 0) {
          log('▶ Installing Edge TTS add-on (edge-tts, mcp)\n');
          const wheels = this.runtime.available ? this.runtime.p('wheels') : null;
          let r = wheels ? await run(py, ['-m', 'pip', 'install', '--no-index', '--find-links', wheels, '-q', 'edge-tts', 'mcp'], { onData: log }) : { code: 1 };
          if (r.code !== 0) r = await run(py, ['-m', 'pip', 'install', '-q', 'edge-tts', 'mcp'], { onData: log });
          if (r.code !== 0) throw new Error('pip install edge-tts mcp failed');
        }
        st.packages = true;
      }
      // 3) MCP registration for agents that read project/user config files
      const spec = this.serverSpec();
      if (spec) {
        fs.mkdirSync(this.mcpDir, { recursive: true });
        writeIfChanged(this.claudeConfig(), JSON.stringify({ mcpServers: { [SERVER]: { type: 'stdio', ...spec } } }, null, 2));
        const std = (d) => { d.mcpServers = d.mcpServers || {}; d.mcpServers[SERVER] = { ...spec, trust: true }; };
        mergeJSON(path.join(root, '.gemini', 'settings.json'), std);   // Gemini CLI
        mergeJSON(path.join(root, '.qwen', 'settings.json'), std);     // Qwen Code
        mergeJSON(path.join(root, '.cursor', 'mcp.json'), (d) => { d.mcpServers = d.mcpServers || {}; d.mcpServers[SERVER] = spec; }); // Cursor Agent
        mergeJSON(path.join(root, 'opencode.json'), (d) => {          // OpenCode
          d.$schema = d.$schema || 'https://opencode.ai/config.json';
          d.mcp = d.mcp || {};
          d.mcp[SERVER] = { type: 'local', command: [spec.command, ...spec.args], enabled: true };
        });
        st.mcp = true;
      }
    } catch (e) {
      st.error = e.message;
      log(`⚠ Edge TTS add-on: ${e.message}\n`);
    }
    return this.state;
  }

  claudeConfig() { return path.join(this.mcpDir, 'claude-mcp.json'); }

  /** Per-run CLI flags that attach the MCP server (for agents configured by flags). */
  agentArgs(agent) {
    const spec = this.state.edgeTts.mcp && this.serverSpec();
    if (!spec || !agent) return [];
    if (agent.id === 'claude') return ['--mcp-config', this.claudeConfig()];
    if (agent.id === 'codex') {
      const key = 'mcp_servers.openmontage_studio';
      return ['-c', `${key}.command=${JSON.stringify(spec.command)}`, '-c', `${key}.args=${JSON.stringify(spec.args)}`];
    }
    return [];
  }


  /** Narration files the asset manifest promises but that don't exist on disk. */
  missingVoice(state) {
    const A = state.artifacts || {};
    const manifest = (A.asset_manifest && A.asset_manifest.assets) || [];
    const scenes = (state.storyboard && state.storyboard.scenes) || [];
    const sections = (A.script && A.script.sections) || [];
    const planScenes = (A.scene_plan && A.scene_plan.scenes) || [];
    return manifest.filter(a => /narration|voice/i.test(a.type || '') && a.path && !fs.existsSync(path.join(state.dir, a.path)))
      .map((a, i) => {
        const sc = scenes.find(s => s.id === a.scene_id) || {};
        const plan = planScenes.find(s => s.id === a.scene_id) || {};
        const sec = sections.find(x => x.id === (plan.script_section || sc.script_section) || x.scene_id === a.scene_id)
          || sections.find(x => typeof x.start_seconds === 'number' && typeof sc.start_seconds === 'number' && x.start_seconds <= sc.start_seconds && sc.start_seconds < x.end_seconds)
          || sections[i];
        const text = (a.text || a.script || sc.narration || (sec && sec.text) || plan.narration || '').trim();
        return { id: a.id, scene_id: a.scene_id, path: a.path, text, provider: a.provider || a.source_tool || '' };
      });
  }

  /**
   * Generate missing narration at the manifest paths (+ word timings for captions).
   * engine: 'auto' (Kokoro when installed, Edge for Arabic lines) | 'kokoro' | 'edge'.
   * Kokoro (HyperFrames' local model) has no Arabic, so Arabic lines always go to Edge TTS.
   */
  async fixVoice(state, { engine = 'auto', dialect = 'egyptian', gender = 'male', voice, rate, kokoroVoice, speed } = {}, onProgress = () => {}) {
    const py = this.venvPython();
    if (!py) throw new Error('OpenMontage is not set up yet');
    await this.ensure();
    const missing = this.missingVoice(state).filter(m => m.text);
    if (!missing.length) return { generated: 0 };
    let kokoroReady = false;
    if (this.hft && engine !== 'edge') {
      try { kokoroReady = (await this.hft.status()).kokoro.ready; } catch {}
      if (!kokoroReady && engine === 'kokoro') {
        onProgress({ done: 0, total: missing.length, current: 'Installing Kokoro voices (one time)' });
        await this.hft.installKokoro((p) => onProgress({ done: 0, total: missing.length, current: p.message + (p.pct ? ` ${p.pct}%` : '') }));
        kokoroReady = true;
      }
    }
    const plan = missing.map(m => ({ ...m, engine: this.hft ? this.hft.pickEngine(m.text, engine, kokoroReady) : 'edge' }));
    let done = 0;
    const fails = [];
    const used = new Set();

    // 1) Kokoro lines, one model load for all of them
    const kItems = plan.filter(m => m.engine === 'kokoro');
    if (kItems.length) {
      const kv = kokoroVoice || (gender === 'female' ? 'af_heart' : 'am_michael');
      onProgress({ done, total: missing.length, current: kItems[0].path });
      const jobs = kItems.map(m => {
        const out = path.join(state.dir, m.path);
        return { m, out, wav: /\.wav$/i.test(out) ? out : out.replace(/\.\w+$/, '') + '.kokoro.wav' };
      });
      const res = await this.hft.kokoro(jobs.map(j => ({ text: j.m.text, out: j.wav, voice: kv, speed: speed || 1 })),
        (r, n) => onProgress({ done: done + n, total: missing.length, current: (jobs[n] && jobs[n].m.path) || null }));
      for (const j of jobs) {
        const r = res.find(x => x.out === j.wav);
        if (!r || !r.ok || !fs.existsSync(j.wav)) { fails.push(`${j.m.path}: ${(r && r.error) || 'Kokoro failed'}`); continue; }
        if (j.wav !== j.out) {
          const c = await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', j.wav, j.out], { timeout: 120000 });
          if (c.code !== 0) { fails.push(`${j.m.path}: ffmpeg ${c.err.slice(-120)}`); continue; }
          try { fs.renameSync(j.wav + '.words.json', j.out + '.words.json'); } catch {}
          for (const f of [j.wav, j.wav.replace(/\.wav$/, '.srt')]) fs.rm(f, { force: true }, () => {});
        }
        j.m.done = true; done++; used.add(`kokoro (${kv})`);
      }
    }

    // 2) Edge TTS lines
    for (const m of plan.filter(x => x.engine === 'edge')) {
      onProgress({ done, total: missing.length, current: m.path });
      const out = path.join(state.dir, m.path);
      const args = ['-m', 'tools.audio.edge_tts', 'synth', '--text', m.text, '--out', out.replace(/\.\w+$/, '.mp3')];
      if (voice) args.push('--voice', voice); else args.push('--dialect', dialect, '--gender', gender);
      if (rate) args.push('--rate', rate);
      const r = await run(py, args, { cwd: this.om.root, timeout: 120000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      const mp3 = out.replace(/\.\w+$/, '.mp3');
      if (r.code === 0 && fs.existsSync(mp3)) {
        if (mp3 !== out) { // manifest asked for .wav etc → convert so the path stays valid
          await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp3, out], { timeout: 120000 });
          try { fs.renameSync(mp3 + '.words.json', out + '.words.json'); } catch {}
        }
        m.done = true; done++; used.add(`edge_tts (${voice || dialect + ' ' + gender})`);
      } else fails.push(`${m.path}: ${(r.err || r.out).trim().split('\n').pop()}`);
    }
    onProgress({ done, total: missing.length, current: null });
    // record what really produced the files, so the next agent turn and the review see the truth
    try {
      const mf = path.join(state.dir, 'artifacts', 'asset_manifest.json');
      const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
      for (const a of j.assets || []) {
        const m = plan.find(x => x.path === a.path && x.done);
        if (!m) continue;
        const tool = m.engine === 'kokoro' ? 'hyperframes_kokoro' : 'edge_tts';
        a.provider = tool; a.source_tool = tool; a.generated_by = 'OpenMontage Studio (missing narration repair)';
      }
      fs.writeFileSync(mf, JSON.stringify(j, null, 2));
    } catch {}
    this.projects.notes = this.projects.notes || {};
    (this.projects.notes[state.project_id] = this.projects.notes[state.project_id] || []).push(
      `${done} narration file(s) listed in asset_manifest.json were missing on disk (the planned TTS provider never produced them). The studio generated them with ${[...used].join(' + ')} at the same paths, with .words.json timings. Verify durations before compose.`);
    if (fails.length) throw new Error(`${done}/${missing.length} generated. Failed: ${fails.slice(0, 3).join(' | ')}`);
    return { generated: done, engines: [...used] };
  }

  /** Short voice preview for the settings page. Returns MP3 bytes. */
  async preview({ text, voice, dialect, gender, rate }) {
    const py = this.venvPython();
    if (!py) throw new Error('OpenMontage is not set up yet');
    const out = path.join(os.tmpdir(), `om-tts-preview-${Date.now()}.mp3`);
    const args = ['-m', 'tools.audio.edge_tts', 'synth', '--text', String(text || '').slice(0, 600), '--out', out];
    if (voice) args.push('--voice', voice);
    if (dialect) args.push('--dialect', dialect);
    if (gender) args.push('--gender', gender);
    if (rate) args.push('--rate', rate);
    const r = await run(py, args, { cwd: this.om.root, timeout: 60000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    if (r.code !== 0 || !fs.existsSync(out)) throw new Error((r.err || r.out || 'Edge TTS failed').trim().split('\n').pop());
    const bytes = fs.readFileSync(out);
    for (const f of [out, out + '.words.json', out.replace(/\.mp3$/, '.srt')]) fs.rm(f, { force: true }, () => {});
    return bytes;
  }

  async voices(lang) {
    const py = this.venvPython();
    if (!py) return [];
    const r = await run(py, ['-m', 'tools.audio.edge_tts', 'voices', '--lang', lang || 'ar'], { cwd: this.om.root, timeout: 30000 });
    try { return JSON.parse(r.out); } catch { return []; }
  }
}

module.exports = { Addons, addonsDir };
