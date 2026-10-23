import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

const COOKIE = 'tb_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export function positiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= max ? number : fallback;
}

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
}

export function createSecurity({ dataDir, env = process.env, now = Date.now }) {
  const accessCode = env.WEB_ACCESS_CODE || '';
  const secret = env.AUTH_SESSION_SECRET || '';
  if (accessCode.length < 24 || secret.length < 32) {
    throw new Error('必须配置 WEB_ACCESS_CODE（至少24字符）和 AUTH_SESSION_SECRET（至少32字符）');
  }
  const publicOrigin = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).origin : null;
  if (publicOrigin && !/^https?:\/\//.test(publicOrigin)) throw new Error('PUBLIC_ORIGIN 必须为 HTTP(S) 地址');
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: publicOrigin?.startsWith('https:') || false, path: '/' };
  const logDir = path.join(dataDir, 'security');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'access.jsonl');
  const logMax = positiveInt(env.SECURITY_LOG_MAX_BYTES, 2 * 1024 * 1024, 10 * 1024 * 1024);
  const logKeep = positiveInt(env.SECURITY_LOG_FILES, 7, 30);
  let logSize = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  let logWarning = false;
  const failures = new Map();
  const requests = new Map();
  const loginLimit = positiveInt(env.AUTH_LOGIN_MAX_FAILURES, 8, 100);
  const requestLimit = positiveInt(env.REQUESTS_PER_MINUTE, 600, 6000);

  function audit(req, res, next) {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' });
    if (req.path !== '/api/health') {
      const requestPath = req.path.slice(0, 256);
      let written = false;
      const record = () => {
        if (written) return;
        written = true;
        const line = JSON.stringify({ at: new Date(now()).toISOString(), method: req.method,
          path: requestPath, peerIp: req.socket.remoteAddress, status: res.statusCode,
          auth: req.authType || 'anonymous', event: req.securityEvent || 'request' }) + '\n';
        try {
          if (logSize + Buffer.byteLength(line) > logMax) {
            fs.rmSync(`${logFile}.${logKeep}`, { force: true });
            for (let index = logKeep - 1; index >= 1; index--) {
              if (fs.existsSync(`${logFile}.${index}`)) fs.renameSync(`${logFile}.${index}`, `${logFile}.${index + 1}`);
            }
            if (fs.existsSync(logFile)) fs.renameSync(logFile, `${logFile}.1`);
            logSize = 0;
          }
          fs.appendFileSync(logFile, line, { mode: 0o600 });
          logSize += Buffer.byteLength(line);
        } catch {
          if (!logWarning) console.error('安全审计日志写入失败，请检查数据目录权限和磁盘空间');
          logWarning = true;
        }
      };
      res.once('finish', record);
      res.once('close', record);
    }
    next();
  }

  function bucket(map, key, windowMs) {
    const timestamp = now();
    for (const [id, value] of map) if (value.until <= timestamp) map.delete(id);
    let value = map.get(key);
    if (!value || value.until <= timestamp) {
      value = { count: 0, until: timestamp + windowMs };
      map.set(key, value);
    }
    return value;
  }

  function rateLimit(req, res, next) {
    const entry = bucket(requests, req.socket.remoteAddress, 60000);
    if (++entry.count > requestLimit) {
      req.securityEvent = 'rate-limited';
      return res.status(429).set('Retry-After', '60').json({ error: '请求过于频繁，请稍后重试' });
    }
    next();
  }

  function sameOrigin(req, res, next) {
    const origin = req.get('Origin');
    const port = req.socket.localPort;
    const allowed = [publicOrigin, `http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
    if (req.get('Sec-Fetch-Site') === 'cross-site' || (origin && !allowed.includes(origin))) {
      req.securityEvent = 'cross-origin-denied';
      return res.status(403).json({ error: '拒绝跨站请求' });
    }
    next();
  }

  const sign = (value) => crypto.createHmac('sha256', secret).update(value).digest('base64url');
  function authenticate(req) {
    const authorization = req.get('Authorization');
    if (authorization) {
      if (authorization.startsWith('Bearer ') && equal(authorization.slice(7), accessCode)) return 'bearer';
      return null;
    }
    const raw = (req.get('Cookie') || '').split(';').find((item) => item.trim().startsWith(`${COOKIE}=`));
    if (!raw) return null;
    const token = raw.trim().slice(COOKIE.length + 1);
    const [expires, nonce, signature, extra] = token.split('.');
    if (extra || !/^\d{13}$/.test(expires || '') || !/^[a-f0-9]{32}$/.test(nonce || '')) return null;
    const expiry = Number(expires);
    if (expiry <= now() || expiry > now() + SESSION_MS + 60000 || !equal(signature, sign(`${expires}.${nonce}`))) return null;
    return 'session';
  }

  function requireAuth(req, res, next) {
    req.authType = authenticate(req);
    if (req.authType) return next();
    req.securityEvent = 'authentication-denied';
    if (req.path.startsWith('/api/') || req.baseUrl === '/auth' || req.path === '/auth/session' || !req.accepts('html')) {
      return res.status(401).json({ error: '请先登录', login: '/auth/login' });
    }
    res.redirect(302, '/auth/login');
  }

  const router = express.Router();
  router.get('/login', (_req, res) => {
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.type('html').send('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>摸鱼看书 · 登录</title><style>body{max-width:340px;margin:15vh auto;padding:24px;font:16px system-ui;background:#f7f4ed;color:#292d32}input,button{box-sizing:border-box;width:100%;padding:12px;margin-top:16px;font:inherit}button{cursor:pointer}small{display:block;margin-top:16px;color:#666}</style><h1>摸鱼看书</h1><form method="post" action="/auth/login"><label>访问密码<input type="password" name="code" required maxlength="512" autocomplete="current-password" autofocus></label><button type="submit">登录</button></form><small>仅供本人使用。登录状态保留30天。</small></html>');
  });
  router.post('/login', sameOrigin, (req, res, next) => {
    const entry = bucket(failures, req.socket.remoteAddress, 15 * 60000);
    if (entry.count >= loginLimit) {
      req.securityEvent = 'login-rate-limited';
      return res.status(429).set('Retry-After', '900').json({ error: '登录失败次数过多，请15分钟后重试' });
    }
    next();
  }, express.urlencoded({ extended: false, limit: '1kb', parameterLimit: 2 }), (req, res) => {
    // Multiple slow bodies can pass the first check before any one password is evaluated.
    if (bucket(failures, req.socket.remoteAddress, 15 * 60000).count >= loginLimit) {
      req.securityEvent = 'login-rate-limited';
      return res.status(429).set('Retry-After', '900').json({ error: '登录失败次数过多，请15分钟后重试' });
    }
    if (!equal(req.body?.code, accessCode)) {
      bucket(failures, req.socket.remoteAddress, 15 * 60000).count++;
      req.securityEvent = 'login-failed';
      return res.status(401).type('html').send('<!doctype html><meta charset="utf-8"><p>访问密码不正确。</p><a href="/auth/login">返回登录</a>');
    }
    failures.delete(req.socket.remoteAddress);
    const value = `${now() + SESSION_MS}.${crypto.randomBytes(16).toString('hex')}`;
    req.authType = 'session';
    req.securityEvent = 'login-succeeded';
    res.cookie(COOKIE, `${value}.${sign(value)}`, { ...cookieOptions, maxAge: SESSION_MS });
    res.redirect(302, '/');
  });
  router.get('/session', requireAuth, (_req, res) => res.json({ authenticated: true }));
  router.post('/logout', sameOrigin, requireAuth, (req, res) => {
    res.clearCookie(COOKIE, cookieOptions);
    req.securityEvent = 'logout';
    res.json({ ok: true });
  });

  return { audit, rateLimit, sameOrigin, requireAuth, router };
}

export function uploadGuard(env = process.env) {
  let active = 0;
  const max = positiveInt(env.BOOK_UPLOAD_CONCURRENCY, 1, 4);
  return (req, res, next) => {
    if (active >= max) return res.status(429).json({ error: '已有小说正在上传，请稍后重试' });
    active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}
