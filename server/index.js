// 摸鱼看书 · 阅读进度云同步服务
// 进度按「同步码 + 小说 ID」隔离，采用 last-write-wins。
import express from 'express';
import compression from 'compression';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeStore } from './storage.js';
import { makeAudiobookRouter } from './audiobook.js';
import { makeBookContentRouter } from './book-content.js';
import { createSecurity, positiveInt, uploadGuard } from './security.js';

const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
if (process.env.THIEFBOOK_ENV_FILE !== 'none' && fs.existsSync(envFile)) process.loadEnvFile(envFile);

const PORT = process.env.PORT || 8787;
const STATIC_DIR = process.env.STATIC_DIR || path.resolve(process.cwd(), '..', 'app', 'dist');
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const BOOKS_DIR = process.env.BOOKS_DIR || path.join(DATA_DIR, 'books');
const BUILTIN_BOOKS_DIR = path.join(STATIC_DIR, 'books');
const SYNC_CODE = process.env.SYNC_CODE || 'eric-fuhan';
const security = createSecurity({ dataDir: DATA_DIR });
const store = await makeStore();

fs.mkdirSync(BOOKS_DIR, { recursive: true });

const isValidCode = (c) => typeof c === 'string' && c === SYNC_CODE;
const isValidBookId = (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id);
const validTimestamp = (value) => value === undefined || (Number.isSafeInteger(value) && value >= 0 && value <= Date.now() + 300000);
const validDevice = (value) => value === undefined || (typeof value === 'string' && value.length <= 40 && !/[\u0000-\u001f\u007f]/.test(value));
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);
app.use(security.audit);
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use(security.rateLimit);
app.use('/auth', security.router);
// Let an existing PWA update its shell before application login. The private
// tunnel still requires the owner's identity; all book/data APIs stay guarded.
app.get(/^\/(?:sw\.js|registerSW\.js|workbox-[a-zA-Z0-9_-]+\.js|index\.html|manifest\.webmanifest|icon\.svg|assets\/[a-zA-Z0-9_.-]+\.(?:js|css))$/, (req, res, next) => {
  const relative = req.path.slice(1);
  const file = path.join(STATIC_DIR, relative);
  if (!fs.existsSync(file)) return next();
  res.sendFile(file);
});
app.use(security.requireAuth);
app.use((req, res, next) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? next() : security.sameOrigin(req, res, next));
app.use(compression());
app.use(express.json({ limit: '16kb' }));

app.use('/api/tts', makeAudiobookRouter({ booksDir: BOOKS_DIR, builtinBooksDir: BUILTIN_BOOKS_DIR, dataDir: DATA_DIR }));
app.use('/api/book-content', makeBookContentRouter({ booksDir: BOOKS_DIR, builtinBooksDir: BUILTIN_BOOKS_DIR }));

// 拉取某本书的进度
app.get('/api/progress', asyncRoute(async (req, res) => {
  const { code, book } = req.query;
  if (!isValidCode(code) || !isValidBookId(book)) return res.status(400).json({ error: 'bad params' });
  res.json(await store.get(code, book));
}));

// 上报进度（last-write-wins）
app.post('/api/progress', asyncRoute(async (req, res) => {
  const { code, book, chapter, percent, updatedAt, device, mode, segment } = req.body || {};
  if (!isValidCode(code) || !isValidBookId(book) || !Number.isInteger(chapter) || chapter < 0 || chapter > 1000000 ||
      (percent !== undefined && (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 1)) ||
      !validTimestamp(updatedAt) || !validDevice(device) ||
      (mode !== undefined && mode !== 'audio' && mode !== 'text') ||
      (segment !== undefined && (!Number.isInteger(segment) || segment < 0 || segment > 1000000)))
    return res.status(400).json({ error: 'bad params' });
  const incoming = {
    book,
    chapter,
    percent: Number(percent) || 0,
    updatedAt: updatedAt ?? Date.now(),
    device: String(device || 'unknown').slice(0, 40),
  };
  if (mode === 'audio' && Number.isInteger(segment) && segment >= 0) {
    incoming.mode = 'audio';
    incoming.segment = segment;
  }
  const existing = await store.get(code, book);
  if (existing && existing.updatedAt > incoming.updatedAt) {
    return res.json({ accepted: false, current: existing });
  }
  await store.set(code, book, incoming);
  res.json({ accepted: true, current: incoming });
}));

// 列出某同步码下所有书的进度（保留给书架/诊断使用）
app.get('/api/library', asyncRoute(async (req, res) => {
  const { code } = req.query;
  if (!isValidCode(code)) return res.status(400).json({ error: 'bad code' });
  res.json(await store.list(code));
}));

// ---------- 小说上传与书库 ----------
const CHAPTER_RE = /^\s*第[零〇一二三四五六七八九十百千万两0-9]+章(?:\s|[　]|$|[^\S\r\n]|.)?/;
const VOLUME_RE = /^\s*第[零〇一二三四五六七八九十百千万两0-9]+卷/;
const SPECIAL_RE = /^\s*(楔子|序章|序|引子|尾声|后记|番外|终章)\s*$/;

function decodeAuto(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    return new TextDecoder('utf-8').decode(buf.subarray(3));
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(buf);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff)
    return new TextDecoder('utf-16be').decode(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('gbk').decode(buf);
  }
}

function parseBook(buf, id, requestedTitle) {
  const rawLines = decodeAuto(buf).split(/\r?\n/);
  const meta = { title: requestedTitle || '', author: '' };
  const chapters = [];
  let current = null;
  let currentVolume = '';

  for (let i = 0; i < Math.min(rawLines.length, 10); i++) {
    const line = rawLines[i].trim();
    if (!meta.title && line && !/[:：]/.test(line)) meta.title = line;
    const match = line.match(/作者[:：]\s*(.+)/);
    if (match) meta.author = match[1].trim();
  }

  const pushChapter = (title) => {
    current = { id: chapters.length, title: title.trim(), volume: currentVolume, paragraphs: [] };
    chapters.push(current);
  };

  for (const raw of rawLines) {
    const line = raw.replace(/[　\s]+$/g, '').replace(/^[　\s]+/g, '').trim();
    if (VOLUME_RE.test(raw)) {
      currentVolume = line;
      continue;
    }
    if (CHAPTER_RE.test(raw) || SPECIAL_RE.test(raw)) {
      pushChapter(line);
      continue;
    }
    if (!current) pushChapter('卷首·内容简介');
    if (line) current.paragraphs.push(line);
  }

  const cleaned = chapters.filter((chapter) => chapter.paragraphs.length > 0);
  cleaned.forEach((chapter, index) => { chapter.id = index; });
  if (!cleaned.length) throw new Error('未识别到可用正文');

  return {
    id,
    title: meta.title || id,
    author: meta.author || '',
    chapterCount: cleaned.length,
    toc: cleaned.map((chapter) => ({ id: chapter.id, title: chapter.title, volume: chapter.volume })),
    chapters: cleaned,
  };
}

function metadataFromFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isValidBookId(parsed.id) || !Array.isArray(parsed.chapters)) return null;
    return {
      id: parsed.id,
      title: parsed.title || parsed.id,
      author: parsed.author || '',
      chapterCount: Number(parsed.chapterCount) || parsed.chapters.length,
    };
  } catch {
    return null;
  }
}

const metadataCache = new Map();

function listBookMetadata() {
  const byId = new Map();
  for (const dir of [BUILTIN_BOOKS_DIR, BOOKS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') || name === 'index.json') continue;
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      const cached = metadataCache.get(file);
      const meta = cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size
        ? cached.meta
        : metadataFromFile(file);
      metadataCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
      if (meta) byId.set(meta.id, meta);
    }
  }
  return [...byId.values()];
}

app.get('/api/current-book', asyncRoute(async (req, res) => {
  const { code } = req.query;
  if (!isValidCode(code)) return res.status(400).json({ error: 'bad code' });
  res.json(await store.get(code, '__current_book__'));
}));

app.post('/api/current-book', asyncRoute(async (req, res) => {
  const { code, book, updatedAt, device } = req.body || {};
  if (!isValidCode(code) || !isValidBookId(book) || !validTimestamp(updatedAt) || !validDevice(device)) return res.status(400).json({ error: 'bad params' });
  const incoming = {
    book,
    updatedAt: updatedAt ?? Date.now(),
    device: String(device || 'unknown').slice(0, 40),
  };
  const existing = await store.get(code, '__current_book__');
  if (existing && existing.updatedAt > incoming.updatedAt) {
    return res.json({ accepted: false, current: existing });
  }
  await store.set(code, '__current_book__', incoming);
  res.json({ accepted: true, current: incoming });
}));

app.get('/api/books', (_req, res) => {
  res.json(listBookMetadata());
});

app.post('/api/books', uploadGuard(), express.raw({ type: 'application/octet-stream', limit: positiveInt(process.env.BOOK_UPLOAD_MAX_BYTES, 16 * 1024 * 1024, 64 * 1024 * 1024) }), (req, res) => {
  const { id, title } = req.query;
  if (!isValidBookId(id) || typeof title !== 'string' || !title.trim())
    return res.status(400).json({ error: 'bad params' });
  if (!Buffer.isBuffer(req.body) || !req.body.length)
    return res.status(400).json({ error: 'empty file' });

  const outFile = path.join(BOOKS_DIR, `${id}.json`);
  if (fs.existsSync(outFile) || fs.existsSync(path.join(BUILTIN_BOOKS_DIR, `${id}.json`)))
    return res.status(409).json({ error: '小说 ID 已存在' });

  try {
    const book = parseBook(req.body, id, title.trim().slice(0, 120));
    const tempFile = `${outFile}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(book));
    fs.renameSync(tempFile, outFile);
    res.status(201).json({
      ok: true,
      book: { id: book.id, title: book.title, author: book.author, chapterCount: book.chapterCount },
    });
  } catch (error) {
    res.status(400).json({ error: '解析小说失败：' + error.message });
  }
});

// 持久化上传的小说优先于构建时内置书籍。
app.get('/books/:name', (req, res, next) => {
  const name = req.params.name;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}\.json$/i.test(name)) return next();
  const file = path.join(BOOKS_DIR, name);
  if (!fs.existsSync(file)) return next();
  res.sendFile(file);
});

// ---------- 托管前端静态文件 ----------
if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(STATIC_DIR, 'index.html')));
  console.log(`🌐 已托管前端: ${STATIC_DIR}`);
}

app.use((error, _req, res, _next) => {
  const status = error.type === 'entity.too.large' ? 413 : error.status || (error.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error('请求处理失败:', error.code || error.name || 'Error');
  res.status(status).json({ error: status >= 500 ? '服务暂时不可用' : status === 413 ? '请求正文过大' : error.publicMessage || '请求无效' });
});

const server = app.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`📚 同步服务已启动: http://localhost:${server.address().port}`);
  console.log(`📖 上传小说目录: ${BOOKS_DIR}`);
});
server.requestTimeout = 120000;
server.headersTimeout = 15000;
