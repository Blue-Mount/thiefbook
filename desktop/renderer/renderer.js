import { loadBook, BOOK_ID } from './book.js';
import { makeSync } from './sync.js';

const bar = document.getElementById('bar');
const measure = document.getElementById('measure');

let config = null;
let book = null;
let chapterIndex = 0;
let chapterText = '';
let pages = [[0, 0]]; // [startChar, endChar]
let pageIndex = 0;

const sync = makeSync(() => config.sync);

// ---------- 样式 / 布局 ----------
function contentWidth() {
  return Math.max(80, (config.width || 1000) - 20); // 左右各 10 padding
}
function maxHeight() {
  // 可用内容高度 = 窗口内容高 - 上下 padding(3+3)；字号不变，文字按此高度重排
  return Math.max(1, (config.height || 34) - 6);
}
function applyStyle() {
  const s = config.settings;
  const font = `${s.fontSize}px/${s.lineHeight} ${s.fontFamily}`;
  bar.style.color = s.fg;
  bar.style.font = font;
  measure.style.font = font;
  measure.style.width = contentWidth() + 'px';
}

// ---------- 分页（针对中文，按字符二分找每页边界）----------
function buildChapterText(idx) {
  const c = book.chapters[idx];
  if (!c) return '';
  const parts = [c.title, ...(c.paragraphs || [])].filter(Boolean);
  return parts.join('　　');
}
function paginate(text) {
  const out = [];
  const n = text.length;
  const limit = maxHeight();
  let start = 0;
  while (start < n) {
    let lo = start + 1,
      hi = n,
      fit = start + 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      measure.textContent = text.slice(start, mid);
      if (measure.scrollHeight <= limit) {
        fit = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (fit <= start) fit = start + 1; // 保证前进
    out.push([start, fit]);
    start = fit;
  }
  return out.length ? out : [[0, 0]];
}

function render() {
  const [a, b] = pages[pageIndex] || [0, 0];
  bar.textContent = chapterText.slice(a, b) || ' ';
}

// ---------- 进度换算 ----------
function currentPercent() {
  const len = chapterText.length;
  return len > 0 ? pages[pageIndex][0] / len : 0;
}
function pageForPercent(p) {
  if (p >= 1) return pages.length - 1;
  const target = p * chapterText.length;
  let idx = 0;
  for (let i = 0; i < pages.length; i++) {
    if (pages[i][0] <= target) idx = i;
    else break;
  }
  return idx;
}

// ---------- 章节 / 翻页 ----------
function loadChapter(idx, percent = 0) {
  chapterIndex = Math.max(0, Math.min(idx, book.chapters.length - 1));
  chapterText = buildChapterText(chapterIndex);
  pages = paginate(chapterText);
  pageIndex = pageForPercent(percent);
  render();
  saveLocal();
  schedulePush();
}
function nextPage() {
  if (pageIndex < pages.length - 1) {
    pageIndex++;
    render();
    saveLocal();
    schedulePush();
  } else if (chapterIndex < book.chapters.length - 1) {
    loadChapter(chapterIndex + 1, 0);
  }
}
function prevPage() {
  if (pageIndex > 0) {
    pageIndex--;
    render();
    saveLocal();
    schedulePush();
  } else if (chapterIndex > 0) {
    loadChapter(chapterIndex - 1, 1); // 上一章最后一页
  }
}

// ---------- 保存 & 云同步 ----------
function makeProgress() {
  return { chapter: chapterIndex, percent: currentPercent(), updatedAt: Date.now() };
}
let saveTimer = null;
function saveLocal() {
  clearTimeout(saveTimer);
  const p = { ...makeProgress(), device: config.device };
  config.progress = p;
  saveTimer = setTimeout(() => window.api.setConfig({ progress: p }), 400);
}
let pushTimer = null;
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 1500);
}
async function pushNow() {
  clearTimeout(pushTimer);
  try {
    const res = await sync.push(BOOK_ID, makeProgress(), config.device);
    if (res.skipped) return;
    if (res.accepted === false && res.current) applyRemote(res.current);
  } catch {
    /* 网络异常忽略，下一次再推 */
  }
}
function applyRemote(remote) {
  if (!remote) return false;
  const localTs = config.progress?.updatedAt || 0;
  if (remote.updatedAt <= localTs) return false; // 本地更新，忽略
  const same =
    config.progress &&
    config.progress.chapter === remote.chapter &&
    Math.abs((config.progress.percent || 0) - (remote.percent || 0)) < 0.01;
  config.progress = { ...remote };
  window.api.setConfig({ progress: config.progress });
  if (same) return false;
  loadChapter(remote.chapter, remote.percent || 0);
  return true;
}
async function pullNow() {
  try {
    const remote = await sync.pull(BOOK_ID);
    applyRemote(remote);
  } catch {
    /* ignore */
  }
}

// ---------- 交互 ----------
function onKey(e) {
  if (e.key === 'PageDown') {
    e.preventDefault();
    nextPage();
  } else if (e.key === 'PageUp') {
    e.preventDefault();
    prevPage();
  }
}
let wheelLock = false;
function onWheel(e) {
  e.preventDefault();
  if (wheelLock) return;
  wheelLock = true;
  setTimeout(() => (wheelLock = false), 60);
  if (e.deltaY > 0) nextPage();
  else prevPage();
}
// 拖动窗口（左键按住）。用 pointer capture，保证细窗口里指针移出也能持续收到事件。
// 锁定时主进程会忽略移动。
let dragging = false;
let lastX = 0,
  lastY = 0;
function onPointerDown(e) {
  if (e.button !== 0) return;
  dragging = true;
  lastX = e.screenX;
  lastY = e.screenY;
  bar.setPointerCapture(e.pointerId);
}
function onPointerMove(e) {
  if (!dragging) return;
  const dx = e.screenX - lastX;
  const dy = e.screenY - lastY;
  lastX = e.screenX;
  lastY = e.screenY;
  if (dx || dy) window.api.drag(dx, dy);
}
function onPointerUp(e) {
  dragging = false;
  try {
    bar.releasePointerCapture(e.pointerId);
  } catch {}
}

// ---------- 配置热更新（设置窗口改动即时生效）----------
function onConfigChanged(cfg) {
  const p = currentPercent();
  const prevCode = config?.sync?.code;
  const prevServer = config?.sync?.serverUrl;
  config = cfg;
  applyStyle();
  pages = paginate(chapterText);
  pageIndex = pageForPercent(p);
  render();
  // 同步码/服务器地址一变，立刻拉一次云端，不用等 20 秒轮询
  if (config.sync.code !== prevCode || config.sync.serverUrl !== prevServer) {
    pullNow();
  }
}

// ---------- 启动 ----------
async function init() {
  config = await window.api.getConfig();
  applyStyle();
  try {
    book = await loadBook(config.sync.serverUrl);
  } catch (e) {
    bar.textContent = '⚠ 书籍加载失败，请检查网络后重启';
    return;
  }
  const local = config.progress;
  loadChapter(local?.chapter || 0, local?.percent || 0);

  bar.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.api.showMenu();
  });
  bar.addEventListener('pointerdown', onPointerDown);
  bar.addEventListener('pointermove', onPointerMove);
  bar.addEventListener('pointerup', onPointerUp);
  window.addEventListener('keydown', onKey);
  window.addEventListener('wheel', onWheel, { passive: false });

  window.api.onConfigChanged(onConfigChanged);
  window.api.onGoto((p) => loadChapter(p.chapter, p.percent || 0));
  window.api.onShown(() => pullNow());
  window.api.onHiding(() => pushNow());

  // 云端拉取一次，并定时轮询捕捉手机端的更新
  pullNow();
  setInterval(() => {
    if (!document.hidden) pullNow();
  }, 20000);
}

init();
