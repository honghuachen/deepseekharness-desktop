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
});
