import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import express from 'express';
import { makeBookContentRouter } from './book-content.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thiefbook-content-'));
const booksDir = path.join(root, 'books');
const builtinBooksDir = path.join(root, 'builtins');
fs.mkdirSync(booksDir);
fs.mkdirSync(builtinBooksDir);
fs.writeFileSync(path.join(booksDir, 'sample.json'), JSON.stringify({
  id: 'sample', title: '大书', author: '作者',
  toc: [{ id: 0, title: '第一章' }, { id: 1, title: '第二章' }],
  chapters: [
    { id: 0, title: '第一章', paragraphs: ['正文一。'] },
    { id: 1, title: '第二章', paragraphs: ['正文二。'] },
  ],
}));

let server;
let base;
before(async () => {
  const app = express();
  app.use(makeBookContentRouter({ booksDir, builtinBooksDir }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

test('manifest excludes body and chapters return only requested content', async () => {
  const manifest = await (await fetch(`${base}/sample/manifest`)).json();
  assert.equal(manifest.chapters.length, 2);
  assert.equal(manifest.chapters[1].title, '第二章');
  assert.equal(JSON.stringify(manifest).includes('正文'), false);
  const chapter = await (await fetch(`${base}/sample/chapters/1`)).json();
  assert.deepEqual(chapter.paragraphs, ['正文二。']);
  assert.equal((await fetch(`${base}/sample/chapters/2`)).status, 404);
  assert.equal((await fetch(`${base}/missing/manifest`)).status, 404);
});
