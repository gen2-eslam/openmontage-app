/* Shared renderer helpers: DOM builder, icons, i18n, markdown, toasts, modals. */
(function () {
  // ---------- DOM ----------
  function h(tag, attrs, ...kids) {
    const [name, ...cls] = tag.split('.');
    const el = document.createElement(name || 'div');
    if (cls.length) el.className = cls.join(' ');
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    const add = (k) => {
      if (k === null || k === undefined || k === false) return;
      if (Array.isArray(k)) return k.forEach(add);
      el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    };
    kids.forEach(add);
    return el;
  }

  // ---------- Icons (simple line icons, 24x24) ----------
  const P = {
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    canvas: '<path d="M4 9h16M4 15h16M9 4v16M15 4v16"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9 17h6"/>',
    flow: '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 6h10M6 8l5 8M18 8l-5 8"/>',
    book: '<path d="M4 19V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM19 19v2H6"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    clip: '<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    text: '<path d="M4 6h16M4 12h10M4 18h14"/>',
    play: '<path d="M7 5v14l11-7z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    check: '<path d="m5 12 5 5L20 7"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
    ext: '<path d="M14 4h6v6M10 14 20 4M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
    term: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
    wand: '<path d="m15 4 5 5L9 20l-5-5zM14 3l1 1M20 9l1 1M3 3l2 2"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.5-4.5"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    minus: '<path d="M5 12h14"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    up: '<path d="m6 15 6-6 6 6"/>',
    layout: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    download: '<path d="M12 4v12M6 10l6 6 6-6M4 20h16"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
    broom: '<path d="M14 4 20 10M4 20l7-7M9 11l4 4-3 5-6-6z"/>',
  };
  function icon(name, cls) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'i' + (cls ? ' ' + cls : ''));
    s.innerHTML = P[name] || P.spark;
    return s;
  }

  // ---------- i18n (English / Arabic) ----------
  const DICT = {
    ar: {
      'Home': 'الرئيسية', 'Canvas': 'الكانفاس', 'Projects': 'المشاريع', 'Agents': 'الإيجنتس', 'Pipelines': 'البايبلاينز', 'Skills': 'السكيلز',
      'Settings': 'الإعدادات', 'Setup': 'التثبيت', 'New project': 'مشروع جديد', 'Recent projects': 'المشاريع الأخيرة', 'View all': 'عرض الكل',
      'ALL-IN-ONE AI VIDEO CREATION, FROM START TO FINISH': 'صناعة فيديو كاملة بالذكاء الاصطناعي، من البداية للنهاية',
      'Describe the video you want…': 'اوصف الفيديو اللي عايزه…', 'Auto pipeline': 'بايبلاين تلقائي', 'Agent': 'الإيجنت',
      'Send': 'إرسال', 'Stop': 'إيقاف', 'Approve': 'موافقة', 'Request changes': 'اطلب تعديل', 'Awaiting your approval': 'مستني موافقتك',
      'Ask the agent to change anything…': 'اطلب من الإيجنت يعدّل أي حاجة…', 'Installed': 'متثبت', 'Not installed': 'مش متثبت',
      'Add custom agent': 'إضافة إيجنت خاص', 'Open terminal': 'فتح التيرمينال', 'Login': 'تسجيل الدخول', 'Remove': 'حذف', 'Save': 'حفظ', 'Cancel': 'إلغاء',
      'OpenMontage is not installed yet': 'OpenMontage لسه مش متثبت', 'Install OpenMontage': 'تثبيت OpenMontage', 'Use existing folder': 'استخدم فولدر موجود',
      'API keys': 'مفاتيح الـ API', 'General': 'عام', 'Language': 'اللغة', 'Default agent': 'الإيجنت الافتراضي', 'Auto-approve agent actions': 'موافقة تلقائية على أوامر الإيجنت',
      'Preview': 'معاينة', 'Timeline': 'التايملاين', 'Inspector': 'التفاصيل', 'Open folder': 'فتح الفولدر', 'Backlot board': 'لوحة Backlot',
      'Script': 'السكريبت', 'Scene': 'مشهد', 'Final render': 'الفيديو النهائي', 'Regenerate': 'إعادة توليد', 'Edit with agent': 'عدّل بالإيجنت',
      'No projects yet': 'مفيش مشاريع لسه', 'Start a conversation to begin production.': 'ابدأ محادثة عشان الإنتاج يبدأ.', 'New chat': 'محادثة جديدة',
      'Search skills…': 'دوّر في السكيلز…', 'Start with this pipeline': 'ابدأ بالبايبلاين ده', 'Requirements': 'المتطلبات', 'Update': 'تحديث',
    },
  };
  let lang = 'en';
  const t = (s) => (DICT[lang] && DICT[lang][s]) || s;
  function setLang(l) {
    lang = l || 'en';
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }

  // ---------- Markdown (small, safe subset) ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function md(src) {
    const blocks = String(src || '').split(/```/);
    return blocks.map((b, i) => {
      if (i % 2) return '<pre><code>' + esc(b.replace(/^\w*\n/, '')) + '</code></pre>';
      return b.split(/\n{2,}/).map((para) => {
        const lines = para.split('\n');
        if (lines.every(l => /^\s*([-*]|\d+\.)\s+/.test(l) || !l.trim())) {
          return '<ul>' + lines.filter(l => l.trim()).map(l => '<li>' + inline(l.replace(/^\s*([-*]|\d+\.)\s+/, '')) + '</li>').join('') + '</ul>';
        }
        const hm = para.match(/^#{1,4}\s+(.*)/);
        if (hm && lines.length === 1) return '<p><b>' + inline(hm[1]) + '</b></p>';
        return para.trim() ? '<p>' + lines.map(inline).join('<br>') + '</p>' : '';
      }).join('');
    }).join('');
  }
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  }

  // ---------- Toasts & modals ----------
  function toast(msg, kind) {
    const el = h('div.toast' + (kind === 'err' ? '.err' : ''), String(msg));
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3500);
  }
  function modal({ title, body, actions, wide, onClose }) {
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); if (onClose) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const foot = (actions || []).map(a => h('button.btn' + (a.primary ? '.primary' : '') + (a.danger ? '.danger' : ''), {
      onclick: async () => { if (a.onClick) { const r = await a.onClick(); if (r === false) return; } close(); },
    }, a.label));
    const ov = h('div.overlay', { onmousedown: (e) => { if (e.target === ov) close(); } },
      h('div.modal' + (wide ? '.wide' : ''),
        h('div.mh2', title, h('div', { style: { flex: 1 } }), h('button.btn.ghost.sm.icon', { onclick: close }, icon('x'))),
        h('div.mb', body),
        foot.length ? h('div.mf', foot) : null));
    document.body.appendChild(ov);
    document.addEventListener('keydown', onKey);
    return { close, el: ov };
  }

  function timeAgo(sec) {
    if (!sec) return '';
    const d = Date.now() / 1000 - sec;
    if (d < 60) return 'just now';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    return Math.floor(d / 86400) + 'd ago';
  }
  const fmtTime = (s) => { s = Math.max(0, s || 0); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
  const titleCase = (s) => String(s || '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const initials = (n) => String(n || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();

  window.UI = { h, icon, t, setLang, md, esc, toast, modal, timeAgo, fmtTime, titleCase, initials, get lang() { return lang; } };
})();
