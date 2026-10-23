const { test } = require('node:test');
const assert = require('node:assert/strict');
const { safeServerUrl, validateRequest, isLoginNavigationAllowed, isAuthenticationResponse, isAuthenticationRedirectError } = require('./renderer/network-policy.cjs');
const server = 'https://reader.example';

test('只允许 HTTPS 根地址，HTTP 限本机回环', () => {
  for (const value of [server, 'http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) assert.ok(safeServerUrl(value));
  for (const value of ['http://example.com', 'file:///etc/passwd', 'https://user:secret@example.com', `${server}/path`, `${server}/?a=b`]) assert.throws(() => safeServerUrl(value));
});

test('API IPC 拒绝跨域、非 API/书籍路径和路径混淆', () => {
  assert.equal(validateRequest(server, { url: `${server}/api/progress?book=fuhan` }).method, 'GET');
  assert.equal(validateRequest(server, { url: `${server}/books/fuhan.json` }).isBook, true);
  assert.equal(validateRequest(server, { url: `${server}/auth/session` }).method, 'GET');
  for (const url of ['https://evil.example/api/progress', `${server}/auth/login`, `${server}/books/a/b.json`, `${server}/books/%66uhan.json`, `${server}/api/../../secret`, `${server}/api/x%2fy`, `${server}/api/x#secret`]) assert.throws(() => validateRequest(server, { url }));
});

test('IPC 方法及正文限制按 UTF-8 字节数执行', () => {
  const url = `${server}/api/progress`;
  assert.equal(validateRequest(server, { url, method: 'POST', body: '{}' }).body, '{}');
  for (const request of [{ url, method: 'DELETE' }, { url, body: 'x' }, { url, method: 'POST', body: {} }, { url, method: 'POST', body: '中'.repeat(21846) }, { url: `${server}/books/fuhan.json`, method: 'POST' }]) assert.throws(() => validateRequest(server, request));
  assert.throws(() => validateRequest(server, { url: `${server}/auth/session`, method: 'POST', body: '{}' }));
});

test('登录导航只接受当前站点、微软账号及隧道认证域', () => {
  for (const url of [`${server}/auth/login`, 'https://login.microsoftonline.com/common/oauth2/authorize', 'https://login.live.com/oauth20_authorize.srf', 'https://global.rel.tunnels.api.visualstudio.com/auth']) assert.ok(isLoginNavigationAllowed(server, url));
  for (const url of ['http://login.live.com', 'https://login.live.com.evil.example', 'https://evil.example', 'file:///etc/passwd', 'javascript:alert(1)', 'https://reader.example:444/auth/login', 'https://user:secret@reader.example/auth/login']) assert.equal(isLoginNavigationAllowed(server, url), false);
});

test('认证拒绝、重定向或隧道 HTML 提示均要求用户登录', () => {
  for (const status of [401, 403, 301, 302, 307, 308]) assert.ok(isAuthenticationResponse(status, 'application/json'));
  assert.ok(isAuthenticationResponse(200, 'text/html; charset=utf-8'));
  assert.equal(isAuthenticationResponse(200, 'application/json'), false);
  assert.equal(isAuthenticationResponse(429, 'application/json'), false);
  assert.ok(isAuthenticationRedirectError(new Error('Redirect was cancelled')));
  assert.equal(isAuthenticationRedirectError(new Error('net::ERR_CONNECTION_REFUSED')), false);
});
