// 与同步服务通信。
// - serverUrl 为空时默认用「同源地址」（前端由同步服务托管的部署场景，最省心）。
// - 是否启用同步只看有没有填「同步码」。
export function makeApi(getSync) {
  const base = () => (getSync().serverUrl || window.location.origin || '').replace(/\/$/, '');
  const theCode = () => (getSync().code || '').trim().toLowerCase();

  async function pull(bookId) {
    const code = theCode();
    if (!code) return null;
    const u = `${base()}/api/progress?code=${encodeURIComponent(code)}&book=${encodeURIComponent(bookId)}`;
    const r = await fetch(u, { cache: 'no-store' });
    if (!r.ok) throw new Error('pull failed ' + r.status);
    return r.json();
  }

  async function push(bookId, progress, device) {
    const code = theCode();
    if (!code) return { skipped: true };
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

  return { pull, push, health };
}
