import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import express from 'express';
import { chapterSegments, makeAudiobookRouter } from './audiobook.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thiefbook-tts-'));
const builtins = path.join(root, 'builtins');
const uploaded = path.join(root, 'uploaded');
const data = path.join(root, 'data');
fs.mkdirSync(builtins, { recursive: true });
fs.mkdirSync(uploaded, { recursive: true });
fs.writeFileSync(path.join(builtins, 'sample.json'), JSON.stringify({
  id: 'sample', title: '测试书', chapters: [{ title: '第一章', paragraphs: ['第一段。第二句。', '第二段。'] }],
}));

const previous = {
  DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
  SFM_WORKSPACE_ID: process.env.SFM_WORKSPACE_ID,
  TTS_ACCESS_CODE: process.env.TTS_ACCESS_CODE,
};
let server;
let base;
let modelCalls = 0;

before(async () => {
  process.env.DASHSCOPE_API_KEY = 'test-key';
  process.env.SFM_WORKSPACE_ID = 'test-workspace';
  process.env.TTS_ACCESS_CODE = 'private-test-code';
  const app = express();
  app.use(express.json());
  app.use('/api/tts', makeAudiobookRouter({
    booksDir: uploaded, builtinBooksDir: builtins, dataDir: data,
    fetchImpl: async (url) => {
      if (new URL(url).hostname.startsWith('dashscope-result-')) {
        return new Response(Buffer.from('fake-mp3'), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
      }
      modelCalls++;
      return new Response(JSON.stringify({
        output: { audio: { url: 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.mp3' } },
        usage: { input_tokens: 100, output_tokens: 200 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/tts`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('chapter text is split into bounded, ordered speech segments', () => {
  const text = '这是一句话。'.repeat(100);
  const segments = chapterSegments({ title: '标题', paragraphs: [text] });
  assert.equal(segments[0].paragraph, -1);
  assert.equal(segments.slice(1).map((part) => part.text).join(''), text);
  assert.ok(segments.every((part) => Array.from(part.text).length <= 220));
});

test('sentence offsets identify the exact sentence within a paragraph', () => {
  const paragraph = '  第一 句。第二句！“第三句？”';
  const segments = chapterSegments({ title: '标题', paragraphs: [paragraph] }).filter((part) => part.paragraph === 0);
  assert.equal(segments.length, 3);
  assert.equal(segments.map((part) => paragraph.slice(part.start, part.end)).join(''), paragraph);
  assert.equal(segments[1].text, '第二句！');
  assert.equal(segments[1].start, paragraph.indexOf('第二句'));
});

test('punctuation-only segments are skipped without shifting text offsets', () => {
  const chapter = { title: '第一章', paragraphs: ['前一句。……', '……', '铛！', '后一句。'] };
  const segments = chapterSegments(chapter);
  assert.deepEqual(segments.map((part) => part.text), ['第一章', '前一句。', '铛！', '后一句。']);
  assert.deepEqual(segments.map((part) => part.paragraph), [-1, 0, 2, 3]);
  assert.equal(segments[1].start, 0);
  assert.equal(segments[1].end, 4);
});

test('audio endpoint accepts only book segments and caches generated audio', async () => {
  const segments = await (await fetch(`${base}/segments?book=sample&chapter=0`)).json();
  assert.equal(segments.segments.length, 4);
  const payload = { book: 'sample', chapter: 0, segment: 1, voice: 'xuyuyuan_v3.1' };
  const post = (body) => fetch(`${base}/audio`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post({ ...payload, code: 'wrong' })).status, 403);
  assert.equal((await post({ ...payload, segment: 999, code: 'private-test-code' })).status, 404);
  const first = await post({ ...payload, code: 'private-test-code' });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('X-TTS-Cache'), 'miss');
  assert.equal(first.headers.get('X-TTS-Cost-CNY'), '0.002550');
  assert.equal(await first.text(), 'fake-mp3');
  const second = await post({ ...payload, code: 'private-test-code' });
  assert.equal(second.headers.get('X-TTS-Cache'), 'hit');
  assert.equal(await second.text(), 'fake-mp3');
  assert.equal(modelCalls, 1);
});

test('daily request, character and budget guards persist across restart and permit cached audio', async () => {
  const names = ['TTS_DAILY_MAX_REQUESTS', 'TTS_DAILY_MAX_CHARS', 'TTS_DAILY_BUDGET_CNY', 'TTS_REQUEST_RESERVE_CNY'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const [name, limit] of [['TTS_DAILY_MAX_REQUESTS', '1'], ['TTS_DAILY_MAX_CHARS', '5'], ['TTS_DAILY_BUDGET_CNY', '0.1001']]) {
      for (const key of names) delete process.env[key];
      process.env[name] = limit;
      const quotaDir = path.join(root, name);
      let calls = 0;
      const options = {
        booksDir: uploaded, builtinBooksDir: builtins, dataDir: quotaDir,
        fetchImpl: async (url) => {
          if (new URL(url).hostname.startsWith('dashscope-result-')) return new Response(Buffer.from('fake-mp3'));
          calls++;
          return new Response(JSON.stringify({ output: { audio: { url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.mp3' } }, usage: { input_tokens: 100, output_tokens: 200 } }), { headers: { 'Content-Type': 'application/json' } });
        },
      };
      for (let run = 0; run < 2; run++) {
        const app = express();
        app.use(express.json());
        app.use(makeAudiobookRouter(options));
        const quotaServer = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => quotaServer.once('listening', resolve));
        try {
          const request = (segment) => fetch(`http://127.0.0.1:${quotaServer.address().port}/audio`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ book: 'sample', chapter: 0, segment, voice: 'xuyuyuan_v3.1', code: 'private-test-code' }),
          });
          const first = await request(1);
          assert.equal(first.status, 200, `${name} cached segment remains available`);
          assert.equal(first.headers.get('X-TTS-Cache'), run ? 'hit' : 'miss');
          await first.arrayBuffer();
          const denied = await request(2);
          assert.equal(denied.status, 429, name);
          await denied.json();
        } finally { await new Promise((resolve) => quotaServer.close(resolve)); }
      }
      assert.equal(calls, 1, `${name} must deny calls before reaching provider`);
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
