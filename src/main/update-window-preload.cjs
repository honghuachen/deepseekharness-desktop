'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updateAPI', {
  getState: () => ipcRenderer.invoke('update:get-state'),
  refresh: () => ipcRenderer.invoke('update:refresh'),
  getShellChangelogs: (opts) => ipcRenderer.invoke('update:get-shell-changelogs', opts),
  getKernelChangelogs: (opts) => ipcRenderer.invoke('update:get-kernel-changelogs', opts),
  switchKernel: (version) => ipcRenderer.invoke('update:switch-kernel', { version }),
  openExternal: (url) => ipcRenderer.invoke('update:open-external', { url }),
  downloadShellUpdate: () => ipcRenderer.invoke('update:shell-download'),
  installShellUpdate: () => ipcRenderer.invoke('update:shell-install'),
  openPluginManager: () => ipcRenderer.invoke('update:open-plugin-manager'),
  onInstallLog: (callback) => {
    const listener = (_evt, line) => callback(line);
    ipcRenderer.on('update:install-log', listener);
    return () => ipcRenderer.removeListener('update:install-log', listener);
  },
  onShellProgress: (callback) => {
    const listener = (_evt, percent) => callback(percent);
    ipcRenderer.on('update:shell-progress', listener);
    return () => ipcRenderer.removeListener('update:shell-progress', listener);
  },
});
