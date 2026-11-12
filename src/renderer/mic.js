/* Voice input: a mic button that records, transcribes (local Whisper or cloud) and types into a textarea. */
(function () {
  const { h, icon, toast } = UI;
  let active = null; // the one recorder running at a time

  function insertText(ta, text) {
    if (!text) return;
    const start = ta.selectionStart ?? ta.value.length, end = ta.selectionEnd ?? ta.value.length;
    const before = ta.value.slice(0, start), after = ta.value.slice(end);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    ta.value = before + pad + text + after;
    const pos = (before + pad + text).length;
    ta.setSelectionRange(pos, pos);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
  }

  function pickMime() {
    for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  /**
   * mic(textarea, { onText, autoSend }) → button element.
   * Click: start / stop. Esc: cancel. Ctrl/Cmd+Shift+M toggles the most recently focused composer's mic.
   */
  function mic(ta, opts = {}) {
    const btn = h('button.btn.ghost.sm.icon.mic', { title: 'Voice input (⌘/Ctrl+Shift+M)', type: 'button' }, icon('mic'));
    const timer = h('span.mic-time.hidden', '0:00');
    const wrap = h('span.mic-wrap', btn, timer);
    let rec = null, chunks = [], stream = null, ctx = null, raf = 0, t0 = 0, tick = 0, cancelled = false;

    const setState = (s) => {
      btn.classList.toggle('rec', s === 'rec');
      btn.classList.toggle('busy', s === 'busy');
      timer.classList.toggle('hidden', s !== 'rec');
      btn.replaceChildren(icon(s === 'busy' ? 'refresh' : s === 'rec' ? 'stop' : 'mic'));
      btn.title = s === 'rec' ? 'Stop and transcribe (Esc to cancel)' : s === 'busy' ? 'Transcribing…' : 'Voice input (⌘/Ctrl+Shift+M)';
    };

    async function start() {
      if (active && active !== api) active.cancel();
      const st = await window.om.stt.status();
      if (!st.resolved) return setupPrompt();
      const perm = await window.om.stt.permission();
      if (perm !== 'granted') {
        toast('Microphone access is off for OpenMontage Studio. Allow it in System Settings → Privacy → Microphone.', 'err');
        window.om.stt.openMicSettings();
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      } catch (e) { toast('Could not open the microphone: ' + e.message, 'err'); return; }
      const mime = pickMime();
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
      chunks = []; cancelled = false;
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = finish;
      rec.start(250);
      active = api;
      t0 = Date.now();
      setState('rec');
      tick = setInterval(() => {
        const s = Math.floor((Date.now() - t0) / 1000);
        timer.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
        if (s >= 300) stop(); // 5 minute cap
      }, 250);
      // live level ring
      try {
        ctx = new AudioContext();
        const an = ctx.createAnalyser(); an.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(an);
        const data = new Uint8Array(an.fftSize);
        const loop = () => {
          an.getByteTimeDomainData(data);
          let sum = 0; for (const v of data) sum += (v - 128) * (v - 128);
          const level = Math.min(1, Math.sqrt(sum / data.length) / 40);
          btn.style.boxShadow = `0 0 0 ${2 + level * 9}px rgba(248,113,113,${0.25 + level * 0.35})`;
          raf = requestAnimationFrame(loop);
        };
        loop();
      } catch { /* level meter is cosmetic */ }
    }

    function cleanup() {
      clearInterval(tick); cancelAnimationFrame(raf);
      btn.style.boxShadow = '';
      if (stream) stream.getTracks().forEach(t => t.stop());
      if (ctx) ctx.close().catch(() => {});
      stream = null; ctx = null;
      if (active === api) active = null;
    }

    function stop() { if (rec && rec.state !== 'inactive') rec.stop(); }
    function cancel() { cancelled = true; stop(); }

    async function finish() {
      const mime = rec.mimeType || 'audio/webm';
      cleanup();
      rec = null;
      if (cancelled) { setState('idle'); return; }
      const dur = Date.now() - t0;
      if (dur < 400 || !chunks.length) { setState('idle'); return; }
      setState('busy');
      try {
        const bytes = new Uint8Array(await new Blob(chunks, { type: mime }).arrayBuffer());
        const r = await window.om.stt.transcribe(bytes, mime);
        if (!r.text) toast('No speech detected.');
        else {
          insertText(ta, r.text);
          if (opts.onText) opts.onText(r.text);
          const st = await window.om.stt.status();
          if (st.autoSend && opts.send) opts.send();
        }
      } catch (e) {
        const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        if (/not set up/i.test(msg)) setupPrompt(); else toast('Voice input failed: ' + msg, 'err');
      } finally { setState('idle'); }
    }

    function setupPrompt() {
      UI.modal({
        title: 'Set up voice input',
        body: [h('div', 'Speak in Arabic or English and your words are typed for the agent.'),
          h('div.muted', 'Free and private: a local Whisper model runs on this computer. Or use a cloud API key (Groq, OpenAI or ElevenLabs).')],
        actions: [{ label: 'Later' }, { label: 'Open voice settings', primary: true, onClick: () => window.App && window.App.go('settings') }],
      });
    }

    const api = { start, stop, cancel, get recording() { return !!rec; } };
    btn.onclick = () => (rec ? stop() : (btn.classList.contains('busy') ? null : start()));
    ta.addEventListener('focus', () => { mic.last = api; });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Escape' && rec) { e.preventDefault(); cancel(); } });
    if (!mic.last) mic.last = api;
    wrap._mic = api;
    return wrap;
  }

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault();
      const m = active || mic.last;
      if (m && document.body.contains(document.activeElement)) (m.recording ? m.stop() : m.start());
    }
    if (e.key === 'Escape' && active) active.cancel();
  });

  UI.mic = mic;
})();
