<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { storage } from './lib/storage';
import { makeApi } from './lib/api';

const book = ref(null);
const books = ref([]);
const currentBookId = ref(storage.getCurrentBook());
const chapterIndex = ref(0);
const loading = ref(true);
const loadError = ref('');

const settings = reactive(storage.getSettings());
const sync = reactive(storage.getSync());
const device = storage.getDevice();
const api = makeApi(() => sync);

const showToc = ref(false);
const showLibrary = ref(false);
const showSettings = ref(false);
const bookFileInput = ref(null);
const uploading = ref(false);
const syncStatus = ref('local');
const toast = ref('');
let toastTimer = null;

const chapter = computed(() => book.value?.chapters[chapterIndex.value] || null);
const chapterCount = computed(() => book.value?.chapters.length || 0);

function activeBookId() {
  return currentBookId.value;
}

function say(msg) {
  toast.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ''), 2600);
}

// ---------- 进度：滚动百分比 ----------
function currentPercent() {
  const el = document.documentElement;
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0;
}
function scrollToPercent(p) {
  const el = document.documentElement;
  const max = el.scrollHeight - el.clientHeight;
  window.scrollTo({ top: max * (p || 0), behavior: 'auto' });
}
function makeProgress() {
  return { chapter: chapterIndex.value, percent: currentPercent(), updatedAt: Date.now() };
}

// ---------- 保存（本地即时 + 云端防抖）----------
let pushTimer = null;
function saveLocal() {
  const bookId = activeBookId();
  if (!book.value || book.value.id !== bookId) return null;
  const progress = { ...makeProgress(), device };
  storage.setProgress(bookId, progress);
  return progress;
}
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushNow(activeBookId()), 1500);
}
async function pushNow(bookId = activeBookId()) {
  clearTimeout(pushTimer);
  const progress = storage.getProgress(bookId);
  if (!progress) return;
  try {
    if (bookId === activeBookId()) syncStatus.value = 'syncing';
    const res = await api.push(bookId, progress, device);
    if (bookId !== activeBookId()) return;
    if (res.skipped) { syncStatus.value = 'local'; return; }
    if (res.accepted === false && res.current) applyRemote(res.current, true);
    syncStatus.value = 'ok';
  } catch {
    if (bookId === activeBookId()) syncStatus.value = 'error';
    pushTimer = setTimeout(() => pushNow(bookId), 5000);
  }
}

// ---------- 应用远端进度 ----------
function applyRemote(remote, notify) {
  if (!remote || remote.book !== activeBookId()) return false;
  const local = storage.getProgress(activeBookId());
  const localTs = local?.updatedAt || 0;
  if (remote.updatedAt <= localTs) return false;
  const samePos = local && local.chapter === remote.chapter && Math.abs((local.percent || 0) - (remote.percent || 0)) < 0.01;
  storage.setProgress(activeBookId(), { ...remote, device: remote.device });
  if (samePos) return false;
  goChapter(remote.chapter, remote.percent, false, false);
  if (notify) say(`已从「${remote.device || '云端'}」同步到 ${chapterTitle(remote.chapter)}`);
  return true;
}

function chapterTitle(idx) {
  return book.value?.chapters[idx]?.title || `第${idx + 1}章`;
}

// ---------- 章节跳转 ----------
function goChapter(idx, percent = 0, resetScroll = true, persist = true) {
  if (idx < 0 || idx >= chapterCount.value) return;
  chapterIndex.value = idx;
  showToc.value = false;
  nextTick(() => {
    if (resetScroll && !percent) window.scrollTo({ top: 0, behavior: 'auto' });
    else scrollToPercent(percent);
    if (persist) {
      saveLocal();
      schedulePush();
    }
  });
}
const prevChapter = () => goChapter(chapterIndex.value - 1);
const nextChapter = () => goChapter(chapterIndex.value + 1);

// ---------- 目录 ----------
const tocList = ref(null);
function openToc() {
  showToc.value = true;
  nextTick(() => {
    const el = tocList.value?.querySelector('li.active');
    if (el) el.scrollIntoView({ block: 'center' });
  });
}

// ---------- 夜间模式 ----------
let lastLightTheme = settings.theme === 'dark' ? 'sepia' : settings.theme;
const isNight = computed(() => settings.theme === 'dark');
function toggleNight() {
  if (settings.theme === 'dark') settings.theme = lastLightTheme || 'sepia';
  else {
    lastLightTheme = settings.theme;
    settings.theme = 'dark';
  }
}

// ---------- 滚动与键盘 ----------
let scrollTimer = null;
function onScroll() {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    if (loading.value) return;
    saveLocal();
    schedulePush();
  }, 400);
}
function onKey(e) {
  if (showSettings.value || showToc.value || showLibrary.value) return;
  if (e.key === 'ArrowLeft') prevChapter();
  if (e.key === 'ArrowRight') nextChapter();
}

// ---------- 设置与同步 ----------
watch(settings, () => storage.setSettings({ ...settings }), { deep: true });
function saveSync() {
  sync.serverUrl = (sync.serverUrl || '').trim();
  storage.setSync({ ...sync });
  showSettings.value = false;
  refreshLibrary();
  refreshSync();
}
async function refreshSync() {
  const bookId = activeBookId();
  syncStatus.value = 'syncing';
  const ok = await api.health();
  if (!ok) { syncStatus.value = 'error'; say('连不上同步服务器，请检查地址'); return; }
  try {
    const remote = await api.pull(bookId);
    if (bookId !== activeBookId()) return;
    const adopted = applyRemote(remote, true);
    syncStatus.value = 'ok';
    if (!adopted) {
      if (!remote) say('云端本书暂无进度（先在另一台读几章并保存）');
      else say(`已是最新 · 云端 ${chapterTitle(remote.chapter)}`);
    }
  } catch {
    if (bookId === activeBookId()) syncStatus.value = 'error';
  }
}
const statusText = computed(() => ({
  local: '仅本地', ok: '已同步', error: '同步异常', syncing: '同步中…',
}[syncStatus.value]));

// ---------- 多书书库 ----------
async function refreshLibrary() {
  try {
    books.value = await api.listBooks();
  } catch {
    try {
      const r = await fetch('./books/index.json', { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      books.value = await r.json();
    } catch {
      books.value = [{ id: 'fuhan', title: '覆汉', author: '', chapterCount: 0 }];
    }
  }
}

async function switchBook(bookId, notify = true, broadcast = true) {
  if (bookId === activeBookId() && book.value) {
    showLibrary.value = false;
    return;
  }

  const previousBookId = activeBookId();
  if (book.value) {
    saveLocal();
    void pushNow(previousBookId);
  }
  clearTimeout(scrollTimer);
  clearTimeout(pushTimer);

  loading.value = true;
  loadError.value = '';
  showLibrary.value = false;
  book.value = null;
  currentBookId.value = bookId;
  const switchedAt = Date.now();
  storage.setCurrentBook(bookId, switchedAt, device);
  if (broadcast) {
    api.pushCurrentBook(bookId, switchedAt, device).catch(() => {});
  }
  window.scrollTo({ top: 0, behavior: 'auto' });

  try {
    // Versioned URL bypasses stale CacheFirst entries created by older PWA builds.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let loaded;
    try {
      const r = await fetch(`./books/${encodeURIComponent(bookId)}.json?v=2`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      loaded = await r.json();
    } finally {
      clearTimeout(timer);
    }
    if (bookId !== activeBookId()) return;
    book.value = loaded;
    const local = storage.getProgress(bookId);
    chapterIndex.value = Math.max(0, Math.min(local?.chapter || 0, loaded.chapters.length - 1));
    loading.value = false;
    await nextTick();
    scrollToPercent(local?.percent || 0);
    if (notify) say(`已切换到《${loaded.title}》，并恢复阅读进度`);
    refreshSync();
  } catch (e) {
    if (bookId !== activeBookId()) return;
    book.value = null;
    loading.value = false;
    loadError.value = '书籍加载失败：' + e.message;
  }
}

async function syncCurrentBook(notify = true) {
  try {
    const remote = await api.pullCurrentBook();
    const local = storage.getCurrentBookState();
    if (remote?.book && remote.updatedAt > (local?.updatedAt || 0)) {
      if (!books.value.some((b) => b.id === remote.book)) return;
      storage.setCurrentBook(remote.book, remote.updatedAt, remote.device || '');
      if (remote.book !== activeBookId()) {
        currentBookId.value = remote.book;
        await switchBook(remote.book, notify, false);
      }
    } else if (local?.book && local.updatedAt > (remote?.updatedAt || 0)) {
      await api.pushCurrentBook(local.book, local.updatedAt, local.device || device);
    }
  } catch {
    // Selection sync is best-effort; reading and progress sync continue offline.
  }
}

async function uploadBook(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.txt')) { say('请选择 TXT 小说文件'); return; }

  const suggested = file.name.replace(/\.txt$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const id = (window.prompt('请输入小说 ID（英文、数字、短横线；以后不能重复）', suggested || `book-${Date.now()}`) || '').trim();
  if (!id) return;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) { say('小说 ID 格式不正确'); return; }
  const guessedTitle = file.name.replace(/\.txt$/i, '').replace(/^《|》$/g, '');
  const title = (window.prompt('请确认小说书名', guessedTitle) || '').trim();
  if (!title) return;

  try {
    uploading.value = true;
    say('正在上传并解析小说…');
    const result = await api.uploadBook(file, id, title);
    await refreshLibrary();
    say(`《${result.book.title}》添加成功`);
    await switchBook(result.book.id);
  } catch (err) {
    say('添加失败：' + err.message);
  } finally {
    uploading.value = false;
  }
}

// ---------- 启动 ----------
onMounted(async () => {
  await refreshLibrary();
  await syncCurrentBook(false);
  if (!books.value.some((b) => b.id === activeBookId())) {
    currentBookId.value = books.value[0]?.id || 'fuhan';
    storage.setCurrentBook(currentBookId.value, Date.now(), device);
  }
  await switchBook(activeBookId(), false, false);

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => { if (document.hidden) pushNow(); });
  window.addEventListener('beforeunload', () => { saveLocal(); });
  setInterval(() => { if (!document.hidden) syncCurrentBook(true); }, 20000);
});

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll);
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div :class="['app', 'theme-' + settings.theme]">
    <header class="bar top">
      <button class="icon" @click="openToc" title="目录">☰</button>
      <button class="icon" @click="showLibrary = true" title="切换小说">▣</button>
      <div class="titles" @click="showLibrary = true" title="切换小说">
        <div class="book-title">{{ book?.title || '摸鱼看书' }}</div>
        <div class="chap-title">{{ chapter?.title }}</div>
      </div>
      <button class="icon" @click="toggleNight" :title="isNight ? '日间模式' : '夜间模式'">{{ isNight ? '☀' : '☾' }}</button>
      <button class="icon" @click="showSettings = true" title="设置">⚙</button>
    </header>

    <main class="reader" :style="{ fontSize: settings.fontSize + 'px', lineHeight: settings.lineHeight, letterSpacing: settings.letterSpacing + 'px' }">
      <div v-if="loading" class="hint">正在加载小说…</div>
      <div v-else-if="loadError" class="hint error">{{ loadError }}</div>
      <template v-else>
        <h2 v-if="chapter?.volume" class="volume">{{ chapter.volume }}</h2>
        <h1 class="chapter-heading">{{ chapter?.title }}</h1>
        <p v-for="(p, i) in chapter?.paragraphs" :key="i">{{ p }}</p>
        <div class="chapter-nav">
          <button :disabled="chapterIndex === 0" @click="prevChapter">上一章</button>
          <span>{{ chapterIndex + 1 }} / {{ chapterCount }}</span>
          <button :disabled="chapterIndex === chapterCount - 1" @click="nextChapter">下一章</button>
        </div>
      </template>
    </main>

    <footer class="bar bottom">
      <button class="icon" :disabled="chapterIndex === 0" @click="prevChapter">‹</button>
      <button class="txt" @click="settings.fontSize = Math.max(14, settings.fontSize - 1)">A-</button>
      <div class="status" :class="syncStatus" @click="refreshSync">● {{ statusText }}</div>
      <button class="txt" @click="settings.fontSize = Math.min(34, settings.fontSize + 1)">A+</button>
      <button class="icon" :disabled="chapterIndex === chapterCount - 1" @click="nextChapter">›</button>
    </footer>

    <div v-if="showToc" class="drawer-mask" @click.self="showToc = false">
      <aside class="drawer">
        <div class="drawer-head">目录 · 共 {{ chapterCount }} 章</div>
        <ul class="toc" ref="tocList">
          <li v-for="c in book?.toc" :key="c.id" :class="{ active: c.id === chapterIndex }" @click="goChapter(c.id)">
            <span class="toc-title">{{ c.title }}</span>
            <span v-if="c.id === chapterIndex" class="toc-now">在读</span>
          </li>
        </ul>
      </aside>
    </div>

    <div v-if="showLibrary" class="drawer-mask" @click.self="showLibrary = false">
      <aside class="drawer library-drawer">
        <div class="drawer-head library-head">
          <span>我的小说 · {{ books.length }} 本</span>
          <button class="add-book" :disabled="uploading" @click="bookFileInput.click()">{{ uploading ? '添加中…' : '＋ 添加 TXT' }}</button>
          <input ref="bookFileInput" class="file-input" type="file" accept=".txt,text/plain" @change="uploadBook" />
        </div>
        <ul class="book-list">
          <li v-for="b in books" :key="b.id" :class="{ active: b.id === currentBookId }" @click="switchBook(b.id)">
            <div class="book-info">
              <strong>{{ b.title }}</strong>
              <span>{{ b.author || '未知作者' }} · {{ b.chapterCount }} 章</span>
            </div>
            <span v-if="b.id === currentBookId" class="toc-now">在读</span>
            <span v-else-if="storage.getProgress(b.id)" class="saved-progress">有进度</span>
          </li>
        </ul>
      </aside>
    </div>

    <div v-if="showSettings" class="drawer-mask center" @click.self="showSettings = false">
      <section class="modal">
        <h3>阅读设置</h3>
        <label>主题
          <div class="themes">
            <button v-for="t in ['light','sepia','dark']" :key="t" :class="['theme-dot', t, { on: settings.theme === t }]" @click="settings.theme = t"></button>
          </div>
        </label>
        <label>字号 <input type="range" min="14" max="34" v-model.number="settings.fontSize" /> {{ settings.fontSize }}</label>
        <label>行距 <input type="range" min="1.4" max="2.6" step="0.1" v-model.number="settings.lineHeight" /> {{ settings.lineHeight }}</label>

        <h3>多端同步</h3>
        <p class="sub">手机与电脑已自动同一份进度，无需再填同步码。</p>
        <label>服务器地址<span class="opt">（选填，留空=当前网址）</span>
          <input type="text" v-model.trim="sync.serverUrl" placeholder="留空即可，本地开发时才需填" />
        </label>
        <div class="modal-actions">
          <button class="ghost" @click="showSettings = false">关闭</button>
          <button class="primary" @click="saveSync">保存并同步</button>
        </div>
      </section>
    </div>

    <transition name="fade">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </transition>
  </div>
</template>
