import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticatedFetch, loginAgain } from './auth-fetch.js';

const browser = { location: { origin: 'https://reader.test', href: 'https://reader.test/' } };
test('private gateway redirects trigger login without following cross-origin OAuth', async () => {
  let redirected = 0;
  await assert.rejects(authenticatedFetch('/api/books', {}, { browser,
    fetchImpl: async (_url, options) => { assert.equal(options.redirect, 'manual'); return { status: 0, type: 'opaqueredirect' }; },
    relogin: async () => { redirected++; },
  }), /登录/);
  assert.equal(redirected, 1);
});
test('401 requests login but ordinary offline failure preserves offline state', async () => {
  let redirected = 0;
  const relogin = async () => { redirected++; };
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
