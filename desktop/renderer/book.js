// 书籍加载：优先用本地缓存（秒开 + 离线可读），后台再从同步服务刷新。
// 书源与手机端同一个：${serverUrl}/books/fuhan.json
export const BOOK_ID = 'fuhan';

export async function loadBook(serverUrl) {
  // 1) 先给缓存
  let cached = null;
  const raw = await window.api.getBookCache();
  if (raw) {
    try {
      cached = JSON.parse(raw);
    } catch {
      cached = null;
    }
  }
  // 2) 无缓存则必须联网拉取
  if (!cached) {
    const fresh = await fetchBook(serverUrl);
    await window.api.setBookCache(JSON.stringify(fresh));
    return fresh;
  }
  // 3) 有缓存：直接返回，同时后台静默刷新（不阻塞）
  fetchBook(serverUrl)
    .then((fresh) => window.api.setBookCache(JSON.stringify(fresh)))
    .catch(() => {});
  return cached;
}

async function fetchBook(serverUrl) {
  const base = (serverUrl || 'http://123.57.90.23:8787').replace(/\/$/, '');
  const r = await fetch(`${base}/books/${BOOK_ID}.json`, { cache: 'no-store' });
  if (!r.ok) throw new Error('书籍下载失败 ' + r.status);
  return r.json();
}
