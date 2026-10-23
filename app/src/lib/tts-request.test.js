import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestSpeech } from './tts-request.js';

const audio = () => new Response('mp3', { headers: { 'X-TTS-Cost-CNY': '0.01' } });

test('a dropped connection or temporary HTTP error retries the same audio request', async () => {
  const delays = [];
  let attempts = 0;
  const result = await requestSpeech('/audio', { body: 'same segment' }, {
    fetchImpl: async (_url, options) => {
      assert.equal(options.body, 'same segment');
      attempts++;
      if (attempts === 1) throw new TypeError('Failed to fetch');
      if (attempts === 2) return new Response('{}', { status: 502 });
      return audio();
    }, wait: async (ms) => delays.push(ms),
  });
  assert.equal(await result.blob.text(), 'mp3');
  assert.equal(result.cost, 0.01);
  assert.deepEqual(delays, [1000, 2000]);
});

test('failure during audio body download is retried as well', async () => {
  let attempts = 0;
  await requestSpeech('/audio', {}, {
    fetchImpl: async () => ++attempts === 1
      ? { ok: true, blob: async () => { throw new TypeError('connection lost'); } } : audio(),
    wait: async () => {},
  });
  assert.equal(attempts, 2);
});

test('invalid listening passwords are never retried', async () => {
  let attempts = 0;
  await assert.rejects(requestSpeech('/audio', {}, {
    fetchImpl: async () => {
      attempts++;
      return new Response(JSON.stringify({ error: '听书密码不正确' }), { status: 403 });
    }, wait: async () => assert.fail('must not retry'),
  }), /听书密码不正确/);
  assert.equal(attempts, 1);
});

test('exhausted transient failures are marked for rolling buffer reconnection', async () => {
  let attempts = 0;
  await assert.rejects(requestSpeech('/audio', {}, {
    fetchImpl: async () => { attempts++; throw new TypeError('Failed to fetch'); },
    wait: async () => {},
  }), (error) => error.retryable && !error.message.includes('Failed to fetch'));
  assert.equal(attempts, 3);
});

test('pausing during retry backoff cancels without sending another request', async () => {
  const controller = new AbortController();
  let attempts = 0;
  await assert.rejects(requestSpeech('/audio', { signal: controller.signal }, {
    fetchImpl: async () => { attempts++; throw new TypeError('Failed to fetch'); },
    wait: async () => controller.abort(),
  }), { name: 'AbortError' });
  assert.equal(attempts, 1);
});
