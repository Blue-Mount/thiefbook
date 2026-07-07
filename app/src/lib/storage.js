// 本地存储封装：设置、同步配置、各书进度、设备标识
const K = {
  settings: 'thiefbook:settings',
  sync: 'thiefbook:sync',
  device: 'thiefbook:device',
  progress: (bookId) => `thiefbook:progress:${bookId}`,
};

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function write(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

export const storage = {
  getSettings: () =>
    read(K.settings, { fontSize: 20, lineHeight: 1.9, theme: 'sepia', letterSpacing: 0 }),
  setSettings: (s) => write(K.settings, s),

  getSync: () => read(K.sync, { serverUrl: '', code: '' }),
  setSync: (s) => write(K.sync, s),

  getProgress: (bookId) => read(K.progress(bookId), null),
  setProgress: (bookId, p) => write(K.progress(bookId), p),

  getDevice() {
    let d = read(K.device, null);
    if (!d) {
      const ua = navigator.userAgent;
      const kind = /Android|iPhone|Mobile/i.test(ua) ? '手机' : '电脑';
      d = `${kind}-${Math.random().toString(36).slice(2, 6)}`;
      write(K.device, d);
    }
    return d;
  },
};
