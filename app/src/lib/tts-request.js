function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// Retry the same segment: the server deduplicates generation and caches audio.
export async function requestSpeech(url, options, { fetchImpl = fetch, wait = waitForRetry } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    options.signal?.throwIfAborted();
    try {
      const response = await fetchImpl(url, { ...options,
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)])
          : AbortSignal.timeout(120000) });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const error = new Error(body.error || `语音请求失败（${response.status}）`);
        error.retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
        throw error;
      }
      const blob = await response.blob();
      if (!blob.size) throw new TypeError('Empty audio response');
      return { blob, cost: Number(response.headers.get('X-TTS-Cost-CNY')) || 0 };
    } catch (error) {
      options.signal?.throwIfAborted();
      const retryable = error.retryable === true || error instanceof TypeError || error.name === 'TimeoutError';
      if (!retryable) throw error;
      if (attempt === 2) {
        const failure = new Error('语音连接中断，请检查网络后重试');
        failure.retryable = true;
        throw failure;
      }
      await wait(1000 * (attempt + 1), options.signal);
    }
  }
}
