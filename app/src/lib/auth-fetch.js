let loginPending = false;

export async function loginAgain(browser = globalThis.window, workers = globalThis.navigator?.serviceWorker, { gateway = false } = {}) {
  if (!browser || loginPending) return;
  loginPending = true;
  try {
    // Old PWA navigation fallback also captures /auth/login. Release it first;
    // localStorage (including offline reading progress) is left intact.
    const registrations = await workers?.getRegistrations?.() || [];
    await Promise.all(registrations.filter((r) => new URL(r.scope).origin === browser.location.origin)
      .map((r) => r.unregister()));
  } catch { /* A normal navigation still lets the gateway request sign-in. */ }
  // Navigate outside this origin so even a still-controlling old worker cannot
  // replace the login navigation with its cached app shell.
  const origin = new URL(browser.location.origin);
  const loginUrl = gateway && origin.hostname.endsWith('.devtunnels.ms')
    ? `https://global.rel.tunnels.api.visualstudio.com/auth/aad?pb=${encodeURIComponent(`${origin.origin}/auth/postback/aad?tunnel=1`)}`
    : '/auth/login';
  browser.location.assign(loginUrl);
}

export async function authenticatedFetch(url, options = {}, {
  fetchImpl = globalThis.fetch, browser = globalThis.window,
  relogin = (gateway) => loginAgain(browser, undefined, { gateway }),
} = {}) {
  const sameOrigin = browser && new URL(url, browser.location.href).origin === browser.location.origin;
  const response = await fetchImpl(url, { ...options, ...(sameOrigin ? { redirect: 'manual' } : {}) });
  if (sameOrigin && (response.status === 401 || response.type === 'opaqueredirect' ||
      (response.status >= 300 && response.status < 400))) {
    // An application 401 needs the reader password, not another Microsoft
    // sign-in (which would leave the reader session missing and loop).
    await relogin(response.status !== 401);
    throw new Error('登录状态已过期，正在打开登录页');
  }
  return response;
}
