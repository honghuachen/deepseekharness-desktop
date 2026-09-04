'use strict';

/**
 * 容器（壳应用）自动更新：封装 electron-updater 的 autoUpdater。
 *
 * 仅 Windows 支持——mac 端未签名/未公证，Squirrel.Mac 强制要求签名才能自动更新，
 * 继续走 shell-update.js 的"检测 + 引导手动下载"（见 electron-builder.yml 里 mac.identity: null）。
 * Windows 端同样未签名，靠 electron-builder.yml 里 win.verifyUpdateCodeSignature: false
 * 关掉 electron-updater 默认的 Authenticode 校验，否则校验这一步必然失败。
 */

const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

function isSupported() {
  return process.platform === 'win32' && app.isPackaged;
}

/**
 * @param {{ log?: Function }} opts
 * @returns {{
 *   isSupported: boolean,
 *   checkAndDownload: (onProgress?: (percent:number) => void) => Promise<{ok:boolean, error?:string}>,
 *   quitAndInstall: () => void,
 * }}
 */
function createShellAutoUpdater({ log = () => {} } = {}) {
  const supported = isSupported();
  if (!supported) {
    return {
      isSupported: false,
      checkAndDownload: async () => ({ ok: false, error: '当前平台不支持自动安装' }),
      quitAndInstall: () => {},
    };
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = {
    info: (m) => log(`[shell-updater] ${m}`),
    warn: (m) => log(`[shell-updater] ${m}`),
    error: (m) => log(`[shell-updater] ${m}`),
    debug: () => {},
  };

  let currentOnProgress = () => {};
  autoUpdater.on('download-progress', (p) => currentOnProgress(Math.round(p.percent)));

  function checkAndDownload(onProgress = () => {}) {
    currentOnProgress = onProgress;
    return new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        autoUpdater.removeListener('update-available', onAvailable);
        autoUpdater.removeListener('update-not-available', onNotAvailable);
        autoUpdater.removeListener('update-downloaded', onDownloaded);
        autoUpdater.removeListener('error', onError);
        currentOnProgress = () => {};
      };
      const done = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onAvailable = () => {
        autoUpdater.downloadUpdate().catch((err) => done({ ok: false, error: String(err.message || err) }));
      };
      const onNotAvailable = () => done({ ok: false, error: '当前已是最新版本' });
      const onDownloaded = () => done({ ok: true });
      const onError = (err) => done({ ok: false, error: String(err?.message || err) });

      autoUpdater.on('update-available', onAvailable);
      autoUpdater.on('update-not-available', onNotAvailable);
      autoUpdater.on('update-downloaded', onDownloaded);
      autoUpdater.on('error', onError);
      autoUpdater.checkForUpdates().catch((err) => done({ ok: false, error: String(err.message || err) }));
    });
  }

  function quitAndInstall() {
    autoUpdater.quitAndInstall();
  }

  return { isSupported: true, checkAndDownload, quitAndInstall };
}

module.exports = { createShellAutoUpdater, isSupported };
