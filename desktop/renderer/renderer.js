import { loadBook } from './book.js';
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
const activeBookId = () => config?.currentBookId || 'fuhan';
const activeProgress = (bookId = activeBookId()) => config?.progresses?.[bookId] || null;

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
  bar.style.background = s.bg; // 窗口透明，这条实色背景由 CSS 画（才能去掉系统边框/投影）
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
function loadChapter(idx, percent = 0, persist = true) {
  chapterIndex = Math.max(0, Math.min(idx, book.chapters.length - 1));
  chapterText = buildChapterText(chapterIndex);
  pages = paginate(chapterText);
  pageIndex = pageForPercent(percent);
  render();
  // 启动恢复、应用远端进度只负责定位，不能伪造一次“本地阅读”再反向覆盖云端。
  if (persist) {
    saveLocal();
    schedulePush();
  }
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
  config.progresses = { ...(config.progresses || {}), [activeBookId()]: p };
  config.progress = p;
  const bookId = activeBookId();
  saveTimer = setTimeout(() => window.api.setConfig({ progress: p, progresses: { [bookId]: p } }), 400);
  return p;
}
let pushTimer = null;
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 1500);
}
async function pushNow(bookId = activeBookId()) {
  clearTimeout(pushTimer);
  // 上报最近一次真实阅读动作保存的进度；不能在发送时重造时间戳，
  // 否则启动恢复出的旧位置也可能被包装成“最新”并覆盖云端。
  const progress = activeProgress(bookId);
  if (!progress) return;
  try {
    const res = await sync.push(bookId, progress, config.device);
    if (res.skipped) return;
    if (res.accepted === false && res.current && bookId === activeBookId()) applyRemote(res.current);
  } catch {
    // 短暂断网时保留同一个 updatedAt 重试，既不丢更新，也不会抢占真正较新的远端进度。
    pushTimer = setTimeout(pushNow, 5000);
  }
}
function applyRemote(remote) {
  if (!remote || remote.book !== activeBookId()) return false;
  const local = activeProgress();
  const localTs = local?.updatedAt || 0;
  if (remote.updatedAt <= localTs) return false; // 本地更新，忽略
  const same =
    local &&
    local.chapter === remote.chapter &&
    Math.abs((local.percent || 0) - (remote.percent || 0)) < 0.01;
  config.progresses = { ...(config.progresses || {}), [activeBookId()]: { ...remote } };
  config.progress = { ...remote };
  window.api.setConfig({ progress: config.progress, progresses: { [activeBookId()]: config.progress } });
  if (same) return false;
  loadChapter(remote.chapter, remote.percent || 0, false);
  return true;
}
async function pullNow() {
  try {
    const remote = await sync.pull(activeBookId());
    applyRemote(remote);
  } catch {
    /* ignore */
  }
}

async function switchToBook(bookId, updatedAt = Date.now(), broadcast = false) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(bookId)) return;
  if (book && bookId === activeBookId()) return;
  const previousBookId = activeBookId();
  if (book) {
    saveLocal();
    void pushNow(previousBookId);
  }
  try {
    const loaded = await loadBook(config.sync.serverUrl, bookId);
    book = loaded;
    config.currentBookId = bookId;
    config.currentBookTitle = `${loaded.title}${loaded.author ? ` · ${loaded.author}` : ''}`;
    config.currentBookUpdatedAt = updatedAt;
    config.progress = activeProgress(bookId);
    await window.api.setConfig({
      currentBookId: bookId,
      currentBookTitle: config.currentBookTitle,
      currentBookUpdatedAt: updatedAt,
      progress: config.progress,
    });
    const local = activeProgress(bookId);
    loadChapter(local?.chapter || 0, local?.percent || 0, false);
    if (broadcast) await sync.pushCurrentBook(bookId, updatedAt, config.device);
    await pullNow();
  } catch {
    bar.textContent = '⚠ 小说加载失败，请检查服务器后重试';
  }
}

async function syncCurrentBook() {
  try {
    const remote = await sync.pullCurrentBook();
    if (remote?.book && remote.updatedAt > (config.currentBookUpdatedAt || 0)) {
      await switchToBook(remote.book, remote.updatedAt, false);
    } else if (activeBookId() && (config.currentBookUpdatedAt || 0) > (remote?.updatedAt || 0)) {
      await sync.pushCurrentBook(activeBookId(), config.currentBookUpdatedAt, config.device);
    }
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
let dragMode = 'move'; // 'move' | 'resize'
let lastX = 0,
  lastY = 0;
function onPointerDown(e) {
  if (e.button !== 0) return;
  dragging = true;
  // 按住 Alt 拖动 = 改大小；否则只移动。刻意区分，避免细窗口里误触把框拖大。
  dragMode = e.altKey ? 'resize' : 'move';
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
  if (!dx && !dy) return;
  if (dragMode === 'resize') window.api.resize(dx, dy);
  else window.api.drag(dx, dy);
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
    book = await loadBook(config.sync.serverUrl, activeBookId());
  } catch (e) {
    bar.textContent = '⚠ 书籍加载失败，请检查网络后重启';
    return;
  }
  const local = activeProgress();
  // 仅恢复位置；没有本地记录时显示第一章，但绝不把第一章自动推到云端。
  loadChapter(local?.chapter || 0, local?.percent || 0, false);

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
  window.api.onSwitchBook((p) => switchToBook(p.id, p.updatedAt || Date.now(), p.broadcast !== false));
  window.api.onShown(() => pullNow());
  window.api.onHiding(() => pushNow());

  // 云端拉取一次，并定时轮询捕捉手机端的更新
  pullNow();
  syncCurrentBook();
  setInterval(() => {
    if (!document.hidden) {
      pullNow();
      syncCurrentBook();
    }
  }, 20000);
}

init();
