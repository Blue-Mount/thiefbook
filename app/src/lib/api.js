// 与同步服务通信。
// - serverUrl 为空时默认用「同源地址」（前端由同步服务托管的部署场景，最省心）。
// - 单用户场景：不再让用户输「同步码」，改用内置固定身份，和桌面端保持一致
//   （见 desktop/renderer/sync.js 的 SYNC_CODE，两端必须一致才能同一份进度）。
export const SYNC_CODE = 'eric-fuhan';

export function makeApi(getSync) {
  const base = () => (getSync().serverUrl || window.location.origin || '').replace(/\/$/, '');
  const theCode = () => SYNC_CODE;

  async function pull(bookId) {
    const code = theCode();
    const u = `${base()}/api/progress?code=${encodeURIComponent(code)}&book=${encodeURIComponent(bookId)}`;
    const r = await fetch(u, { cache: 'no-store' });
    if (!r.ok) throw new Error('pull failed ' + r.status);
    return r.json();
  }

  async function push(bookId, progress, device) {
    const code = theCode();
    const r = await fetch(`${base()}/api/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, book: bookId, device, ...progress }),
    });
    if (!r.ok) throw new Error('push failed ' + r.status);
    return r.json();
  }

  async function health() {
    try {
      const r = await fetch(`${base()}/api/health`, { cache: 'no-store' });
      return r.ok;
    } catch {
      return false;
    }
  }

  async function listBooks() {
    const r = await fetch(`${base()}/api/books?code=${encodeURIComponent(theCode())}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('list books failed ' + r.status);
    return r.json();
  }

  async function uploadBook(file, id, title) {
    const u = `${base()}/api/books?code=${encodeURIComponent(theCode())}&id=${encodeURIComponent(id)}&title=${encodeURIComponent(title)}&filename=${encodeURIComponent(file.name)}`;
    const r = await fetch(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || 'upload failed ' + r.status);
    return body;
  }

  return { pull, push, health, listBooks, uploadBook };
}
