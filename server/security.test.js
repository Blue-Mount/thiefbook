import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import express from 'express';
import { createSecurity } from './security.js';
import { fileStore } from './storage.js';

const code = 'test-access-code-0123456789abcdef';
const secret = 'test-session-secret-0123456789abcdef0123456789abcdef';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thiefbook-security-'));
const dataDir = path.join(root, 'data');
const staticDir = path.join(root, 'static');
const serverDir = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(staticDir);
fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>private book reader</h1>');
let child;
let base;
let cookie;

before(async () => {
  child = spawn(process.execPath, ['index.js'], {
    cwd: serverDir, windowsHide: true,
    env: { ...process.env, THIEFBOOK_ENV_FILE: 'none', PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir,
      STATIC_DIR: staticDir, BOOKS_DIR: path.join(root, 'books'), WEB_ACCESS_CODE: code, AUTH_SESSION_SECRET: secret,
      PUBLIC_ORIGIN: 'https://reader.example', PROGRESS_MAX_RECORDS: '3', AUTH_LOGIN_MAX_FAILURES: '3',
      UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', DASHSCOPE_API_KEY: '', SFM_WORKSPACE_ID: '', TTS_ACCESS_CODE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server startup timed out')), 10000);
    child.once('exit', (exitCode) => { clearTimeout(timeout); reject(new Error(`server exited: ${exitCode}`)); });
    child.stdout.on('data', (chunk) => {
      const match = chunk.toString().match(/http:\/\/localhost:(\d+)/);
      if (match) { base = `http://127.0.0.1:${match[1]}`; clearTimeout(timeout); resolve(); }
    });
    child.stderr.resume();
  });
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const bearer = { Authorization: `Bearer ${code}` };
const post = (route, body, headers = bearer) => fetch(`${base}${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual',
});
const login = (value, headers = {}) => fetch(`${base}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams({ code: value }), redirect: 'manual',
});

test('configuration fails closed when login or signing secrets are missing', () => {
  assert.throws(() => createSecurity({ dataDir, env: {} }), /WEB_ACCESS_CODE/);
  assert.throws(() => createSecurity({ dataDir, env: { WEB_ACCESS_CODE: code, AUTH_SESSION_SECRET: 'short' } }), /AUTH_SESSION_SECRET/);
});

test('anonymous clients see only health and login; bodies are rejected before large parsers', async () => {
  const health = await fetch(`${base}/api/health`);
  assert.deepEqual(await health.json(), { ok: true });
  for (const route of ['/api/books', '/api/progress?code=eric-fuhan&book=sample', '/api/tts/segments?book=sample&chapter=0', '/api/book-content/sample/manifest', '/auth/session']) {
    assert.equal((await fetch(`${base}${route}`)).status, 401, route);
  }
  const page = await fetch(base, { headers: { Accept: 'text/html' }, redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/auth/login');
  assert.equal((await fetch(`${base}/books/sample.json`, { redirect: 'manual' })).status, 302);
  assert.equal((await post('/api/progress', { code: 'eric-fuhan', book: 'sample', chapter: 1 }, {})).status, 401);
  for (const [route, type] of [['/api/books', 'application/octet-stream'], ['/api/progress', 'application/json']]) {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': type }, body: 'x'.repeat(100000) });
    assert.equal(response.status, 401, route);
  }
});

test('login sets signed expiring secure cookie and requires the actual access code', async () => {
  const response = await login(code, { Origin: 'https://reader.example' });
  assert.equal(response.status, 302);
  const header = response.headers.get('set-cookie');
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Max-Age=2592000/);
  cookie = header.split(';')[0];
  assert.equal((await fetch(`${base}/auth/session`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${base}/auth/session`, { headers: bearer })).status, 200);
  assert.equal((await fetch(`${base}/auth/session`, { headers: { Cookie: `${cookie}tampered` } })).status, 401);
  assert.equal((await fetch(`${base}/auth/session`, { headers: { Authorization: 'Bearer eric-fuhan' } })).status, 401);
});

test('mutation and login deny cross-site origins, while originless authenticated clients work', async () => {
  assert.equal((await login(code, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await login(code, { Origin: 'null' })).status, 403);
  assert.equal((await login(code, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const body = { code: 'eric-fuhan', book: 'sample', chapter: 1, percent: 0.25, updatedAt: Date.now(), device: 'test' };
  assert.equal((await post('/api/progress', body, { Cookie: cookie, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/progress', body, { ...bearer, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post('/api/progress', body, { Cookie: cookie })).status, 200);
  assert.equal((await post('/api/progress', { ...body, chapter: 2 })).status, 200);
  assert.equal((await fetch(`${base}/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status, 403);
  const logout = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
});

test('valid sessions skip the password form and desktop login finishes without opening the reader', async () => {
  const signedIn = await login(code);
  const headers = { Cookie: signedIn.headers.get('set-cookie').split(';')[0] };
  for (const [route, destination] of [['/auth/login', '/'], ['/auth/login?desktop=1', '/auth/desktop'],
    ['/auth/login?desktop=https://evil.example', '/']]) {
    const response = await fetch(`${base}${route}`, { headers, redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), destination);
  }
  const anonymous = await fetch(`${base}/auth/login?desktop=1`);
  assert.equal(anonymous.status, 200);
  assert.match(await anonymous.text(), /action="\/auth\/login\?desktop=1"/);
  const desktopLogin = await fetch(`${base}/auth/login?desktop=1`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code }), redirect: 'manual',
  });
  assert.equal(desktopLogin.headers.get('location'), '/auth/desktop');
  const completed = await fetch(`${base}/auth/desktop`, { headers });
  assert.equal(completed.status, 200);
  assert.match(await completed.text(), /同步登录成功/);
  assert.equal((await fetch(`${base}/auth/desktop`)).status, 401);
});

test('progress validates namespaces, identifiers, coordinates, clocks and storage quotas', async () => {
  const body = { code: 'eric-fuhan', book: 'sample', chapter: 1, percent: 0.25, updatedAt: Date.now(), device: 'test' };
  for (const bad of [
    { code: 'another-user' }, { book: '../secret' }, { book: '__proto__' }, { chapter: -1 }, { chapter: 1.5 },
    { percent: 1.01 }, { percent: -1 }, { percent: '0.5' }, { updatedAt: Date.now() + 86400000 },
    { updatedAt: 'not-time' }, { device: 'x'.repeat(41) }, { segment: -1 }, { mode: 'arbitrary' },
  ]) assert.equal((await post('/api/progress', { ...body, ...bad })).status, 400, JSON.stringify(bad));
  assert.equal((await fetch(`${base}/api/progress?code=other&book=sample`, { headers: bearer })).status, 400);
  assert.equal((await post('/api/current-book', { ...body, book: '../secret' })).status, 400);
  assert.equal((await post('/api/progress', { ...body, book: 'second' })).status, 200);
  assert.equal((await post('/api/progress', { ...body, book: 'third' })).status, 200);
  assert.equal((await post('/api/progress', { ...body, book: 'fourth' })).status, 429);
  assert.equal((await post('/api/progress', { ...body, chapter: 3 })).status, 200);
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'));
  assert.equal(Object.keys(persisted).length, 3);
  assert.equal(persisted['eric-fuhan::sample'].chapter, 3);
});

test('authenticated JSON has a small bound, uploads need authentication rather than a public sync code', async () => {
  assert.equal((await post('/api/progress', { padding: 'x'.repeat(20000) })).status, 413);
  assert.equal((await fetch(`${base}/api/books?code=arbitrary`, { headers: bearer })).status, 200);
  const upload = await fetch(`${base}/api/books?id=uploaded&title=test`, {
    method: 'POST', headers: { ...bearer, 'Content-Type': 'application/octet-stream' }, body: '第一章 正文\n测试上传正文。',
  });
  assert.equal(upload.status, 201);
  assert.equal((await fetch(`${base}/api/book-content/uploaded/manifest`, { headers: bearer })).status, 200);
});

test('a slow upload occupies the concurrency slot before the body is buffered', async () => {
  const body = Buffer.from('第一章 正文\n并发上传测试正文。');
  let connected;
  const waiting = new Promise((resolve) => { connected = resolve; });
  const firstResponse = new Promise((resolve, reject) => {
    const upload = http.request(`${base}/api/books?id=slow-upload&title=test`, {
      method: 'POST', headers: { ...bearer, 'Content-Type': 'application/octet-stream', 'Content-Length': body.length },
    }, (res) => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    upload.once('error', reject);
    upload.once('socket', (socket) => socket.once('connect', () => connected(upload)));
    upload.write(body.subarray(0, 1));
  });
  const upload = await waiting;
  // Wait for the first request's headers to enter the server before opening the second socket.
  await new Promise((resolve) => setTimeout(resolve, 40));
  const second = await fetch(`${base}/api/books?id=parallel-upload&title=test`, {
    method: 'POST', headers: { ...bearer, 'Content-Type': 'application/octet-stream' }, body,
  });
  assert.equal(second.status, 429);
  await second.arrayBuffer();
  upload.end(body.subarray(1));
  assert.equal(await firstResponse, 201);
  const third = await fetch(`${base}/api/books?id=after-upload&title=test`, {
    method: 'POST', headers: { ...bearer, 'Content-Type': 'application/octet-stream' }, body,
  });
  assert.equal(third.status, 201);
  await third.arrayBuffer();
});

test('failed login limit rejects even a correct password after repeated failures', async () => {
  for (let index = 0; index < 3; index++) assert.equal((await login('wrong')).status, 401);
  assert.equal((await login(code)).status, 429);
  assert.equal((await fetch(`${base}/auth/session`, { headers: bearer })).status, 200);
});

test('audit records access outcomes without query strings, passwords or cookies', async () => {
  await fetch(`${base}/api/books?code=DO_NOT_LOG_QUERY_SECRET`, { headers: bearer });
  const log = fs.readFileSync(path.join(dataDir, 'security', 'access.jsonl'), 'utf8');
  assert.equal(log.includes(code), false);
  assert.equal(log.includes(secret), false);
  assert.equal(log.includes(cookie), false);
  assert.equal(log.includes('DO_NOT_LOG_QUERY_SECRET'), false);
  const entries = log.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(entries.some((entry) => entry.event === 'login-failed'));
  assert.ok(entries.some((entry) => entry.auth === 'bearer' && entry.status === 200));
  assert.ok(entries.every((entry) => entry.path !== '/api/health'));
});

test('file quota keeps existing records updateable and every acknowledged write survives reload', async () => {
  const directory = path.join(root, 'store-unit');
  const store = fileStore({ dataDir: directory, maxRecords: 1 });
  await store.set('code', 'book', { chapter: 1 });
  await assert.rejects(store.set('code', 'another', { chapter: 1 }), { status: 429 });
  await store.set('code', 'book', { chapter: 2 });
  assert.deepEqual(await fileStore({ dataDir: directory, maxRecords: 1 }).get('code', 'book'), { chapter: 2 });
  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith('.tmp')), false);
  fs.writeFileSync(path.join(directory, 'store.json'), '{bad json');
  assert.throws(() => fileStore({ dataDir: directory }), /拒绝启动/);
});

test('session expiry and proxy HTTPS hints cannot bypass signing or cookie policy', async () => {
  let clock = Date.now();
  const security = createSecurity({ dataDir: path.join(root, 'clock'), env: { WEB_ACCESS_CODE: code, AUTH_SESSION_SECRET: secret }, now: () => clock });
  const app = express();
  app.use('/auth', security.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${url}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-Proto': 'https' }, body: new URLSearchParams({ code }), redirect: 'manual' });
    const header = response.headers.get('set-cookie');
    assert.equal(header.includes('Secure'), false);
    const auth = { Cookie: header.split(';')[0] };
    assert.equal((await fetch(`${url}/auth/session`, { headers: auth })).status, 200);
    clock += 31 * 86400000;
    assert.equal((await fetch(`${url}/auth/session`, { headers: auth })).status, 401);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('request limits deny authenticated clients too and audit files rotate within configured bounds', async () => {
  const directory = path.join(root, 'rate-logs');
  const security = createSecurity({ dataDir: directory, env: { WEB_ACCESS_CODE: code, AUTH_SESSION_SECRET: secret,
    REQUESTS_PER_MINUTE: '2', SECURITY_LOG_MAX_BYTES: '250', SECURITY_LOG_FILES: '2' } });
  const app = express();
  app.use(security.audit, security.rateLimit, security.requireAuth);
  app.get('/private', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/private`;
    for (let index = 0; index < 10; index++) {
      const response = await fetch(url, { headers: bearer });
      assert.equal(response.status, index < 2 ? 200 : 429);
      await response.arrayBuffer();
    }
    const directoryFiles = path.join(directory, 'security');
    const files = fs.readdirSync(directoryFiles);
    assert.equal(files.length, 3, 'one active log plus two archives');
    assert.ok(files.every((name) => fs.statSync(path.join(directoryFiles, name)).size <= 250));
    const entry = JSON.parse(fs.readFileSync(path.join(directoryFiles, 'access.jsonl'), 'utf8').trim());
    assert.equal(entry.peerIp, '127.0.0.1');
    assert.equal(entry.event, 'rate-limited');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
