import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { ref, reactive, computed, nextTick, watch } from 'vue';

// Execute the reader's actual setup code with deterministic browser/network adapters.
const script = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
  .split('<script setup>')[1].split('</script>')[0].replace(/^import .*;\r?\n/gm, '');

async function reader({ local, remote = local } = {}) {
  const events = new Map();
  const timers = new Map();
  const intervals = [];
  const pushes = [];
  const progresses = new Map(local ? [['fuhan', structuredClone(local)]] : []);
  let current = { book: 'fuhan', updatedAt: 10, device: 'phone' };
  let cloud = remote && structuredClone(remote);
  let mounted;
  let id = 0;
  const doc = { hidden: false, documentElement: { scrollHeight: 2000, clientHeight: 1000, scrollTop: 0 } };
  const browser = {
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: (name) => events.delete(name),
    scrollTo({ top }) {
      doc.documentElement.scrollTop = top;
      queueMicrotask(() => events.get('scroll')?.());
    },
  };
  Object.assign(doc, { addEventListener: browser.addEventListener, removeEventListener: browser.removeEventListener });
  const api = {
    listBooks: async () => [{ id: 'fuhan' }, { id: 'other' }],
    bookManifest: async (book) => ({ id: book, title: book, chapters: Array.from({ length: 8 }, (_, id) => ({ id, title: `${id}` })) }),
    bookChapter: async (_book, id) => ({ id, title: `${id}`, paragraphs: ['正文'] }),
    pullCurrentBook: async () => current,
    pushCurrentBook: async () => {},
    pull: async () => cloud,
    push: async (book, progress) => {
      pushes.push({ book, ...structuredClone(progress) });
      if (cloud && cloud.updatedAt > progress.updatedAt) return { accepted: false, current: cloud };
      cloud = { book, ...structuredClone(progress) };
      return { accepted: true, current: cloud };
    },
  };
  const context = vm.createContext({
    ref, reactive, computed, nextTick, watch, console, document: doc, window: browser,
    onMounted: (fn) => { mounted = fn; }, onBeforeUnmount: () => {},
    setTimeout: (fn, delay) => { timers.set(++id, { fn, delay }); return id; },
    clearTimeout: (key) => timers.delete(key),
    setInterval: (fn) => { intervals.push(fn); return intervals.length; }, clearInterval: () => {},
    storage: {
      getSettings: () => ({ theme: 'sepia' }), getSync: () => ({}), getDevice: () => 'phone',
      getCurrentBook: () => current.book, getCurrentBookState: () => current,
      setCurrentBook: (book, updatedAt, device) => { current = { book, updatedAt, device }; },
      getProgress: (book) => progresses.get(book),
      setProgress: (book, p) => progresses.set(book, structuredClone(p)),
    },
    makeApi: () => api,
    useAudiobook: () => ({ state: {}, stop() {}, destroy() {} }),
  });
  vm.runInContext(script + '\nglobalThis.reader = { goChapter, refreshSync, switchBook, applyRemote };', context);
  await mounted();
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  return {
    ...context.reader, doc, events, pushes, intervals, api,
    progress: (book = 'fuhan') => progresses.get(book),
    cloud: () => cloud,
    setRemote: (p) => { cloud = structuredClone(p); },
    async fire(name) { events.get(name)?.(); await settle(); },
    async runTimers(delay) {
      for (const [key, timer] of [...timers]) if (timer.delay === delay && timers.delete(key)) await timer.fn();
      await settle();
    },
    async poll() { intervals[0](); await settle(); },
  };
}

const position = (chapter, updatedAt, percent = 0.5) => ({ book: 'fuhan', chapter, percent, updatedAt, device: 'desktop' });

test('startup restoration and page exit preserve the actual reading timestamp', async () => {
  const local = position(1, 100);
  const app = await reader({ local });
  await app.runTimers(400);
  await app.fire('pagehide');
  assert.equal(app.progress().updatedAt, 100);
  assert.equal(app.cloud().updatedAt, 100);
});

test('returning to the foreground adopts newer desktop progress without a scroll echo', async () => {
  const app = await reader({ local: position(1, 100) });
  app.setRemote(position(4, 200));
  app.doc.hidden = false;
  await app.fire('visibilitychange');
  await app.runTimers(400);
  await app.runTimers(1500);
  await app.fire('pagehide');
  assert.equal(app.progress().chapter, 4);
  assert.equal(app.progress().updatedAt, 200);
  assert.equal(app.cloud().chapter, 4);
  assert.equal(app.cloud().updatedAt, 200);
});

test('opening a stale phone page adopts desktop progress before any local save', async () => {
  const app = await reader({ local: position(1, 100), remote: position(4, 200) });
  await app.runTimers(400);
  assert.equal(app.progress().chapter, 4);
  assert.equal(app.progress().updatedAt, 200);
  assert.equal(app.cloud().updatedAt, 200);
});

test('foreground polling and network recovery both pull updated progress', async () => {
  const app = await reader({ local: position(1, 100) });
  app.setRemote(position(3, 200));
  await app.poll();
  assert.equal(app.progress().chapter, 3);
  app.setRemote(position(5, 300));
  await app.fire('online');
  assert.equal(app.progress().chapter, 5);
  assert.equal(app.progress().updatedAt, 300);
});

test('genuine phone scrolling is saved before backgrounding and reaches the desktop cloud', async () => {
  const app = await reader({ local: position(1, 100) });
  app.doc.documentElement.scrollTop = 750;
  await app.fire('scroll');
  app.doc.hidden = true;
  await app.fire('visibilitychange');
  assert.equal(app.progress().percent, 0.75);
  assert.ok(app.progress().updatedAt > 100);
  assert.equal(app.cloud().percent, 0.75);
});

test('a newer offline phone position is uploaded when sync resumes', async () => {
  const app = await reader({ local: position(5, 300), remote: position(1, 100) });
  assert.equal(app.cloud().chapter, 5);
  assert.equal(app.cloud().updatedAt, 300);
});

test('polling preserves a real phone scroll still waiting for its save debounce', async () => {
  const app = await reader({ local: position(1, 100) });
  app.doc.documentElement.scrollTop = 750;
  await app.fire('scroll');
  app.setRemote(position(3, 200));
  await app.poll();
  assert.equal(app.progress().chapter, 1);
  assert.equal(app.progress().percent, 0.75);
  assert.ok(app.cloud().updatedAt > 200);
});

test('switching books leaves the previous reading timestamp unchanged', async () => {
  const app = await reader({ local: position(1, 100) });
  await app.switchBook('other', false);
  assert.equal(app.progress('fuhan').updatedAt, 100);
  assert.equal(app.pushes.find((p) => p.book === 'fuhan').updatedAt, 100);
});

test('a delayed remote chapter request cannot overwrite subsequent local reading', async () => {
  const app = await reader({ local: position(1, 100) });
  const original = app.api.bookChapter;
  let resolve;
  app.api.bookChapter = (_book, chapter) => chapter === 4
    ? new Promise((done) => { resolve = done; }) : original(_book, chapter);
  const pending = app.applyRemote(position(4, 200), false);
  await app.goChapter(2, 0.3);
  resolve({ id: 4, paragraphs: ['延迟正文'] });
  assert.equal(await pending, false);
  assert.equal(app.progress().chapter, 2);
  assert.ok(app.progress().updatedAt > 200);
});
