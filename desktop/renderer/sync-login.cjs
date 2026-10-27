// 隧道认证需要顶层导航；API 请求仍禁止跟随重定向。
const { safeServerUrl, isLoginNavigationAllowed } = require('./network-policy.cjs');

function createSyncLogin({ createWindow, serverUrl, checkSession, onAuthenticated, onClosed, onNeedsLogin,
  now = Date.now, timeoutMs = 20000, cooldownMs = 60000 }) {
  let active = null;
  let retryAfter = 0;

  function start(interactive) {
    const base = safeServerUrl(serverUrl());
    if (active) {
      if (interactive) {
        active.interactive = true;
        active.win.show();
        active.win.focus();
      }
      return active.promise;
    }
    if (!interactive && now() < retryAfter) return Promise.resolve(false);
    const win = createWindow();
    let resolve;
    const state = { win, base, interactive, promise: new Promise((done) => { resolve = done; }), checking: false };
    active = state;

    function finish(authenticated) {
      if (active !== state) return;
      active = null;
      clearTimeout(state.timeout);
      clearTimeout(state.reveal);
      retryAfter = now() + cooldownMs;
      resolve(authenticated);
      if (!win.isDestroyed()) win.destroy();
      if (authenticated) onAuthenticated();
      else onNeedsLogin();
      onClosed();
    }
    state.cancel = () => finish(false);
    function reveal() {
      if (active === state && state.interactive && !win.isDestroyed()) win.show();
    }
    win.on('closed', () => finish(false));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    for (const name of ['will-navigate', 'will-redirect']) {
      win.webContents.on(name, (event, target) => {
        if (!isLoginNavigationAllowed(base.href, target)) {
          event.preventDefault();
          finish(false);
        }
      });
    }
    async function inspectSession() {
      if (active !== state) return;
      if (state.checking) { state.checkAgain = true; return; }
      const current = new URL(win.webContents.getURL());
      if (current.origin !== base.origin) return;
      state.checking = true;
      try {
        const authenticated = await checkSession(base);
        if (active !== state) return;
        if (authenticated) return finish(true);
        // 已到达本服务，仍未登录才需要密码。后台探测不弹出窗口。
        onNeedsLogin();
        if (!state.interactive) return finish(false);
        clearTimeout(state.reveal);
        reveal();
      } catch {
        if (!state.interactive) finish(false);
        else reveal();
      } finally {
        state.checking = false;
        if (state.checkAgain) {
          state.checkAgain = false;
          void inspectSession();
        }
      }
    }
    win.webContents.on('did-finish-load', inspectSession);
    // 交互登录仍允许微软 MFA 等耗时操作；后台恢复严格限时并冷却。
    state.timeout = setTimeout(() => {
      if (!state.interactive) finish(false);
      else reveal();
    }, timeoutMs);
    state.reveal = setTimeout(reveal, 1500);
    win.loadURL(new URL('/auth/login?desktop=1', base).href).catch(() => finish(false));
    return state.promise;
  }

  return {
    open: () => { void start(true); },
    restore: () => active?.interactive ? Promise.resolve(false) : start(false),
    cancel: () => { active?.cancel(); retryAfter = 0; },
  };
}

module.exports = { createSyncLogin };
