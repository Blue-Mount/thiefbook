// 书籍加载：优先用本地缓存（秒开 + 离线可读），后台再从同步服务刷新。
// 书源与手机端同一个：${serverUrl}/books/fuhan.json
export async function loadBook(serverUrl, bookId = 'fuhan') {
  // 1) 先给缓存
  let cached = null;
  const raw = await window.api.getBookCache(bookId);
  if (raw) {
    try {
      cached = JSON.parse(raw);
    } catch {
      cached = null;
    }
  }
  // 2) 无缓存则必须联网拉取
  if (!cached) {
    const fresh = await fetchBook(serverUrl, bookId);
    await window.api.setBookCache(bookId, JSON.stringify(fresh));
    return fresh;
  }
  // 3) 有缓存：直接返回，同时后台静默刷新（不阻塞）
  fetchBook(serverUrl, bookId)
    .then((fresh) => window.api.setBookCache(bookId, JSON.stringify(fresh)))
    .catch(() => {});
  return cached;
}

async function fetchBook(serverUrl, bookId) {
  const base = (serverUrl || 'https://vjqm1hqc-8787.jpe1.devtunnels.ms').replace(/\/$/, '');
  const r = await fetch(`${base}/books/${encodeURIComponent(bookId)}.json`, { cache: 'no-store' });
  if (!r.ok) throw new Error('书籍下载失败 ' + r.status);
  return r.json();
}
