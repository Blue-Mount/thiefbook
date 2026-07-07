// 存储层：配了 Upstash Redis 就用云端 Redis（持久、免绑卡），否则用本地 JSON 文件。
// 三个操作：get(code,book) / set(code,book,val) / list(code)
import fs from 'node:fs';
import path from 'node:path';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function fileStore() {
  const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const STORE_FILE = path.join(DATA_DIR, 'store.json');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let store = {};
  try {
    if (fs.existsSync(STORE_FILE)) store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
  } catch (e) {
    console.error('读取 store 失败，从空开始:', e.message);
  }
  let timer = null;
  const persist = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => fs.writeFile(STORE_FILE, JSON.stringify(store), (e) => e && console.error('落盘失败:', e.message)),
      300
    );
  };
  const k = (code, book) => `${code}::${book}`;
  return {
    kind: `本地文件 ${STORE_FILE}`,
    async get(code, book) { return store[k(code, book)] || null; },
    async set(code, book, val) { store[k(code, book)] = val; persist(); },
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
      await redis.set(pk(code, book), val);
      await redis.sadd(sk(code), book);
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
