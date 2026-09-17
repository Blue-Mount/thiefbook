import { loadBook } from './book.js';
import { makeSync } from './sync.js';

let config = null;
const $ = (id) => document.getElementById(id);

// 窗口控制不能等待网络。服务器失联时，关闭按钮和 Esc 也必须立即可用。
function closeWin() {
  if (config) saveSync();
  window.api.closeSelf();
}
$('close').addEventListener('click', closeWin);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeWin();
});

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
  $('winWidth').value = config.width;
  $('winWidthV').textContent = config.width;
  $('winHeight').value = config.height;
  $('winHeightV').textContent = config.height;
  $('serverUrl').value = config.sync.serverUrl || '';

  const sync = makeSync(() => ({ serverUrl: ($('serverUrl').value || '').trim() }));
  void refreshBookList(sync);
  $('switchBook').addEventListener('click', () => {
    const select = $('bookSelect');
    const option = select.options[select.selectedIndex];
    window.api.switchBook({ id: select.value, title: option?.textContent || select.value });
    config.currentBookId = select.value;
    buildToc();
  });

  // 绑定：改动即时生效（setConfig 会广播给阅读器）
  $('bg').addEventListener('input', (e) => window.api.setConfig({ settings: { bg: e.target.value } }));
  $('fg').addEventListener('input', (e) => window.api.setConfig({ settings: { fg: e.target.value } }));
  $('fontFamily').addEventListener('change', (e) => window.api.setConfig({ settings: { fontFamily: e.target.value } }));
  bindRange('fontSize', (v) => window.api.setConfig({ settings: { fontSize: Number(v) } }));
  bindRange('lineHeight', (v) => window.api.setConfig({ settings: { lineHeight: Number(v) } }));
  bindRange('opacity', (v) => window.api.setConfig({ settings: { opacity: Number(v) } }));
  // 框大小：直接改顶层 width/height，主进程 applyWindowConfig 会 setContentSize 并让阅读器重排
  bindRange('winWidth', (v) => window.api.setConfig({ width: Number(v) }));
  bindRange('winHeight', (v) => window.api.setConfig({ height: Number(v) }));

  $('serverUrl').addEventListener('change', saveSync);

  buildToc();
}

function saveSync() {
  const serverUrl = ($('serverUrl').value || '').trim();
  return window.api.setConfig({ sync: { serverUrl } });
}

async function refreshBookList(sync) {
  let books = [];
  try {
    books = await sync.listBooks();
  } catch {
    books = await window.api.listLocalBooks();
  }
  if (!books.some((b) => b.id === (config.currentBookId || 'fuhan'))) {
    books.unshift({
      id: config.currentBookId || 'fuhan',
      title: config.currentBookTitle || '覆汉',
      author: '',
    });
  }
  $('bookSelect').innerHTML = books.map((b) =>
    `<option value="${escapeHtml(b.id)}">${escapeHtml(b.title)}${b.author ? ` · ${escapeHtml(b.author)}` : ''}</option>`
  ).join('');
  $('bookSelect').value = config.currentBookId || 'fuhan';
}

// ---------- 目录 ----------
let toc = [];
function buildToc() {
  loadBook(config.sync.serverUrl, config.currentBookId || 'fuhan')
    .then((book) => {
      toc = book.toc || [];
      renderToc('');
    })
    .catch(() => {
      $('toc').innerHTML = '<div class="item">目录加载失败（先让阅读器联网一次）</div>';
    });
}
function renderToc(q) {
  const list = $('toc');
  const cur = config.progresses?.[config.currentBookId || 'fuhan']?.chapter ?? config.progress?.chapter ?? 0;
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

$('search').addEventListener('input', (e) => renderToc(e.target.value.trim()));

init();
