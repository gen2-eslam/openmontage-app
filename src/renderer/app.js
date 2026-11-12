/* OpenMontage Studio — app shell, router and non-canvas views. */
(function () {
  const { h, icon, t, toast, modal, timeAgo, titleCase, initials } = UI;
  const view = document.getElementById('view');
  const side = document.getElementById('side');

  const PIPE_ICON = {
    'animated-explainer': ['spark', '#7c5cff'], animation: ['wand', '#ff6b9a'], 'avatar-spokesperson': ['mic', '#ffb347'],
    cinematic: ['film', '#e0565b'], 'clip-factory': ['layout', '#2bb3a3'], 'documentary-montage': ['book', '#8f9bb3'],
    hybrid: ['flow', '#4f8df5'], 'localization-dub': ['globe', '#22c55e'], 'podcast-repurpose': ['mic', '#f59e0b'],
    'screen-demo': ['term', '#06b6d4'], 'talking-head': ['bot', '#a78bfa'], 'character-animation': ['wand', '#f472b6'],
  };
  const pipeIcon = (id) => PIPE_ICON[id] || ['spark', '#731dfb'];

  const App = {
    route: 'home', param: null, engine: {}, agents: [], pipelines: [], projects: [], settings: {}, status: {}, ws: null, pendingPrompt: null,
    go(route, param) { this.route = route; this.param = param || null; render(); },
  };
  window.App = App;

  // ---------------- sidebar ----------------
  function renderSide() {
    const nav = (route, ic, label, badge) => h('div.nav' + (App.route === route ? '.active' : ''), { onclick: () => App.go(route) }, icon(ic), t(label), badge || null);
    const st = App.status;
    const installed = App.agents.filter(a => a.installed);
    const lastProject = App.projects[0];
    side.replaceChildren(
      h('div.brand.drag', h('div.logo', icon('film')), h('div', 'OpenMontage', h('small', 'Studio'))),
      nav('home', 'home', 'Home'),
      h('div.nav' + (App.route === 'canvas' ? '.active' : ''), {
        onclick: () => (lastProject ? App.go('canvas', lastProject.project_id) : App.go('home')),
      }, icon('canvas'), t('Canvas')),
      nav('projects', 'folder', 'Projects', App.projects.length ? h('span.badge.gray', String(App.projects.length)) : null),
      h('div.sep'),
      nav('agents', 'bot', 'Agents', h('span.badge' + (installed.length ? '' : '.err'), String(installed.length))),
      nav('pipelines', 'flow', 'Pipelines'),
      nav('skills', 'book', 'Skills'),
      h('div.grow'),
      h('div.side-status',
        h('div.row', h('i.dot.' + (st.repo ? (st.venv ? 'ok' : 'warn') : 'err')), st.repo ? (st.venv ? 'OpenMontage ready' : 'Setup incomplete') : 'OpenMontage missing'),
        h('div.row', h('i.dot.' + (installed.length ? 'ok' : 'err')), installed.length ? `${installed.length} agent${installed.length > 1 ? 's' : ''} detected` : 'No agent found'),
        App.engine.busy === 'update' ? h('div.row', h('i.dot.live'), 'Updating engine…') : null,
        App.engine.update && App.engine.update.available && !App.engine.busy
          ? h('button.btn.sm', { onclick: () => App.go('settings') }, icon('download'), 'Update available') : null,
        (!st.repo || !st.venv) && App.engine.busy !== 'provision' ? h('button.btn.primary.sm', { onclick: () => App.go('setup') }, icon('download'), t('Setup')) : null),
      nav('settings', 'gear', 'Settings'),
    );
  }

  // ---------------- router ----------------
  async function render() {
    if (App.ws) { App.ws.destroy(); App.ws = null; }
    renderSide();
    view.scrollTop = 0;
    const r = App.route;
    if (r === 'canvas' && App.param) { App.ws = Workspace(view, App, App.param); return; }
    if (r === 'canvas') return App.go('home');
    const pages = { home: Home, projects: ProjectsPage, agents: AgentsPage, pipelines: PipelinesPage, skills: SkillsPage, settings: SettingsPage, setup: SetupPage };
    view.replaceChildren(h('div.page', h('div.muted', 'Loading…')));
    try { view.replaceChildren(await (pages[r] || Home)()); } catch (e) { view.replaceChildren(h('div.page', h('div.empty', e.message))); }
  }

  async function loadAll() {
    const [settings, status, agents] = await Promise.all([window.om.settings.get(), window.om.repo.status(), window.om.agents.detect()]);
    App.settings = settings; App.status = status; App.agents = agents; App.engine = status.engine || {};
    UI.setLang(settings.language);
    document.body.classList.add('platform-' + settings.platform);
    if (status.repo) {
      [App.pipelines, App.projects] = await Promise.all([window.om.repo.pipelines(), window.om.projects.list().catch(() => [])]);
    }
  }

  // ---------------- shared pieces ----------------
  function projectCard(p) {
    const poster = p.poster ? `url("${window.om.media(p.project_id, p.poster)}")` : '';
    return h('div.pcard', { onclick: () => App.go('canvas', p.project_id) },
      h('div.poster', { style: { backgroundImage: poster } }, poster ? null : icon('film'),
        h('div.tags', p.live ? h('span.badge', h('span', '● LIVE')) : null, p.awaiting_human ? h('span.badge.warn', 'Needs approval') : null,
          p.render_count ? h('span.badge.ok', `${p.render_count} render${p.render_count > 1 ? 's' : ''}`) : null)),
      h('div.body', h('div.title', p.title || p.project_id),
        h('div.meta', h('span', p.pipeline_type ? titleCase(p.pipeline_type) : 'No pipeline'), p.scene_count ? h('span', `· ${p.scene_count} scenes`) : null, h('span', '· ' + timeAgo(p.last_activity))),
        h('div.rail', (p.stage_states || []).map(s => h('i.' + s.status, { title: `${s.name}: ${s.status}` })))));
  }

  function agentSelect(value, onChange) {
    const sel = h('select.input', { style: { width: 'auto', height: '34px', padding: '0 30px 0 10px' }, onchange: e => onChange(e.target.value) },
      App.agents.map(a => h('option', { value: a.id, selected: a.id === value, disabled: !a.installed }, `${a.name}${a.installed ? '' : ' (not installed)'}`)));
    return sel;
  }

  function needsRepo() {
    return h('div.card', { style: { display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '18px', borderColor: 'rgba(251,191,36,.4)' } },
      icon('download'), h('div', { style: { flex: 1 } }, h('b', t('OpenMontage is not installed yet')),
        h('div.muted', 'Install the open-source engine once (about 2–5 minutes), or point the app at an existing clone.')),
      h('button.btn.primary', { onclick: () => App.go('setup') }, t('Setup')));
  }

  // ---------------- Home ----------------
  async function Home() {
    const installed = App.agents.filter(a => a.installed);
    let agentId = installed.find(a => a.id === App.settings.defaultAgent) ? App.settings.defaultAgent : (installed[0] || {}).id;
    let pipeline = App.homePipeline || '';
    const ta = h('textarea', { placeholder: t('Describe the video you want…') });
    const send = h('button.send', { disabled: true, title: t('Send') }, icon('send'));
    ta.addEventListener('input', () => { send.disabled = !ta.value.trim(); ta.style.height = 'auto'; ta.style.height = Math.min(240, ta.scrollHeight) + 'px'; });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!send.disabled) send.click(); } });
    const pipeSel = h('select.input', { style: { width: 'auto', height: '34px', padding: '0 30px 0 10px' }, onchange: e => { pipeline = e.target.value; App.homePipeline = pipeline; } },
      h('option', { value: '' }, t('Auto pipeline')), App.pipelines.map(p => h('option', { value: p.id, selected: p.id === pipeline }, titleCase(p.id))));
    send.onclick = async () => {
      const text = ta.value.trim();
      if (!text) return;
      if (!App.status.repo) return App.go('setup');
      if (!agentId) { toast('No agent installed. Open Agents to install or add one.', 'err'); return App.go('agents'); }
      const title = text.split(/\s+/).slice(0, 7).join(' ').replace(/[^\p{L}\p{N}\s-]/gu, '').slice(0, 60) || 'Untitled';
      const { id } = await window.om.projects.create({ title, pipeline });
      App.pendingPrompt = { projectId: id, text, agentId };
      App.projects = await window.om.projects.list();
      App.go('canvas', id);
    };
    const tabs = h('div.tabs', h('div.tab.active', icon('canvas'), 'Agent (Canvas)'),
      h('div.tab', { onclick: () => App.go('pipelines') }, icon('flow'), t('Pipelines')),
      h('div.tab', { onclick: () => App.go('agents') }, icon('bot'), t('Agents')));
    const chips = App.pipelines.slice(0, 5).map((p) => {
      const [ic, col] = pipeIcon(p.id);
      return h('div.chip', { onclick: () => { pipeline = p.id; App.homePipeline = p.id; pipeSel.value = p.id; ta.focus(); } },
        h('span.thumb', { style: { background: col } }, icon(ic)), titleCase(p.id));
    });
    const recent = App.projects.slice(0, 8);
    return h('div.page',
      !App.status.repo ? needsRepo() : null,
      h('div.hero',
        h('h1', t('ALL-IN-ONE AI VIDEO CREATION, FROM START TO FINISH')),
        h('div.composer', tabs, ta, h('div.foot',
          h('button.btn.sm.icon', { title: 'Attach after creating the project', onclick: () => toast('Create the project first, then attach files from the canvas chat.') }, icon('plus')),
          UI.mic(ta, { send: () => send.click() }),
          installed.length ? agentSelect(agentId, v => { agentId = v; }) : h('button.btn.sm', { onclick: () => App.go('agents') }, icon('bot'), 'Connect an agent'),
          pipeSel, send)),
        h('div.chips', chips, h('div.chip.plain', { onclick: () => App.go('pipelines') }, 'More pipelines →'))),
      h('div.feature-row',
        h('div.feature', { onclick: () => App.go('agents') }, h('b', icon('bot'), 'Bring your own agent'), h('span.k', `${installed.length} connected`),
          h('span', 'Claude Code, Codex, Gemini, Cursor, OpenCode, Copilot… or any CLI you add.')),
        h('div.feature', { onclick: () => App.go('pipelines') }, h('b', icon('flow'), `${App.pipelines.length || 12} production pipelines`), h('span.k', 'OpenMontage'),
          h('span', 'Research → proposal → script → scenes → assets → edit → compose, with approval gates.')),
        h('div.feature', { onclick: () => App.go('settings') }, h('b', icon('key'), 'Free or premium providers'), h('span.k', 'Your keys, your machine'),
          h('span', 'Stock footage, Piper TTS and local GPU models for free, plus FAL, Kling, ElevenLabs and others.'))),
      h('h2.sec', t('Recent projects'), App.projects.length > 8 ? h('span.more', { onclick: () => App.go('projects') }, t('View all') + ' →') : null),
      recent.length ? h('div.grid', recent.map(projectCard)) : h('div.empty', t('No projects yet') + ' — ' + t('Start a conversation to begin production.')));
  }

  // ---------------- Projects ----------------
  async function ProjectsPage() {
    if (App.status.repo) App.projects = await window.om.projects.list();
    renderSide();
    let q = '';
    const grid = h('div.grid');
    const draw = () => {
      const list = App.projects.filter(p => !q || (p.title + ' ' + p.project_id + ' ' + (p.pipeline_type || '')).toLowerCase().includes(q));
      grid.replaceChildren(...(list.length ? list.map(projectCard) : [h('div.empty', t('No projects yet'))]));
    };
    draw();
    return h('div.page', !App.status.repo ? needsRepo() : null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' } },
        h('div', { style: { flex: 1 } }, h('h1', t('Projects')), h('div.muted', App.status.projectsDir || '')),
        h('div.search', { style: { width: '260px' } }, icon('search'), h('input.input', { placeholder: 'Search…', oninput: e => { q = e.target.value.toLowerCase(); draw(); } })),
        h('button.btn', { onclick: () => window.om.projects.reveal('') }, icon('folder'), t('Open folder')),
        h('button.btn.primary', { onclick: () => App.go('home') }, icon('plus'), t('New project'))),
      grid);
  }

  // ---------------- Agents ----------------
  async function AgentsPage() {
    App.agents = await window.om.agents.detect();
    renderSide();
    const termOK = await window.om.term.available();
    const card = (a) => h('div.acard',
      h('div.head', h('div.avatar', { style: { background: a.color } }, initials(a.name)),
        h('div', { style: { flex: 1, minWidth: 0 } }, h('div.name', a.name), h('div.vendor', a.vendor + (a.custom ? ' · custom' : ''))),
        h('span.badge.' + (a.installed ? 'ok' : 'gray'), a.installed ? t('Installed') : t('Not installed'))),
      a.installed ? h('div.muted', { style: { fontSize: '11.5px' } }, a.version || a.path) : null,
      h('div.cmd', a.installed ? `${a.cmd} ${a.args.join(' ')}` : (a.install || a.cmd)),
      h('div.actions',
        App.settings.defaultAgent === a.id ? h('span.badge', 'DEFAULT')
          : (a.installed ? h('button.btn.sm', { onclick: async () => { await window.om.settings.set('defaultAgent', a.id); App.settings.defaultAgent = a.id; render(); } }, 'Make default') : null),
        termOK ? h('button.btn.sm', { onclick: () => openTerminal(a.installed ? a.cmd : null, a.installed ? (a.login || []) : [], a.installed ? `${a.name} — sign in` : `Install ${a.name}`, a.installed ? null : a.install) }, icon('term'), a.installed ? t('Login') : 'Install')
          : (!a.installed && a.install ? h('button.btn.sm', { onclick: () => { navigator.clipboard.writeText(a.install); toast('Install command copied'); } }, 'Copy install') : null),
        a.custom ? h('button.btn.sm', { onclick: () => customAgentModal(a) }, icon('edit')) : null,
        a.custom ? h('button.btn.sm.danger', { onclick: async () => { await window.om.agents.remove(a.id); render(); } }, icon('trash')) : null));
    return h('div.page',
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' } },
        h('div', { style: { flex: 1 } }, h('h1', t('Agents')),
          h('div.muted', 'Any coding agent that can read files and run commands can drive OpenMontage. The studio runs it headless inside your OpenMontage folder and streams its work onto the canvas.')),
        h('button.btn', { onclick: () => render() }, icon('refresh'), 'Re-detect'),
        termOK ? h('button.btn', { onclick: () => openTerminal(null, [], 'Terminal') }, icon('term'), t('Open terminal')) : null,
        h('button.btn.primary', { onclick: () => customAgentModal() }, icon('plus'), t('Add custom agent'))),
      h('div.grid', App.agents.map(card)),
      h('div.card', { style: { marginTop: '20px' } }, h('h3', 'How agents connect'),
        h('div.muted', { html: 'Each turn runs the CLI non-interactively (for example <code>claude -p … --output-format stream-json</code> or <code>codex exec --json …</code>) with the OpenMontage repo as the working directory, so it picks up <code>CLAUDE.md</code>, <code>CODEX.md</code>, <code>AGENT_GUIDE.md</code> and the pipeline skills automatically. Sessions are resumed per project, so the agent remembers the production. Sign in to each CLI once (button above) before using it here.' })));
  }

  function customAgentModal(a = {}) {
    const f = {
      name: h('input.input', { value: a.name || '', placeholder: 'My Agent' }),
      cmd: h('input.input', { value: a.cmd || '', placeholder: 'aider / my-agent / /usr/local/bin/agent' }),
      args: h('textarea.input.mono', { rows: 3 }, (a.args || ['{prompt}']).join('\n')),
      resume: h('textarea.input.mono', { rows: 2 }, (a.resumeArgs || []).join('\n')),
      auto: h('input.input.mono', { value: (a.autoArgs || []).join(' '), placeholder: '--yes' }),
      format: h('select.input', ['text', 'claude-stream', 'codex-json', 'gemini-stream'].map(v => h('option', { value: v, selected: (a.format || 'text') === v }, v))),
      env: h('textarea.input.mono', { rows: 2, placeholder: 'KEY=value' }, Object.entries(a.env || {}).map(([k, v]) => `${k}=${v}`).join('\n')),
      color: h('input', { type: 'color', value: a.color || '#9d62ff', style: { width: '48px', height: '34px', border: 0, background: 'none' } }),
    };
    modal({
      title: a.id ? 'Edit custom agent' : t('Add custom agent'),
      body: [
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '12px' } },
          h('label.field', 'Name', f.name), h('label.field', 'Command', f.cmd), h('label.field', 'Color', f.color)),
        h('label.field', 'Arguments for a new turn (one per line)', f.args, h('span.hint', 'Use {prompt} where the message goes. Example for Aider: --message ⏎ {prompt} ⏎ --yes-always')),
        h('label.field', 'Arguments to continue a session (optional)', f.resume, h('span.hint', 'Tokens: {prompt}, {session}. Leave empty to always start fresh.')),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } },
          h('label.field', 'Auto-approve flags', f.auto), h('label.field', 'Output format', f.format)),
        h('label.field', 'Environment variables (optional)', f.env),
      ],
      actions: [{ label: t('Cancel') }, {
        label: t('Save'), primary: true, onClick: async () => {
          if (!f.cmd.value.trim()) { toast('Command is required', 'err'); return false; }
          const lines = (el) => el.value.split('\n').map(s => s.trim()).filter(Boolean);
          const env = Object.fromEntries(lines(f.env).map(l => [l.split('=')[0], l.split('=').slice(1).join('=')]));
          await window.om.agents.save({ id: a.id, name: f.name.value.trim() || f.cmd.value.trim(), cmd: f.cmd.value.trim(), args: lines(f.args),
            resumeArgs: lines(f.resume), autoArgs: f.auto.value.split(/\s+/).filter(Boolean), format: f.format.value, env, color: f.color.value });
          toast('Agent saved'); App.go('agents');
        },
      }],
    });
  }

  async function openTerminal(cmd, args, title, typeLine) {
    if (!window.Terminal) { toast('Terminal UI not available.', 'err'); return; }
    const host = h('div.term-host');
    let id = null;
    const term = new window.Terminal({ fontSize: 12.5, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', theme: { background: '#0a0a0a' }, cursorBlink: true });
    const fit = window.FitAddon ? new window.FitAddon.FitAddon() : null;
    if (fit) term.loadAddon(fit);
    const offs = [];
    const m = modal({ title, wide: true, body: [host, h('div.muted', 'Interactive shell in your OpenMontage folder. Close the window when done.')], onClose: () => { offs.forEach(o => o()); if (id) window.om.term.kill(id); term.dispose(); App.go('agents'); } });
    void m;
    setTimeout(async () => {
      term.open(host);
      if (fit) fit.fit();
      try {
        id = await window.om.term.start({ cmd, args, cols: term.cols, rows: term.rows });
        offs.push(window.om.term.onData(p => { if (p.id === id) term.write(p.data); }));
        offs.push(window.om.term.onExit(p => { if (p.id === id) term.write('\r\n[process exited]\r\n'); }));
        term.onData(d => window.om.term.input(id, d));
        term.onResize(({ cols, rows }) => window.om.term.resize(id, cols, rows));
        if (typeLine) setTimeout(() => window.om.term.input(id, typeLine), 400);
      } catch (e) { term.write(String(e.message || e)); }
    }, 50);
  }

  // ---------------- Pipelines & Skills ----------------
  async function PipelinesPage() {
    if (App.status.repo) App.pipelines = await window.om.repo.pipelines();
    return h('div.page', !App.status.repo ? needsRepo() : null,
      h('h1', t('Pipelines')), h('div.sub', 'Each pipeline is a YAML manifest in OpenMontage with director skills for every stage. Pick one, or let the agent choose.'),
      h('div.grid', { style: { gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' } }, App.pipelines.map((p) => {
        const [ic, col] = pipeIcon(p.id);
        return h('div.acard',
          h('div.head', h('div.avatar', { style: { background: col } }, icon(ic)), h('div', { style: { flex: 1 } }, h('div.name', titleCase(p.id)), h('div.vendor', [p.category, p.stability].filter(Boolean).join(' · ')))),
          h('div.muted', { style: { fontSize: '12px' } }, p.description.slice(0, 220) + (p.description.length > 220 ? '…' : '')),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } }, p.stages.map(s => h('span.badge.gray', s))),
          h('div.actions', h('button.btn.sm.primary', { onclick: () => { App.homePipeline = p.id; App.go('home'); } }, t('Start with this pipeline'))));
      })));
  }

  async function SkillsPage() {
    const skills = App.status.repo ? await window.om.repo.skills() : [];
    const groups = [...new Set(skills.map(s => s.group))];
    let q = '', g = '';
    const list = h('div');
    const draw = () => {
      const f = skills.filter(s => (!g || s.group === g) && (!q || (s.title + s.path).toLowerCase().includes(q)));
      list.replaceChildren(...f.slice(0, 400).map(s => h('div.list-row', { onclick: () => showSkill(s) }, icon('book'), h('div', { style: { flex: 1 } }, s.title), h('span.mono.muted', s.path))));
    };
    const pills = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '14px 0' } });
    const drawPills = () => pills.replaceChildren(h('span.pill' + (!g ? '.active' : ''), { onclick: () => { g = ''; drawPills(); draw(); } }, 'All'),
      ...groups.map(x => h('span.pill' + (g === x ? '.active' : ''), { onclick: () => { g = x; drawPills(); draw(); } }, x)));
    drawPills(); draw();
    return h('div.page', !App.status.repo ? needsRepo() : null,
      h('h1', t('Skills')), h('div.sub', `${skills.length} production-knowledge files your agent reads while it works.`),
      h('div.search', icon('search'), h('input.input', { placeholder: t('Search skills…'), oninput: e => { q = e.target.value.toLowerCase(); draw(); } })), pills, list);
  }

  async function showSkill(s) {
    const txt = await window.om.repo.readFile(s.path);
    modal({ title: s.title, wide: true, body: h('div.txt', { style: { maxHeight: '65vh', overflow: 'auto' }, html: UI.md(txt) }) });
  }

  // ---------------- Settings ----------------
  async function SettingsPage() {
    const st = App.status = await window.om.repo.status();
    const s = App.settings;
    const toggle = (key) => {
      const el = h('div.toggle' + (s[key] ? '.on' : ''), { onclick: async () => { s[key] = !s[key]; await window.om.settings.set(key, s[key]); el.classList.toggle('on', s[key]); } });
      return el;
    };
    const lang = h('select.input', { style: { width: '160px' }, onchange: async e => { await window.om.settings.set('language', e.target.value); s.language = e.target.value; UI.setLang(e.target.value); render(); } },
      h('option', { value: 'en', selected: s.language !== 'ar' }, 'English'), h('option', { value: 'ar', selected: s.language === 'ar' }, 'العربية'));
    const general = h('div.card', h('h3', t('General')),
      h('div.row', h('div.l', t('Language')), lang),
      h('div.row', h('div.l', t('Default agent')), agentSelect(s.defaultAgent, async v => { await window.om.settings.set('defaultAgent', v); s.defaultAgent = v; })),
      h('div.row', h('div.l', t('Auto-approve agent actions'), h('small', 'Lets the agent run OpenMontage tools (Python, ffmpeg, renders) without stopping to ask. It is needed for headless production. Turn it off to allow file edits only.')), toggle('autoApprove')));

    const repo = h('div.card', h('h3', 'OpenMontage'),
      h('div.row', h('div.l', 'Repository folder', h('small.mono', st.root)), h('span.badge.' + (st.repo ? 'ok' : 'err'), st.repo ? 'found' : 'missing'),
        h('button.btn.sm', { onclick: async () => { const p = await window.om.pickFolder('Choose your OpenMontage folder'); if (p) { App.status = await window.om.repo.setRoot(p); await loadAll(); render(); } } }, 'Change…')),
      h('div.row', h('div.l', 'Projects folder', h('small.mono', st.projectsDir)),
        h('button.btn.sm', { onclick: async () => { const p = await window.om.pickFolder('Choose projects folder'); if (p) { await window.om.settings.set('projectsDir', p); render(); } } }, 'Change…'),
        h('button.btn.sm', { onclick: async () => { await window.om.settings.set('projectsDir', ''); render(); } }, 'Default')),
      h('div.row', h('div.l', 'Environment', h('small', `venv ${st.venv ? '✓' : '✗'} · .env ${st.env ? '✓' : '✗'} · remotion ${st.remotion ? '✓' : '✗'}`)),
        h('button.btn.sm', { onclick: () => App.go('setup') }, t('Setup')),
        st.repo ? h('button.btn.sm', { onclick: () => runLog('Updating OpenMontage', () => window.om.repo.update()) }, t('Update')) : null));

    const updates = UpdatesCard();
    const voice = VoiceCard();
    const addonsCard = AddonsCard();
    const envCard = h('div.card', h('h3', t('API keys')), h('div.muted', 'Stored in OpenMontage/.env on this computer. Every key is optional; free providers work without any.'));
    if (st.repo) {
      const entries = await window.om.repo.env();
      const inputs = {};
      let section = null;
      const wrap = h('div');
      let grid = null;
      for (const e of entries) {
        if (e.section !== section) { section = e.section; wrap.appendChild(h('div.envsec', section || 'General')); grid = h('div.envgrid'); wrap.appendChild(grid); }
        const secret = /KEY|TOKEN|SECRET|PASSWORD/.test(e.key);
        const inp = h('input.input.mono', { value: e.value || '', type: secret ? 'password' : 'text', placeholder: e.commented ? '(optional)' : '' });
        inputs[e.key] = inp;
        grid.appendChild(h('label.field', h('span', e.key), secret ? h('div.pwd', inp, h('button', { onclick: (ev) => { ev.preventDefault(); inp.type = inp.type === 'password' ? 'text' : 'password'; } }, icon('eye'))) : inp,
          e.help ? h('span.hint', e.help.slice(0, 160)) : null));
      }
      envCard.append(wrap, h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '16px' } },
        h('button.btn.primary', { onclick: async () => {
          const vals = {};
          for (const [k, el] of Object.entries(inputs)) { const orig = entries.find(x => x.key === k).value || ''; if (el.value !== orig) vals[k] = el.value; }
          await window.om.repo.saveEnv(vals); toast(`Saved ${Object.keys(vals).length} value(s) to .env`);
        } }, icon('check'), t('Save'))));
    }
    return h('div.page', h('h1', t('Settings')), h('div.sub', `OpenMontage Studio ${s.version} · ${s.platform}`), general, addonsCard, voice, updates, repo, envCard);
  }

  // ---------------- Setup ----------------
  async function SetupPage() {
    const st = App.status = await window.om.repo.status();
    if (st.bundle && st.bundle.available) return BundledSetupPage(st);
    const deps = await window.om.repo.deps();
    const depRow = (name, label, hint) => {
      const d = deps[name] || {};
      return h('div.dep', h('i.dot.' + (d.ok ? 'ok' : 'err')), h('div', h('div', label), h('small', d.ok ? d.version : hint)));
    };
    const missing = ['git', 'python', 'node', 'ffmpeg'].filter(k => !(deps[k] && deps[k].ok));
    const plat = App.settings.platform;
    const hints = {
      darwin: 'brew install git python@3.12 node ffmpeg',
      win32: 'winget install Git.Git Python.Python.3.12 OpenJS.NodeJS.LTS Gyan.FFmpeg',
      linux: 'sudo apt install git python3 python3-venv nodejs npm ffmpeg',
    };
    return h('div.page',
      h('h1', 'Set up OpenMontage'),
      h('div.sub', 'The studio drives the open-source OpenMontage engine (AGPL-3.0). It is cloned to your computer and set up the same way as `make setup`.'),
      h('div.card', h('h3', t('Requirements')),
        h('div.deps', { style: { marginTop: '12px' } },
          depRow('git', 'Git', 'required to clone'), depRow('python', 'Python 3.10+', 'required'),
          depRow('node', 'Node.js 18+', 'required (22+ for HyperFrames)'), depRow('npm', 'npm', 'comes with Node'), depRow('ffmpeg', 'FFmpeg', 'required for rendering')),
        deps.node && deps.node.ok && !deps.node.hyperframesReady ? h('div.muted', { style: { marginTop: '10px' } }, 'Tip: Node.js 22+ unlocks the HyperFrames render runtime.') : null,
        missing.length ? h('div', { style: { marginTop: '12px' } }, h('div.muted', 'Install the missing tools, then press Re-check:'), h('div.cmd.mono', { style: { marginTop: '6px', padding: '8px', border: '1px solid var(--line)', borderRadius: '8px' } }, hints[plat] || hints.linux)) : null,
        h('div', { style: { marginTop: '12px' } }, h('button.btn.sm', { onclick: () => render() }, icon('refresh'), 'Re-check'))),
      h('div.card', h('h3', 'Engine'),
        h('div.row', h('div.l', 'Install location', h('small.mono', st.root)),
          h('button.btn.sm', { onclick: async () => { const p = await window.om.pickFolder(t('Use existing folder')); if (p) { await window.om.repo.setRoot(p); await loadAll(); render(); } } }, t('Use existing folder'))),
        h('div.row', h('div.l', st.repo ? (st.venv ? 'OpenMontage is installed and ready.' : 'Repository found; Python environment not set up yet.') : 'Not installed at this location.'),
          h('button.btn.primary', { disabled: missing.some(m => m !== 'ffmpeg'), onclick: () => runLog('Installing OpenMontage', () => window.om.repo.setup(), async () => { await loadAll(); App.go('home'); }) },
            icon('download'), st.repo && st.venv ? 'Re-run setup' : t('Install OpenMontage')))),
      h('div.card', h('h3', 'Then connect an agent'),
        h('div.muted', 'Install at least one coding agent CLI (Claude Code, Codex, Gemini CLI…) and sign in once.'),
        h('div', { style: { marginTop: '10px' } }, h('button.btn.sm', { onclick: () => App.go('agents') }, icon('bot'), t('Agents')))));
  }

  function runLog(title, fn, after) {
    const log = h('div.log');
    const off = window.om.repo.onLog((txt) => { log.textContent += txt; log.scrollTop = log.scrollHeight; });
    const m = modal({ title, wide: true, body: [log], onClose: () => off() });
    fn().then(() => { log.textContent += '\nDone.\n'; toast(title + ' — done'); if (after) { m.close(); after(); } })
      .catch((e) => { log.textContent += '\n✗ ' + (e.message || e) + '\n'; toast(e.message, 'err'); });
  }


  // ---------------- bundled engine: setup + updates ----------------
  function BundledSetupPage(st) {
    const m = st.bundle.meta || {};
    const busy = App.engine.busy === 'provision';
    return h('div.page',
      h('h1', 'OpenMontage is built in'),
      h('div.sub', 'This app ships with the full OpenMontage engine and its own Python, Node.js and ffmpeg. Nothing to download — the engine is unpacked into a folder you can open.'),
      h('div.card', h('h3', 'Bundled engine'),
        h('div.deps', { style: { marginTop: '12px' } },
          dep(true, 'OpenMontage', (m.engine && m.engine.sha || '').slice(0, 7) + (m.engine && m.engine.date ? ' · ' + new Date(m.engine.date).toLocaleDateString() : '')),
          dep(true, 'Python', m.python), dep(true, 'Node.js', m.node), dep(true, 'ffmpeg + ffprobe', 'bundled')),
        h('div.row', { style: { marginTop: '12px' } }, h('div.l', 'Engine folder', h('small.mono', st.root)),
          h('button.btn.sm', { onclick: async () => { const p = await window.om.pickFolder('Choose where to put OpenMontage'); if (p) { await window.om.repo.setRoot(p); render(); } } }, 'Change…'),
          h('button.btn.primary', { disabled: busy, onclick: () => runLog('Preparing OpenMontage', () => window.om.repo.setup(), async () => { await loadAll(); App.go('home'); }) },
            icon('download'), busy ? 'Preparing…' : (st.repo && st.venv ? 'Repair' : 'Install now')))),
      h('div.card', h('h3', 'Then connect an agent'),
        h('div.muted', 'This is the only thing you set up yourself: install a coding agent CLI (Claude Code, Codex, Gemini CLI…) and sign in once.'),
        h('div', { style: { marginTop: '10px' } }, h('button.btn.sm', { onclick: () => App.go('agents') }, icon('bot'), t('Agents')))));
  }
  function dep(ok, label, sub) { return h('div.dep', h('i.dot.' + (ok ? 'ok' : 'err')), h('div', h('div', label), h('small', sub || ''))); }



  function AddonsCard() {
    const card = h('div.card', h('h3', 'Add-ons'), h('div.muted', 'Free tools installed into OpenMontage and offered to every agent (as a registry tool, a skill and an MCP server).'));
    const body = h('div', h('div.muted', { style: { padding: '10px 0' } }, 'Checking…'));
    card.append(body);
    const DIALECTS = [['egyptian', 'مصري — Egyptian'], ['saudi', 'سعودي — Saudi'], ['emirati', 'إماراتي — Emirati'], ['kuwaiti', 'كويتي — Kuwaiti'],
      ['qatari', 'قطري — Qatari'], ['bahraini', 'بحريني — Bahraini'], ['omani', 'عماني — Omani'], ['yemeni', 'يمني — Yemeni'], ['jordanian', 'أردني — Jordanian'],
      ['lebanese', 'لبناني — Lebanese'], ['syrian', 'سوري — Syrian'], ['iraqi', 'عراقي — Iraqi'], ['moroccan', 'مغربي — Moroccan'], ['algerian', 'جزائري — Algerian'],
      ['tunisian', 'تونسي — Tunisian'], ['libyan', 'ليبي — Libyan'], ['', 'Other voice (English / any language)…']];
    const draw = async () => {
      const st = (await window.om.addons.state()).edgeTts;
      const ok = st.tool && st.packages && st.mcp;
      const dialect = h('select.input', { style: { width: '230px' } }, DIALECTS.map(([v, l]) => h('option', { value: v }, l)));
      const gender = h('select.input', { style: { width: '120px' } }, h('option', { value: 'female' }, 'Female'), h('option', { value: 'male' }, 'Male'));
      const voiceIn = h('input.input.mono.hidden', { placeholder: 'en-US-AndrewMultilingualNeural', style: { width: '260px' } });
      dialect.onchange = () => { voiceIn.classList.toggle('hidden', !!dialect.value); gender.classList.toggle('hidden', !dialect.value); };
      const text = h('textarea.input', { rows: 2, dir: 'auto' }, 'أهلاً بيكم! النهارده هنعمل فيديو قصير عن الـ AI، وهتشوفوا إزاي الموضوع سهل جداً.');
      const player = h('audio', { controls: true, style: { width: '100%', display: 'none' } });
      const play = h('button.btn.sm.primary', { onclick: async () => {
        play.disabled = true; play.replaceChildren(icon('refresh'), 'Generating…');
        try {
          const bytes = await window.om.addons.ttsPreview({ text: text.value, dialect: dialect.value || undefined, gender: gender.value, voice: dialect.value ? undefined : voiceIn.value.trim() });
          player.src = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
          player.style.display = 'block'; player.play().catch(() => {});
        } catch (e) { toast('Edge TTS: ' + String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err'); }
        finally { play.disabled = false; play.replaceChildren(icon('play'), 'Listen'); }
      } }, icon('play'), 'Listen');
      body.replaceChildren(...[
        h('div.row', h('div.l', 'Edge TTS — free voiceover', h('small', 'Microsoft neural voices: 16 Arabic dialects, English and 70+ languages, with word timings for captions. No key; needs internet.')),
          h('span.badge.' + (ok ? 'ok' : st.error ? 'err' : 'warn'), ok ? 'installed' : st.error ? 'error' : 'not installed'),
          h('button.btn.sm', { onclick: () => runLog('Installing Edge TTS add-on', () => window.om.addons.ensure(), () => draw()) }, icon(ok ? 'refresh' : 'download'), ok ? 'Repair' : 'Install')),
        st.error ? h('div.muted', { style: { fontSize: '11.5px', paddingBottom: '8px' } }, st.error) : null,
        ok ? h('div.row', h('div.l', 'Try a voice', h('small', 'Write the text in the dialect you pick — the voice gives the accent.')), dialect, gender, voiceIn) : null,
        ok ? h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '4px 0 8px' } }, text, play) : null,
        ok ? player : null,
        h('div.muted', { style: { fontSize: '11.5px' } }, 'Agents get it as: the edge_tts tool in OpenMontage, the edge-tts skill, and the MCP server "openmontage-studio" (Claude Code, Codex, Gemini, Cursor, OpenCode, Qwen).'),
        h('div', { style: { height: '1px', background: 'var(--line)', margin: '14px 0 6px' } }),
        h('div.row', h('div.l', 'Kokoro — HyperFrames voices', h('small', 'The local model HyperFrames uses (Kokoro-82M): the most natural free voice for English, Spanish, French, Italian, Hindi, Portuguese, Japanese and Chinese. Offline. No Arabic — Arabic stays on Edge TTS.'))),
        HFToolsUI.kokoroStatus((ks) => kokoroTry.classList.remove('hidden')),
        kokoroTry,
        hfRow].filter(Boolean));
    };
    const kokoroTry = h('div.hidden', { style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '8px 0' } });
    HFToolsUI.voiceSelect().then((vs) => {
      vs.style.width = '240px';
      const txt = h('input.input', { value: 'Every night, the keeper climbs one hundred and twelve stairs to light the lamp.', style: { flex: 1 } });
      const b = h('button.btn.sm.primary', icon('play'), 'Listen');
      b.onclick = async () => {
        b.disabled = true;
        try { await HFToolsUI.playBytes(await window.om.hft.preview({ text: txt.value, voice: vs.value }), 'audio/wav'); }
        catch (e) { toast(String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err'); }
        b.disabled = false;
      };
      kokoroTry.replaceChildren(vs, txt, b);
    }).catch(() => {});
    const hfRow = h('div.muted', { style: { fontSize: '11.5px', paddingTop: '4px' } }, 'Checking HyperFrames…');
    window.om.hft.status().then((st) => {
      hfRow.textContent = st.cli
        ? `HyperFrames ${st.skills ? 'skills installed' : 'skills pending'} · \`hyperframes\` command ${st.shim ? 'available' : 'pending'} for agents (transcribe, catalog/add, capture, remove-background, beats, check, snapshot). Open a project → HyperFrames tools.`
        : 'HyperFrames needs Node 22 — run npm run bundle, or install Node 22+.';
    }).catch(() => {});
    window.om.addons.ensure().catch(() => {}).then(draw).catch(e => body.replaceChildren(h('div.muted', e.message)));
    return card;
  }

  function VoiceCard() {
    const card = h('div.card', h('h3', 'Voice input'), h('div.muted', 'Press the mic in any prompt box (or ⌘/Ctrl+Shift+M), speak, press again — your words are typed for the agent.'));
    const body = h('div', h('div.muted', { style: { padding: '10px 0' } }, 'Loading…'));
    card.append(body);
    const draw = async () => {
      const st = await window.om.stt.status();
      const sel = (key, val, opts) => h('select.input', { style: { width: '220px' }, onchange: async (e) => { await window.om.settings.set(key, e.target.value); draw(); } },
        opts.map(([v, l]) => h('option', { value: v, selected: v === val }, l)));
      const L = st.local;
      const engineName = { local: 'Local Whisper', groq: 'Groq', openai: 'OpenAI', elevenlabs: 'ElevenLabs' };
      const keyRow = (prov, label, url) => {
        const inp = h('input.input.mono', { type: 'password', placeholder: st.cloud[prov] ? '•••••••• (saved)' : 'paste key', style: { width: '260px' } });
        return h('div.row', h('div.l', label, h('small', h('a', { href: url, target: '_blank' }, url.replace('https://', '')))),
          st.cloud[prov] ? h('span.badge.ok', 'key set') : null, inp,
          h('button.btn.sm', { onclick: async () => { if (!inp.value.trim()) return; await window.om.stt.setKey(prov, inp.value.trim()); toast(label + ' key saved'); draw(); } }, t('Save')));
      };
      body.replaceChildren(
        h('div.row', h('div.l', 'Status', h('small', st.resolved ? `Using ${engineName[st.resolved]}` : 'Not set up yet — enable the local model or add a key')),
          h('span.badge.' + (st.resolved ? 'ok' : 'warn'), st.resolved ? 'ready' : 'setup needed')),
        h('div.row', h('div.l', 'Engine', h('small', 'Auto = local model if installed, otherwise the first cloud key found.')),
          sel('sttEngine', st.engine, [['auto', 'Auto'], ['local', 'Local Whisper (free, offline)'], ['groq', 'Groq (fast, cheap)'], ['openai', 'OpenAI'], ['elevenlabs', 'ElevenLabs Scribe']])),
        h('div.row', h('div.l', 'Language', h('small', 'Auto-detect handles mixed Arabic/English. Pick one to force it.')),
          sel('sttLanguage', st.language, [['', 'Auto-detect'], ['ar', 'Arabic (العربية)'], ['en', 'English']])),
        h('div.row', h('div.l', 'Local model', h('small', L.ready ? `Installed: ${L.model}` : (L.installed ? 'faster-whisper installed — model not downloaded' : 'Runs on this computer. "small" is a good balance for Arabic; "medium"/"large-v3" are more accurate but slower.'))),
          sel('sttModel', L.model, L.models.map(m => [m, m + (L.available.includes(m) ? ' ✓' : '')])),
          h('button.btn.sm' + (L.ready ? '' : '.primary'), { onclick: () => runLog('Setting up local voice input', () => window.om.stt.enableLocal(L.model), () => draw()) },
            icon('download'), L.ready ? 'Reinstall' : 'Enable')),
        h('div.row', h('div.l', 'Send automatically', h('small', 'Send the message as soon as the transcription is typed.')),
          (() => { const tg = h('div.toggle' + (st.autoSend ? '.on' : ''), { onclick: async () => { await window.om.settings.set('sttAutoSend', !st.autoSend); draw(); } }); return tg; })()),
        h('div.envsec', 'Cloud keys (optional)'),
        keyRow('groq', 'Groq', 'https://console.groq.com/keys'),
        keyRow('openai', 'OpenAI', 'https://platform.openai.com/api-keys'),
        keyRow('elevenlabs', 'ElevenLabs', 'https://elevenlabs.io/app/settings/api-keys'));
    };
    draw().catch(e => body.replaceChildren(h('div.muted', e.message)));
    return card;
  }

  function UpdatesCard() {
    const card = h('div.card', h('h3', 'Updates'), h('div.muted', 'The engine is checked on launch and every 6 hours.'));
    const engineRow = h('div');
    const agentsBox = h('div', h('div.muted', { style: { padding: '8px 0' } }, 'Checking agent versions…'));
    const toggle = h('div.toggle' + (App.settings.autoUpdate !== false ? '.on' : ''), {
      onclick: async () => { App.settings.autoUpdate = App.settings.autoUpdate === false; await window.om.settings.set('autoUpdate', App.settings.autoUpdate); toggle.classList.toggle('on', App.settings.autoUpdate); },
    });
    const drawEngine = () => {
      const u = App.engine.update || {};
      const meta = App.status.engineMeta;
      const cur = meta && meta.sha ? `${meta.sha.slice(0, 7)} · ${meta.date ? new Date(meta.date).toLocaleDateString() : ''}` : (u.head || '—');
      engineRow.replaceChildren(...[
        h('div.row', h('div.l', 'OpenMontage engine', h('small.mono', cur)),
          App.engine.busy === 'update' ? h('span.badge', 'updating…')
            : u.available ? h('span.badge.warn', u.behind ? `${u.behind} new commit${u.behind > 1 ? 's' : ''}` : 'update available')
              : u.error ? h('span.badge.err', 'check failed') : u.checkedAt ? h('span.badge.ok', 'up to date') : null,
          h('button.btn.sm', { onclick: async () => { await window.om.repo.checkUpdate(); } }, icon('refresh'), 'Check now'),
          u.available ? h('button.btn.sm.primary', { onclick: () => runLog('Updating OpenMontage', () => window.om.repo.update()) }, icon('download'), t('Update')) : null),
        u.available && u.commits && u.commits.length ? h('div.muted', { style: { fontSize: '12px', padding: '0 0 8px' } }, u.commits.map(c => h('div', '• ' + c))) : null,
        u.error ? h('div.muted', { style: { fontSize: '11.5px' } }, u.error) : null,
        h('div.row', h('div.l', 'Install engine updates automatically', h('small', 'Skipped while an agent is working. Your projects and .env are never touched.')), toggle)].filter(Boolean));
    };
    drawEngine();
    card._drawEngine = drawEngine;
    App._updatesCard = card;
    card.append(engineRow, h('div.envsec', 'Agents'), agentsBox);
    window.om.agents.checkUpdates().then((list) => {
      if (!list.length) { agentsBox.replaceChildren(h('div.muted', 'No npm-based agents installed.')); return; }
      agentsBox.replaceChildren(...list.map(a => h('div.row', h('div.l', a.name, h('small.mono', `${a.installed || '?'}${a.latest ? '  →  latest ' + a.latest : ''}`)),
        a.available ? h('button.btn.sm.primary', { onclick: () => runLog(`Updating ${a.name}`, () => window.om.agents.update(a.id), async () => { App.agents = await window.om.agents.detect(); render(); }) }, icon('download'), t('Update'))
          : h('span.badge.ok', 'up to date'))));
    }).catch(e => agentsBox.replaceChildren(h('div.muted', e.message)));
    return card;
  }

  // Preparing overlay while the bundled engine unpacks on first launch.
  let prepOverlay = null;
  function showPrep() {
    if (prepOverlay) return;
    const log = h('div.log', { style: { height: '220px' } });
    const off = window.om.repo.onLog((txt) => { log.textContent += txt; log.scrollTop = log.scrollHeight; });
    prepOverlay = h('div.overlay', h('div.modal',
      h('div.mh2', h('div.logo', { style: { width: '26px', height: '26px', borderRadius: '8px', background: 'var(--grad)', display: 'grid', placeItems: 'center' } }, icon('film')), 'Preparing OpenMontage'),
      h('div.mb', h('div.muted', 'First launch: unpacking the built-in engine and its Python packages. This takes about a minute and needs no internet.'),
        h('div.rail', h('i.in_progress'), h('i.in_progress'), h('i.in_progress')), log)));
    prepOverlay._off = off;
    document.body.appendChild(prepOverlay);
  }
  function hidePrep() { if (prepOverlay) { prepOverlay._off(); prepOverlay.remove(); prepOverlay = null; } }

  window.om.repo.onEngine(async (st) => {
    const was = App.engine.busy;
    App.engine = st;
    if (st.busy === 'provision' && !document.querySelector('.modal .log')) showPrep();
    if (!st.busy && was === 'provision') { hidePrep(); if (st.error) toast(st.error, 'err'); }
    if (App._updatesCard && document.body.contains(App._updatesCard)) App._updatesCard._drawEngine();
    if (App.route !== 'canvas') renderSide();
  });
  window.om.repo.onReady(async () => { await loadAll(); toast('OpenMontage is ready'); App.go('home'); });
  window.om.repo.onUpdated(async () => { App.status = await window.om.repo.status(); App.pipelines = await window.om.repo.pipelines(); toast('OpenMontage engine updated'); if (App.route !== 'canvas') renderSide(); });

  // ---------------- boot ----------------
  window.om.projects.onChanged(async () => {
    if (App.route === 'home' || App.route === 'projects') {
      clearTimeout(App._lt);
      App._lt = setTimeout(async () => {
        App.projects = await window.om.projects.list();
        const typing = document.activeElement && /TEXTAREA|INPUT/.test(document.activeElement.tagName) && document.activeElement.value;
        if ((App.route === 'home' || App.route === 'projects') && !typing) render();
      }, 1200);
    }
  });

  (async () => {
    try { await loadAll(); } catch (e) { toast(e.message, 'err'); }
    const hash = (location.hash || '').slice(1);
    if (hash.startsWith('canvas/')) App.go('canvas', decodeURIComponent(hash.slice(7)));
    else if (hash) App.go(hash);
    else App.go(App.status.repo || (App.status.bundle && App.status.bundle.available) ? 'home' : 'setup');
    if (App.engine.busy === 'provision') showPrep();
  })();
})();
