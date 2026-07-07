<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { storage } from './lib/storage';
import { makeApi } from './lib/api';

const BOOK_ID = 'fuhan';
const BOOK_URL = `./books/${BOOK_ID}.json`;

const book = ref(null);          // { title, author, toc, chapters:[{id,title,volume,paragraphs}] }
const chapterIndex = ref(0);
const loading = ref(true);
const loadError = ref('');

const settings = reactive(storage.getSettings());
const sync = reactive(storage.getSync());
const device = storage.getDevice();
const api = makeApi(() => sync);

const showToc = ref(false);
const showSettings = ref(false);
const syncStatus = ref('local');  // local | ok | error | syncing
const toast = ref('');
let toastTimer = null;

const chapter = computed(() => book.value?.chapters[chapterIndex.value] || null);
const chapterCount = computed(() => book.value?.chapters.length || 0);

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
  storage.setProgress(BOOK_ID, { ...makeProgress(), device });
}
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 1500);
}
async function pushNow() {
  clearTimeout(pushTimer);
  if (!sync.code) return;
  try {
    syncStatus.value = 'syncing';
    const res = await api.push(BOOK_ID, makeProgress(), device);
    if (res.skipped) { syncStatus.value = 'local'; return; }
    if (res.accepted === false && res.current) {
      // 服务器上有更新的记录（别的设备刚存的），跟进它
      applyRemote(res.current, true);
    }
    syncStatus.value = 'ok';
  } catch {
    syncStatus.value = 'error';
  }
}

// ---------- 应用远端进度 ----------
function applyRemote(remote, notify) {
  if (!remote) return false;
  const local = storage.getProgress(BOOK_ID);
  const localTs = local?.updatedAt || 0;
  if (remote.updatedAt <= localTs) return false;         // 本地更新，忽略
  const samePos = local && local.chapter === remote.chapter && Math.abs((local.percent || 0) - (remote.percent || 0)) < 0.01;
  storage.setProgress(BOOK_ID, { ...remote, device: remote.device });
  if (samePos) return false;
  goChapter(remote.chapter, remote.percent, false);
  if (notify) say(`已从「${remote.device || '云端'}」同步到 ${chapterTitle(remote.chapter)}`);
  return true;
}

function chapterTitle(idx) {
  return book.value?.chapters[idx]?.title || `第${idx + 1}章`;
}

// ---------- 章节跳转 ----------
function goChapter(idx, percent = 0, resetScroll = true) {
  if (idx < 0 || idx >= chapterCount.value) return;
  chapterIndex.value = idx;
  showToc.value = false;
  nextTick(() => {
    if (resetScroll && !percent) window.scrollTo({ top: 0, behavior: 'auto' });
    else scrollToPercent(percent);
    saveLocal();
    schedulePush();
  });
}
const prevChapter = () => goChapter(chapterIndex.value - 1);
const nextChapter = () => goChapter(chapterIndex.value + 1);

// ---------- 滚动监听 ----------
let scrollTimer = null;
function onScroll() {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    saveLocal();
    schedulePush();
  }, 400);
}

// ---------- 键盘 ----------
function onKey(e) {
  if (showSettings.value || showToc.value) return;
  if (e.key === 'ArrowLeft') prevChapter();
  if (e.key === 'ArrowRight') nextChapter();
}

// ---------- 设置持久化 ----------
watch(settings, () => storage.setSettings({ ...settings }), { deep: true });
function saveSync() {
  // 同步码统一小写+去空格，避免手机自动大写/多打空格导致两端对不上
  sync.code = (sync.code || '').trim().toLowerCase();
  sync.serverUrl = (sync.serverUrl || '').trim();
  storage.setSync({ ...sync });
  showSettings.value = false;
  refreshSync();
}
async function refreshSync() {
  if (!sync.code) { syncStatus.value = 'local'; return; }
  syncStatus.value = 'syncing';
  const ok = await api.health();
  if (!ok) { syncStatus.value = 'error'; say('连不上同步服务器，请检查地址'); return; }
  try {
    const remote = await api.pull(BOOK_ID);
    const adopted = applyRemote(remote, true);
    syncStatus.value = 'ok';
    if (!adopted) {
      if (!remote) say('云端本码下暂无进度（先在另一台读几章并保存）');
      else say(`已是最新 · 云端 ${chapterTitle(remote.chapter)}`);
    }
  } catch {
    syncStatus.value = 'error';
  }
}

const statusText = computed(() => ({
  local: '仅本地', ok: '已同步', error: '同步异常', syncing: '同步中…',
}[syncStatus.value]));

// ---------- 启动 ----------
onMounted(async () => {
  try {
    const r = await fetch(BOOK_URL);
    book.value = await r.json();
  } catch (e) {
    loadError.value = '书籍加载失败：' + e.message;
    loading.value = false;
    return;
  }
  const local = storage.getProgress(BOOK_ID);
  chapterIndex.value = Math.min(local?.chapter || 0, chapterCount.value - 1);
  loading.value = false;

  await nextTick();
  if (local?.percent) scrollToPercent(local.percent);

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => { if (document.hidden) pushNow(); });
  window.addEventListener('beforeunload', () => { saveLocal(); });

  refreshSync();
});

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll);
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div :class="['app', 'theme-' + settings.theme]">
    <!-- 顶栏 -->
    <header class="bar top">
      <button class="icon" @click="showToc = true" title="目录">☰</button>
      <div class="titles">
        <div class="book-title">{{ book?.title || '摸鱼看书' }}</div>
        <div class="chap-title">{{ chapter?.title }}</div>
      </div>
      <button class="icon" @click="showSettings = true" title="设置">⚙</button>
    </header>

    <!-- 正文 -->
    <main
      class="reader"
      :style="{
        fontSize: settings.fontSize + 'px',
        lineHeight: settings.lineHeight,
        letterSpacing: settings.letterSpacing + 'px',
      }"
    >
      <div v-if="loading" class="hint">正在加载《覆汉》…</div>
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

    <!-- 底栏 -->
    <footer class="bar bottom">
      <button class="icon" :disabled="chapterIndex === 0" @click="prevChapter">‹</button>
      <button class="txt" @click="settings.fontSize = Math.max(14, settings.fontSize - 1)">A-</button>
      <div class="status" :class="syncStatus" @click="refreshSync">● {{ statusText }}</div>
      <button class="txt" @click="settings.fontSize = Math.min(34, settings.fontSize + 1)">A+</button>
      <button class="icon" :disabled="chapterIndex === chapterCount - 1" @click="nextChapter">›</button>
    </footer>

    <!-- 目录抽屉 -->
    <div v-if="showToc" class="drawer-mask" @click.self="showToc = false">
      <aside class="drawer">
        <div class="drawer-head">目录 · 共 {{ chapterCount }} 章</div>
        <ul class="toc">
          <li
            v-for="c in book?.toc"
            :key="c.id"
            :class="{ active: c.id === chapterIndex }"
            @click="goChapter(c.id)"
          >
            {{ c.title }}
          </li>
        </ul>
      </aside>
    </div>

    <!-- 设置弹窗 -->
    <div v-if="showSettings" class="drawer-mask center" @click.self="showSettings = false">
      <section class="modal">
        <h3>阅读设置</h3>
        <label>主题
          <div class="themes">
            <button v-for="t in ['light','sepia','dark']" :key="t"
              :class="['theme-dot', t, { on: settings.theme === t }]" @click="settings.theme = t"></button>
          </div>
        </label>
        <label>字号 <input type="range" min="14" max="34" v-model.number="settings.fontSize" /> {{ settings.fontSize }}</label>
        <label>行距 <input type="range" min="1.4" max="2.6" step="0.1" v-model.number="settings.lineHeight" /> {{ settings.lineHeight }}</label>

        <h3>多端同步</h3>
        <p class="sub">两台设备填<b>相同的同步码</b>即可自动同步进度。</p>
        <label>同步码
          <input type="text" v-model.trim="sync.code" placeholder="自定义，如 eric-2026"
            autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off" />
        </label>
        <p class="sub" v-if="sync.code">两端只要这串一致即可（不区分大小写）：<b>{{ sync.code.trim().toLowerCase() }}</b></p>
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
