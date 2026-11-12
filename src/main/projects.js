// Project state. Primary source: OpenMontage's own backlot.state (exact parity with
// the Backlot board). Fallback: a Node reader of the same on-disk contract.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { run, readJSON, slugify } = require('./util');

const MEDIA_EXT = {
  video: ['.mp4', '.mov', '.webm', '.mkv'],
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'],
};
const kindOf = (f) => Object.keys(MEDIA_EXT).find(k => MEDIA_EXT[k].includes(path.extname(f).toLowerCase()));

const PY_BRIDGE = `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from backlot.state import load_board_state, list_projects
mode = sys.argv[2]
if mode == 'list':
    out = list_projects(Path(sys.argv[3]))
else:
    out = load_board_state(Path(sys.argv[3]))
sys.stdout.write('__OMJSON__' + json.dumps(out, default=str))
`;

class Projects {
  constructor(om, store) {
    this.om = om;
    this.store = store;      // layout positions, chat sessions
    this.pyOk = null;        // null = unknown, false = bridge unavailable
    this.watcher = null;
    this.watchTimers = new Map();
  }

  get dir() { return this.om.projectsDir(); }

  async _py(mode, target) {
    if (this.pyOk === false || !this.om.isRepo()) return null;
    const r = await run(this.om.python(), ['-c', PY_BRIDGE, this.om.root, mode, target], {
      cwd: this.om.root, timeout: 20000,
      env: { ...process.env, OPENMONTAGE_PROJECTS_DIR: this.dir, PYTHONIOENCODING: 'utf-8' },
    });
    const i = r.out.indexOf('__OMJSON__');
    if (r.code === 0 && i >= 0) {
      this.pyOk = true;
      try { return JSON.parse(r.out.slice(i + 10)); } catch { return null; }
    }
    if (this.pyOk === null && /ModuleNotFoundError|No module named|not found|ENOENT/i.test(r.err + r.out)) this.pyOk = false;
    return null;
  }

  async list() {
    if (!fs.existsSync(this.dir)) return [];
    const viaPy = await this._py('list', this.dir);
    const list = Array.isArray(viaPy) ? viaPy : this._listNode();
    return list.map(p => ({ ...p, dir: path.join(this.dir, p.project_id) }))
      .sort((a, b) => (b.last_activity || 0) - (a.last_activity || 0));
  }

  async state(id) {
    const dir = path.join(this.dir, id);
    if (!fs.existsSync(dir)) throw new Error('Project not found: ' + id);
    const viaPy = await this._py('state', dir);
    const s = viaPy && viaPy.project_id ? viaPy : this._stateNode(dir);
    s.dir = dir;
    s.files = this._files(dir);
    s.layout = (this.store.get('layouts', {})[id]) || {};
    s.source = viaPy ? 'backlot' : 'node';
    return s;
  }

  /** Create the folder + project.json marker so the agent works in a known project id. */
  create({ title, pipeline }) {
    fs.mkdirSync(this.dir, { recursive: true });
    let id = slugify(title);
    let n = 2;
    while (fs.existsSync(path.join(this.dir, id))) id = `${slugify(title)}-${n++}`;
    const dir = path.join(this.dir, id);
    fs.mkdirSync(dir, { recursive: true });
    const marker = { version: '1.0', created_at: new Date().toISOString(), project_id: id, title: title || id };
    if (pipeline) marker.pipeline_type = pipeline;
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(marker, null, 2));
    return { id, dir };
  }

  /** Agents sometimes pass projects/<id> as pipeline_dir, writing projects/<id>/<id>/checkpoint_*.json. Move them to the canonical place. */
  repairNested(id) {
    const dir = path.join(this.dir, id);
    const nested = path.join(dir, id);
    let moved = 0;
    try {
      if (!fs.existsSync(nested) || !fs.statSync(nested).isDirectory()) return 0;
      for (const f of fs.readdirSync(nested)) {
        const src = path.join(nested, f);
        if (/^checkpoint_.+\.json$|^decision_log\.json$/.test(f)) {
          const dest = path.join(dir, f);
          const srcT = fs.statSync(src).mtimeMs, destT = fs.existsSync(dest) ? fs.statSync(dest).mtimeMs : 0;
          if (srcT >= destT) fs.renameSync(src, dest); else fs.unlinkSync(src);
          moved++;
        } else if (f === 'history' && fs.statSync(src).isDirectory()) {
          fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
          for (const g of fs.readdirSync(src)) { const d = path.join(dir, 'history', g); if (!fs.existsSync(d)) fs.renameSync(path.join(src, g), d); }
          try { fs.rmdirSync(src); } catch {}
        }
      }
      try { fs.rmdirSync(nested); } catch {}
    } catch { return moved; }
    if (moved) {
      this.notes = this.notes || {};
      (this.notes[id] = this.notes[id] || []).push(`Your checkpoints were written to projects/${id}/${id}/ (wrong pipeline_dir). The studio moved them to projects/${id}/. From now on pass lib.checkpoint.PROJECTS_DIR as pipeline_dir.`);
    }
    return moved;
  }

  takeNotes(id) {
    const n = (this.notes && this.notes[id]) || [];
    if (this.notes) delete this.notes[id];
    return n;
  }

  saveLayout(id, layout) {
    const all = this.store.get('layouts', {});
    all[id] = layout;
    this.store.set('layouts', all);
  }

  /** Small edits from the inspector: patch a JSON artifact at a dotted path, or write a text file. */
  patchArtifact(id, file, pointer, value) {
    const p = this._safe(id, file);
    const data = readJSON(p);
    if (!data) throw new Error('Cannot read ' + file);
    const keys = pointer.split('.');
    let o = data;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = /^\d+$/.test(keys[i]) ? +keys[i] : keys[i];
      if (o[k] === undefined) throw new Error('Bad path ' + pointer);
      o = o[k];
    }
    o[/^\d+$/.test(keys.at(-1)) ? +keys.at(-1) : keys.at(-1)] = value;
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
    return true;
  }

  readText(id, file) { return fs.readFileSync(this._safe(id, file), 'utf8'); }
  writeText(id, file, text) { fs.writeFileSync(this._safe(id, file), text); return true; }

  /** Copy user files into projects/<id>/inputs so the agent can use them. */
  importFiles(id, files) {
    const dest = path.join(this.dir, id, 'inputs');
    fs.mkdirSync(dest, { recursive: true });
    return files.map((f) => {
      let name = path.basename(f);
      let target = path.join(dest, name);
      let n = 1;
      while (fs.existsSync(target)) { target = path.join(dest, name.replace(/(\.[^.]+)?$/, `-${n++}$1`)); }
      fs.copyFileSync(f, target);
      return path.relative(path.join(this.dir, id), target).split(path.sep).join('/');
    });
  }

  _safe(id, rel) {
    const base = path.resolve(this.dir, id);
    const p = path.resolve(base, rel);
    if (!p.startsWith(base + path.sep)) throw new Error('Path escapes project');
    return p;
  }

  /** Watch projects/ and call onChange(projectId) (debounced per project). */
  watch(onChange) {
    if (this.watcher) { try { this.watcher.close(); } catch {} this.watcher = null; }
    // Don't create folders before OpenMontage exists (it would block a clean install there).
    if (!fs.existsSync(this.dir)) return;
    try {
      this.watcher = fs.watch(this.dir, { recursive: true }, (_ev, file) => {
        if (!file) return;
        const id = String(file).split(/[\\/]/)[0];
        if (!id || id.startsWith('.')) return;
        clearTimeout(this.watchTimers.get(id));
        this.watchTimers.set(id, setTimeout(() => onChange(id), 400));
      });
      this.watcher.on('error', () => {});
    } catch { /* recursive watch unsupported — renderer also polls */ }
  }

  // ---------------- Node fallback reader (same on-disk contract) ----------------

  _listNode() {
    return fs.readdirSync(this.dir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => {
        const s = this._stateNode(path.join(this.dir, d.name));
        const stages = s.stages || [];
        return {
          project_id: d.name, title: s.title, series: s.series, pipeline_type: s.pipeline.pipeline_type,
          has_pipeline_state: s.has_pipeline_state, poster: s.poster, live: s.live, last_activity: s.last_activity,
          active_stage: (stages.find(x => x.status === 'in_progress') || {}).name || null,
          awaiting_human: stages.some(x => x.status === 'awaiting_human'),
          stage_states: stages.map(x => ({ name: x.name, status: x.status })),
          completed_count: stages.filter(x => x.status === 'completed').length,
          render_count: s.media.renders.length, scene_count: s.storyboard.scenes.length,
        };
      });
  }

  _stateNode(dir) {
    const marker = readJSON(path.join(dir, 'project.json'), {});
    const checkpoints = {};
    for (const f of safeList(dir)) {
      const m = f.match(/^checkpoint_(.+)\.json$/);
      if (m) checkpoints[m[1]] = readJSON(path.join(dir, f), {});
    }
    const anyCp = Object.values(checkpoints)[0] || {};
    const pipelineType = marker.pipeline_type || anyCp.pipeline_type || null;
    let stageDefs = [];
    try {
      const d = yaml.load(fs.readFileSync(path.join(this.om.root, 'pipeline_defs', pipelineType + '.yaml'), 'utf8'));
      stageDefs = (d.stages || []).map(s => ({ name: s.name, gated: !!s.human_approval_default, produces: s.produces || [] }));
    } catch {
      stageDefs = ['research', 'proposal', 'script', 'scene_plan', 'assets', 'edit', 'compose', 'publish'].map(n => ({ name: n, gated: false, produces: [] }));
    }
    const stages = stageDefs.map((sd) => {
      const cp = checkpoints[sd.name];
      return { ...sd, status: cp ? cp.status : 'pending', timestamp: cp && cp.timestamp, error: cp && cp.error, human_approved: !!(cp && cp.human_approved), review: cp && cp.review, cost_snapshot: cp && cp.cost_snapshot };
    });
    const artifacts = {};
    for (const f of safeList(path.join(dir, 'artifacts'))) if (f.endsWith('.json')) artifacts[f.replace(/\.json$/, '')] = readJSON(path.join(dir, 'artifacts', f));
    const media = { renders: [], snapshots: [], music: [] };
    for (const f of this._files(dir)) {
      if (f.kind === 'video' && /(^|\/)renders\//.test(f.path)) media.renders.push({ path: f.path, size: f.size, mtime: f.mtime });
      else if (f.kind === 'video' && !f.path.includes('/')) media.renders.push({ path: f.path, size: f.size, mtime: f.mtime });
      if (f.kind === 'audio' && /music/i.test(f.path)) media.music.push({ path: f.path });
    }
    const scenesSrc = (artifacts.scene_plan && artifacts.scene_plan.scenes) || [];
    const assets = (artifacts.asset_manifest && artifacts.asset_manifest.assets) || [];
    const sections = (artifacts.script && artifacts.script.sections) || [];
    const scenes = scenesSrc.map((sc) => {
      const own = assets.filter(a => a.scene_id === sc.id).map(a => ({ ...a, exists: !!a.path && fs.existsSync(path.join(dir, a.path)) }));
      const visual = own.find(a => ['image', 'video'].includes(a.type)) || null;
      const sec = sections.find(s => s.id === sc.script_section || (s.start_seconds <= (sc.start_seconds || 0) && (sc.start_seconds || 0) < s.end_seconds));
      return {
        id: sc.id, type: sc.type, description: sc.description, start_seconds: sc.start_seconds, end_seconds: sc.end_seconds,
        duration_seconds: (sc.end_seconds || 0) - (sc.start_seconds || 0), narration: sec ? sec.text : '', section_label: sec ? sec.label : '',
        visual, takes: own.filter(a => ['image', 'video'].includes(a.type)), audio: own.filter(a => ['audio', 'narration', 'music'].includes(a.type)),
        generating: false,
      };
    });
    const events = [];
    try {
      const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').slice(-200);
      for (const l of lines) { try { events.push(JSON.parse(l)); } catch {} }
    } catch {}
    const last = Math.max(0, ...this._files(dir).map(f => f.mtime / 1000));
    const lastCost = Object.values(checkpoints).map(c => c.cost_snapshot).filter(Boolean).pop();
    return {
      project_id: path.basename(dir), title: marker.title || path.basename(dir), series: marker.series || null,
      pipeline: { pipeline_type: pipelineType, stages: stageDefs, known: !!stageDefs.length },
      style_playbook: marker.style_playbook || anyCp.style_playbook || null,
      has_marker: !!marker.project_id, has_pipeline_state: Object.keys(checkpoints).length > 0,
      stages, artifacts,
      storyboard: { scenes, total_duration_seconds: (artifacts.script && artifacts.script.total_duration_seconds) || (scenes.length ? Math.max(...scenes.map(s => s.end_seconds || 0)) : 0) },
      media, events, cost: lastCost || null, last_activity: last, live: Date.now() / 1000 - last < 120,
      poster: (scenes.find(s => s.visual && s.visual.exists && s.visual.type === 'image') || { visual: {} }).visual.path || null,
    };
  }

  _files(dir) {
    const out = [];
    const walk = (d, rel, depth) => {
      if (depth > 4 || out.length > 800) return;
      for (const it of safeList(d, true)) {
        if (it.name.startsWith('.') || it.name === 'history' || it.name === 'node_modules') continue;
        const p = path.join(d, it.name);
        const r = rel ? rel + '/' + it.name : it.name;
        if (it.isDirectory()) walk(p, r, depth + 1);
        else {
          const kind = kindOf(it.name);
          if (!kind) continue;
          let st; try { st = fs.statSync(p); } catch { continue; }
          out.push({ path: r, kind, size: st.size, mtime: st.mtimeMs });
        }
      }
    };
    walk(dir, '', 0);
    return out;
  }
}

function safeList(d, withTypes = false) {
  try { return fs.readdirSync(d, withTypes ? { withFileTypes: true } : undefined); } catch { return []; }
}

module.exports = { Projects };
