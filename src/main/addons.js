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
