// 与同步服务通信，接口与手机网页端完全一致。
// 单用户场景：不再让用户输「同步码」，改用一个内置固定身份，
// 手机端与电脑端只要都用这个常量就自动同一份进度（两端必须一致，见 app/src/lib/api.js）。
export const SYNC_CODE = 'eric-fuhan';

const REQUEST_TIMEOUT_MS = 8000;

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function makeSync(getSync) {
  const base = () => (getSync().serverUrl || 'https://vjqm1hqc-8787.jpe1.devtunnels.ms').replace(/\/$/, '');
  const theCode = () => SYNC_CODE;

  async function pull(bookId) {
    const code = theCode();
    const u = `${base()}/api/progress?code=${encodeURIComponent(code)}&book=${encodeURIComponent(bookId)}`;
    const r = await request(u, { cache: 'no-store' });
    if (!r.ok) throw new Error('pull failed ' + r.status);
    return r.json();
  }

  async function push(bookId, progress, device) {
    const code = theCode();
    const r = await request(`${base()}/api/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, book: bookId, device, ...progress }),
    });
    if (!r.ok) throw new Error('push failed ' + r.status);
    return r.json();
  }

  async function health() {
    try {
      const r = await request(`${base()}/api/health`, { cache: 'no-store' });
      return r.ok;
    } catch {
      return false;
    }
  }

  async function listBooks() {
    const r = await request(`${base()}/api/books?code=${encodeURIComponent(theCode())}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('list books failed ' + r.status);
    return r.json();
  }

  async function pullCurrentBook() {
    const r = await request(`${base()}/api/current-book?code=${encodeURIComponent(theCode())}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('pull current book failed ' + r.status);
    return r.json();
  }

  async function pushCurrentBook(book, updatedAt, device) {
    const r = await request(`${base()}/api/current-book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: theCode(), book, updatedAt, device }),
    });
    if (!r.ok) throw new Error('push current book failed ' + r.status);
    return r.json();
  }

  return { pull, push, health, listBooks, pullCurrentBook, pushCurrentBook };
}
