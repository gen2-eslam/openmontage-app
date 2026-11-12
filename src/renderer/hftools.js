// HyperFrames tools panel (inside a project): Kokoro voice, captions, blocks catalog, media
// (background removal, beats), website capture, review (check + snapshots).
// Also exports a voice picker used by the "missing voiceover" banner.
(() => {
  const { h, icon, toast, modal } = window.UI;
  const clean = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const ARABIC = /[؀-ۿ]/;
  let voicesCache = null;
  const voices = async () => (voicesCache = voicesCache || await window.om.hft.voices());

  async function voiceSelect(value) {
    const list = await voices();
    const byLang = {};
    for (const v of list) (byLang[v.language] = byLang[v.language] || []).push(v);
    const sel = h('select.input', { style: { height: '32px' } },
      ...Object.entries(byLang).map(([lang, vs]) => h('optgroup', { label: lang },
        ...vs.sort((a, b) => (b.top - a.top) || a.name.localeCompare(b.name)).map(v => h('option', { value: v.id }, `${v.top ? '★ ' : ''}${v.name} · ${v.gender}`)))));
    sel.value = value || localStorage.getItem('kokoroVoice') || 'am_michael';
    sel.onchange = () => localStorage.setItem('kokoroVoice', sel.value);
    return sel;
  }

  let audioEl = null;
  async function playBytes(bytes, type) {
    if (audioEl) { audioEl.pause(); URL.revokeObjectURL(audioEl.src); }
    audioEl = new Audio(URL.createObjectURL(new Blob([bytes], { type })));
    await audioEl.play().catch(() => {});
  }

  /** Kokoro status line with an install button. onReady(status) after install. */
  function kokoroStatus(onReady) {
    const box = h('div.hft-status');
    const paint = async () => {
      let st; try { st = await window.om.hft.status(); } catch (e) { box.replaceChildren(h('span.badge.err', 'HyperFrames unavailable'), h('span.muted', clean(e))); return; }
      if (st.kokoro.ready) { box.replaceChildren(h('span.badge.ok', 'Kokoro ready'), h('span.muted', 'Local, offline, free · 54 voices')); onReady && onReady(st); return; }
      const btn = h('button.btn.sm.primary', icon('download'), 'Install Kokoro voices');
      const msg = h('span.muted', 'One-time download, about 340 MB (model + voices).');
      btn.onclick = async () => {
        btn.disabled = true; btn.replaceChildren(icon('refresh'), 'Installing…');
        const off = window.om.hft.onKokoro((p) => { msg.textContent = p.message + (p.pct ? ` · ${p.pct}%` : ''); });
        try { await window.om.hft.installKokoro(); toast('Kokoro voices installed'); paint(); }
        catch (e) { toast(clean(e), 'err'); btn.disabled = false; btn.replaceChildren(icon('download'), 'Retry install'); }
        finally { off && off(); }
      };
      box.replaceChildren(h('span.badge.warn', 'Not installed'), msg, btn);
    };
    paint();
    return box;
  }

  /** Picker for the missing-voiceover banner. Returns {el, value()}. */
  async function voiceFixPicker(lines) {
    const arabic = (lines || []).some(l => ARABIC.test(l.text || ''));
    const allArabic = (lines || []).length && (lines || []).every(l => ARABIC.test(l.text || ''));
    let st = { kokoro: { ready: false } }; try { st = await window.om.hft.status(); } catch {}
    const sx = { height: '30px', padding: '0 26px 0 8px' };
    const engine = h('select.input', { style: { ...sx, width: '170px' }, title: 'Voice engine' },
      h('option', { value: 'auto' }, 'Auto (best free)'),
      h('option', { value: 'kokoro' }, 'Kokoro · HyperFrames'),
      h('option', { value: 'edge' }, 'Edge TTS'));
    engine.value = allArabic ? 'edge' : (localStorage.getItem('voiceEngine') || 'auto');
    const dialect = h('select.input', { style: { ...sx, width: '130px' }, title: 'Arabic dialect (Edge TTS)' },
      ...[['egyptian', 'مصري'], ['saudi', 'سعودي'], ['emirati', 'إماراتي'], ['jordanian', 'أردني'], ['lebanese', 'لبناني'], ['moroccan', 'مغربي']].map(([v, l]) => h('option', { value: v }, l)),
      h('option', { value: 'en-US-AndrewMultilingualNeural' }, 'English (Andrew)'), h('option', { value: 'en-US-AvaMultilingualNeural' }, 'English (Ava)'));
    const gender = h('select.input', { style: { ...sx, width: '92px' } }, h('option', { value: 'male' }, 'Male'), h('option', { value: 'female' }, 'Female'));
    const kv = await voiceSelect();
    Object.assign(kv.style, { ...sx, width: '170px' });
    const preview = h('button.btn.sm.icon', { title: 'Preview voice' }, icon('play'));
    const usesKokoro = () => engine.value === 'kokoro' || (engine.value === 'auto' && st.kokoro.ready);
    const sync = () => {
      localStorage.setItem('voiceEngine', engine.value);
      const k = usesKokoro() && !allArabic;
      kv.style.display = k ? '' : 'none';
      dialect.style.display = (!k || arabic) ? '' : 'none';
      gender.style.display = (!k || arabic) ? '' : 'none';
    };
    engine.onchange = sync; sync();
    preview.onclick = async () => {
      preview.disabled = true;
      try {
        const sample = ((lines || [])[0] || {}).text || 'This is how the narration will sound.';
        if (usesKokoro() && !ARABIC.test(sample)) await playBytes(await window.om.hft.preview({ text: sample.slice(0, 220), voice: kv.value }), 'audio/wav');
        else {
          const voice = dialect.value.includes('Neural') ? dialect.value : undefined;
          await playBytes(await window.om.addons.ttsPreview({ text: sample.slice(0, 220), voice, dialect: voice ? undefined : dialect.value, gender: gender.value }), 'audio/mpeg');
        }
      } catch (e) { toast(clean(e), 'err'); } finally { preview.disabled = false; }
    };
    const el = h('div.vfix', engine, kv, dialect, gender, preview);
    return {
      el,
      value: () => {
        const voice = dialect.value.includes('Neural') ? dialect.value : undefined;
        return { engine: engine.value, kokoroVoice: kv.value, dialect: voice ? undefined : dialect.value, gender: gender.value, voice };
      },
      note: () => arabic && !allArabic && usesKokoro() ? 'Arabic lines use Edge TTS (Kokoro has no Arabic).' : allArabic ? 'Arabic narration → Edge TTS dialect voices.' : usesKokoro() ? 'Kokoro — the local voice model HyperFrames uses.' : 'Edge TTS (free, online).',
    };
  }

  // ---------------- the panel ----------------
  function open(ctx) {
    const tabs = [
      ['voice', 'Voice', 'mic'], ['captions', 'Captions', 'text'], ['blocks', 'Blocks', 'layout'],
      ['media', 'Media', 'image'], ['website', 'Website', 'globe'], ['review', 'Review', 'eye'],
    ];
    let cur = localStorage.getItem('hftTab') || 'voice';
    const nav = h('div.hft-tabs');
    const pane = h('div.hft-pane');
    const files = (re) => (ctx.files() || []).map(f => f.path).filter(p => re.test(p) && !/^(\.studio|history)\//.test(p));
    const pick = (re, empty) => {
      const list = files(re);
      return list.length ? h('select.input', ...list.map(p => h('option', { value: p }, p))) : h('div.muted', empty);
    };
    const busy = (btn, label) => { btn.disabled = true; btn.dataset.l = btn.textContent; btn.replaceChildren(icon('refresh'), label || 'Working…'); };
    const unbusy = (btn, ic) => { btn.disabled = false; btn.replaceChildren(icon(ic || 'check'), btn.dataset.l || 'Run'); };
    const logBox = () => h('div.log.hft-log');
    const follow = (box, tool) => window.om.hft.onLog((ev) => { if (ev.projectId === ctx.id && (!tool || ev.tool === tool)) { box.textContent = (box.textContent + ev.line + '\n').slice(-3000); box.scrollTop = 1e9; } });
    const askAgent = (text, label) => h('button.btn.sm', { onclick: () => { m.close(); ctx.send(text); } }, icon('bot'), label || 'Ask the agent to use it');

    const views = {
      async voice() {
        const ta = h('textarea.input', { rows: 5, dir: 'auto', placeholder: 'Type the narration… (English, Spanish, French, Italian, Hindi, Portuguese, Japanese, Chinese)' });
        const vs = await voiceSelect();
        const speed = h('input', { type: 'range', min: '0.7', max: '1.3', step: '0.05', value: '1' });
        const sp = h('span.mono.muted', '1.00×'); speed.oninput = () => { sp.textContent = Number(speed.value).toFixed(2) + '×'; };
        const name = h('input.input', { placeholder: 'file name (optional)', style: { width: '200px' } });
        const warn = h('div.muted.hidden', { style: { color: 'var(--warn)', fontSize: '12px' } }, 'Kokoro has no Arabic. For Arabic narration use Edge TTS (Egyptian, Saudi, Gulf, Levantine, Maghrebi) — ask the agent, or use the voiceover banner.');
        ta.oninput = () => warn.classList.toggle('hidden', !ARABIC.test(ta.value));
        const prev = h('button.btn', icon('play'), 'Preview');
        const add = h('button.btn.primary', icon('plus'), 'Add to project');
        const result = h('div');
        prev.onclick = async () => {
          if (!ta.value.trim()) return toast('Type some text first', 'err');
          busy(prev, 'Speaking…');
          try { await playBytes(await window.om.hft.preview({ text: ta.value, voice: vs.value, speed: Number(speed.value) }), 'audio/wav'); } catch (e) { toast(clean(e), 'err'); }
          unbusy(prev, 'play');
        };
        add.onclick = async () => {
          if (!ta.value.trim()) return toast('Type some text first', 'err');
          busy(add, 'Generating…');
          try {
            const r = await window.om.hft.speak(ctx.id, { text: ta.value, voice: vs.value, speed: Number(speed.value), name: name.value.trim() || undefined });
            result.replaceChildren(h('div.hft-result', icon('check'), h('span.mono', r.rel), h('span.muted', `${r.duration}s · word timings saved`),
              h('audio', { controls: true, src: window.om.media(ctx.id, r.rel) }), askAgent(`Use the narration I generated: projects/${ctx.id}/${r.rel} (word timings in ${r.rel}.words.json).`)));
            toast('Narration added to assets/audio');
          } catch (e) { toast(clean(e), 'err'); }
          unbusy(add, 'plus');
        };
        return [kokoroStatus(), ta, warn,
          h('div.row', h('label.lbl2', 'Voice'), vs, h('label.lbl2', 'Speed'), speed, sp),
          h('div.row', name, h('div', { style: { flex: 1 } }), prev, add), result];
      },

      async captions() {
        const sel = pick(/\.(wav|mp3|m4a|aac|ogg|flac|mp4|mov|webm|mkv)$/i, 'No audio or video in this project yet.');
        const lang = h('select.input', { style: { width: '150px' } },
          ...[['', 'Auto / English'], ['ar', 'Arabic'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['tr', 'Turkish'], ['hi', 'Hindi'], ['ja', 'Japanese'], ['zh', 'Chinese']].map(([v, l]) => h('option', { value: v }, l)));
        const go = h('button.btn.primary', icon('text'), 'Transcribe');
        const log = logBox(); const result = h('div');
        go.onclick = async () => {
          if (!sel.value) return;
          busy(go, 'Transcribing…'); log.textContent = '';
          const off = follow(log, 'transcribe');
          try {
            const r = await window.om.hft.transcribe(ctx.id, sel.value, { language: lang.value || undefined });
            result.replaceChildren(h('div.hft-result', icon('check'), h('span', `${r.words} words`), h('span.mono', r.srt),
              askAgent(`Captions are ready for projects/${ctx.id}/${sel.value}: ${r.srt}${r.wordsFile ? ` and word timings in ${r.wordsFile}` : ''}. Use them for the burned-in captions.`)));
            toast('Captions written next to the file');
          } catch (e) { toast(clean(e), 'err'); }
          off && off(); unbusy(go, 'text');
        };
        return [h('div.muted', 'Word-level timestamps with HyperFrames transcribe (whisper.cpp, local). Writes an .srt and .words.json next to the file; the player and timeline pick them up.'),
          h('div.row', sel, lang, go), log, result];
      },

      async blocks() {
        const q = h('input.input', { placeholder: 'Search 448 blocks & components — captions, transition, chart, title card…' });
        const tagsEl = h('div.hft-tags');
        const grid = h('div.hft-grid', h('div.muted', 'Loading the catalog…'));
        let list = [], tag = '';
        const paint = () => {
          const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
          const res = list.filter(x => (!tag || (x.tags || []).includes(tag)) && words.every(w => (x.name + ' ' + x.title + ' ' + x.description + ' ' + (x.tags || []).join(' ')).toLowerCase().includes(w))).slice(0, 120);
          grid.replaceChildren(...(res.length ? res.map(card) : [h('div.muted', 'Nothing matches.')]));
        };
        const card = (x) => {
          const btn = h('button.btn.sm', icon('plus'), 'Add');
          btn.onclick = async () => {
            busy(btn, 'Adding…');
            try {
              const r = await window.om.hft.add(ctx.id, x.name);
              btn.replaceChildren(icon('check'), 'Added'); btn.classList.add('ok');
              toast(`${x.title} installed`);
              m.close(); ctx.send(`I added the HyperFrames ${x.type} "${x.name}" (${x.title}) to the project (${r.written.join(', ')}). Place it in the video where it fits best${r.snippet ? ` — mount snippet: ${r.snippet}` : ''}.`);
            } catch (e) { toast(clean(e), 'err'); unbusy(btn, 'plus'); }
          };
          return h('div.hft-card',
            h('div.hft-card-h', h('span.badge.gray', x.type), x.duration ? h('span.muted.mono', x.duration + 's') : null, x.dimensions ? h('span.muted.mono', `${x.dimensions.width}×${x.dimensions.height}`) : null),
            h('div.hft-card-t', x.title || x.name), h('div.hft-card-d', x.description || ''),
            h('div.hft-card-f', h('span.muted.mono', x.name), h('div', { style: { flex: 1 } }), btn));
        };
        q.oninput = paint;
        window.om.hft.catalog().then((l) => {
          list = l;
          const counts = {}; for (const x of l) for (const t of x.tags || []) counts[t] = (counts[t] || 0) + 1;
          const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([t]) => t);
          const chip = (t, label) => h('button.chip' + (tag === t ? '.on' : ''), { onclick: () => { tag = t; tagsEl.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.t === t)); paint(); }, 'data-t': t }, label || t);
          tagsEl.replaceChildren(chip('', 'All'), ...top.map(t => chip(t)));
          paint();
        }).catch((e) => grid.replaceChildren(h('div.muted', 'Catalog unavailable: ' + clean(e))));
        return [q, tagsEl, grid];
      },

      async media() {
        const src = pick(/\.(png|jpe?g|webp|mp4|mov|webm|mkv)$/i, 'No images or videos in this project yet.');
        const rb = h('button.btn.primary', icon('wand'), 'Remove background');
        const log = logBox(); const out = h('div');
        rb.onclick = async () => {
          if (!src.value) return;
          busy(rb, 'Cutting out…'); log.textContent = '';
          const off = follow(log, 'removeBg');
          try {
            const r = await window.om.hft.removeBg(ctx.id, src.value);
            const isImg = /\.png$/i.test(r.rel);
            out.replaceChildren(h('div.hft-result', icon('check'), h('span.mono', r.rel),
              isImg ? h('img.hft-thumb.checker', { src: window.om.media(ctx.id, r.rel) }) : h('video.hft-thumb.checker', { src: window.om.media(ctx.id, r.rel), controls: true, muted: true }),
              askAgent(`I removed the background of ${src.value}: projects/${ctx.id}/${r.rel} (transparent). Use it as an overlay where it fits.`)));
          } catch (e) { toast(clean(e), 'err'); }
          off && off(); unbusy(rb, 'wand');
        };
        const music = pick(/\.(wav|mp3|m4a|aac|ogg|flac)$/i, 'No music file yet.');
        const bt = h('button.btn', icon('music'), 'Detect beats');
        const bout = h('div');
        bt.onclick = async () => {
          if (!music.value) return;
          busy(bt, 'Listening…');
          try {
            const r = await window.om.hft.beats(ctx.id, music.value);
            bout.replaceChildren(h('div.hft-result', icon('check'), h('span', `${r.beats} beats${r.bpm ? ` · ${Math.round(r.bpm)} BPM` : ''}`),
              askAgent(`Cut the scenes on the beat of ${music.value} (${r.bpm ? Math.round(r.bpm) + ' BPM, ' : ''}run \`hyperframes beats\` for the beat grid).`)));
          } catch (e) { toast(clean(e), 'err'); }
          unbusy(bt, 'music');
        };
        return [h('div.hft-sec', 'Background removal'), h('div.muted', 'Transparent PNG for images, WebM with alpha for video. Runs locally (first run downloads the model).'),
          h('div.row', src, rb), log, out,
          h('div.hft-sec', 'Beat detection'), h('div.row', music, bt), bout];
      },

      async website() {
        const url = h('input.input', { placeholder: 'https://your-product.com', type: 'url' });
        const go = h('button.btn.primary', icon('globe'), 'Capture');
        const log = logBox(); const out = h('div');
        go.onclick = async () => {
          busy(go, 'Capturing…'); log.textContent = '';
          const off = follow(log, 'capture');
          try {
            const r = await window.om.hft.capture(ctx.id, url.value.trim());
            out.replaceChildren(h('div.hft-result', icon('check'), h('span.mono', r.dir), askAgent(`I captured ${url.value.trim()} into projects/${ctx.id}/${r.dir}. Use the real screenshots and brand assets from there.`)),
              h('div.hft-shots', ...r.shots.map(s => h('img', { src: window.om.media(ctx.id, s), title: s }))));
          } catch (e) { toast(clean(e), 'err'); }
          off && off(); unbusy(go, 'globe');
        };
        return [h('div.muted', 'Screenshots, images, logos and design tokens of a real website — so the video shows the actual product instead of a drawn one.'),
          h('div.row', url, go), log, out];
      },

      async review() {
        const ck = h('button.btn', icon('check'), 'Check composition');
        const sn = h('button.btn', icon('image'), 'Snapshot key frames');
        const out = h('div');
        ck.onclick = async () => {
          busy(ck, 'Checking…');
          try {
            const r = await window.om.hft.check(ctx.id);
            if (r.none) out.replaceChildren(h('div.muted', 'The agent has not written a HyperFrames composition yet — the player shows the draft cut.'));
            else if (!r.issues.length) out.replaceChildren(h('div.hft-result', icon('check'), r.ok ? 'No problems found.' : (r.raw || 'Check finished.')));
            else {
              const txt = r.issues.map(i => `- [${i.severity}] ${i.code ? i.code + ': ' : ''}${i.message}${i.fix ? ' — Fix: ' + i.fix : ''}`).join('\n');
              out.replaceChildren(h('div.hft-issues', ...r.issues.map(i => h('div.hft-issue.' + (/err/i.test(i.severity) ? 'err' : 'warn'),
                h('b', i.code || i.severity), h('span', i.message), i.fix ? h('div.muted', 'Fix: ' + i.fix) : null))),
              askAgent('`hyperframes check` found these problems in the composition. Fix them:\n' + txt, 'Ask the agent to fix these'));
            }
          } catch (e) { toast(clean(e), 'err'); }
          unbusy(ck, 'check');
        };
        sn.onclick = async () => {
          busy(sn, 'Rendering frames…');
          try {
            const r = await window.om.hft.snapshot(ctx.id, { frames: 8 });
            out.replaceChildren(h('div.hft-shots', ...r.files.map(f => h('img', { src: window.om.media(ctx.id, f), title: f }))));
          } catch (e) { toast(clean(e), 'err'); }
          unbusy(sn, 'image');
        };
        return [h('div.muted', 'Validate the agent\'s HyperFrames composition (lint, runtime errors, missing assets, layout) and look at key frames without rendering the whole video.'),
          h('div.row', ck, sn), out];
      },
    };

    const show = async (id) => {
      cur = id; localStorage.setItem('hftTab', id);
      nav.querySelectorAll('.hft-tab').forEach(b => b.classList.toggle('on', b.dataset.id === id));
      pane.replaceChildren(h('div.muted', 'Loading…'));
      try { pane.replaceChildren(...[].concat(await views[id]()).filter(Boolean)); } catch (e) { pane.replaceChildren(h('div.muted', clean(e))); }
    };
    nav.replaceChildren(...tabs.map(([id, label, ic]) => h('button.hft-tab', { 'data-id': id, onclick: () => show(id) }, icon(ic), label)));
    const m = modal({ title: 'HyperFrames tools', wide: true, body: h('div.hft', nav, pane) });
    show(tabs.some(t => t[0] === cur) ? cur : 'voice');
    return m;
  }

  window.HFToolsUI = { open, voiceFixPicker, kokoroStatus, voiceSelect, playBytes };
})();
