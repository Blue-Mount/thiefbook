// 渲染层与主进程之间的安全桥
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  onConfigChanged: (cb) => ipcRenderer.on('config:changed', (_e, cfg) => cb(cfg)),

  // 书籍缓存
  getBookCache: () => ipcRenderer.invoke('book:getCache'),
  setBookCache: (json) => ipcRenderer.invoke('book:setCache', json),

  // 窗口/菜单
  showMenu: () => ipcRenderer.send('menu:show'),
  openSettings: () => ipcRenderer.send('settings:open'),
  openJump: () => ipcRenderer.send('jump:open'),
  drag: (dx, dy) => ipcRenderer.send('win:drag', { dx, dy }),
  resize: (dx, dy) => ipcRenderer.send('win:resize', { dx, dy }),
  quit: () => ipcRenderer.send('app:quit'),
  closeSelf: () => ipcRenderer.send('window:close'),

  // 章节跳转（跨窗口）
  gotoChapter: (payload) => ipcRenderer.send('reader:goto', payload),
  onGoto: (cb) => ipcRenderer.on('reader:goto', (_e, p) => cb(p)),

  // 老板键相关事件
  onShown: (cb) => ipcRenderer.on('reader:shown', () => cb()),
  onHiding: (cb) => ipcRenderer.on('reader:hiding', () => cb()),
});
