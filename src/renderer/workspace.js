/* Project workspace: agent chat · infinite canvas · inspector · timeline + player. */
(function () {
  const { h, icon, t, md, toast, fmtTime, titleCase, initials } = UI;

  const NODE_W = 280;
  const OFF = 66; // timeline left gutter for track labels
  const COLS = 3;

  function Workspace(root, app, projectId) {
    const S = {
      id: projectId, st: null, view: { x: 60, y: 40, z: 0.85 }, fitted: false,
      sel: new Set(), nodes: new Map(), layout: {}, time: 0, playing: false, tlZoom: 1, tlCollapsed: false,
      agentId: localStorage.getItem('agent:' + projectId) || app.settings.defaultAgent || 'claude',
      history: { messages: [] }, running: false, unsub: [],
    };

    // ---------------- DOM skeleton ----------------
    const stagebar = h('div.stagebar');
    const costEl = h('span.cost');
    const titleEl = h('div.ttl');
    const pipeEl = h('div.pipe');
    const top = h('div.ws-top.drag',
      h('button.btn.ghost.sm.icon.nodrag', { title: t('Projects'), onclick: () => app.go('projects') }, icon('layout')),
      h('div', titleEl, pipeEl), stagebar, costEl,
      h('div.nodrag', { style: { display: 'flex', gap: '6px' } },
        h('div', { style: { position: 'relative' } }, h('button.btn.sm.primary', { onclick: (e) => exportMenu(e.currentTarget.parentElement) }, icon('download'), 'Export')),
        h('button.btn.sm', { title: 'Voice, captions, 448 blocks, background removal, website capture, review', onclick: () => HFToolsUI.open({ id: S.id, files: () => (S.st && S.st.files) || [], send: (text) => sendMessage(text) }) }, icon('wand'), t('HyperFrames tools')),
        h('button.btn.sm', { onclick: () => window.om.projects.reveal(S.id) }, icon('folder'), t('Open folder')),
        h('button.btn.sm', { onclick: () => window.om.repo.backlot(S.id).catch(e => toast(e.message, 'err')) }, icon('ext'), t('Backlot board'))));

    // chat
    const msgs = h('div.msgs');
    const agentPick = h('div.agent-pick');
    const modelPick = h('div.agent-pick.model-pick');
    const focusbar = h('div.focusbar');
    const ta = h('textarea', { placeholder: t('Ask the agent to change anything…'), rows: 3 });
    const sendBtn = h('button.btn.primary.sm.send', icon('send'), t('Send'));
    const attachBtn = h('button.btn.ghost.sm.icon', { title: 'Attach files' }, icon('clip'));
    const chat = h('div.chat',
      h('div.chat-head', agentPick, modelPick, h('div', { style: { flex: 1 } }),
        h('button.btn.ghost.sm.icon', { title: t('New chat'), onclick: newChat }, icon('broom'))),
      msgs,
      h('div.chat-comp', focusbar, ta, h('div.foot', attachBtn, UI.mic(ta, { send: () => sendBtn.click() }), h('span.muted', { style: { fontSize: '11px' } }, '⏎ send · ⇧⏎ newline'), sendBtn)));

    // board
    const layer = h('div.layer');
    const edges = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    edges.setAttribute('class', 'edges');
    edges.setAttribute('width', '1'); edges.setAttribute('height', '1');
    layer.appendChild(edges);
    const board = h('div.board', layer);
    const zoomLbl = h('span.z');
    const gate = h('div.gate.hidden');
    const voiceEl = h('div.gate.voice.hidden');
    const jobEl = h('div.job.hidden');
    const empty = h('div.board-empty.hidden');
    const boardWrap = h('div.board-wrap', board, h('div.banners', gate, voiceEl), jobEl, empty,
      h('div.board-tools',
        h('button.btn.ghost.sm.icon', { title: 'Zoom out', onclick: () => zoomBy(1 / 1.2) }, icon('minus')), zoomLbl,
        h('button.btn.ghost.sm.icon', { title: 'Zoom in', onclick: () => zoomBy(1.2) }, icon('plus')),
        h('button.btn.ghost.sm.icon', { title: 'Fit', onclick: fit }, icon('fit')),
        h('button.btn.ghost.sm.icon', { title: 'Tidy layout', onclick: resetLayout }, icon('layout')),
        h('button.btn.ghost.sm.icon', { title: 'Refresh', onclick: () => refresh(true) }, icon('refresh'))));

    // inspector
    const insp = h('div.insp.closed');

    // timeline
    const screen = h('div.screen', icon('film'));
    const pvHead = h('div.pv-head');
    const playBtn = h('button.btn.sm.icon', { onclick: togglePlay }, icon('play'));
    const timeEl = h('span.time', '0:00 / 0:00');
    const tlMain = h('div.tl-main');
    const tlToggle = h('button.btn.ghost.sm.icon.tl-toggle', { onclick: () => setTlCollapsed(!S.tlCollapsed) });
    const tlResize = h('div.tl-resize', { title: 'Drag to resize · double-click to hide/show' });
    const tl = h('div.tl',
      tlResize,
      h('div.player', pvHead, screen, h('div.ctrl', playBtn, h('button.btn.ghost.sm', { onclick: () => seek(0) }, '⏮'), timeEl, tlToggle)),
      tlMain);
    function setTlCollapsed(v) {
      S.tlCollapsed = v;
      tl.classList.toggle('collapsed', v);
      tl.style.height = v ? '' : (S.tlHeight ? S.tlHeight + 'px' : '');
      tlToggle.replaceChildren(icon(v ? 'up' : 'down'));
      tlToggle.title = v ? 'Show player and timeline' : 'Hide player and timeline';
      try { localStorage.setItem('tlCollapsed', v ? '1' : '0'); } catch {}
      if (!v && S.st) requestAnimationFrame(() => renderTimeline());
    }
    S.tlHeight = Number(localStorage.getItem('tlHeight')) || 0;
    tlResize.ondblclick = () => setTlCollapsed(!S.tlCollapsed);
    tlResize.onpointerdown = (e) => {
      e.preventDefault();
      const startY = e.clientY, startH = tl.getBoundingClientRect().height;
      const max = Math.max(160, window.innerHeight - 220);
      let moved = false;
      tlResize.setPointerCapture(e.pointerId);
      tl.classList.add('resizing');
      tlResize.onpointermove = (ev) => {
        const nh = Math.round(startH + (startY - ev.clientY));
        if (Math.abs(startY - ev.clientY) > 3) moved = true;
        if (!moved) return;
        if (nh < 90) { if (!S.tlCollapsed) setTlCollapsed(true); return; }
        if (S.tlCollapsed) setTlCollapsed(false);
        S.tlHeight = Math.min(max, Math.max(150, nh));
        tl.style.height = S.tlHeight + 'px';
      };
      tlResize.onpointerup = () => {
        tlResize.onpointermove = tlResize.onpointerup = null;
        tl.classList.remove('resizing');
        if (moved && !S.tlCollapsed) { try { localStorage.setItem('tlHeight', String(S.tlHeight)); } catch {} if (S.st) renderTimeline(); }
      };
    };

    const ws = h('div.ws', top, chat, boardWrap, insp, tl);
    root.replaceChildren(ws);
    setTlCollapsed(localStorage.getItem('tlCollapsed') === '1');

    // ---------------- data ----------------
    async function refresh(force) {
      try {
        const st = await window.om.projects.state(S.id);
        S.st = st;
        if (!Object.keys(S.layout).length || force) S.layout = st.layout || {};
        renderTop(); renderBoard(); renderGate(); renderTimeline(); renderInspector();
        checkVoice().then(() => renderTimeline());
        loadPreview();
        if (!S.fitted && S.nodes.size) { S.fitted = true; fit(); }
      } catch (e) {
        toast(e.message, 'err');
      }
    }

    function renderTop() {
      const st = S.st;
      titleEl.textContent = st.title || st.project_id;
      pipeEl.textContent = st.pipeline && st.pipeline.pipeline_type ? titleCase(st.pipeline.pipeline_type) : 'Pipeline not chosen yet';
      stagebar.replaceChildren(...(st.stages || []).map(s => h('div.stage.' + (s.status || 'pending'), { title: s.error || s.status },
        h('i.d'), titleCase(s.name), s.gated ? icon('lock', 'lock') : null)));
      const c = st.cost && (st.cost.total_spent_usd ?? st.cost.total);
      costEl.textContent = c != null ? '$' + Number(c).toFixed(2) : '';
    }

    function renderGate() {
      const g = (S.st.stages || []).find(s => s.status === 'awaiting_human');
      gate.classList.toggle('hidden', !g);
      if (!g) return;
      gate.replaceChildren(icon('lock'), h('div', h('div.t', t('Awaiting your approval') + ': ' + titleCase(g.name)),
        h('div.muted', { style: { fontSize: '11.5px' } }, 'Review the canvas, then approve or ask for changes.')),
        h('button.btn.sm.primary', { onclick: () => sendMessage(`I approve the ${g.name} stage. Continue to the next stage.`) }, icon('check'), t('Approve')),
        h('button.btn.sm', { onclick: () => { ta.value = `Before approving ${g.name}, please change: `; ta.focus(); } }, t('Request changes')));
    }

    // ---------------- board model ----------------
    function model() {
      const st = S.st;
      const A = st.artifacts || {};
      const list = [];
      const pp = A.proposal_packet;
      const rb = A.research_brief;
      if (pp || rb) {
        const concept = pp && pp.concept_options && pp.selected_concept ? pp.concept_options.find(c => c.concept_id === pp.selected_concept.concept_id || c.id === pp.selected_concept.concept_id) : null;
        list.push({ id: 'brief', kind: 'brief', title: 'Brief', data: { pp, rb, concept } });
      }
      if (A.script && (A.script.sections || []).length) list.push({ id: 'script', kind: 'script', title: t('Script'), data: A.script });
      (st.storyboard && st.storyboard.scenes || []).forEach((sc, i) => list.push({ id: 'scene:' + sc.id, kind: 'scene', title: `${t('Scene')} ${i + 1}`, data: sc, index: i }));
      const renders = (st.media && st.media.renders) || [];
      renders.forEach(r => list.push({ id: 'render:' + r.path, kind: 'render', title: r.path.split('/').pop(), data: r }));
      for (const m of (st.media && st.media.music) || []) list.push({ id: 'music:' + m.path, kind: 'audio', title: m.path.split('/').pop(), data: m });
      for (const f of st.files || []) {
        if (/^inputs\//.test(f.path)) list.push({ id: 'file:' + f.path, kind: 'upload', title: f.path.split('/').pop(), data: f });
      }
      // default positions
      const sceneNodes = list.filter(n => n.kind === 'scene');
      const rows = Math.ceil(sceneNodes.length / COLS) || 1;
      let leftY = 0, rightY = 0, upY = 0;
      for (const n of list) {
        if (S.layout[n.id]) { n.x = S.layout[n.id].x; n.y = S.layout[n.id].y; continue; }
        if (n.kind === 'brief') { n.x = 0; n.y = leftY; leftY += 300; }
        else if (n.kind === 'script') { n.x = 0; n.y = leftY; leftY += 420; }
        else if (n.kind === 'scene') { n.x = 360 + (n.index % COLS) * (NODE_W + 30); n.y = Math.floor(n.index / COLS) * 320; }
        else if (n.kind === 'upload') { n.x = -330; n.y = upY; upY += 250; }
        else { n.x = 360 + COLS * (NODE_W + 30) + 50; n.y = rightY; rightY += n.kind === 'render' ? 300 : 120; }
      }
      void rows;
      return list;
    }

    function sig(n) { return JSON.stringify([n.kind, n.data, S.sel.has(n.id)]); }

    function renderBoard() {
      const list = model();
      const seen = new Set();
      for (const n of list) {
        seen.add(n.id);
        const s = sig(n);
        let entry = S.nodes.get(n.id);
        if (!entry || entry.sig !== s) {
          const el = buildNode(n);
          if (entry) entry.el.replaceWith(el); else layer.appendChild(el);
          entry = { el, sig: s, n };
          S.nodes.set(n.id, entry);
        }
        entry.n = n;
        entry.el.style.transform = `translate(${n.x}px, ${n.y}px)`;
      }
      for (const [id, e] of S.nodes) if (!seen.has(id)) { e.el.remove(); S.nodes.delete(id); }
      drawEdges();
      const isEmpty = !list.length;
      empty.classList.toggle('hidden', !isEmpty);
      if (isEmpty) {
        empty.replaceChildren(h('div', icon('canvas'), h('h3', 'Your canvas is empty'),
          h('div', S.running ? 'The agent is working — research, proposal and script cards will appear here as they are written.'
            : 'Describe your video in the chat. The agent writes the brief, script, scenes and renders, and each one appears here live.')));
      }
      applyView();
    }

    function buildNode(n) {
      const sel = S.sel.has(n.id);
      const media = (rel, type, gen) => {
        const box = h('div.media' + (gen ? '.gen' : ''));
        if (rel && type === 'video') box.appendChild(h('video', { src: window.om.media(S.id, rel), muted: true, preload: 'metadata', playsInline: true, onmouseenter: e => e.target.play().catch(() => {}), onmouseleave: e => e.target.pause() }));
        else if (rel) box.style.backgroundImage = `url("${window.om.media(S.id, rel)}")`;
        else box.appendChild(icon(type === 'video' ? 'film' : 'image'));
        return box;
      };
      let body;
      let kindIcon = 'image';
      let cls = '';
      let right = null;
      const d = n.data;
      if (n.kind === 'scene') {
        const v = d.visual;
        const ok = v && v.exists && v.path;
        body = [media(ok ? v.path : null, v && v.type === 'video' ? 'video' : 'image', d.generating),
          h('div.desc', d.description || ''), d.narration ? h('div.narr', '“' + d.narration + '”') : null,
          h('div.foot', icon('film'), fmtTime(d.duration_seconds || ((d.end_seconds || 0) - (d.start_seconds || 0))),
            (d.takes || []).length > 1 ? h('span', `· ${d.takes.length} takes`) : null,
            d.hero_moment ? h('span.badge', 'HERO') : null)];
        kindIcon = v && v.type === 'video' ? 'film' : 'image';
        right = d.generating ? h('span.badge', 'generating') : (ok ? null : h('span.badge.gray', 'planned'));
      } else if (n.kind === 'script') {
        cls = '.text'; kindIcon = 'text';
        body = (d.sections || []).slice(0, 8).map(s => h('div.sec', h('b', `${s.label || s.id} · ${fmtTime(s.start_seconds)}`), s.text));
        right = h('span.muted', fmtTime(d.total_duration_seconds));
      } else if (n.kind === 'brief') {
        cls = '.text'; kindIcon = 'spark';
        const { pp, rb, concept } = d;
        body = [
          rb ? h('div.sec', h('b', 'Topic'), rb.topic || '') : null,
          concept ? h('div.sec', h('b', 'Concept'), concept.title || concept.logline || concept.concept_id || '') : null,
          pp && pp.production_plan ? h('div.sec', h('b', 'Render runtime'), pp.production_plan.render_runtime || '—') : null,
          pp && pp.cost_estimate ? h('div.sec', h('b', 'Estimated cost'), '$' + Number(pp.cost_estimate.total_estimated_usd || 0).toFixed(2) + ' · ' + (pp.cost_estimate.budget_verdict || '')) : null,
        ];
      } else if (n.kind === 'render') {
        cls = '.render'; kindIcon = 'film';
        body = [media(d.path, 'video'), h('div.foot', d.size ? (d.size / 1048576).toFixed(1) + ' MB' : '')];
      } else if (n.kind === 'audio') {
        kindIcon = 'music';
        body = [h('audio', { src: window.om.media(S.id, d.path), controls: true, style: { width: '100%' } })];
      } else if (n.kind === 'upload') {
        kindIcon = d.kind === 'audio' ? 'music' : d.kind === 'video' ? 'film' : 'image';
        body = d.kind === 'audio' ? [h('audio', { src: window.om.media(S.id, d.path), controls: true, style: { width: '100%' } })] : [media(d.path, d.kind)];
        right = h('span.badge.gray', 'upload');
      }
      const el = h('div.node' + cls + (sel ? '.sel' : ''), { style: { width: NODE_W + 'px' }, 'data-id': n.id },
        h('div.nh', icon(kindIcon), h('span.k', n.title), h('div.r', right)),
        h('div.nb', body));
      el.addEventListener('mousedown', (e) => startDrag(e, n.id));
      el.addEventListener('dblclick', () => { select(n.id, false); ta.focus(); });
      return el;
    }

    function center(id) {
      const e = S.nodes.get(id);
      if (!e) return null;
      return { x: e.n.x, y: e.n.y, w: e.el.offsetWidth || NODE_W, h: e.el.offsetHeight || 200 };
    }

    function drawEdges() {
      const links = [];
      const ids = [...S.nodes.keys()];
      const scenes = ids.filter(i => i.startsWith('scene:'));
      const renders = ids.filter(i => i.startsWith('render:'));
      if (S.nodes.has('brief') && S.nodes.has('script')) links.push(['brief', 'script']);
      const src = S.nodes.has('script') ? 'script' : (S.nodes.has('brief') ? 'brief' : null);
      if (src) scenes.forEach(s => links.push([src, s]));
      if (renders.length) scenes.forEach(s => links.push([s, renders[0]]));
      const paths = links.map(([a, b]) => {
        const A = center(a), B = center(b);
        if (!A || !B) return '';
        const vertical = a === 'brief' && b === 'script';
        if (vertical) return `M${A.x + A.w / 2},${A.y + A.h} C${A.x + A.w / 2},${A.y + A.h + 40} ${B.x + B.w / 2},${B.y - 40} ${B.x + B.w / 2},${B.y}`;
        const x1 = A.x + A.w, y1 = A.y + Math.min(A.h / 2, 60), x2 = B.x, y2 = B.y + Math.min(B.h / 2, 60);
        const dx = Math.max(40, Math.abs(x2 - x1) / 2);
        return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
      }).filter(Boolean);
      edges.innerHTML = paths.map(p => `<path d="${p}"/>`).join('');
    }

    // ---------------- pan / zoom / drag / select ----------------
    function applyView() {
      const { x, y, z } = S.view;
      layer.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
      board.style.backgroundSize = `${22 * z}px ${22 * z}px`;
      board.style.backgroundPosition = `${x}px ${y}px`;
      zoomLbl.textContent = Math.round(z * 100) + '%';
    }
    function zoomAt(f, cx, cy) {
      const z = Math.min(2.5, Math.max(0.15, S.view.z * f));
      const k = z / S.view.z;
      S.view.x = cx - (cx - S.view.x) * k;
      S.view.y = cy - (cy - S.view.y) * k;
      S.view.z = z;
      applyView();
    }
    function zoomBy(f) { const r = board.getBoundingClientRect(); zoomAt(f, r.width / 2, r.height / 2); }
    function fit() {
      const items = [...S.nodes.keys()].map(center).filter(Boolean);
      if (!items.length) return;
      const minX = Math.min(...items.map(i => i.x)), minY = Math.min(...items.map(i => i.y));
      const maxX = Math.max(...items.map(i => i.x + i.w)), maxY = Math.max(...items.map(i => i.y + i.h));
      const r = board.getBoundingClientRect();
      const z = Math.min(1.1, Math.max(0.2, Math.min((r.width - 120) / (maxX - minX), (r.height - 140) / (maxY - minY))));
      S.view = { z, x: (r.width - (maxX - minX) * z) / 2 - minX * z, y: Math.max(70, (r.height - (maxY - minY) * z) / 2) - minY * z };
      applyView();
    }
    function resetLayout() { S.layout = {}; window.om.projects.saveLayout(S.id, {}); renderBoard(); setTimeout(fit, 30); }

    board.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = board.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      else { S.view.x -= e.deltaX; S.view.y -= e.deltaY; applyView(); }
    }, { passive: false });

    board.addEventListener('mousedown', (e) => {
      if (e.target.closest('.node')) return;
      if (!e.shiftKey) { S.sel.clear(); selectionChanged(); }
      board.classList.add('panning');
      const sx = e.clientX, sy = e.clientY, ox = S.view.x, oy = S.view.y;
      const mv = (ev) => { S.view.x = ox + ev.clientX - sx; S.view.y = oy + ev.clientY - sy; applyView(); };
      const up = () => { board.classList.remove('panning'); window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    });

    let saveTimer;
    function startDrag(e, id) {
      if (e.button !== 0 || e.target.closest('video[controls],audio,button,a')) return;
      e.stopPropagation();
      const entry = S.nodes.get(id);
      const sx = e.clientX, sy = e.clientY, ox = entry.n.x, oy = entry.n.y;
      let moved = false;
      const mv = (ev) => {
        const dx = (ev.clientX - sx) / S.view.z, dy = (ev.clientY - sy) / S.view.z;
        if (!moved && Math.hypot(dx, dy) < 3) return;
        moved = true;
        entry.n.x = ox + dx; entry.n.y = oy + dy;
        entry.el.style.transform = `translate(${entry.n.x}px, ${entry.n.y}px)`;
        drawEdges();
      };
      const up = () => {
        window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
        if (moved) {
          S.layout[id] = { x: Math.round(entry.n.x), y: Math.round(entry.n.y) };
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => window.om.projects.saveLayout(S.id, S.layout), 300);
        } else select(id, e.shiftKey || e.metaKey || e.ctrlKey);
      };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    }

    function select(id, additive) {
      if (!additive) S.sel.clear();
      if (S.sel.has(id) && additive) S.sel.delete(id); else S.sel.add(id);
      selectionChanged();
      if (id.startsWith('scene:')) {
        const sc = modelScenes().find(x => 'scene:' + x.id === id);
        if (sc && !S.playing) seek(sc.start);
      }
    }
    function selectionChanged() {
      for (const [id, e] of S.nodes) e.el.classList.toggle('sel', S.sel.has(id));
      for (const c of tlMain.querySelectorAll('.clip[data-id]')) c.classList.toggle('sel', S.sel.has(c.dataset.id));
      for (const e of S.nodes.values()) e.sig = sig(e.n);
      renderFocus(); renderInspector();
    }

    // ---------------- inspector ----------------
    function focusLabel(id) {
      const e = S.nodes.get(id);
      if (!e) return id;
      const n = e.n;
      if (n.kind === 'scene') return `${n.title} (${n.data.id})`;
      return n.title;
    }
    function focusContext() {
      return [...S.sel].map((id) => {
        const e = S.nodes.get(id);
        if (!e) return null;
        const n = e.n, d = n.data;
        if (n.kind === 'scene') return `Scene ${d.id} [${fmtTime(d.start_seconds)}–${fmtTime(d.end_seconds)}]: "${d.description || ''}"` + (d.visual && d.visual.path ? ` — current visual: projects/${S.id}/${d.visual.path}` : ' — no visual yet');
        if (n.kind === 'script') return `The script (projects/${S.id}/artifacts/script.json)`;
        if (n.kind === 'brief') return `The brief / proposal (projects/${S.id}/artifacts/proposal_packet.json)`;
        if (n.kind === 'render') return `Final render projects/${S.id}/${d.path}`;
        return `File projects/${S.id}/${d.path}`;
      }).filter(Boolean);
    }

    function renderInspector() {
      const ids = [...S.sel];
      insp.classList.toggle('closed', ids.length !== 1);
      if (ids.length !== 1) return;
      const e = S.nodes.get(ids[0]);
      if (!e) return;
      const n = e.n, d = n.data;
      const quick = (labels) => h('div.quick', labels.map(([l, p]) => h('button.pill', { onclick: () => sendMessage(p) }, icon('wand'), l)));
      const editable = (label, value, save, rows = 3) => {
        const area = h('textarea.input', { rows }, value || '');
        const btn = h('button.btn.sm', { disabled: true, onclick: async () => {
          try { await save(area.value); toast('Saved. Ask the agent to apply it to the downstream assets if needed.'); btn.disabled = true; refresh(); }
          catch (err) { toast(err.message, 'err'); }
        } }, icon('check'), t('Save'));
        area.addEventListener('input', () => { btn.disabled = area.value === (value || ''); });
        return h('label.field', label, area, h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, btn));
      };
      let body = [];
      if (n.kind === 'scene') {
        const v = d.visual;
        const big = h('div.media');
        if (v && v.exists) big.appendChild(v.type === 'video' ? h('video', { src: window.om.media(S.id, v.path), controls: true }) : h('img', { src: window.om.media(S.id, v.path) }));
        const planIdx = (S.st.artifacts.scene_plan && S.st.artifacts.scene_plan.scenes || []).findIndex(s => s.id === d.id);
        body = [big,
          (d.takes || []).length > 1 ? h('div', h('div.muted', { style: { marginBottom: '6px' } }, 'Takes'),
            h('div.takes', d.takes.map(tk => h('div', { title: tk.prompt || tk.id, style: { backgroundImage: tk.type === 'image' ? `url("${window.om.media(S.id, tk.path)}")` : '' } })))) : null,
          h('dl.kv', h('dt', 'Time'), h('dd', `${fmtTime(d.start_seconds)} – ${fmtTime(d.end_seconds)}`),
            h('dt', 'Type'), h('dd', d.type || '—'), v ? h('dt', 'Model') : null, v ? h('dd', v.model || v.source_tool || '—') : null,
            v && v.cost_usd != null ? h('dt', 'Cost') : null, v && v.cost_usd != null ? h('dd', '$' + v.cost_usd) : null,
            d.shot_language ? h('dt', 'Shot') : null, d.shot_language ? h('dd', [d.framing, d.movement].filter(Boolean).join(' · ') || String(d.shot_language)) : null),
          h('div.quick', h('button.btn.sm', { onclick: () => playScene(d.id) }, icon('play'), 'Play scene'),
            h('button.btn.sm', { onclick: () => startExport({ sceneId: d.id }) }, icon('download'), 'Export scene')),
          planIdx >= 0 ? editable('Scene description', d.description, (val) => window.om.projects.patch(S.id, 'artifacts/scene_plan.json', `scenes.${planIdx}.description`, val)) : null,
          v && v.prompt ? h('label.field', 'Generation prompt', h('div.mono', { style: { color: 'var(--text-2)' } }, v.prompt)) : null,
          h('div', h('div.muted', { style: { marginBottom: '8px' } }, t('Edit with agent')),
            quick([['Regenerate shot', 'Regenerate the visual for the selected scene with a fresh take, keeping the same intent and style.'],
              ['More cinematic', 'Make the selected scene more cinematic: stronger composition, lighting and camera movement. Regenerate its visual.'],
              ['Animate it', 'Turn the selected scene still into a short motion clip (image-to-video) if the pipeline and budget allow.'],
              ['Rewrite narration', 'Rewrite the narration line for the selected scene to be punchier, keeping timing.']])),
        ];
      } else if (n.kind === 'script') {
        body = [h('div.muted', `${(d.sections || []).length} sections · ${fmtTime(d.total_duration_seconds)}`),
          ...(d.sections || []).map((s, i) => editable(`${s.label || s.id} · ${fmtTime(s.start_seconds)}–${fmtTime(s.end_seconds)}`, s.text,
            (val) => window.om.projects.patch(S.id, 'artifacts/script.json', `sections.${i}.text`, val), 2)),
          quick([['Tighten script', 'Tighten the script: cut filler, keep the total duration.'], ['Change tone', 'Rewrite the script in a more energetic, social-first tone.']])];
      } else if (n.kind === 'render') {
        body = [h('div.media', h('video', { src: window.om.media(S.id, d.path), controls: true })),
          h('div.quick', h('button.btn.sm', { onclick: () => window.om.projects.reveal(S.id, d.path) }, icon('folder'), 'Show file')),
          quick([['Vertical 9:16 cut', 'Create a vertical 9:16 version of the final render for Reels/TikTok.'],
            ['Add captions', 'Burn in styled captions on the final render.'], ['Review quality', 'Run the final review on this render and list concrete fixes.']])];
      } else if (n.kind === 'brief') {
        const { pp, concept } = d;
        body = [concept ? h('div', h('b', concept.title || concept.concept_id), h('div.muted', concept.logline || concept.summary || '')) : null,
          pp && pp.concept_options ? h('div', h('div.muted', { style: { marginBottom: '6px' } }, 'Concept options'),
            ...pp.concept_options.map(c => h('div.list-row', { onclick: () => sendMessage(`Switch to concept "${c.title || c.concept_id}" and redo the downstream stages.`) }, icon('spark'), c.title || c.concept_id))) : null];
      } else {
        body = [h('div.mono', d.path), h('button.btn.sm', { onclick: () => window.om.projects.reveal(S.id, d.path) }, icon('folder'), 'Show file')];
      }
      insp.replaceChildren(h('div.ih', n.title, h('div', { style: { flex: 1 } }), h('button.btn.ghost.sm.icon', { onclick: () => { S.sel.clear(); selectionChanged(); } }, icon('x'))), h('div.ib', body));
    }

    // ---------------- timeline + player (HyperFrames) ----------------
    // The player shows the agent's HyperFrames composition when one exists, otherwise a draft cut
    // the studio builds from the scenes, narration, music and captions (rebuilt when files change).
    let player = null, pvSig = '', pvLoading = false;
    const pvModel = () => (S.pv && S.pv.model) || null;
    function modelScenes() {
      const m = pvModel();
      if (m) return m.scenes;
      return ((S.st.storyboard && S.st.storyboard.scenes) || []).map(s => ({ id: s.id, start: s.start_seconds || 0, end: s.end_seconds || 0, visual: s.visual && s.visual.exists ? { path: s.visual.path, type: s.visual.type } : null, title: s.description }));
    }
    function duration() {
      if (player && isFinite(player.duration) && player.duration > 0) return player.duration;
      const m = pvModel();
      if (m) return m.duration;
      const sb = S.st && S.st.storyboard;
      return sb ? (sb.total_duration_seconds || Math.max(0, ...(sb.scenes || []).map(s => s.end_seconds || 0))) : 0;
    }
    function previewSignature() {
      const st = S.st;
      const sc = ((st.storyboard && st.storyboard.scenes) || []).map(s => [s.id, s.start_seconds, s.end_seconds, s.visual && s.visual.path, s.visual && s.visual.exists, s.narration]);
      const files = (st.files || []).filter(f => !/^(\.studio|renders)\//.test(f.path)).map(f => f.path + ':' + Math.round(f.mtime));
      return JSON.stringify([sc, files, S.preferDraft, (st.artifacts.asset_manifest || {}).assets && st.artifacts.asset_manifest.assets.length]);
    }
    async function loadPreview(force) {
      if (!S.st) return;
      const sig = previewSignature();
      if ((!force && sig === pvSig) || pvLoading) return;
      const hasScenes = ((S.st.storyboard && S.st.storyboard.scenes) || []).length > 0;
      pvSig = sig;
      if (!hasScenes) { S.pv = null; player = null; screen.replaceChildren(h('div.muted', { style: { textAlign: 'center', fontSize: '11px', padding: '10px' } }, 'The preview appears as soon as the scene plan exists.')); renderPlayerHead(); return; }
      pvLoading = true;
      try {
        S.pv = await window.om.hf.preview(S.id, { prefer: S.preferDraft ? 'draft' : undefined });
        mountPlayer(screen, S.pv.url, (p) => { player = p; });
        renderTimeline(); renderPlayerHead();
      } catch (e) {
        screen.replaceChildren(h('div.muted', { style: { padding: '10px', fontSize: '11px' } }, 'Preview failed: ' + e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));
      } finally { pvLoading = false; }
    }

    function mountPlayer(host, url, onReady, { big } = {}) {
      if (!window.customElements || !customElements.get('hyperframes-player')) {
        host.replaceChildren(h('div.muted', { style: { padding: '10px' } }, 'HyperFrames player is not installed (npm install).'));
        return null;
      }
      const keep = S.time || 0;
      const p = document.createElement('hyperframes-player');
      p.setAttribute('src', url + '&v=' + Date.now());
      p.setAttribute('controls', '');
      p.setAttribute('no-load-timeout', '');
      if (!big) p.setAttribute('low-power-idle', '');
      p.style.cssText = 'display:block;width:100%;height:100%;';
      p.addEventListener('ready', () => { if (keep && !big) { try { p.seek(keep); } catch {} } });
      if (!big) {
        p.addEventListener('timeupdate', () => { S.time = p.currentTime || 0; updatePlayhead(); });
        p.addEventListener('play', () => { S.playing = true; playBtn.replaceChildren(icon('pause')); });
        p.addEventListener('pause', () => { S.playing = false; playBtn.replaceChildren(icon('play')); });
        p.addEventListener('ended', () => { S.playing = false; playBtn.replaceChildren(icon('play')); });
      }
      p.addEventListener('error', (e) => toast('Preview error: ' + ((e.detail && e.detail.message) || 'could not load'), 'err'));
      host.replaceChildren(p);
      if (onReady) onReady(p);
      return p;
    }

    function renderPlayerHead() {
      const src = S.pv ? S.pv.source : null;
      const label = src === 'composition' ? 'Agent composition' : src === 'draft' ? 'Draft cut' : 'No preview yet';
      const kids = [h('span.badge.' + (src === 'composition' ? 'ok' : 'gray'), label)];
      if (S.pv && (S.pv.hasComposition || S.pv.hasDraftAlternative)) {
        kids.push(h('button.btn.ghost.sm', { title: 'Switch preview source', onclick: () => { S.preferDraft = !S.preferDraft; loadPreview(true); } }, S.preferDraft ? 'Use composition' : 'Use draft'));
      }
      if (S.range) kids.push(h('span.pill.active', { title: 'Playing one scene' }, S.range.id, h('button', { style: { background: 'none', border: 0, color: 'inherit', cursor: 'pointer' }, onclick: clearRange }, '×')));
      kids.push(h('div', { style: { flex: 1 } }));
      kids.push(h('button.btn.ghost.sm.icon', { title: 'Big preview', onclick: openBigPreview, disabled: !S.pv }, icon('fit')));
      pvHead.replaceChildren(...kids);
    }

    function playScene(sceneId) {
      const sc = modelScenes().find(s => s.id === sceneId);
      if (!sc || !player) return;
      S.range = { id: sceneId, start: sc.start, end: sc.end };
      player.setAttribute('range-start', String(sc.start));
      player.setAttribute('range-end', String(sc.end));
      try { player.seek(sc.start); player.play(); } catch {}
      renderPlayerHead();
    }
    function clearRange() {
      S.range = null;
      if (player) { player.removeAttribute('range-start'); player.removeAttribute('range-end'); }
      renderPlayerHead();
    }

    function openBigPreview() {
      if (!S.pv) return;
      const host = h('div', { style: { width: '100%', aspectRatio: pvModel() ? `${pvModel().width}/${pvModel().height}` : '16/9', maxHeight: '70vh', background: '#000', borderRadius: '12px', overflow: 'hidden', margin: '0 auto' } });
      if (player) player.pause();
      const sceneSel = [...S.sel].find(id => id.startsWith('scene:'));
      UI.modal({
        title: `${S.st.title || S.id} — ${S.pv.source === 'composition' ? 'Agent composition' : 'Draft cut'}`, wide: true,
        body: [host, h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
          sceneSel ? h('button.btn', { onclick: () => startExport({ sceneId: sceneSel.slice(6) }) }, icon('download'), 'Export this scene') : null,
          h('button.btn.primary', { onclick: () => startExport({}) }, icon('download'), 'Export video'))],
      });
      setTimeout(() => {
        const p = mountPlayer(host, S.pv.url, null, { big: true });
        if (p && S.range) { p.setAttribute('range-start', String(S.range.start)); p.setAttribute('range-end', String(S.range.end)); }
        if (p) p.addEventListener('ready', () => { try { p.seek(S.range ? S.range.start : (S.time || 0)); p.play(); } catch {} });
      }, 30);
    }

    function renderTimeline() {
      const dur = duration();
      const pps = 40 * S.tlZoom;
      const width = Math.max(tlMain.clientWidth - 4, OFF + dur * pps + 40);
      const scenes = modelScenes();
      const m = pvModel();
      const ruler = h('div.ruler', { style: { width: width + 'px' } });
      const step = dur > 120 ? 10 : dur > 40 ? 5 : 2;
      for (let s = 0; s <= dur + 0.01; s += step) ruler.appendChild(h('span', { style: { left: (OFF + s * pps) + 'px' } }, fmtTime(s)));
      const pos = (a, b) => ({ left: (OFF + a * pps) + 'px', width: Math.max(6, (b - a) * pps - 2) + 'px' });
      const vt = h('div.track', { style: { width: width + 'px' } }, h('span.lbl', 'Video'));
      for (const sc of scenes) {
        const v = sc.visual;
        const c = h('div.clip' + (v ? '' : '.card-clip'), { 'data-id': 'scene:' + sc.id, title: sc.title || sc.id,
          style: { ...pos(sc.start, sc.end), backgroundImage: v && v.type === 'image' ? `url("${window.om.media(S.id, v.path)}")` : '' },
          onclick: (e) => { e.stopPropagation(); select('scene:' + sc.id, e.shiftKey); seek(sc.start); },
          ondblclick: (e) => { e.stopPropagation(); playScene(sc.id); } }, h('span', sc.id));
        if (S.sel.has('scene:' + sc.id)) c.classList.add('sel');
        vt.appendChild(c);
      }
      const capT = h('div.track.sm', { style: { width: width + 'px' } }, h('span.lbl', 'Captions'));
      for (const c of (m && m.captions) || []) capT.appendChild(h('div.clip.cap-clip', { title: c.text, style: pos(c.start, c.end) }, h('span', { dir: 'auto' }, c.text)));
      const voT = h('div.track.sm', { style: { width: width + 'px' } }, h('span.lbl', 'Voice'));
      const voices = ((m && m.audio) || []).filter(a => a.kind === 'voice');
      if (voices.length) for (const a of voices) voT.appendChild(h('div.clip.narr', { title: a.path, style: pos(a.start, a.start + (a.duration || 3)) }, h('span', a.path.split('/').pop())));
      else if (S.missingVoice && S.missingVoice.length) voT.appendChild(h('div.clip.narr.missing', { style: pos(0, Math.max(1, dur)) }, h('span', `${S.missingVoice.length} voiceover files missing`)));
      const music = ((m && m.audio) || []).filter(a => a.kind === 'music');
      const mt = music.length ? h('div.track.sm', { style: { width: width + 'px' } }, h('span.lbl', 'Music'),
        h('div.clip.music', { style: pos(0, dur) }, h('span', music[0].path.split('/').pop()))) : null;
      const ph = h('div.playhead');
      const inner = h('div', { style: { position: 'relative', width: width + 'px', minHeight: '100%' } }, ruler, vt, capT, voT, mt, ph);
      const scrub = (e) => { const r = inner.getBoundingClientRect(); seek(Math.max(0, Math.min(dur, (e.clientX - r.left - OFF) / pps))); };
      ruler.addEventListener('mousedown', (e) => {
        scrub(e);
        const mv = (ev) => scrub(ev);
        const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
        window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
      });
      tlMain.replaceChildren(inner);
      tlMain.onwheel = (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); S.tlZoom = Math.min(6, Math.max(0.25, S.tlZoom * Math.exp(-e.deltaY * 0.01))); renderTimeline(); } };
      updatePlayhead();
    }

    function updatePlayhead() {
      const pps = 40 * S.tlZoom;
      const ph = tlMain.querySelector('.playhead');
      if (ph) ph.style.left = (OFF + S.time * pps) + 'px';
      timeEl.textContent = `${fmtTime(S.time)} / ${fmtTime(duration())}`;
    }

    function togglePlay() {
      if (!player) return;
      try { if (S.playing) player.pause(); else player.play(); } catch {}
    }
    function seek(sec) {
      S.time = sec;
      if (player) { try { player.seek(sec); } catch {} }
      updatePlayhead();
    }

    // ---------------- export ----------------
    function exportMenu(anchor) {
      const sceneSel = [...S.sel].find(id => id.startsWith('scene:'));
      let quality = localStorage.getItem('exportQuality') || 'standard';
      const q = h('div', { style: { display: 'flex', gap: '4px', padding: '4px 8px 8px' } },
        ...[['draft', 'Fast'], ['standard', 'Standard'], ['high', 'High']].map(([v, l]) => h('span.pill' + (quality === v ? '.active' : ''), {
          onclick: (e) => { e.stopPropagation(); quality = v; localStorage.setItem('exportQuality', v); q.querySelectorAll('.pill').forEach(x => x.classList.toggle('active', x.textContent === l)); },
        }, l)));
      const menu = h('div.menu', { style: { right: '0', left: 'auto', minWidth: '280px' } },
        h('div.mh', 'Export'),
        h('div.mi', { onclick: () => startExport({ quality }) }, icon('film'), h('div', h('div', 'Full video · MP4'), h('div.sub2', S.pv && S.pv.source === 'composition' ? 'Renders the agent composition' : 'Renders the draft cut (scenes + voice + music + captions)'))),
        h('div.mi' + (sceneSel ? '' : '.disabled'), { onclick: () => sceneSel && startExport({ sceneId: sceneSel.slice(6), quality }) }, icon('image'),
          h('div', h('div', sceneSel ? `Selected scene · ${sceneSel.slice(6)}` : 'Selected scene'), h('div.sub2', sceneSel ? 'Just this scene, with its voice, music and captions' : 'Select a scene on the canvas first'))),
        h('div.mi', { onclick: () => startExport({ quality, format: 'gif' }) }, icon('spark'), h('div', h('div', 'GIF'), h('div.sub2', 'Looping preview for chats and docs'))),
        h('div.mh', 'Quality'), q);
      anchor.appendChild(menu);
      const off = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', off); } };
      setTimeout(() => document.addEventListener('mousedown', off), 0);
    }

    async function startExport({ sceneId, quality, format }) {
      document.querySelectorAll('.menu').forEach(m => m.remove());
      if (S.job) return toast('An export is already running.', 'err');
      try {
        const r = await window.om.hf.export({ projectId: S.id, sceneId, quality: quality || localStorage.getItem('exportQuality') || 'standard', format: format || 'mp4', source: S.preferDraft ? 'draft' : 'auto' });
        S.job = { jobId: r.jobId, sceneId, pct: 1, message: 'Preparing' };
        renderJob();
      } catch (e) { toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err'); }
    }

    function renderJob() {
      const j = S.job;
      jobEl.classList.toggle('hidden', !j);
      if (!j) return;
      jobEl.replaceChildren(icon('download'),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px' } }, h('b', j.sceneId ? `Exporting ${j.sceneId}` : 'Exporting video'), h('span.mono', Math.round(j.pct || 0) + '%')),
          h('div.rail', { style: { marginTop: '6px' } }, h('i.completed', { style: { flex: 'none', width: Math.max(2, j.pct || 0) + '%' } }), h('i', { style: { flex: 1 } })),
          h('div.muted', { style: { fontSize: '11px', marginTop: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, j.message || '')),
        h('button.btn.ghost.sm', { onclick: () => window.om.hf.cancel(j.jobId) }, t('Cancel')));
    }

    function onExportProgress(ev) {
      if (ev.projectId !== S.id || !S.job || ev.jobId !== S.job.jobId) return;
      if (ev.done) {
        S.job = null; renderJob();
        if (ev.error) { if (ev.error !== 'Cancelled') toast('Export failed: ' + ev.error, 'err'); else toast('Export cancelled'); return; }
        toast('Exported: ' + ev.rel);
        window.om.projects.reveal(S.id, ev.rel);
        refresh();
        return;
      }
      S.job = { ...S.job, pct: ev.pct != null ? ev.pct : S.job.pct, message: ev.message || S.job.message };
      renderJob();
    }

    // ---------------- missing voiceover ----------------
    async function checkVoice() {
      try { S.missingVoice = await window.om.voice.missing(S.id); } catch { S.missingVoice = []; }
      const n = (S.missingVoice || []).length;
      voiceEl.classList.toggle('hidden', !n);
      const key = (S.missingVoice || []).map(m => m.path).join('|');
      if (!n || (key === S.voiceKey && voiceEl.childNodes.length)) { if (!n) S.voiceKey = ''; return; }
      S.voiceKey = key;
      const prov = [...new Set(S.missingVoice.map(m => m.provider).filter(Boolean))].join(', ');
      const picker = await HFToolsUI.voiceFixPicker(S.missingVoice);
      const sub = h('div.muted', { style: { fontSize: '11.5px' } });
      const paintSub = () => { sub.textContent = `Planned with ${prov || 'a TTS provider'} but never created. ${picker.note()}`; };
      picker.el.addEventListener('change', paintSub); paintSub();
      const go = h('button.btn.sm.primary', { onclick: async () => {
        go.disabled = true; go.replaceChildren(icon('refresh'), 'Generating…');
        const off = window.om.voice.onProgress((p) => { if (p.projectId === S.id && p.current) go.replaceChildren(icon('refresh'), p.total ? `${p.done}/${p.total}` : 'Generating…'); });
        try {
          const r = await window.om.voice.fix(S.id, picker.value());
          toast(`Generated ${r.generated} voiceover file(s)${r.engines && r.engines.length ? ' with ' + r.engines.join(' + ') : ''}`);
          await refresh(); loadPreview(true);
        } catch (e) { toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err'); go.disabled = false; go.replaceChildren(icon('mic'), 'Generate free'); }
        finally { off && off(); }
      } }, icon('mic'), 'Generate free');
      voiceEl.replaceChildren(icon('mic'),
        h('div', { style: { minWidth: '230px', flex: '1 1 260px' } }, h('div.t', `${n} voiceover file${n > 1 ? 's are' : ' is'} missing`), sub),
        picker.el, go);
    }

    // ---------------- chat ----------------
    function agentInfo(id) { return (app.agents || []).find(a => a.id === id) || { id, name: id, color: '#888' }; }
    function renderAgentPick() {
      const a = agentInfo(S.agentId);
      let menu = null;
      const cur = h('div.cur', h('div.avatar.sm', { style: { background: a.color } }, initials(a.name)), h('span', a.name),
        a.installed === false ? h('span.badge.err', '!') : null, icon('down'));
      cur.onclick = (e) => {
        e.stopPropagation();
        if (menu) { menu.remove(); menu = null; return; }
        const installed = (app.agents || []).filter(x => x.installed);
        const missing = (app.agents || []).filter(x => !x.installed);
        menu = h('div.menu',
          h('div.mh', 'Installed on this computer'),
          installed.length ? installed.map(x => item(x)) : h('div.mi.disabled', 'No agent CLIs found'),
          missing.length ? h('div.mh', 'Not installed') : null, missing.map(x => item(x)),
          h('div.mi', { onclick: () => app.go('agents') }, icon('plus'), t('Add custom agent')));
        agentPick.appendChild(menu);
        const off = () => { if (menu) menu.remove(); menu = null; document.removeEventListener('click', off); };
        setTimeout(() => document.addEventListener('click', off), 0);
      };
      const item = (x) => h('div.mi' + (x.installed ? '' : '.disabled'), {
        onclick: () => {
          if (!x.installed) { app.go('agents'); return; }
          S.agentId = x.id; localStorage.setItem('agent:' + S.id, x.id); renderAgentPick(); renderModelPick();
        },
      }, h('div.avatar.sm', { style: { background: x.color } }, initials(x.name)),
      h('div', h('div', x.name), h('div.sub2', x.installed ? (x.version || x.cmd) : (x.install || x.cmd))),
      x.id === S.agentId ? icon('check') : null);
      agentPick.replaceChildren(cur);
    }

    // ---------------- model picker ----------------
    const modelKey = (agentId) => `model:${S.id}:${agentId}`;
    function getModel(agentId = S.agentId) {
      const v = localStorage.getItem(modelKey(agentId));
      if (v !== null) return v;
      return localStorage.getItem(`model:*:${agentId}`) || '';
    }
    function setModel(m, agentId = S.agentId) {
      localStorage.setItem(modelKey(agentId), m);
      localStorage.setItem(`model:*:${agentId}`, m); // new projects start with the last choice
      if (m) {
        const a = agentInfo(agentId);
        if (!(a.models || []).some(x => x.id === m)) {
          const rk = `modelRecent:${agentId}`;
          const rec = JSON.parse(localStorage.getItem(rk) || '[]').filter(x => x !== m);
          localStorage.setItem(rk, JSON.stringify([m, ...rec].slice(0, 6)));
        }
      }
      renderModelPick();
    }
    function modelLabel(agentId, m) {
      if (!m) return 'Default';
      const x = (agentInfo(agentId).models || []).find(o => o.id === m);
      return x ? x.label : m;
    }
    function renderModelPick() {
      const a = agentInfo(S.agentId);
      const cur = getModel();
      let menu = null;
      const btn = h('div.cur', { title: 'Model' }, icon('spark'), h('span', modelLabel(S.agentId, cur)), icon('down'));
      btn.onclick = (e) => {
        e.stopPropagation();
        if (menu) { menu.remove(); menu = null; return; }
        const recent = JSON.parse(localStorage.getItem(`modelRecent:${S.agentId}`) || '[]');
        const custom = h('input.input.mono', { placeholder: 'model id, e.g. gpt-5-codex', style: { height: '30px' },
          onclick: (ev) => ev.stopPropagation(),
          onkeydown: (ev) => { if (ev.key === 'Enter' && custom.value.trim()) { setModel(custom.value.trim()); close(); } } });
        const item = (id, label, note) => h('div.mi', { onclick: () => { setModel(id); close(); } },
          h('div', { style: { flex: 1 } }, h('div', label), note ? h('div.sub2', note) : null), (cur || '') === id ? icon('check') : null);
        menu = h('div.menu', { style: { minWidth: '270px' } },
          h('div.mh', `${a.name} model`),
          item('', 'Default', "The CLI's own setting"),
          ...(a.models || []).map(o => item(o.id, o.label, o.note || o.id)),
          recent.length ? h('div.mh', 'Recent') : null, ...recent.map(r => item(r, r, 'custom')),
          h('div.mh', 'Custom'),
          h('div', { style: { padding: '2px 8px 8px', display: 'flex', gap: '6px' } }, custom,
            h('button.btn.sm', { onclick: (ev) => { ev.stopPropagation(); if (custom.value.trim()) { setModel(custom.value.trim()); close(); } } }, 'Use')),
          a.modelArgs ? h('div.muted', { style: { fontSize: '10.5px', padding: '0 8px 6px' } }, `Passed as ${a.modelArgs.join(' ').replace('{model}', '<model>')}`) : null);
        modelPick.appendChild(menu);
        setTimeout(() => document.addEventListener('click', close), 0);
      };
      const close = () => { if (menu) menu.remove(); menu = null; document.removeEventListener('click', close); };
      modelPick.replaceChildren(btn);
    }

    function renderFocus() {
      focusbar.replaceChildren(...[...S.sel].map(id => h('span.fc', icon('wand'), focusLabel(id),
        h('button', { onclick: () => { S.sel.delete(id); selectionChanged(); } }, '×'))));
    }

    function renderMsgs() {
      const list = S.history.messages || [];
      if (!list.length) {
        const pt = S.st && S.st.pipeline && S.st.pipeline.pipeline_type;
        msgs.replaceChildren(h('div', { style: { color: 'var(--text-3)', padding: '6px 2px' } },
          h('div', { style: { color: 'var(--text)', fontWeight: 600, marginBottom: '6px' } }, 'Direct your video'),
          h('div', { style: { marginBottom: '12px' } }, `Every message goes to ${agentInfo(S.agentId).name}, running inside your OpenMontage folder. Select items on the canvas to point at them.`),
          h('div.suggest', [
            pt ? `Start the ${pt} pipeline for this project. Begin with research.` : 'Make a 45-second animated explainer about how solar panels work, warm friendly style.',
            'Continue the production from the last checkpoint.',
            'Show me the available providers and estimated costs before generating anything.',
          ].map(s => h('button.pill', { onclick: () => { ta.value = s; ta.focus(); } }, s)))));
        return;
      }
      const stick = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
      msgs.replaceChildren(...list.map((m, i) => renderMsg(m, i, list)));
      if (stick || !renderMsgs.once) msgs.scrollTop = msgs.scrollHeight;
      renderMsgs.once = true;
    }

    function renderMsg(m, idx = 0, list = []) {
      if (m.role === 'user') {
        return h('div.msg.user', (m.focus || []).length ? h('div.focus', m.focus.map(f => h('span', f.length > 50 ? f.slice(0, 50) + '…' : f))) : null, m.text);
      }
      const a = agentInfo(m.agent);
      const out = [];
      let steps = [];
      const flush = () => {
        if (!steps.length) return;
        if (steps.length <= 3) out.push(...steps.map(stepEl));
        else out.push(h('details', h('summary.tool', icon('gear'), h('b', `${steps.length} steps`), h('span', steps.at(-1).name ? `${steps.at(-1).name} ${steps.at(-1).detail || ''}` : (steps.at(-1).text || ''))), ...steps.map(stepEl)));
        steps = [];
      };
      const stepEl = (p) => p.type === 'tool' ? h('div.tool', h('b', p.name), h('span', p.detail || ''))
        : h('div.tool.res' + (p.isError ? '.err' : ''), h('span', (p.text || '').split('\n')[0] || (p.isError ? 'error' : 'ok')));
      const questions = [];
      const textParts = (m.parts || []).filter(p => p.type === 'text');
      for (const p of m.parts || []) {
        if (p.type === 'tool' || p.type === 'tool_result') { steps.push(p); continue; }
        flush();
        if (p.type === 'question') { questions.push(...(p.questions || [])); continue; }
        if (p.type === 'text' && p.text.trim()) {
          // structured questions become cards; an unfinished block (still streaming) is hidden
          const parsed = Questions.parseBlocks(p.text.replace(/<studio-question\b(?![\s\S]*<\/studio-question>)[\s\S]*$/i, ''));
          questions.push(...parsed.questions.filter(q => q.options.length));
          if (parsed.text) out.push(h('div.txt', { html: md(parsed.text) }));
          continue;
        }
        else if (p.type === 'stderr' && p.text.trim()) out.push(h('div.stderr', p.text.trim().slice(-1200)));
        else if (p.type === 'result') out.push(h('div.result', p.costUsd != null ? h('span', '$' + Number(p.costUsd).toFixed(3)) : null, p.durationMs ? h('span', Math.round(p.durationMs / 1000) + 's') : null, p.isError ? h('span.badge.err', 'error') : null));
        else if (p.type === 'raw') out.push(h('div.tool.res', h('span', p.text)));
      }
      flush();
      // fallback: a plain-text question with A/B/C or 1/2/3 options at the end of the reply
      if (!questions.length && m.done && textParts.length) {
        const loose = Questions.parseLoose(textParts[textParts.length - 1].text);
        if (loose) questions.push(loose);
      }
      if (questions.length) {
        const answeredLater = list.slice(idx + 1).some(x => x.role === 'user');
        const ansKey = `ans:${S.id}:${idx}`;
        let chosen = {};
        try { chosen = JSON.parse(localStorage.getItem(ansKey) || '{}'); } catch {}
        out.push(Questions.renderQuestions(questions, {
          locked: answeredLater || !m.done || S.running, answered: answeredLater, chosen,
          onAnswer: (text, snapshot) => { localStorage.setItem(ansKey, JSON.stringify(snapshot)); sendMessage(text); },
        }));
      }
      if (!m.done) out.push(h('div.typing', h('i'), h('i'), h('i')));
      else if (m.code && m.code !== 0 && !(m.parts || []).some(p => p.type === 'result')) out.push(h('div.tool.err', h('span', `Agent exited with code ${m.code}`)));
      return h('div.msg.assistant', h('div.who', h('div.avatar.sm', { style: { background: a.color } }, initials(a.name)), a.name,
        m.model ? h('span.badge.gray', modelLabel(m.agent, m.model)) : null), out);
    }

    function setRunning(r) {
      S.running = r;
      sendBtn.replaceChildren(icon(r ? 'stop' : 'send'), r ? t('Stop') : t('Send'));
      sendBtn.classList.toggle('primary', !r);
    }

    async function sendMessage(text) {
      text = (text || '').trim();
      if (!text) return;
      if (S.running) { toast('The agent is still working. Stop it or wait for it to finish.', 'err'); return; }
      const a = agentInfo(S.agentId);
      if (a.installed === false) { toast(`${a.name} is not installed. Pick another agent or install it.`, 'err'); return; }
      const focus = focusContext();
      const focusLabels = [...S.sel].map(focusLabel);
      try {
        setRunning(true);
        S.history.messages.push({ role: 'user', text, focus: [...S.sel].map(focusLabel) }, { role: 'assistant', agent: S.agentId, model: getModel() || null, parts: [], done: false, ts: Date.now() });
        renderMsgs();
        msgs.scrollTop = msgs.scrollHeight;
        await window.om.chat.send({ projectId: S.id, agentId: S.agentId, model: getModel() || undefined, message: text, focus, focusLabels, pipeline: S.st && S.st.pipeline && S.st.pipeline.pipeline_type, title: S.st && S.st.title });
      } catch (e) {
        setRunning(false);
        S.history.messages.pop();
        renderMsgs();
        toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err');
      }
    }

    function onChatEvent(ev) {
      if (ev.projectId !== S.id) return;
      const last = S.history.messages.at(-1);
      if (!last || last.role !== 'assistant') return;
      if (ev.type === 'text' && ev.delta) {
        const lp = last.parts.at(-1);
        if (lp && lp.type === 'text') lp.text += ev.text; else last.parts.push({ type: 'text', text: ev.text });
      } else if (ev.type === 'stderr') {
        const lp = last.parts.at(-1);
        if (lp && lp.type === 'stderr') lp.text = (lp.text + ev.text).slice(-4000); else last.parts.push({ type: 'stderr', text: ev.text });
      } else if (ev.type === 'exit') {
        last.done = true; last.code = ev.code; setRunning(false); refresh();
      } else if (ev.type !== 'session') {
        last.parts.push(ev);
        if (ev.type === 'tool' || ev.type === 'tool_result') scheduleRefresh();
      }
      renderMsgs();
    }

    let rt;
    function scheduleRefresh() { clearTimeout(rt); rt = setTimeout(refresh, 700); }

    async function newChat() {
      if (S.running) return toast('Stop the agent first.', 'err');
      await window.om.chat.clear(S.id);
      S.history = { messages: [], agentIds: {} };
      renderMsgs();
    }

    sendBtn.onclick = () => { if (S.running) window.om.chat.stop(S.id); else { const v = ta.value; ta.value = ''; sendMessage(v); } };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendBtn.click(); }
    });
    attachBtn.onclick = async () => {
      const files = await window.om.projects.import(S.id);
      if (files.length) { ta.value += (ta.value ? '\n' : '') + 'Use these files I added: ' + files.map(f => `projects/${S.id}/${f}`).join(', '); refresh(); }
    };

    // keyboard: space toggles play when not typing
    const onKey = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      if (e.key === 'Escape') { S.sel.clear(); selectionChanged(); }
      if (e.key === 'f') fit();
    };
    document.addEventListener('keydown', onKey);

    // ---------------- boot ----------------
    S.unsub.push(window.om.chat.onEvent(onChatEvent));
    S.unsub.push(window.om.hf.onProgress(onExportProgress));
    S.unsub.push(window.om.projects.onChanged((pid) => { if (pid === S.id) scheduleRefresh(); }));
    const poll = setInterval(() => { if (S.running) refresh(); }, 5000);
    let lastW = 0, roRaf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(roRaf);
      roRaf = requestAnimationFrame(() => { const w = tlMain.clientWidth; if (S.st && Math.abs(w - lastW) > 2) { lastW = w; renderTimeline(); } });
    });
    ro.observe(tlMain);

    renderAgentPick();
    renderModelPick();
    (async () => {
      S.history = await window.om.chat.history(S.id);
      const running = await window.om.chat.running();
      const last = S.history.messages.at(-1);
      setRunning(running.includes(S.id));
      if (last && last.role === 'assistant' && !last.done && !running.includes(S.id)) last.done = true;
      await refresh();
      renderMsgs();
      renderFocus();
      if (app.pendingPrompt && app.pendingPrompt.projectId === S.id) {
        const p = app.pendingPrompt; app.pendingPrompt = null;
        if (p.agentId) { S.agentId = p.agentId; localStorage.setItem('agent:' + S.id, p.agentId); renderAgentPick(); }
        sendMessage(p.text);
      }
    })();

    return {
      destroy() {
        S.unsub.forEach(f => f()); clearInterval(poll); ro.disconnect();
        document.removeEventListener('keydown', onKey);
        if (player) { try { player.pause(); } catch {} }
      },
      refreshAgents: renderAgentPick,
    };
  }

  window.Workspace = Workspace;
})();
