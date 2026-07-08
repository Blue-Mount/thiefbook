import { loadBook } from './book.js';

let config = null;
const $ = (id) => document.getElementById(id);

function bindRange(id, apply) {
  const el = $(id);
  const v = $(id + 'V');
  el.addEventListener('input', () => {
    if (v) v.textContent = el.value;
    apply(el.value);
  });
}

async function init() {
  config = await window.api.getConfig();
  const s = config.settings;

  // 回填
  $('bg').value = s.bg;
  $('fg').value = s.fg;
  $('fontSize').value = s.fontSize;
  $('fontSizeV').textContent = s.fontSize;
  $('lineHeight').value = s.lineHeight;
  $('lineHeightV').textContent = s.lineHeight;
  $('opacity').value = s.opacity;
  $('opacityV').textContent = s.opacity;
  $('fontFamily').value = s.fontFamily;
  $('serverUrl').value = config.sync.serverUrl || '';

  // 绑定：改动即时生效（setConfig 会广播给阅读器）
  $('bg').addEventListener('input', (e) => window.api.setConfig({ settings: { bg: e.target.value } }));
  $('fg').addEventListener('input', (e) => window.api.setConfig({ settings: { fg: e.target.value } }));
  $('fontFamily').addEventListener('change', (e) => window.api.setConfig({ settings: { fontFamily: e.target.value } }));
  bindRange('fontSize', (v) => window.api.setConfig({ settings: { fontSize: Number(v) } }));
  bindRange('lineHeight', (v) => window.api.setConfig({ settings: { lineHeight: Number(v) } }));
  bindRange('opacity', (v) => window.api.setConfig({ settings: { opacity: Number(v) } }));

  const saveSync = () => {
    const serverUrl = ($('serverUrl').value || '').trim();
    window.api.setConfig({ sync: { serverUrl } });
  };
  $('serverUrl').addEventListener('change', saveSync);

  const closeWin = () => {
    saveSync(); // 关闭前兜底存一次，防止「输入后直接点关闭」漏掉 change 事件
    window.api.closeSelf();
  };
  $('close').addEventListener('click', closeWin);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeWin();
  });

  buildToc();
}

// ---------- 目录 ----------
let toc = [];
function buildToc() {
  loadBook(config.sync.serverUrl)
    .then((book) => {
      toc = book.toc || [];
      renderToc('');
    })
    .catch(() => {
      $('toc').innerHTML = '<div class="item">目录加载失败（先让阅读器联网一次）</div>';
    });

  $('search').addEventListener('input', (e) => renderToc(e.target.value.trim()));
}
function renderToc(q) {
  const list = $('toc');
  const cur = config.progress?.chapter ?? 0;
  const filtered = q
    ? toc.filter((c) => c.title.includes(q) || String(c.id) === q)
    : toc;
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const c of filtered.slice(0, 400)) {
    const div = document.createElement('div');
    div.className = 'item' + (c.id === cur ? ' active' : '');
    div.innerHTML = `${escapeHtml(c.title)}${c.volume ? `<span class="vol">${escapeHtml(c.volume)}</span>` : ''}`;
    div.addEventListener('click', () => {
      window.api.gotoChapter({ chapter: c.id, percent: 0 });
      window.api.closeSelf();
    });
    frag.appendChild(div);
  }
  list.appendChild(frag);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
}

init();
