// 摸鱼看书 · Win11 桌面隐蔽阅读器 —— Electron 主进程
// 一条细长文字混在屏幕里，Alt+P 老板键秒隐/秒现，进度与手机网页端走同一套云同步。
const { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// ---------- 配置持久化（userData/config.json）----------
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');
const BOOK_CACHE = () => path.join(app.getPath('userData'), 'fuhan.json');

function randId() {
  return Math.random().toString(36).slice(2, 6);
}

function defaultConfig() {
  return {
    x: undefined,
    y: undefined,
    width: 1000,
    height: 34,
    locked: false,
    device: `电脑-${randId()}`,
    settings: {
      bg: '#1e1e1e',
      fg: '#7a8290',
      fontSize: 14,
      fontFamily: "Consolas, 'Cascadia Code', 'Microsoft YaHei', monospace",
      lines: 1,
      lineHeight: 1.6,
      opacity: 1,
    },
    sync: { serverUrl: 'http://123.57.90.23:8787', code: '' },
    progress: null, // { chapter, percent, updatedAt, device }
  };
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && base[k]) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

let config = defaultConfig();

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH(), 'utf8');
    config = deepMerge(defaultConfig(), JSON.parse(raw));
  } catch {
    config = defaultConfig();
  }
}
let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2));
    } catch (e) {
      console.error('保存配置失败', e);
    }
  }, 200);
}

// ---------- 窗口 ----------
let reader = null;
let settingsWin = null;
let jumpWin = null;

function readerHeight() {
  // 尺寸由用户拖拽决定，不再随字号联动；字号只影响文字排版
  return Math.max(20, config.height || 34);
}

function applyWindowConfig() {
  if (!reader || reader.isDestroyed()) return;
  const s = config.settings;
  // 不再 setBackgroundColor：窗口保持透明，实色条由渲染层 CSS 画，避免重新引入边框/投影
  reader.setOpacity(Number(s.opacity) || 1);
  reader.setContentSize(config.width, readerHeight());
}

function createReader() {
  const opts = {
    width: config.width,
    height: readerHeight(),
    minWidth: 160,
    minHeight: 20,
    frame: false,
    // transparent 才能真正去掉 Win11 frameless 窗口那圈 DWM 灰边 + 投影；
    // 实色条改由渲染层 CSS 画（body 透明，只有 .reader 画背景色）。
    transparent: true,
    // 关掉系统四边缩放。34px 高的细窗口几乎整条都在系统缩放热区里，
    // 想移动一按就触发缩放 → 窗口越拖越大。改大小改由「设置」里的滑块驱动。
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    useContentSize: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  if (typeof config.x === 'number') opts.x = config.x;
  if (typeof config.y === 'number') opts.y = config.y;

  reader = new BrowserWindow(opts);
  reader.setAlwaysOnTop(true, 'screen-saver');
  reader.setOpacity(Number(config.settings.opacity) || 1);
  reader.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 首次没有坐标：居中偏下（贴近状态栏习惯）
  if (typeof config.x !== 'number') {
    const { workArea } = screen.getPrimaryDisplay();
    const x = Math.round(workArea.x + (workArea.width - config.width) / 2);
    const y = Math.round(workArea.y + workArea.height - readerHeight() - 48);
    reader.setPosition(x, y);
    config.x = x;
    config.y = y;
    saveConfig();
  }

  reader.on('moved', () => {
    const [x, y] = reader.getPosition();
    config.x = x;
    config.y = y;
    saveConfig();
  });

  // 尺寸改由「设置」里的宽/高滑块驱动（config:set → applyWindowConfig 调 setContentSize，
  // 再广播 config:changed 让渲染层按新框重排）。这里不再监听系统 resize。
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 420,
    height: 560,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#252526',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.on('closed', () => (settingsWin = null));
}

function openJump() {
  if (jumpWin && !jumpWin.isDestroyed()) {
    jumpWin.show();
    jumpWin.focus();
    return;
  }
  jumpWin = new BrowserWindow({
    width: 460,
    height: 420,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#252526',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  jumpWin.loadFile(path.join(__dirname, 'renderer', 'jump.html'));
  jumpWin.on('closed', () => (jumpWin = null));
  jumpWin.on('blur', () => {
    if (jumpWin && !jumpWin.isDestroyed()) jumpWin.close();
  });
}

// ---------- 老板键 & 显隐 ----------
function toggleReader() {
  if (!reader || reader.isDestroyed()) return;
  if (reader.isVisible()) {
    reader.webContents.send('reader:hiding'); // 让渲染层先推一次进度
    setTimeout(() => reader.hide(), 60);
  } else {
    reader.show();
    reader.setAlwaysOnTop(true, 'screen-saver');
    reader.webContents.send('reader:shown'); // 恢复时拉一次云端
  }
}

// ---------- 右键菜单（原生，可画到细窗口之外）----------
function showContextMenu() {
  const template = [
    { label: '快速选章节…  (Alt+G)', click: openJump },
    { label: '设置 / 目录…', click: openSettings },
    { type: 'separator' },
    {
      label: config.locked ? '解锁位置' : '锁定位置',
      click: () => {
        config.locked = !config.locked;
        saveConfig();
        if (reader) reader.webContents.send('config:changed', config);
      },
    },
    { label: '隐藏  (Alt+P)', click: toggleReader },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ];
  Menu.buildFromTemplate(template).popup({ window: reader });
}

// ---------- IPC ----------
ipcMain.handle('config:get', () => config);

ipcMain.handle('config:set', (e, patch) => {
  config = deepMerge(config, patch || {});
  saveConfig();
  // 只有外观/尺寸改动才动窗口。进度保存(patch.progress)绝不碰几何——
  // 否则拖动时防抖的进度保存会不停 setContentSize，和拖动叠加导致“越拖越大”。
  if (patch && (patch.width != null || patch.height != null || patch.settings)) {
    applyWindowConfig();
  }
  // 广播给「除发起方之外」的窗口：避免阅读器保存自身进度时被回声，触发无谓重排。
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.webContents.id !== e.sender.id) {
      w.webContents.send('config:changed', config);
    }
  }
  return config;
});

ipcMain.handle('book:getCache', () => {
  try {
    return fs.readFileSync(BOOK_CACHE(), 'utf8');
  } catch {
    return null;
  }
});
ipcMain.handle('book:setCache', (_e, json) => {
  try {
    fs.writeFileSync(BOOK_CACHE(), json);
    return true;
  } catch {
    return false;
  }
});

ipcMain.on('menu:show', showContextMenu);
ipcMain.on('settings:open', openSettings);
ipcMain.on('jump:open', openJump);
ipcMain.on('app:quit', () => app.quit());

ipcMain.on('win:drag', (_e, { dx, dy }) => {
  if (!reader || reader.isDestroyed() || config.locked) return;
  // 只移动、绝不碰尺寸：setPosition 物理上只能改 x/y，无法改宽高，
  // 从根上杜绝“越拖越大”。不再用 setBounds(会带 width/height，DPI 取整会漂)。
  const [x, y] = reader.getPosition();
  const nx = Math.round(x + dx);
  const ny = Math.round(y + dy);
  reader.setPosition(nx, ny);
  config.x = nx;
  config.y = ny;
  saveConfig(); // 已防抖，拖动过程不会频繁写盘
});

// 按住 Alt 拖动 = 改大小（刻意操作，不会误触；普通拖动只移动）。
// 字号不变，改完广播 config:changed 让渲染层按新框重排。
ipcMain.on('win:resize', (_e, { dx, dy }) => {
  if (!reader || reader.isDestroyed() || config.locked) return;
  config.width = Math.max(160, Math.round((config.width || 1000) + dx));
  config.height = Math.max(20, Math.round((config.height || 34) + dy));
  reader.setContentSize(config.width, readerHeight());
  saveConfig();
  reader.webContents.send('config:changed', config);
});

// 从设置/快速选章节窗口跳转 → 转发给阅读器
ipcMain.on('reader:goto', (_e, payload) => {
  if (reader && !reader.isDestroyed()) reader.webContents.send('reader:goto', payload);
});
ipcMain.on('window:close', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed()) w.close();
});

// ---------- 生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (reader) {
      reader.show();
      reader.focus();
    }
  });

  app.whenReady().then(() => {
    loadConfig();
    createReader();
    globalShortcut.register('Alt+P', toggleReader);
    globalShortcut.register('Alt+G', openJump);
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
  // 隐蔽阅读器：关掉细窗口不等于退出的场景不存在（只有 Alt+P 隐藏）；
  // 所有窗口关闭时退出。
  app.on('window-all-closed', () => app.quit());
}
