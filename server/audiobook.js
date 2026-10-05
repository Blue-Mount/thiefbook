import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

export const TTS_VOICES = [
  { id: 'xuyuyuan_v3.1', name: '许玉远 · 知性女声' },
  { id: 'longyuan_v3.1', name: '龙媛 · 温暖女声' },
  { id: 'longsanshu_v3.1', name: '龙三叔 · 沉稳男声' },
  { id: 'anmingyuan_v3.1', name: '安明远 · 清亮男声' },
  { id: 'xieshurou_v3.1', name: '谢舒柔 · 柔和女声' },
  { id: 'baiqinglan_v3.1', name: '白清岚 · 明亮女声' },
];

const MODEL = 'qwen-audio-3.1-tts-flash';
const MAX_SEGMENT_CHARS = 220;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_GENERATIONS = 3;
const BREAK_AFTER = /[。！？!?；;，,、：:]/;

export function splitForSpeech(text) {
  return speechPieces(text).map((piece) => piece.text);
}

export function speechPieces(text) {
  const source = String(text || '');
  const chars = Array.from(source);
  const offsets = [0];
  for (const char of chars) offsets.push(offsets.at(-1) + char.length);
  const parts = [];
  let start = 0;
  while (start < chars.length) {
    let end = start;
    while (end < chars.length && end - start < MAX_SEGMENT_CHARS) {
      end++;
      if (/[。！？!?；;]/.test(chars[end - 1])) {
        while (end < chars.length && end - start < MAX_SEGMENT_CHARS && /[”’」』】）)]/.test(chars[end])) end++;
        break;
      }
    }
    if (end < chars.length && end - start >= MAX_SEGMENT_CHARS) {
      for (let i = end - 1; i >= start + Math.floor(MAX_SEGMENT_CHARS * 0.55); i--) {
        if (BREAK_AFTER.test(chars[i])) { end = i + 1; break; }
      }
    }
    const raw = source.slice(offsets[start], offsets[end]);
    const text = raw.trim();
    // Standalone punctuation (for example a paragraph containing only “……”)
    // cannot be synthesized and would stop playback at the next segment.
    if (/[\p{L}\p{N}]/u.test(text)) parts.push({ text, start: offsets[start], end: offsets[end] });
    start = end;
  }
  return parts;
}

export function chapterSegments(chapter) {
  if (!chapter) return [];
  return [
    ...speechPieces(chapter.title).map((piece) => ({ ...piece, paragraph: -1 })),
    ...(chapter.paragraphs || []).flatMap((paragraph, index) =>
      speechPieces(paragraph).map((piece) => ({ ...piece, paragraph: index }))),
  ];
}

async function readBounded(response) {
  if (!response.ok) throw new Error(`audio download failed: ${response.status}`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_AUDIO_BYTES) throw new Error('audio file is too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_AUDIO_BYTES) throw new Error('audio file is too large');
    chunks.push(chunk);
  }
  if (!size) throw new Error('empty audio file');
  return Buffer.concat(chunks);
}

export function makeAudiobookRouter({ booksDir, builtinBooksDir, dataDir, fetchImpl = fetch }) {
  const router = express.Router();
  const cacheDir = path.join(dataDir, 'tts-cache');
  const books = new Map();
  const pending = new Map();
  let activeGenerations = 0;

  function enabled() {
    return Boolean(process.env.DASHSCOPE_API_KEY && process.env.SFM_WORKSPACE_ID && process.env.TTS_ACCESS_CODE);
  }

  function authenticated(code) {
    const expected = process.env.TTS_ACCESS_CODE || '';
    if (!expected || typeof code !== 'string') return false;
    const a = Buffer.from(code);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function getBook(bookId) {
    if (typeof bookId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(bookId)) return null;
    const uploaded = path.join(booksDir, `${bookId}.json`);
    const builtin = path.join(builtinBooksDir, `${bookId}.json`);
    const file = fs.existsSync(uploaded) ? uploaded : builtin;
    if (!fs.existsSync(file)) return null;
    const stat = fs.statSync(file);
    const cached = books.get(file);
    if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.book;
    const book = JSON.parse(fs.readFileSync(file, 'utf8'));
    books.set(file, { book, mtimeMs: stat.mtimeMs, size: stat.size });
    return book;
  }

  function getSegments(bookId, chapterIndex) {
    const book = getBook(bookId);
    const chapter = Number(chapterIndex);
    if (!book || !Number.isInteger(chapter) || chapter < 0 || chapter >= book.chapters.length) return null;
    return { book, chapter, segments: chapterSegments(book.chapters[chapter]) };
  }

  function pruneCache() {
    if (!fs.existsSync(cacheDir)) return;
    const files = fs.readdirSync(cacheDir).filter((name) => name.endsWith('.mp3')).map((name) => {
      const file = path.join(cacheDir, name);
      const stat = fs.statSync(file);
      return { file, size: stat.size, mtimeMs: stat.mtimeMs };
    }).sort((a, b) => b.mtimeMs - a.mtimeMs);
    let size = 0;
    for (const file of files) {
      size += file.size;
      if (size > MAX_CACHE_BYTES) fs.rmSync(file.file, { force: true });
    }
  }

  async function generate(text, voice) {
    const workspace = process.env.SFM_WORKSPACE_ID;
    if (!/^[a-z0-9-]+$/i.test(workspace)) throw new Error('invalid workspace ID');
    const endpoint = `https://${workspace}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`;
    const result = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, input: { text, voice, format: 'mp3', language_hints: ['zh'] } }),
      signal: AbortSignal.timeout(90000),
    });
    const body = await result.json().catch(() => ({}));
    if (!result.ok || body.code || !body.output?.audio?.url) {
      throw new Error(`Aliyun TTS failed: ${body.code || result.status}`);
    }
    const audioUrl = new URL(body.output.audio.url);
    if (!/^dashscope-result-[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/i.test(audioUrl.hostname)) {
      throw new Error('unexpected audio host');
    }
    audioUrl.protocol = 'https:';
    const audio = await readBounded(await fetchImpl(audioUrl, { signal: AbortSignal.timeout(30000) }));
    const inputTokens = Number(body.usage?.input_tokens) || 0;
    const outputTokens = Number(body.usage?.output_tokens) || 0;
    return { audio, inputTokens, outputTokens };
  }

  async function getAudio(text, voice) {
    const hash = crypto.createHash('sha256').update(JSON.stringify([MODEL, voice, text])).digest('hex');
    const file = path.join(cacheDir, `${hash}.mp3`);
    if (fs.existsSync(file)) return { audio: fs.readFileSync(file), charged: false };
    if (pending.has(hash)) return { audio: (await pending.get(hash)).audio, charged: false };
    if (activeGenerations >= MAX_GENERATIONS) {
      const error = new Error('语音生成繁忙，请稍后重试');
      error.status = 429;
      throw error;
    }
    activeGenerations++;
    const task = (async () => {
      const result = await generate(text, voice);
      fs.mkdirSync(cacheDir, { recursive: true });
      const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temp, result.audio);
      fs.renameSync(temp, file);
      pruneCache();
      return result;
    })();
    pending.set(hash, task);
    try {
      return { ...await task, charged: true };
    } finally {
      pending.delete(hash);
      activeGenerations--;
    }
  }

  router.get('/config', (_req, res) => res.json({ enabled: enabled(), voices: TTS_VOICES }));

  router.get('/segments', (req, res) => {
    try {
      const found = getSegments(req.query.book, req.query.chapter);
      if (!found) return res.status(404).json({ error: '找不到书籍或章节' });
      res.json({ segments: found.segments });
    } catch {
      res.status(500).json({ error: '无法读取章节' });
    }
  });

  router.post('/audio', async (req, res) => {
    if (!enabled()) return res.status(503).json({ error: '听书服务尚未配置' });
    if (!authenticated(req.body?.code)) return res.status(403).json({ error: '听书密码不正确' });
    const { book, chapter, segment, voice } = req.body;
    if (!TTS_VOICES.some((item) => item.id === voice)) return res.status(400).json({ error: '音色不支持' });
    try {
      const found = getSegments(book, chapter);
      const index = Number(segment);
      if (!found || !Number.isInteger(index) || index < 0 || index >= found.segments.length) {
        return res.status(404).json({ error: '找不到朗读内容' });
      }
      const result = await getAudio(found.segments[index].text, voice);
      const cost = result.charged ? (result.inputTokens * 1.5 + result.outputTokens * 12) / 1_000_000 : 0;
      res.set({
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'private, max-age=86400',
        'X-TTS-Cost-CNY': cost.toFixed(6),
        'X-TTS-Cache': result.charged ? 'miss' : 'hit',
        'Access-Control-Expose-Headers': 'X-TTS-Cost-CNY, X-TTS-Cache',
      });
      res.send(result.audio);
    } catch (error) {
      console.error('TTS error:', error.message);
      res.status(error.status || 502).json({ error: error.status ? error.message : '语音生成失败，请稍后重试' });
    }
  });

  pruneCache();
  return router;
}
