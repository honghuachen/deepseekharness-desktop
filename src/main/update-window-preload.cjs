'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updateAPI', {
  getState: () => ipcRenderer.invoke('update:get-state'),
  refresh: () => ipcRenderer.invoke('update:refresh'),
  switchKernel: (version, pin) => ipcRenderer.invoke('update:switch-kernel', { version, pin }),
  clearPin: () => ipcRenderer.invoke('update:clear-pin'),
  openExternal: (url) => ipcRenderer.invoke('update:open-external', { url }),
  onInstallLog: (callback) => {
    const listener = (_evt, line) => callback(line);
    ipcRenderer.on('update:install-log', listener);
    return () => ipcRenderer.removeListener('update:install-log', listener);
  },
});
