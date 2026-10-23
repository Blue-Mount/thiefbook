let loginPending = false;

export async function loginAgain(browser = globalThis.window, workers = globalThis.navigator?.serviceWorker) {
  if (!browser || loginPending) return;
  loginPending = true;
  try {
    // Old PWA navigation fallback also captures /auth/login. Release it first;
    // localStorage (including offline reading progress) is left intact.
    const registrations = await workers?.getRegistrations?.() || [];
    await Promise.all(registrations.filter((r) => new URL(r.scope).origin === browser.location.origin)
      .map((r) => r.unregister()));
  } catch { /* A normal navigation still lets the gateway request sign-in. */ }
  browser.location.assign('/auth/login');
}

export async function authenticatedFetch(url, options = {}, {
  fetchImpl = globalThis.fetch, browser = globalThis.window,
  relogin = () => loginAgain(browser),
} = {}) {
  const sameOrigin = browser && new URL(url, browser.location.href).origin === browser.location.origin;
  const response = await fetchImpl(url, { ...options, ...(sameOrigin ? { redirect: 'manual' } : {}) });
  if (sameOrigin && (response.status === 401 || response.type === 'opaqueredirect' ||
      (response.status >= 300 && response.status < 400))) {
    await relogin();
    throw new Error('登录状态已过期，正在打开登录页');
  }
  return response;
}
