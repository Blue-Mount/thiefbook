// 与阿里云同步服务通信，接口与手机网页端完全一致。
// 单用户场景：不再让用户输「同步码」，改用一个内置固定身份，
// 手机端与电脑端只要都用这个常量就自动同一份进度（两端必须一致，见 app/src/lib/api.js）。
export const SYNC_CODE = 'eric-fuhan';

export function makeSync(getSync) {
  const base = () => (getSync().serverUrl || 'http://123.57.90.23:8787').replace(/\/$/, '');
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

  return { pull, push, health };
}
