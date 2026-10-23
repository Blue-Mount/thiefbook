import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { chapterSegments, TTS_VOICES } from '../server/audiobook.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.loadEnvFile(path.join(root, 'server/.env'));
const local = 'http://127.0.0.1:8787';
const remote = 'https://vjqm1hqc-8787.jpe1.devtunnels.ms';
async function measure(label, url, options) {
  const start = performance.now();
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(90000) });
  const headersAt = performance.now();
  const bytes = Buffer.from(await response.arrayBuffer());
  const result = { label, status: response.status, firstByteMs: Math.round(headersAt - start),
    totalMs: Math.round(performance.now() - start), bytes: bytes.length,
    cache: response.headers.get('X-TTS-Cache') };
  console.log(JSON.stringify(result));
  return bytes;
}
await Promise.all([local, remote].map(async (origin) => {
  for (let i = 0; i < 3; i++) await measure(origin === local ? 'local health' : 'public health', `${origin}/api/health`);
}));
const current = await (await fetch(`${local}/api/current-book?code=eric-fuhan`)).json();
const progress = await (await fetch(`${local}/api/progress?code=eric-fuhan&book=${current.book}`)).json();
console.log(JSON.stringify({ label: 'listening position', book: current.book, chapter: progress.chapter, segment: progress.segment, mode: progress.mode }));
const book = JSON.parse(fs.readFileSync(path.join(root, 'server/data/books', `${current.book}.json`), 'utf8'));
const cacheDir = path.join(root, 'server/data/tts-cache');
const recent = new Set(fs.readdirSync(cacheDir).filter(f => f.endsWith('.mp3')).map(f => ({ f, time: fs.statSync(path.join(cacheDir, f)).mtimeMs }))
  .sort((a, b) => b.time - a.time).slice(0, 30).map(x => x.f));
const hash = (text, voice) => crypto.createHash('sha256').update(JSON.stringify(['qwen-audio-3.1-tts-flash', voice, text])).digest('hex') + '.mp3';
let match;
const matches = [];
for (let chapter = Math.max(0, progress.chapter - 1); chapter <= Math.min(book.chapters.length - 1, progress.chapter + 1); chapter++) {
  const segments = chapterSegments(book.chapters[chapter]);
  for (let index = 0; index < segments.length; index++) {
    for (const voice of TTS_VOICES) {
      const file = hash(segments[index].text, voice.id);
      if (recent.has(file)) {
        match = { chapter, index, voice: voice.id, file, segments };
        matches.push(match);
      }
    }
  }
}
if (!match) throw new Error('No recent audio matched listening chapter');
console.log(JSON.stringify({ label: 'matched cached audio', chapter: match.chapter, segment: match.index, voice: match.voice }));
const payload = { book: current.book, chapter: match.chapter, segment: match.index, voice: match.voice, code: process.env.TTS_ACCESS_CODE };
const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
await measure('local cached audio', `${local}/api/tts/audio`, options);
await measure('public cached audio', `${remote}/api/tts/audio`, options);
for (const sample of matches.sort((a, b) => fs.statSync(path.join(cacheDir, a.file)).size - fs.statSync(path.join(cacheDir, b.file)).size).slice(0, 3)) {
  await measure(`public short cached audio ${sample.chapter}:${sample.index}`, `${remote}/api/tts/audio`, {
    ...options, body: JSON.stringify({ ...payload, chapter: sample.chapter, segment: sample.index, voice: sample.voice }),
  });
}
if (process.argv.includes('--generate')) {
  const text = match.segments.filter(s => !fs.existsSync(path.join(cacheDir, hash(s.text, match.voice))))
    .sort((a, b) => b.text.length - a.text.length)[0]?.text;
  if (!text) throw new Error('No uncached sentence available');
  const endpoint = `https://${process.env.SFM_WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`;
  const data = await measure('Aliyun synthesis', endpoint, { method: 'POST',
    headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen-audio-3.1-tts-flash', input: { text, voice: match.voice, format: 'mp3', language_hints: ['zh'] } }) });
  const body = JSON.parse(data);
  if (!body.output?.audio?.url) throw new Error(`Synthesis failed: ${body.code || 'missing audio'}`);
  const url = new URL(body.output.audio.url);
  if (!/^dashscope-result-[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/i.test(url.hostname)) throw new Error('Unexpected audio host');
  url.protocol = 'https:';
  await measure('Aliyun audio download', url);
  console.log(JSON.stringify({ label: 'synthesis sample', characters: text.length, tokens: body.usage }));
}
