import { loadBook } from './book.js';

const $ = (id) => document.getElementById(id);
let toc = [];
let filtered = [];
let active = 0;
let config = null;

async function init() {
  config = await window.api.getConfig();
  try {
    const book = await loadBook(config.sync.serverUrl);
    toc = book.toc || [];
  } catch {
    $('toc').innerHTML = '<div class="item">目录加载失败（先让阅读器联网一次）</div>';
    return;
  }
  filtered = toc;
  active = config.progress?.chapter ?? 0;
  render();

  const search = $('search');
  search.focus();
  search.addEventListener('input', () => {
    const q = search.value.trim();
    filtered = q ? toc.filter((c) => c.title.includes(q) || String(c.id) === q) : toc;
    active = 0;
    render();
  });

  window.addEventListener('keydown', onKey);
  $('close').addEventListener('click', () => window.api.closeSelf());
}

function onKey(e) {
  if (e.key === 'Escape') {
    window.api.closeSelf();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    active = Math.min(active + 1, filtered.length - 1);
    render(true);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    active = Math.max(active - 1, 0);
    render(true);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    go(filtered[active]);
  }
}

function go(c) {
  if (!c) return;
  window.api.gotoChapter({ chapter: c.id, percent: 0 });
  window.api.closeSelf();
}

function render(scroll) {
  const list = $('toc');
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  const view = filtered.slice(0, 400);
  view.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'item' + (i === active ? ' active' : '');
    div.innerHTML = `${escapeHtml(c.title)}${c.volume ? `<span class="vol">${escapeHtml(c.volume)}</span>` : ''}`;
    div.addEventListener('click', () => go(c));
    frag.appendChild(div);
  });
  list.appendChild(frag);
  if (scroll) {
    const el = list.children[active];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
}

init();
