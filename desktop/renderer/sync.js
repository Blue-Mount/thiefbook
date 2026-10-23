// 与同步服务通信，接口与手机网页端完全一致。
// 同步码仅用来标识同一份进度，访问权限由登录会话控制。
export const SYNC_CODE = 'eric-fuhan';

function showAuthState(needsLogin) {
  // 阅读保持可用；用悬停提示与设置页状态提示登录，不覆盖本地正文。
  const bar = document.getElementById('bar');
  if (bar) bar.title = needsLogin ? '同步服务需要登录：右键 → 登录同步服务，或在设置中登录。本地阅读不受影响。' : '';
  window.dispatchEvent(new CustomEvent('sync:auth-state', { detail: { needsLogin } }));
}
window.api.onSyncAuthState?.(({ needsLogin }) => showAuthState(needsLogin));

export async function request(url, options = {}) {
  const result = await window.api.syncRequest({ url, method: options.method || 'GET', body: options.body });
  if (result.status === 401 || result.status === 403 || (result.status >= 300 && result.status < 400)) {
    showAuthState(true);
    throw new Error('同步服务需要登录，请在设置中点击“登录同步服务”');
  }
  return new Response([204, 205].includes(result.status) ? null : result.body, { status: result.status, headers: result.headers });
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
      const r = await request(`${base()}/auth/session`, { cache: 'no-store' });
      return r.ok && (await r.json()).authenticated === true;
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
