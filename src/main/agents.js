// Agent registry: built-in presets for popular coding-agent CLIs + user-defined agents.
// Every agent runs headless in the OpenMontage repo and streams normalized events.
const { spawnCmd, which, run, IS_WIN } = require('./util');
const path = require('path');
const crypto = require('crypto');

/**
 * Preset definition fields
 *  cmd        executable name
 *  args       argv template for a new turn. Tokens: {prompt}
 *  resumeArgs argv template when continuing a session. Tokens: {prompt} {session}
 *  autoArgs   extra argv when "auto-approve" is on (agent may edit/run without asking)
 *  format     output parser: claude-stream | codex-json | gemini-stream | text
 *  install    how to install (shown in the UI)
 *  login      argv to start an interactive login/session in the terminal
 *  version    argv to print a version
 */
const PRESETS = [
  {
    id: 'claude', modelArgs: ['--model', '{model}'], models: [
      { id: 'opus', label: 'Opus', note: 'Most capable — complex productions' },
      { id: 'sonnet', label: 'Sonnet', note: 'Fast and strong — good default' },
      { id: 'haiku', label: 'Haiku', note: 'Fastest and cheapest' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Pinned version' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Pinned version' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'Pinned version' },
      { id: 'claude-fable-5-2', label: 'Claude Fable 5.2', note: 'Mythos-tier (if your plan includes it)' },
    ],
    npm: '@anthropic-ai/claude-code', selfUpdate: ['update'], name: 'Claude Code', vendor: 'Anthropic', cmd: 'claude', color: '#d97757',
    args: ['-p', '{prompt}', '--output-format', 'stream-json', '--verbose'],
    resumeArgs: ['-p', '{prompt}', '--output-format', 'stream-json', '--verbose', '--resume', '{session}'],
    autoArgs: ['--permission-mode', 'bypassPermissions'],
    alwaysArgs: ['--disallowedTools', 'AskUserQuestion'],
    safeArgs: ['--permission-mode', 'acceptEdits'],
    format: 'claude-stream', install: 'npm install -g @anthropic-ai/claude-code', login: [], version: ['--version'],
  },
  {
    id: 'codex', modelArgs: ['-m', '{model}'], models: [],
    npm: '@openai/codex', selfUpdate: null, name: 'Codex CLI', vendor: 'OpenAI', cmd: 'codex', color: '#10a37f',
    args: ['exec', '--json', '--skip-git-repo-check', '{prompt}'],
    resumeArgs: ['exec', '--json', '--skip-git-repo-check', 'resume', '{session}', '{prompt}'],
    autoArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    safeArgs: ['--full-auto'],
    format: 'codex-json', install: 'npm install -g @openai/codex', login: ['login'], version: ['--version'],
  },
  {
    id: 'gemini', modelArgs: ['-m', '{model}'], models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
    npm: '@google/gemini-cli', selfUpdate: null, name: 'Gemini CLI', vendor: 'Google', cmd: 'gemini', color: '#4f8df5',
    args: ['-p', '{prompt}', '--output-format', 'stream-json'],
    resumeArgs: ['-p', '{prompt}', '--output-format', 'stream-json', '--resume', '{session}'],
    autoArgs: ['--yolo'], safeArgs: ['--approval-mode', 'auto_edit'],
    format: 'gemini-stream', install: 'npm install -g @google/gemini-cli', login: [], version: ['--version'],
  },
  {
    id: 'cursor', modelArgs: ['--model', '{model}'], models: [],
    name: 'Cursor Agent', vendor: 'Cursor', cmd: 'cursor-agent', color: '#e8e8e8',
    args: ['-p', '{prompt}', '--output-format', 'stream-json'],
    resumeArgs: ['-p', '{prompt}', '--output-format', 'stream-json', '--resume', '{session}'],
    autoArgs: ['--force'], safeArgs: [],
    format: 'claude-stream', install: 'curl https://cursor.com/install -fsS | bash', login: ['login'], version: ['--version'],
  },
  {
    id: 'opencode', modelArgs: ['-m', '{model}'], models: [],
    npm: 'opencode-ai', selfUpdate: null, name: 'OpenCode', vendor: 'sst', cmd: 'opencode', color: '#f5a524',
    args: ['run', '{prompt}'], resumeArgs: ['run', '--session', '{session}', '{prompt}'],
    autoArgs: [], safeArgs: [], format: 'text', install: 'npm install -g opencode-ai', login: ['auth', 'login'], version: ['--version'],
  },
  {
    id: 'copilot', modelArgs: ['--model', '{model}'], models: [],
    npm: '@github/copilot', selfUpdate: null, name: 'GitHub Copilot CLI', vendor: 'GitHub', cmd: 'copilot', color: '#8957e5',
    args: ['-p', '{prompt}'], resumeArgs: ['-p', '{prompt}', '--resume', '{session}'],
    autoArgs: ['--allow-all-tools'], safeArgs: [], format: 'text', install: 'npm install -g @github/copilot', login: [], version: ['--version'],
  },
  {
    id: 'qwen', modelArgs: ['-m', '{model}'], models: [],
    npm: '@qwen-code/qwen-code', selfUpdate: null, name: 'Qwen Code', vendor: 'Alibaba', cmd: 'qwen', color: '#615ced',
    args: ['-p', '{prompt}'], resumeArgs: ['-p', '{prompt}'],
    autoArgs: ['--yolo'], safeArgs: [], format: 'text', install: 'npm install -g @qwen-code/qwen-code', login: [], version: ['--version'],
  },
];

function newer(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
}

function whichIn(cmd, pathStr) {
  const saved = process.env.PATH;
  try { process.env.PATH = pathStr; return which(cmd); } finally { process.env.PATH = saved; }
}

function fill(tpl, vars) {
  return tpl.map(a => a.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : '')));
}

class AgentManager {
  constructor(store) {
    this.store = store;        // persists custom agents
    this.runs = new Map();     // runId -> child
  }

  all() {
    const custom = this.store.get('customAgents', []).map(a => ({ ...a, custom: true }));
    return [...PRESETS, ...custom];
  }

  get(id) { return this.all().find(a => a.id === id); }

  async detect() {
    const out = [];
    for (const a of this.all()) {
      const p = which(a.cmd);
      let version = null;
      if (p && a.version && a.version.length) {
        const r = await run(a.cmd, a.version, { timeout: 8000 });
        version = (r.out || r.err).trim().split('\n')[0].slice(0, 60) || null;
      }
      out.push({ ...a, path: p, installed: !!p, version });
    }
    return out;
  }

  saveCustom(agent) {
    const list = this.store.get('customAgents', []);
    const id = agent.id || 'custom-' + crypto.randomBytes(3).toString('hex');
    const clean = {
      id, name: agent.name || id, vendor: agent.vendor || 'Custom', cmd: agent.cmd,
      color: agent.color || '#9d62ff',
      args: agent.args && agent.args.length ? agent.args : ['{prompt}'],
      resumeArgs: agent.resumeArgs && agent.resumeArgs.length ? agent.resumeArgs : (agent.args || ['{prompt}']),
      autoArgs: agent.autoArgs || [], safeArgs: agent.safeArgs || [],
      format: agent.format || 'text', install: agent.install || '', login: agent.login || [], version: agent.version || ['--version'],
      modelArgs: agent.modelArgs && agent.modelArgs.length ? agent.modelArgs : ['--model', '{model}'], models: agent.models || [],
      env: agent.env || {},
    };
    const i = list.findIndex(a => a.id === id);
    if (i >= 0) list[i] = clean; else list.push(clean);
    this.store.set('customAgents', list);
    return clean;
  }

  removeCustom(id) {
    this.store.set('customAgents', this.store.get('customAgents', []).filter(a => a.id !== id));
  }

  /**
   * Start one agent turn. emit(event) receives normalized events:
   *  {type:'session', id} {type:'text', text} {type:'tool', name, detail}
   *  {type:'tool_result', text, isError} {type:'result', costUsd, durationMs, text}
   *  {type:'stderr', text} {type:'exit', code}
   */
  start({ agentId, prompt, cwd, session, autoApprove, env, extraArgs, model }, emit) {
    const agent = this.get(agentId);
    if (!agent) throw new Error('Unknown agent: ' + agentId);
    const vars = { prompt, session: session || '' };
    let args = fill(session ? agent.resumeArgs : agent.args, vars);
    const modelArgs = model && agent.modelArgs ? fill(agent.modelArgs, { model }) : [];
    const mode = [...fill(autoApprove ? (agent.autoArgs || []) : (agent.safeArgs || []), vars), ...modelArgs, ...(agent.alwaysArgs || []), ...(extraArgs ? extraArgs(agent) : [])];
    // Option flags must come before positional args for some CLIs (codex exec <flags> <prompt>).
    if (agent.format === 'codex-json') args = [args[0], ...mode, ...args.slice(1)];
    else args = [...args, ...mode];

    const runId = crypto.randomBytes(6).toString('hex');
    const child = spawnCmd(agent.cmd, args, {
      cwd, env: { ...process.env, ...(agent.env || {}), ...(env || {}), FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.runs.set(runId, child);
    const parser = makeParser(agent.format, emit);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { parser(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', d => emit({ type: 'stderr', text: String(d) }));
    child.on('error', e => emit({ type: 'stderr', text: `Failed to start ${agent.cmd}: ${e.message}\n` }));
    child.on('close', (code) => {
      if (buf.trim()) parser(buf);
      this.runs.delete(runId);
      emit({ type: 'exit', code });
    });
    return runId;
  }

  stop(runId) {
    const c = this.runs.get(runId);
    if (!c) return false;
    try {
      if (process.platform === 'win32') spawnCmd('taskkill', ['/pid', String(c.pid), '/T', '/F']);
      else c.kill('SIGINT');
      setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, 3000);
    } catch {}
    return true;
  }

  stopAll() { for (const id of this.runs.keys()) this.stop(id); }

  /** Compare installed CLI versions with the latest on npm. systemPath = PATH without the bundled runtime. */
  async checkUpdates(systemPath) {
    const npmCmd = whichIn('npm', systemPath) || 'npm';
    const out = [];
    for (const a of this.all()) {
      if (!a.npm || !which(a.cmd)) continue;
      const cur = await run(a.cmd, a.version || ['--version'], { timeout: 10000 });
      const installed = ((cur.out + cur.err).match(/\d+\.\d+\.\d+/) || [])[0] || null;
      const v = await run(npmCmd, ['view', a.npm, 'version'], { timeout: 20000 });
      const latest = (v.out.match(/\d+\.\d+\.\d+/) || [])[0] || null;
      out.push({ id: a.id, name: a.name, installed, latest, available: !!(installed && latest && newer(latest, installed)) });
    }
    return out;
  }

  async update(id, systemPath, log) {
    const a = this.get(id);
    if (!a) throw new Error('Unknown agent');
    if (a.selfUpdate) {
      const r = await run(a.cmd, a.selfUpdate, { onData: log, timeout: 300000 });
      if (r.code === 0) return true;
      log(`\n${a.name}: self-update failed, trying npm\n`);
    }
    if (!a.npm) throw new Error(`${a.name} has no known update command`);
    // Use the npm that installed the agent (next to it), never the bundled one.
    const agentPath = which(a.cmd);
    const sibling = agentPath && path.join(path.dirname(agentPath), IS_WIN ? 'npm.cmd' : 'npm');
    const npmCmd = (sibling && require('fs').existsSync(sibling)) ? sibling : (whichIn('npm', systemPath) || 'npm');
    const r = await run(npmCmd, ['install', '-g', `${a.npm}@latest`], { onData: log, timeout: 600000, env: { ...process.env, PATH: systemPath } });
    if (r.code !== 0) throw new Error(`npm install -g ${a.npm} failed (exit ${r.code})`);
    return true;
  }
}

function short(v, n = 140) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + '…' : (s || '');
}

function toolDetail(input) {
  if (!input || typeof input !== 'object') return short(input);
  return short(input.command || input.file_path || input.path || input.pattern || input.url || input.description || input.prompt || input);
}

function isQuestionTool(name, input) {
  return /ask.?user|question/i.test(name || '') && input && Array.isArray(input.questions);
}
function normQuestions(input) {
  return (input.questions || []).map((q, i) => ({
    id: q.id || 'q' + (i + 1), question: q.question || q.text || '', header: q.header || '',
    multi: !!(q.multiSelect || q.multi), options: (q.options || []).map((o, j) => typeof o === 'string'
      ? { key: String.fromCharCode(65 + j), label: o } : { key: o.key || String.fromCharCode(65 + j), label: o.label || o.text || '', description: o.description || '' }),
  }));
}

function makeParser(format, emit) {
  if (format === 'text') return line => emit({ type: 'text', text: line + '\n', delta: true });

  return (line) => {
    const t = line.trim();
    if (!t) return;
    let m;
    try { m = JSON.parse(t); } catch { return emit({ type: 'text', text: line + '\n', delta: true }); }

    // --- Claude Code / Cursor Agent stream-json ---
    if (m.session_id && (m.type === 'system' || m.type === 'init')) emit({ type: 'session', id: m.session_id });
    if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
      for (const c of m.message.content) {
        if (c.type === 'text' && c.text) emit({ type: 'text', text: c.text });
        else if (c.type === 'tool_use' && isQuestionTool(c.name, c.input)) emit({ type: 'question', source: 'tool', questions: normQuestions(c.input) });
        else if (c.type === 'tool_use') emit({ type: 'tool', name: c.name, detail: toolDetail(c.input) });
      }
      return;
    }
    if (m.type === 'user' && m.message && Array.isArray(m.message.content)) {
      for (const c of m.message.content) {
        if (c.type === 'tool_result') {
          const txt = Array.isArray(c.content) ? c.content.map(x => x.text || '').join('') : c.content;
          emit({ type: 'tool_result', text: short(txt, 400), isError: !!c.is_error });
        }
      }
      return;
    }
    if (m.type === 'tool_call') { // cursor-agent
      const call = m.tool_call || {};
      const k = Object.keys(call)[0];
      if (m.subtype === 'started' && k) emit({ type: 'tool', name: k.replace(/ToolCall$/, ''), detail: toolDetail((call[k] || {}).args) });
      return;
    }
    if (m.type === 'result') {
      if (m.session_id) emit({ type: 'session', id: m.session_id });
      emit({ type: 'result', costUsd: m.total_cost_usd, durationMs: m.duration_ms, isError: !!m.is_error,
        text: typeof m.result === 'string' ? m.result : '' });
      return;
    }

    // --- Codex exec --json ---
    if (m.type === 'thread.started' && m.thread_id) return emit({ type: 'session', id: m.thread_id });
    if (m.type && m.type.startsWith('item.') && m.item) {
      const it = m.item;
      const kind = it.type || it.item_type;
      if (m.type === 'item.completed' && (kind === 'agent_message' || kind === 'assistant_message')) return emit({ type: 'text', text: it.text || '' });
      if (m.type === 'item.started' && kind === 'command_execution') return emit({ type: 'tool', name: 'shell', detail: short(it.command) });
      if (m.type === 'item.completed' && kind === 'command_execution') return emit({ type: 'tool_result', text: short(it.aggregated_output || '', 400), isError: it.exit_code ? it.exit_code !== 0 : false });
      if (m.type === 'item.completed' && kind === 'file_change') return emit({ type: 'tool', name: 'edit', detail: short((it.changes || []).map(c => c.path).join(', ')) });
      if (m.type === 'item.completed' && kind === 'reasoning') return emit({ type: 'thinking', text: short(it.text || '', 300) });
      return;
    }
    if (m.type === 'turn.completed') return emit({ type: 'result', usage: m.usage });
    if (m.type === 'error' || m.type === 'turn.failed') return emit({ type: 'tool_result', isError: true, text: short(m.message || (m.error && m.error.message) || t, 400) });

    // --- Gemini CLI stream-json ---
    if (m.type === 'message' && m.role === 'assistant') return emit({ type: 'text', text: m.content || '', delta: !!m.delta });
    if (m.type === 'tool_use') return emit({ type: 'tool', name: m.tool_name || 'tool', detail: toolDetail(m.parameters) });
    if (m.type === 'tool_result') return emit({ type: 'tool_result', text: short(m.output || m.status || '', 400), isError: m.status === 'error' });

    // Unknown event: hide CLI bookkeeping (uuid/session-tagged metadata), surface anything else briefly.
    if (m.uuid || m.session_id || ['system', 'init', 'message', 'stream_event', 'rate_limit_event'].includes(m.type)) return;
    emit({ type: 'raw', text: short(t, 300) });
  };
}

module.exports = { AgentManager, PRESETS, makeParser };
