// Builds a HyperFrames composition ("draft cut") from an OpenMontage project's state:
// scene visuals (or generated title cards), narration audio, music and word-timed captions.
// Output: projects/<id>/.studio/draft/{index.html, preview.html, hyperframes.json, assets/...}
//   index.html   → what `hyperframes render` exports
//   (the in-app preview server injects the HyperFrames runtime when it serves the page)
const fs = require('fs');
const path = require('path');
const { run } = require('./util');

const W_H = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '4:3': [1440, 1080], '21:9': [2520, 1080] };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r3 = (n) => Math.round(n * 1000) / 1000;
const isArabic = (s) => /[؀-ۿ]/.test(String(s || ''));
const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '-');

function findAspect(artifacts) {
  const hits = [];
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 6) return;
    for (const [k, v] of Object.entries(o)) {
      if (/aspect/i.test(k) && typeof v === 'string' && W_H[v.trim()]) hits.push(v.trim());
      else if (typeof v === 'object') walk(v, depth + 1);
    }
  };
  for (const key of ['edit_decisions', 'scene_plan', 'proposal_packet', 'script', 'brief']) walk(artifacts[key], 0);
  if (hits.length) return hits[0];
  const blob = JSON.stringify(artifacts.proposal_packet || {}) + JSON.stringify(artifacts.research_brief || {});
  return /9:16|vertical|reels|tiktok|shorts/i.test(blob) ? '9:16' : '16:9';
}

/** Probe media duration with ffprobe (bundled on PATH). */
async function probeDuration(file) {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeout: 20000 });
  const d = parseFloat(r.out);
  return isFinite(d) && d > 0 ? d : null;
}

/** Split text into caption chunks spread across [start, end). */
function chunkCaptions(text, start, end, maxWords = 5) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length || end <= start) return [];
  const groups = [];
  for (let i = 0; i < words.length; i += maxWords) groups.push(words.slice(i, i + maxWords));
  const total = words.length;
  let t = start, used = 0;
  return groups.map((g) => {
    const dur = ((end - start) * g.length) / total;
    const c = { text: g.join(' '), start: r3(t), end: r3(t + dur) };
    t += dur; used += g.length;
    return c;
  });
}

/** Group word timings (Edge TTS .words.json / whisper words) into caption lines. */
function groupWords(words, offset, maxWords = 4, maxGap = 0.6) {
  const out = [];
  let cur = null;
  for (const w of words) {
    const s = offset + w.start, e = offset + w.end;
    if (!cur || cur.n >= maxWords || s - cur.end > maxGap) {
      if (cur) out.push(cur);
      cur = { text: w.text, start: s, end: e, n: 1 };
    } else { cur.text += ' ' + w.text; cur.end = e; cur.n++; }
  }
  if (cur) out.push(cur);
  return out.map(c => ({ text: c.text, start: r3(c.start), end: r3(c.end) }));
}

function readWords(file) {
  for (const p of [file + '.words.json', file.replace(/\.[^.]+$/, '.words.json')]) {
    try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(j) ? j : j.words; } catch {}
  }
  return null;
}

function stage(projectDir, rel, draftDir) {
  const src = path.join(projectDir, rel);
  const dest = path.join(draftDir, rel.startsWith('assets/') ? rel : 'assets/' + rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    const a = fs.statSync(src), b = fs.existsSync(dest) ? fs.statSync(dest) : null;
    if (!b || b.size !== a.size || b.mtimeMs < a.mtimeMs) {
      try { fs.rmSync(dest, { force: true }); fs.linkSync(src, dest); } catch { fs.copyFileSync(src, dest); }
    }
  } catch { return null; }
  return path.relative(draftDir, dest).split(path.sep).join('/');
}

/**
 * Collect a timeline model from the project state.
 * Returns { width, height, duration, scenes:[{id,start,end,visual,title,subtitle,type}], audio:[...], captions:[...] }
 */
async function buildModel(state) {
  const dir = state.dir;
  const A = state.artifacts || {};
  const aspect = findAspect(A);
  const [width, height] = W_H[aspect] || W_H['16:9'];
  const planScenes = (A.scene_plan && A.scene_plan.scenes) || [];
  const sbScenes = (state.storyboard && state.storyboard.scenes) || [];
  const manifest = (A.asset_manifest && A.asset_manifest.assets) || [];
  const sections = (A.script && A.script.sections) || [];
  const exists = (rel) => rel && fs.existsSync(path.join(dir, rel));

  // narration per scene (only files that really exist)
  const narrAll = manifest.filter(a => /narration|voice/i.test(a.type || '') && exists(a.path));
  const narrDur = {};
  for (const a of narrAll) narrDur[a.path] = await probeDuration(path.join(dir, a.path));
  // an unreadable/corrupt file would make the whole render fail — leave it out (reported as skipped)
  const narr = narrAll.filter(a => narrDur[a.path]);
  const skipped = narrAll.filter(a => !narrDur[a.path]).map(a => a.path);

  const base = (sbScenes.length ? sbScenes : planScenes).map((s, i) => {
    const plan = planScenes.find(p => p.id === s.id) || s;
    return { id: s.id || `scene-${i + 1}`, index: i, start: s.start_seconds, end: s.end_seconds, plan, sb: s };
  });

  // timings: planned times when present, else sequential from narration length (min 3 s)
  let t = 0;
  for (const s of base) {
    const vo = narr.find(a => a.scene_id === s.id);
    const voLen = vo ? narrDur[vo.path] : null;
    if (typeof s.start !== 'number' || typeof s.end !== 'number' || s.end <= s.start) {
      s.start = t;
      s.end = t + Math.max(3, voLen ? voLen + 0.4 : 4);
    }
    // never cut narration short: stretch the scene to fit its voiceover
    if (voLen && s.start + voLen + 0.2 > s.end) s.end = s.start + voLen + 0.3;
    t = s.end;
  }
  // re-pack so stretched scenes push later ones (keeps order, removes overlaps)
  let cursor = 0;
  for (const s of base) {
    const len = s.end - s.start;
    s.start = Math.max(cursor, s.start); s.end = s.start + len; cursor = s.end;
  }
  const duration = r3(base.length ? base[base.length - 1].end : 5);

  const scenes = base.map((s) => {
    const sb = s.sb || {};
    const v = sb.visual && sb.visual.exists && sb.visual.path ? sb.visual
      : manifest.find(a => a.scene_id === s.id && ['image', 'video'].includes(a.type) && exists(a.path)) || null;
    const p = s.plan || {};
    const onscreen = p.on_screen_text || p.text_overlay || p.title || p.headline
      || (Array.isArray(p.text_elements) ? p.text_elements.map(x => x.text || x).join(' · ') : '')
      || (p.overlays && p.overlays.map ? p.overlays.map(o => o.text).filter(Boolean).join(' · ') : '');
    return {
      id: s.id, start: r3(s.start), end: r3(s.end), type: p.type || sb.type || 'scene',
      visual: v ? { path: v.path, type: v.type === 'video' ? 'video' : 'image' } : null,
      title: String(onscreen || '').trim() || firstSentence(p.description || sb.description || ''),
      subtitle: p.type ? String(p.type).replace(/_/g, ' ') : '',
      narration: sb.narration || '',
    };
  });

  const audio = [];
  const captions = [];
  for (const a of narr) {
    const sc = scenes.find(s => s.id === a.scene_id);
    const start = sc ? sc.start : 0;
    audio.push({ id: 'vo-' + safeId(a.id || a.path), path: a.path, start, kind: 'voice', duration: narrDur[a.path] });
    const words = readWords(path.join(dir, a.path));
    if (words && words.length) captions.push(...groupWords(words, start));
    else {
      const text = (sc && sc.narration) || (sections.find(x => x.id === a.scene_id || x.scene_id === a.scene_id) || {}).text || '';
      const len = narrDur[a.path] || (sc ? sc.end - sc.start : 4);
      captions.push(...chunkCaptions(text, start + 0.1, start + len - 0.1));
    }
  }
  // no voiceover yet → still show the planned narration as captions so the cut reads
  if (!narr.length) for (const sc of scenes) if (sc.narration) captions.push(...chunkCaptions(sc.narration, sc.start + 0.2, sc.end - 0.2));

  let music = manifest.find(a => /music/i.test(a.type || '') && exists(a.path))
    || ((state.media && state.media.music) || []).map(m => ({ path: m.path })).find(m => exists(m.path));
  if (music && !(await probeDuration(path.join(dir, music.path)))) { skipped.push(music.path); music = null; }
  if (music) audio.push({ id: 'music', path: music.path, start: 0, kind: 'music', volume: narr.length ? 0.16 : 0.45 });

  return { aspect, width, height, duration, scenes, audio, captions, hasVoice: narr.length > 0, skipped };
}

function firstSentence(s) {
  const t = String(s || '').split(/(?<=[.!?؟])\s/)[0] || '';
  return t.length > 90 ? t.slice(0, 87) + '…' : t;
}

const PALETTES = [
  ['#1b1040', '#4f10f2'], ['#0f1f3d', '#1d6fd8'], ['#2a0f2f', '#c2185b'], ['#0d2a26', '#0f9d7a'], ['#2b1a0a', '#e07b16'], ['#1a1a1a', '#5a5a5a'],
];

/** Render the model to HyperFrames HTML. */
function toHtml(m, { title, runtimeTag = '' } = {}) {
  const { width: W, height: H, duration } = m;
  const portrait = H > W;
  const titleSize = Math.round((portrait ? W : H) * 0.075);
  const capSize = Math.round((portrait ? W : H) * 0.05);
  const clips = [];
  const tweens = [];
  m.scenes.forEach((s, i) => {
    const id = 's-' + safeId(s.id);
    const dur = r3(s.end - s.start);
    if (s.visual && s.visual.type === 'video') {
      clips.push(`      <video id="${id}" class="clip scene-media" data-start="${s.start}" data-duration="${dur}" data-track-index="1" muted playsinline src="${esc(s.visual.src)}"></video>`);
    } else if (s.visual) {
      clips.push(`      <div id="${id}" class="clip scene" data-start="${s.start}" data-duration="${dur}" data-track-index="1"><img id="${id}-img" class="kb" src="${esc(s.visual.src)}" alt="" /></div>`);
      tweens.push(`tl.fromTo("#${id}-img", { scale: 1.0 }, { scale: 1.08, duration: ${dur}, ease: "none" }, ${s.start});`);
    } else {
      const [a, b] = PALETTES[i % PALETTES.length];
      const dir = isArabic(s.title) ? 'rtl' : 'ltr';
      clips.push(`      <div id="${id}" class="clip card${dir === 'rtl' ? ' rtl' : ''}" data-start="${s.start}" data-duration="${dur}" data-track-index="1" style="background: radial-gradient(120% 90% at ${dir === 'rtl' ? '80%' : '20%'} 10%, ${b} 0%, ${a} 60%, #07070a 100%);">
        <div id="${id}-k" class="kicker">${esc(String(i + 1).padStart(2, '0'))}${s.subtitle ? ' · ' + esc(s.subtitle) : ''}</div>
        <div id="${id}-t" class="headline" dir="${dir}">${esc(s.title || '')}</div>
        <div id="${id}-bar" class="bar"></div>
      </div>`);
      tweens.push(`tl.fromTo("#${id}-k", { opacity: 0, y: 20 }, { opacity: 0.8, y: 0, duration: 0.5, ease: "power3.out" }, ${r3(s.start + 0.15)});`);
      tweens.push(`tl.fromTo("#${id}-t", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.7, ease: "power3.out" }, ${r3(s.start + 0.3)});`);
      tweens.push(`tl.fromTo("#${id}-bar", { scaleX: 0 }, { scaleX: 1, duration: ${r3(Math.max(0.5, dur - 0.6))}, ease: "none" }, ${r3(s.start + 0.3)});`);
    }
  });
  m.captions.forEach((c, i) => {
    const id = 'cap-' + i;
    const dir = isArabic(c.text) ? 'rtl' : 'ltr';
    clips.push(`      <div id="${id}" class="clip caption" data-start="${c.start}" data-duration="${r3(Math.max(0.2, c.end - c.start))}" data-track-index="3"><span id="${id}-t" dir="${dir}">${esc(c.text)}</span></div>`);
    tweens.push(`tl.fromTo("#${id}-t", { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.18, ease: "power2.out" }, ${r3(c.start)});`);
  });
  const audio = m.audio.map(a => {
    const vol = a.kind === 'music' ? ` data-volume="${a.volume}" data-fade-in="1" data-fade-out="2" data-duration="${duration}"` : ' data-volume="1"';
    const ms = a.offset ? ` data-media-start="${r3(a.offset)}"` : '';
    return `      <audio id="${esc(a.id)}" class="clip" data-start="${r3(a.start)}" data-track-index="${a.kind === 'music' ? 5 : 4}"${vol}${ms} src="${esc(a.src)}"></audio>`;
  });
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <title>${esc(title || 'Draft cut')}</title>
    <script src="assets/vendor/gsap.min.js"></script>${runtimeTag}
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; font-family: Inter, sans-serif; color: #fff; }
      .scene, .card, .scene-media { position: absolute; inset: 0; overflow: hidden; }
      .scene-media { width: 100%; height: 100%; object-fit: cover; }
      .kb { width: 100%; height: 100%; object-fit: cover; transform-origin: 50% 50%; }
      .card { display: flex; flex-direction: column; justify-content: center; padding: ${Math.round(W * 0.09)}px; gap: ${Math.round(H * 0.025)}px; }
      .kicker { font-size: ${Math.round(titleSize * 0.36)}px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255,255,255,.8); }
      .headline { font-size: ${titleSize}px; font-weight: 900; line-height: 1.15; max-width: 92%; text-wrap: balance; }
      .card.rtl { align-items: flex-end; text-align: right; }
      .card.rtl .bar { transform-origin: 100% 50%; }
      .bar { height: ${Math.max(4, Math.round(H * 0.006))}px; width: 38%; background: #fff; transform-origin: 0 50%; border-radius: 99px; opacity: .85; }
      .caption { position: absolute; left: 6%; right: 6%; bottom: ${portrait ? '16%' : '9%'}; display: flex; justify-content: center; z-index: 10; }
      .caption span { font-size: ${capSize}px; font-weight: 700; line-height: 1.3; padding: .18em .55em; border-radius: .35em; background: rgba(0,0,0,.62); text-align: center; max-width: 100%; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="${W}" data-height="${H}">
${clips.join('\n')}
${audio.join('\n')}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      ${tweens.join('\n      ')}
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = tl;
      tl.seek(0);
    </script>
  </body>
</html>
`;
}

/**
 * Write the draft composition. opts.sceneId → a composition holding only that scene (time-shifted to 0).
 * vendor: { gsap, runtime } absolute paths to copy into assets/vendor/.
 */
async function writeDraft(state, { sceneId, vendor }) {
  const model = await buildModel(state);
  let m = model;
  const sub = sceneId ? 'scene-' + safeId(sceneId) : 'full';
  if (sceneId) {
    const s = model.scenes.find(x => x.id === sceneId);
    if (!s) throw new Error('Scene not found: ' + sceneId);
    const off = s.start, end = s.end;
    const inRange = (a, b) => a < end && b > off;
    m = {
      ...model, duration: r3(end - off),
      scenes: [{ ...s, start: 0, end: r3(end - off) }],
      captions: model.captions.filter(c => inRange(c.start, c.end)).map(c => ({ ...c, start: r3(Math.max(0, c.start - off)), end: r3(Math.min(end, c.end) - off) })),
      audio: model.audio.filter(a => a.kind === 'music' || (a.start >= off - 0.01 && a.start < end)).map(a => ({ ...a, start: a.kind === 'music' ? 0 : r3(a.start - off) })),
    };
    // music: start mid-track at the scene's offset
    m.audio = m.audio.map(a => a.kind === 'music' ? { ...a, offset: off } : a);
  }
  const draft = path.join(state.dir, '.studio', 'draft', sub);
  fs.mkdirSync(path.join(draft, 'assets', 'vendor'), { recursive: true });
  for (const s of m.scenes) if (s.visual) s.visual.src = stage(state.dir, s.visual.path, draft) || s.visual.path;
  for (const a of m.audio) a.src = stage(state.dir, a.path, draft) || a.path;
  m.audio = m.audio.filter(a => a.src);
  fs.copyFileSync(vendor.gsap, path.join(draft, 'assets', 'vendor', 'gsap.min.js'));
  const title = state.title + (sceneId ? ` — ${sceneId}` : '');
  fs.writeFileSync(path.join(draft, 'index.html'), toHtml(m, { title }));
  try { fs.rmSync(path.join(draft, 'preview.html'), { force: true }); } catch {}
  fs.writeFileSync(path.join(draft, 'hyperframes.json'), JSON.stringify({
    $schema: 'https://hyperframes.heygen.com/schema/hyperframes.json',
    paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' }, media: { autoProxy: true },
  }, null, 2));
  return { dir: draft, rel: path.relative(state.dir, draft).split(path.sep).join('/'), model: m, full: model };
}

module.exports = { writeDraft, buildModel, toHtml, findAspect, groupWords, chunkCaptions };
