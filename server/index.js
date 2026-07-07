// 摸鱼看书 · 阅读进度云同步服务（MVP）
// 用「同步码」区分用户，进度采用 last-write-wins（按 updatedAt 时间戳取新）。
// 存储层见 storage.js：配了 Upstash Redis 用云端，否则用本地文件。
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { makeStore } from './storage.js';

const PORT = process.env.PORT || 8787;
const store = await makeStore();

const isValidCode = (c) => typeof c === 'string' && /^[\w一-龥-]{4,64}$/.test(c);

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, time: Date.now() }));

// 拉取某本书的进度
app.get('/api/progress', async (req, res) => {
  const { code, book } = req.query;
  if (!isValidCode(code) || !book) return res.status(400).json({ error: 'bad params' });
  res.json(await store.get(code, book));
});

// 上报进度（last-write-wins）
app.post('/api/progress', async (req, res) => {
  const { code, book, chapter, percent, updatedAt, device } = req.body || {};
  if (!isValidCode(code) || !book || typeof chapter !== 'number')
    return res.status(400).json({ error: 'bad params' });
  const incoming = {
    book,
    chapter,
    percent: Number(percent) || 0,
    updatedAt: Number(updatedAt) || Date.now(),
    device: String(device || 'unknown').slice(0, 40),
  };
  const existing = await store.get(code, book);
  if (existing && existing.updatedAt > incoming.updatedAt) {
    // 服务器上有更新的记录，回传给客户端让其跟进
    return res.json({ accepted: false, current: existing });
  }
  await store.set(code, book, incoming);
  res.json({ accepted: true, current: incoming });
});

// 列出某同步码下所有书的进度（书架用）
app.get('/api/library', async (req, res) => {
  const { code } = req.query;
  if (!isValidCode(code)) return res.status(400).json({ error: 'bad code' });
  res.json(await store.list(code));
});

// ---- 托管前端静态文件（若已构建）----
const STATIC_DIR = process.env.STATIC_DIR || path.resolve(process.cwd(), '..', 'app', 'dist');
if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(STATIC_DIR, 'index.html')));
  console.log(`🌐 已托管前端: ${STATIC_DIR}`);
}

app.listen(PORT, () => {
  console.log(`📚 同步服务已启动: http://localhost:${PORT}`);
});
