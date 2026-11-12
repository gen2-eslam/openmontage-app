/* Agent questions → clickable choice cards.
   Sources: <studio-question> blocks in the agent's text, AskUserQuestion-style tool calls,
   and (fallback) a plain-text question followed by lettered/numbered options. */
(function () {
  const { h, icon, md } = UI;

  const OPT_RE = /^\s*(?:[-*•]\s*)?(?:\[\s*([A-Za-z0-9])\s*\]|\(?\**\s*([A-Fa-f]|[1-9])\s*\**[).:\]]|\**\s*(?:option|خيار|اختيار)\s+([A-Fa-f1-9])\s*\**\s*[:.)–—-])\s*(.+)$/i;

  function splitOption(rest) {
    const t = rest.replace(/\*\*/g, '').trim();
    const m = t.match(/^(.+?)\s+[—–-]\s+(.+)$/) || t.match(/^(.+?):\s+(.+)$/);
    let label = m ? m[1].trim() : t, description = m ? m[2].trim() : '';
    const recommended = /\(recommended\)|\(مُ?قترح\)|\(موصى به\)/i.test(label + ' ' + description);
    label = label.replace(/\s*\((recommended|مُ?قترح|موصى به)\)\s*/i, '').trim();
    return { label, description, recommended };
  }

  /** Parse <studio-question> blocks. Returns { text, questions }. */
  function parseBlocks(text) {
    const questions = [];
    const clean = String(text || '').replace(/<studio-question\b([^>]*)>([\s\S]*?)<\/studio-question>/gi, (_, attrs, body) => {
      const id = (attrs.match(/id\s*=\s*"([^"]+)"/) || [])[1] || 'q' + (questions.length + 1);
      const multi = /multi\s*=\s*"(true|1|yes)"/i.test(attrs);
      const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
      const options = [];
      const qLines = [];
      for (const l of lines) {
        const m = l.match(OPT_RE);
        if (m) { const key = (m[1] || m[2] || m[3]).toUpperCase(); options.push({ key, ...splitOption(m[4]) }); }
        else if (!options.length) qLines.push(l);
        else options[options.length - 1].description += (options[options.length - 1].description ? ' ' : '') + l;
      }
      questions.push({ id, multi, question: qLines.join(' '), options });
      return '';
    });
    return { text: clean.trim(), questions };
  }

  /** Fallback: last question in plain text followed by ≥2 options (A/B/C or 1/2/3). */
  function parseLoose(text) {
    const lines = String(text || '').split('\n');
    let end = lines.length - 1;
    while (end >= 0 && !lines[end].trim()) end--;
    // allow up to two closing lines after the options ("Reply with the number.")
    for (let k = end, seen = 0; k >= 0 && seen < 3; k--) {
      if (!lines[k].trim()) continue;
      if (OPT_RE.test(lines[k])) { end = k; break; }
      seen++;
    }
    // walk up collecting options
    const opts = [];
    let i = end;
    for (; i >= 0; i--) {
      const l = lines[i];
      if (!l.trim()) { if (opts.length) continue; else continue; }
      const m = l.match(OPT_RE);
      if (m) opts.unshift({ key: (m[1] || m[2] || m[3]).toUpperCase(), ...splitOption(m[4]), line: i });
      else if (opts.length && /^\s{2,}\S/.test(l)) opts[0].description += ' ' + l.trim();
      else break;
    }
    if (opts.length < 2 || opts.length > 8) return null;
    // the question: nearest preceding non-empty line(s) ending with ? / ؟ / :
    let q = '';
    for (let j = i; j >= Math.max(0, i - 4); j--) {
      const l = lines[j] && lines[j].trim();
      if (!l) continue;
      if (/[?؟:]\s*\**$/.test(l)) { q = l.replace(/[*#>]/g, '').trim(); break; }
      break;
    }
    if (!q) return null;
    // trailing text after the options (e.g. "Reply with A, B or C") is fine; we keep the text as-is
    return { id: 'auto', multi: false, question: q, options: opts.map(({ line, ...o }) => o), loose: true };
  }

  /**
   * Render a question group. opts: { locked, chosen: {qid: [keys] | text}, onAnswer(text, chosen) }
   */
  function renderQuestions(questions, opts = {}) {
    const state = {};
    const locked = !!opts.locked;
    const chosen = opts.chosen || {};
    const single = questions.length === 1 && !questions[0].multi;
    const sendBtn = h('button.btn.sm.primary', { disabled: true }, icon('send'), questions.length > 1 ? 'Send answers' : 'Send');
    const otherInputs = {};
    const refresh = () => { sendBtn.disabled = locked || !questions.every(q => (state[q.id] && state[q.id].length) || (otherInputs[q.id] && otherInputs[q.id].value.trim())); };

    const answerText = () => questions.map((q) => {
      const other = otherInputs[q.id] && otherInputs[q.id].value.trim();
      const picks = (state[q.id] || []).map(k => q.options.find(o => o.key === k)).filter(Boolean);
      const ans = other ? other : picks.map(o => `${o.key}) ${o.label}`).join(', ');
      return questions.length > 1 || !q.loose ? `${q.question}\n→ ${ans}` : ans;
    }).join('\n\n');

    const submit = () => {
      if (locked || !opts.onAnswer) return;
      const snapshot = {};
      for (const q of questions) snapshot[q.id] = (otherInputs[q.id] && otherInputs[q.id].value.trim()) || state[q.id] || [];
      opts.onAnswer(answerText(), snapshot);
    };
    sendBtn.onclick = submit;

    const cards = questions.map((q) => {
      state[q.id] = Array.isArray(chosen[q.id]) ? [...chosen[q.id]] : [];
      const optEls = q.options.map((o) => {
        const isOn = () => state[q.id].includes(o.key);
        const el = h('button.q-opt' + (isOn() ? '.on' : '') + (o.recommended ? '.rec' : ''), {
          disabled: locked, type: 'button',
          onclick: () => {
            if (q.multi) state[q.id] = isOn() ? state[q.id].filter(k => k !== o.key) : [...state[q.id], o.key];
            else state[q.id] = [o.key];
            if (otherInputs[q.id]) otherInputs[q.id].value = '';
            for (const x of optEls) x.classList.toggle('on', state[q.id].includes(x.dataset.key));
            refresh();
            if (single) submit(); // one question, one choice → answer straight away
          },
          'data-key': o.key,
        },
        h('span.q-key', q.multi ? (isOn() ? '✓' : '') : o.key),
        h('span.q-body', h('span.q-label', { dir: 'auto' }, o.label, o.recommended ? h('span.badge', { style: { marginInlineStart: '6px' } }, 'Recommended') : null),
          o.description ? h('span.q-desc', { dir: 'auto' }, o.description) : null));
        return el;
      });
      const other = h('input.input.q-other', { placeholder: 'Or type your own answer…', disabled: locked, dir: 'auto',
        value: typeof chosen[q.id] === 'string' ? chosen[q.id] : '',
        oninput: () => { if (other.value.trim()) { state[q.id] = []; optEls.forEach(x => x.classList.remove('on')); } refresh(); },
        onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing && other.value.trim()) { e.preventDefault(); submit(); } } });
      otherInputs[q.id] = other;
      return h('div.q-card',
        h('div.q-head', icon('chat'), q.header ? h('span.badge.gray', q.header) : null, q.multi ? h('span.badge.gray', 'Pick any') : null, opts.answered ? h('span.badge.ok', 'Answered') : null),
        h('div.q-text', { dir: 'auto', html: md(q.question) }),
        h('div.q-opts', optEls), locked ? null : other);
    });
    refresh();
    const showSend = !locked && (!single);
    const wrap = h('div.q-group', cards, showSend ? h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, sendBtn) : null,
      !locked && single ? h('div.muted', { style: { fontSize: '11px' } }, 'Click an option to answer, or type your own and press Enter.') : null);
    return wrap;
  }

  window.Questions = { parseBlocks, parseLoose, renderQuestions };
})();
