// 使用真实 Electron 验证登录 cookie 与禁自动跳转；不连接任何公网服务。
// 运行：electron.exe session-fetch.smoke.cjs [结果 JSON 路径]
const { app, BrowserWindow, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { isAuthenticationRedirectError } = require('./renderer/network-policy.cjs');
const { createSyncLogin } = require('./renderer/sync-login.cjs');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'thiefbook-session-test-')));
const resultPath = process.argv[2];
const observed = {};
const timeout = setTimeout(() => finish({ ok: false, error: 'Electron smoke test timed out' }), 40000);
function finish(result) {
  clearTimeout(timeout);
  result = { ...result, ...observed };
  if (resultPath) fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  app.exit(result.ok ? 0 : 1);
}
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

app.whenReady().then(async () => {
  let foreignRequests = 0;
  let cookieObserved = false;
  let fetchOriginAbsent = false;
  let fetchSiteAbsent = false;
  let tunnelExpired = false;
  let passwordValid = true;
  let unsafeRedirect = false;
  let loginRequests = 0;
  const foreign = http.createServer((_request, response) => {
    foreignRequests += 1;
    response.end('redirect reached');
  });
  const foreignUrl = await listen(foreign);
  const server = http.createServer((request, response) => {
    if (request.url === '/auth/login?desktop=1') {
      loginRequests++;
      if (unsafeRedirect) {
        response.writeHead(302, { Location: foreignUrl });
        return response.end();
      }
      if (tunnelExpired) {
        response.writeHead(302, { Location: '/tunnel/refresh' });
        return response.end();
      }
      if (request.method === 'POST') {
        passwordValid = true;
        response.writeHead(302, { Location: '/auth/desktop' });
        return response.end();
      }
      if (passwordValid) {
        response.writeHead(302, { Location: '/auth/desktop' });
        return response.end();
      }
      response.writeHead(200, { 'Content-Type': 'text/html' });
      return response.end('<!doctype html><form method="post" action="/auth/login?desktop=1"><input name="code" value="local-test-only"><button>Login</button></form>');
    } else if (request.url === '/tunnel/refresh') {
      tunnelExpired = false;
      response.writeHead(302, { Location: '/auth/login?desktop=1' });
      return response.end();
    } else if (request.url === '/auth/desktop') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      return response.end('<!doctype html><title>Desktop login complete</title>');
    } else if (request.url === '/auth/login') {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'tb_session=local-smoke-only; HttpOnly; SameSite=Lax; Path=/; Max-Age=60' });
      response.end('<!doctype html><title>Local smoke login</title>Signed in');
    } else if (request.url === '/auth/session') {
      cookieObserved = passwordValid && !tunnelExpired && (request.headers.cookie || '').includes('tb_session=local-smoke-only');
      fetchOriginAbsent = !request.headers.origin;
      fetchSiteAbsent = !request.headers['sec-fetch-site'];
      observed.fetchOrigin = request.headers.origin || null;
      observed.fetchSite = request.headers['sec-fetch-site'] || null;
      response.writeHead(cookieObserved ? 200 : 401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ authenticated: cookieObserved }));
    } else if (request.url === '/api/progress') {
      observed.postOrigin = request.headers.origin || null;
      observed.postCookieShared = (request.headers.cookie || '').includes('tb_session=local-smoke-only');
      response.writeHead(observed.postOrigin === base && observed.postCookieShared ? 200 : 403, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: observed.postOrigin === base && observed.postCookieShared }));
    } else {
      response.writeHead(302, { Location: foreignUrl });
      response.end();
    }
  });
  const base = await listen(server);
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await win.loadURL(`${base}/auth/login`);
  const response = await session.defaultSession.fetch(`${base}/auth/session`, { credentials: 'include', redirect: 'manual' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).authenticated, true);
  assert.equal(cookieObserved, true);
  assert.equal(fetchOriginAbsent, true);
  assert.notEqual(observed.fetchSite, 'cross-site');
  const post = await session.defaultSession.fetch(`${base}/api/progress`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: '{}',
    credentials: 'include',
    redirect: 'manual',
  });
  assert.equal(post.status, 200);
  assert.equal((await post.json()).ok, true);
  assert.equal(observed.postOrigin, base);
  assert.equal(observed.postCookieShared, true);
  let redirectStatus = null;
  let redirectCancelled = false;
  try {
    const redirect = await session.defaultSession.fetch(`${base}/api/redirect`, { credentials: 'include', redirect: 'manual' });
    redirectStatus = redirect.status;
    assert.equal(redirect.status, 302);
  } catch (error) {
    assert.equal(isAuthenticationRedirectError(error), true);
    redirectCancelled = true;
  }
  assert.equal(foreignRequests, 0);
  const windows = [];
  let authenticatedCount = 0;
  let clock = Date.now();
  const login = createSyncLogin({
    serverUrl: () => base,
    createWindow: () => {
      const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
      windows.push(window);
      return window;
    },
    checkSession: async () => {
      const result = await session.defaultSession.fetch(`${base}/auth/session`, { credentials: 'include', redirect: 'manual' });
      return result.ok && (await result.json()).authenticated === true;
    },
    onAuthenticated: () => authenticatedCount++,
    onNeedsLogin: () => {}, onClosed: () => {}, now: () => clock,
  });
  tunnelExpired = true;
  const firstRestore = login.restore();
  assert.equal(login.restore(), firstRestore, 'concurrent requests share one recovery');
  assert.equal(await firstRestore, true);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].isDestroyed(), true);
  assert.equal(authenticatedCount, 1);
  observed.silentTunnelRecovery = true;

  clock += 60001;
  passwordValid = false;
  assert.equal(await login.restore(), false, 'missing password never counts as authenticated');
  assert.equal(windows[1].isDestroyed(), true);
  const beforeCooldown = loginRequests;
  assert.equal(await login.restore(), false);
  assert.equal(loginRequests, beforeCooldown, 'failed recovery respects cooldown');
  observed.recoveryCooldown = true;

  login.open();
  const interactive = windows[2];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('login form did not appear')), 5000);
    interactive.once('show', () => { clearTimeout(timer); resolve(); });
  });
  const closed = new Promise((resolve) => interactive.once('closed', resolve));
  await interactive.webContents.executeJavaScript('document.querySelector("form").requestSubmit()');
  await closed;
  assert.equal(authenticatedCount, 2);
  observed.passwordLoginAutoCloses = true;

  clock += 60001;
  unsafeRedirect = true;
  assert.equal(await login.restore(), false);
  assert.equal(foreignRequests, 0, 'recovery must also block off-allowlist navigations');
  observed.recoveryBlocksForeignNavigation = true;
  win.destroy();
  server.close();
  foreign.close();
  finish({ ok: true, httpOnlyLaxCookieShared: cookieObserved, fetchOriginAbsent, fetchSiteAbsent, redirectStatus, redirectCancelled, foreignRequests });
}).catch((error) => finish({ ok: false, error: error.stack || error.message }));
