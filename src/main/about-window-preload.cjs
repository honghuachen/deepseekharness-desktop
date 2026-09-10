'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aboutAPI', {
  getState: () => ipcRenderer.invoke('about:get-state'),
  openExternal: (url) => ipcRenderer.invoke('about:open-external', { url }),
});
