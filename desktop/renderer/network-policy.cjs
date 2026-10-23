// 主进程网络边界；纯函数也用于 Node 下的回归验证。
const LOGIN_HOSTS = new Set([
  'login.microsoftonline.com', 'login.live.com', 'account.live.com', 'login.windows.net',
  'global.rel.tunnels.api.visualstudio.com',
]);

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(hostname);
}

function safeServerUrl(value) {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('服务器需使用 HTTPS 根地址；HTTP 仅允许本机回环地址');
  }
  return url;
}

function validateRequest(serverUrl, request) {
  const base = safeServerUrl(serverUrl);
  if (!request || typeof request.url !== 'string') throw new Error('无效同步请求');
  const url = new URL(request.url);
  if (url.origin !== base.origin || url.username || url.password || url.hash || /[\\%]/.test(url.pathname)) {
    throw new Error('同步请求地址不在允许范围');
  }
  const isBook = /^\/books\/[a-z0-9][a-z0-9_-]{0,63}\.json$/i.test(url.pathname);
  const isApi = /^\/api\/[a-z0-9][a-z0-9/_-]*$/i.test(url.pathname);
  const isSession = url.pathname === '/auth/session';
  if (!isBook && !isApi && !isSession) throw new Error('同步请求路径不在允许范围');
  const method = String(request.method || 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(method) || ((isBook || isSession) && method !== 'GET')) throw new Error('同步请求方法不允许');
  if (request.body != null && (method !== 'POST' || typeof request.body !== 'string')) throw new Error('无效同步请求正文');
  if (Buffer.byteLength(request.body || '', 'utf8') > 65536) throw new Error('同步请求正文超过 64 KB');
  return { url: url.href, method, body: request.body, isBook };
}

function isLoginNavigationAllowed(serverUrl, target) {
  try {
    const base = safeServerUrl(serverUrl);
    const url = new URL(target);
    if (url.username || url.password) return false;
    if (url.origin === base.origin) return true;
    // 登录窗口无 preload / Node 权限，只允许微软账号与 Dev Tunnel 的认证入口。
    return url.protocol === 'https:' && !url.port && (LOGIN_HOSTS.has(url.hostname) ||
      url.hostname.endsWith('.tunnels.api.visualstudio.com'));
  } catch {
    return false;
  }
}

function isAuthenticationResponse(status, contentType = '') {
  return [401, 403].includes(status) || (status >= 300 && status < 400) || /text\/html/i.test(contentType);
}

function isAuthenticationRedirectError(error) {
  // Electron 33 的 session.fetch 在 manual 模式下以此错误拒绝 302，而非返回 Response。
  return /redirect.*(?:cancelled|canceled|not allowed)/i.test(String(error?.message || ''));
}

module.exports = { safeServerUrl, validateRequest, isLoginNavigationAllowed, isAuthenticationResponse, isAuthenticationRedirectError };
