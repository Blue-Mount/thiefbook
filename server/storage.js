// 存储层：配了 Upstash Redis 就用云端 Redis（持久、免绑卡），否则用本地 JSON 文件。
// 三个操作：get(code,book) / set(code,book,val) / list(code)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { positiveInt } from './security.js';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function quotaError() {
  const error = new Error('progress record quota exceeded');
  error.status = 429;
  error.publicMessage = '进度记录达到上限，请清理后重试';
  return error;
}

export function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(value));
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function fileStore({ dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data'), maxRecords = positiveInt(process.env.PROGRESS_MAX_RECORDS, 2000, 10000) } = {}) {
  const DATA_DIR = dataDir;
  const STORE_FILE = path.join(DATA_DIR, 'store.json');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let store = Object.create(null);
  try {
    if (fs.existsSync(STORE_FILE)) {
      if (fs.statSync(STORE_FILE).size > 8 * 1024 * 1024) throw new Error('store file too large');
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid store');
      store = Object.assign(Object.create(null), parsed);
    }
  } catch (e) {
    throw new Error('进度存储读取失败；为保护现有记录，服务拒绝启动', { cause: e });
  }
  const k = (code, book) => `${code}::${book}`;
  return {
    kind: `本地文件 ${STORE_FILE}`,
    async get(code, book) { return store[k(code, book)] || null; },
    async set(code, book, val) {
      const key = k(code, book);
      if (!Object.hasOwn(store, key) && Object.keys(store).length >= maxRecords) throw quotaError();
      const updated = Object.assign(Object.create(null), store, { [key]: val });
      atomicJson(STORE_FILE, updated);
      store = updated;
    },
    async list(code) {
      const p = `${code}::`;
      return Object.entries(store).filter(([kk]) => kk.startsWith(p)).map(([, v]) => v);
    },
  };
}

async function redisStore() {
  const { Redis } = await import('@upstash/redis');
  const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  const pk = (code, book) => `progress:${code}:${book}`;
  const sk = (code) => `books:${code}`;
  return {
    kind: 'Upstash Redis',
    async get(code, book) { return (await redis.get(pk(code, book))) || null; },
    async set(code, book, val) {
      const maxRecords = positiveInt(process.env.PROGRESS_MAX_RECORDS, 2000, 10000);
      const accepted = await redis.eval(`
        if redis.call('EXISTS', KEYS[1]) == 0 and redis.call('SCARD', KEYS[2]) >= tonumber(ARGV[3]) then return 0 end
        redis.call('SET', KEYS[1], ARGV[1])
        redis.call('SADD', KEYS[2], ARGV[2])
        return 1
      `, [pk(code, book), sk(code)], [JSON.stringify(val), book, maxRecords]);
      if (!accepted) throw quotaError();
    },
    async list(code) {
      const books = await redis.smembers(sk(code));
      if (!books.length) return [];
      const vals = await Promise.all(books.map((b) => redis.get(pk(code, b))));
      return vals.filter(Boolean);
    },
  };
}

export async function makeStore() {
  if (REDIS_URL && REDIS_TOKEN) {
    try {
      const s = await redisStore();
      console.log('🗄  存储:', s.kind);
      return s;
    } catch (e) {
      console.error('Redis 初始化失败，回退本地文件:', e.message);
    }
  }
  const s = fileStore();
  console.log('🗄  存储:', s.kind);
  return s;
}
