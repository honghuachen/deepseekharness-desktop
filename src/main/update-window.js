'use strict';

/**
 * 「检查更新」窗口：独立 BrowserWindow + IPC，同时展示容器(壳)更新检测与内核多版本管理。
 * 不直接持有 runner/updater，由 main.js 注入一组回调（见 openUpdateWindow 的 context 参数）。
 */

const { BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fsSync = require('node:fs');

const CHANNEL = 'update';

let win = null; // 单例窗口

function registerIpc(context) {
  const send = (line) => {
    if (win && !win.isDestroyed()) win.webContents.send(`${CHANNEL}:install-log`, line);
  };

  async function collectState() {
    const [shellInfo, kernelInfo] = await Promise.all([
      context.getShellInfo(),
      context.getKernelInfo(),
    ]);
    return { shell: shellInfo, kernel: kernelInfo };
  }

  ipcMain.handle(`${CHANNEL}:get-state`, () => collectState());
  ipcMain.handle(`${CHANNEL}:refresh`, () => collectState());

  ipcMain.handle(`${CHANNEL}:switch-kernel`, async (_evt, payload) => {
    const { version, pin } = payload || {};
    if (typeof version !== 'string' || !version) return { ok: false, error: '缺少版本号' };
    try {
      await context.switchKernelVersion(version, { pin: pin !== false, onLine: send });
      return { ok: true, state: await collectState() };
    } catch (err) {
      context.log?.(`[update-window] 切换内核版本失败：${err.message}`);
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(`${CHANNEL}:clear-pin`, async () => {
    try {
      const kernel = await context.getKernelInfo();
      const target = kernel.latestTag || kernel.activeVersion;
      if (!target) throw new Error('无法确定要跟随的版本');
      await context.switchKernelVersion(target, { pin: false, onLine: send });
      return { ok: true, state: await collectState() };
    } catch (err) {
      context.log?.(`[update-window] 恢复自动跟随失败：${err.message}`);
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle(`${CHANNEL}:open-external`, (_evt, payload) => {
    const url = payload?.url;
    if (typeof url === 'string' && url) context.openExternal(url);
  });

  return () => {
    ipcMain.removeHandler(`${CHANNEL}:get-state`);
    ipcMain.removeHandler(`${CHANNEL}:refresh`);
    ipcMain.removeHandler(`${CHANNEL}:switch-kernel`);
    ipcMain.removeHandler(`${CHANNEL}:clear-pin`);
    ipcMain.removeHandler(`${CHANNEL}:open-external`);
  };
}

/**
 * @param {object} context
 * @param {() => Promise<{currentVersion: string, latest: object|null}>} context.getShellInfo
 * @param {() => Promise<{activeVersion: string|null, pinnedVersion: string, latestTag: string|null, entries: object[]|null}>} context.getKernelInfo
 * @param {(version: string, opts: {pin: boolean, onLine?: Function}) => Promise<void>} context.switchKernelVersion
 * @param {(url: string) => void} context.openExternal
 * @param {Function} [context.log]
 */
function openUpdateWindow(context) {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return win;
  }

  const unregister = registerIpc(context);

  win = new BrowserWindow({
    width: 640,
    height: 720,
    minWidth: 520,
    minHeight: 560,
    title: '检查更新',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'update-window-preload.cjs'),
    },
  });

  win.loadFile(path.join(__dirname, 'pages', 'update.html'));
  win.once('ready-to-show', () => win.show());
  // 开发诊断：DSH_WEB_DEV_UPDATE_DUMP=<路径> 时导出窗口文本
  win.webContents.once('did-finish-load', () => {
    if (!process.env.DSH_WEB_DEV_UPDATE_DUMP) return;
    setTimeout(async () => {
      try {
        const text = await win.webContents.executeJavaScript('document.body.innerText');
        fsSync.writeFileSync(process.env.DSH_WEB_DEV_UPDATE_DUMP, text);
      } catch {}
    }, 4000);
  });
  win.on('closed', () => {
    win = null;
    unregister();
  });

  return win;
}

module.exports = { openUpdateWindow };
