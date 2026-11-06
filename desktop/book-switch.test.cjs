const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function readerHarness(loadBook) {
  const callbacks = {};
  const config = {
    currentBookId: 'xuanhundaozhang', currentBookUpdatedAt: 100,
    sync: {}, settings: {}, progresses: {}, width: 380, height: 42,
  };
  const bar = { style: {}, textContent: '', addEventListener() {} };
  const measure = { style: {}, textContent: '', scrollHeight: 1 };
  const api = {
    getConfig: async () => structuredClone(config),
    setConfig: async (patch) => { Object.assign(config, patch); return structuredClone(config); },
    onConfigChanged: (fn) => { callbacks.config = fn; },
    onGoto() {}, onShown() {}, onHiding() {}, onSyncLoginClosed() {},
    onSwitchBook: (fn) => { callbacks.switch = fn; },
    reportBookSwitch: (result) => { callbacks.result = result; },
  };
  const sync = {
    pull: async () => null, push: async () => ({}),
    pullCurrentBook: async () => null, pushCurrentBook: async () => ({}),
  };
  let source = fs.readFileSync(path.join(__dirname, 'renderer/renderer.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/init\(\);\s*$/, 'globalThis.ready = init();');
  source += '\nglobalThis.state = () => ({ id: book?.id, active: activeBookId(), text: bar.textContent });';
  const context = vm.createContext({
    window: { api, addEventListener() {} },
    document: { getElementById: (id) => id === 'bar' ? bar : measure },
    loadBook, makeSync: () => sync,
    setTimeout: () => 1, clearTimeout() {}, setInterval() {},
    console,
  });
  vm.runInContext(source, context);
  return { context, callbacks, config };
}
const book = (id) => ({ id, title: id, chapters: [{ title: '正文', paragraphs: ['测试正文'] }] });

test('startup download failure keeps switch listener alive; retry same configured book works', async () => {
  let fail = true;
  const h = readerHarness(async (idOrServer, id) => {
    if (fail) throw new Error('需要登录');
    return book(id);
  });
  await h.context.ready;
  assert.equal(typeof h.callbacks.switch, 'function');
  assert.match(h.context.state().text, /加载失败/);
  fail = false;
  await h.callbacks.switch({ id: 'xuanhundaozhang', broadcast: false });
  assert.equal(h.callbacks.result.ok, true);
  assert.equal(h.context.state().id, 'xuanhundaozhang');
  assert.match(h.context.state().text, /测试正文/);
});

test('failed switch preserves loaded book, current-book config and reading text', async () => {
  const h = readerHarness(async (_server, id) => {
    if (id === 'missing') throw new Error('下载失败 404');
    return book(id);
  });
  await h.context.ready;
  const before = h.context.state().text;
  await h.callbacks.switch({ id: 'missing', broadcast: false });
  assert.equal(h.callbacks.result.ok, false);
  assert.match(h.callbacks.result.error, /404/);
  assert.equal(h.config.currentBookId, 'xuanhundaozhang');
  assert.equal(h.context.state().text, before);
});

test('late download from startup cannot replace a newer manual switch', async () => {
  let release;
  const h = readerHarness(async (_server, id) => id === 'xuanhundaozhang'
    ? new Promise((resolve) => { release = () => resolve(book(id)); })
    : book(id));
  // init has awaited config and registered handlers before beginning its download.
  await new Promise((resolve) => setImmediate(resolve));
  await h.callbacks.switch({ id: 'fuhan', broadcast: false });
  release();
  await h.context.ready;
  assert.equal(h.context.state().id, 'fuhan');
  assert.equal(h.config.currentBookId, 'fuhan');
});
