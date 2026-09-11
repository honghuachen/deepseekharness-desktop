'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pluginAPI', {
  list: () => ipcRenderer.invoke('pm', 'list'),
  remove: (selections) => ipcRenderer.invoke('pm', 'remove', { selections }),
  // 新增：检查更新（不传 profiles 则检查所有 profile）
  checkUpdates: (profiles) => ipcRenderer.invoke('pm', 'checkUpdates', { profiles }),
  // 新增：升级单个第三方依赖
  update: (profile, name, target) =>
    ipcRenderer.invoke('pm', 'update', { profile, name, target }),
  // 新增：一键升级 profile 内多个第三方依赖（串行）
  updateAll: (profile, names) => ipcRenderer.invoke('pm', 'updateAll', { profile, names }),
  // 打开系统外部浏览器链接
  openExternal: (url) => ipcRenderer.invoke('pm', 'openExternal', { url }),
  // 插件市场
  marketList: () => ipcRenderer.invoke('pm', 'marketList'),
  marketRefresh: () => ipcRenderer.invoke('pm', 'marketRefresh'),
  marketInstall: (plugin, profile) => ipcRenderer.invoke('pm', 'marketInstall', { plugin, profile }),
  toggleBundle: (profile, name, enable) => ipcRenderer.invoke('pm', 'toggleBundle', { profile, name, enable }),
  restartService: () => ipcRenderer.invoke('pm', 'restartService'),
  onSwitchTab: (cb) => ipcRenderer.on('pm:switch-tab', (_e, tab) => cb(tab)),
  // 安装/更新进度：{ profile, name (批量操作为 null), resolved, reused, downloaded, added, done }
  onProgress: (cb) => ipcRenderer.on('pm:progress', (_e, data) => cb(data)),
});
