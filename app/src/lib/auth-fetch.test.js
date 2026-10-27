import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticatedFetch, loginAgain } from './auth-fetch.js';

const browser = { location: { origin: 'https://reader.test', href: 'https://reader.test/' } };
test('private gateway redirects trigger login without following cross-origin OAuth', async () => {
  let redirected = 0;
  await assert.rejects(authenticatedFetch('/api/books', {}, { browser,
    fetchImpl: async (_url, options) => { assert.equal(options.redirect, 'manual'); return { status: 0, type: 'opaqueredirect' }; },
    relogin: async (gateway) => { assert.equal(gateway, true); redirected++; },
  }), /登录/);
  assert.equal(redirected, 1);
});
test('401 requests login but ordinary offline failure preserves offline state', async () => {
  let redirected = 0;
  const relogin = async (gateway) => { assert.equal(gateway, false); redirected++; };
  await assert.rejects(authenticatedFetch('/api/books', {}, { browser, relogin,
    fetchImpl: async () => ({ status: 401 }) }), /登录/);
  await assert.rejects(authenticatedFetch('/api/books', {}, { browser, relogin,
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), TypeError);
  assert.equal(redirected, 1);
});
test('login navigation releases stale worker without deleting progress or other sites', async () => {
  const events = [];
  await loginAgain({ location: { ...browser.location, assign: (url) => events.push(url) } }, {
    getRegistrations: async () => [
      { scope: 'https://reader.test/', unregister: async () => events.push('unregister') },
      { scope: 'https://other.test/', unregister: async () => assert.fail('wrong origin') },
    ],
  });
  assert.deepEqual(events, ['unregister', '/auth/login']);
});

test('private tunnel login bypasses a worker still controlling the current page', async () => {
  const origin = 'https://sample-8787.jpe1.devtunnels.ms';
  // Reload the module to represent a fresh page with no login in progress.
  const { loginAgain: freshLogin } = await import('./auth-fetch.js?tunnel-login');
  let destination;
  await freshLogin({ location: { origin, assign: (url) => { destination = new URL(url); } } }, {
    getRegistrations: async () => { throw new Error('worker unavailable'); },
  }, { gateway: true });
  assert.equal(destination.origin, 'https://global.rel.tunnels.api.visualstudio.com');
  assert.equal(destination.pathname, '/auth/aad');
  assert.equal(destination.searchParams.get('pb'), `${origin}/auth/postback/aad?tunnel=1`);
});

test('reader login on a tunnel opens the password form instead of repeating Microsoft sign-in', async () => {
  const { loginAgain: freshLogin } = await import('./auth-fetch.js?reader-login');
  const events = [];
  await freshLogin({ location: { origin: 'https://sample-8787.jpe1.devtunnels.ms',
    assign: (url) => events.push(url) } }, {
    getRegistrations: async () => [{ scope: 'https://sample-8787.jpe1.devtunnels.ms/',
      unregister: async () => events.push('unregister') }],
  });
  assert.deepEqual(events, ['unregister', '/auth/login']);
});
