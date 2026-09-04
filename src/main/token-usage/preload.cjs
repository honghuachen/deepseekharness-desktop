'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tokenUsageAPI', {
  reload: () => ipcRenderer.invoke('token-usage:reload'),
  getAggregate: (spec) => ipcRenderer.invoke('token-usage:get-aggregate', spec),
  openPath: (targetPath) => ipcRenderer.invoke('token-usage:open-path', targetPath),
  onRecordsUpdated: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('token-usage:records-updated', listener);
    return () => ipcRenderer.removeListener('token-usage:records-updated', listener);
  },
});
