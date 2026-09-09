'use strict';

/**
 * 容器（壳应用）自动更新：封装 electron-updater 的 autoUpdater。
 *
 * 仅 Windows 支持——mac 端未签名/未公证，Squirrel.Mac 强制要求签名才能自动更新，
 * 继续走 shell-update.js 的"检测 + 引导手动下载"（见 electron-builder.yml 里 mac.identity: null）。
 * Windows 端同样未签名，靠 electron-builder.yml 里 win.verifyUpdateCodeSignature: false
 * 关掉 electron-updater 默认的 Authenticode 校验，否则校验这一步必然失败。
 */

let electronApp = null;
try {
  electronApp = require('electron').app;
} catch {}

let defaultAutoUpdater = null;
function getDefaultAutoUpdater() {
  if (!defaultAutoUpdater) {
    defaultAutoUpdater = require('electron-updater').autoUpdater;
  }
  return defaultAutoUpdater;
}

function isSupported(platform = process.platform, appInstance = electronApp) {
  return platform === 'win32' && !!appInstance?.isPackaged;
}

/**
 * @param {{ log?: Function, updater?: object, isSupported?: boolean }} opts
 * @returns {{
 *   isSupported: boolean,
 *   checkAndDownload: (onProgress?: (percent:number) => void) => Promise<{ok:boolean, error?:string}>,
 *   quitAndInstall: () => void,
 * }}
 */
function createShellAutoUpdater({ log = () => {}, updater = null, isSupported: customIsSupported } = {}) {
  const supported = typeof customIsSupported === 'boolean' ? customIsSupported : isSupported();
  if (!supported) {
    return {
      isSupported: false,
      checkAndDownload: async () => ({ ok: false, error: '当前平台不支持自动安装' }),
      quitAndInstall: () => {},
    };
  }

  const autoUpdater = updater || getDefaultAutoUpdater();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  // 禁用差量分块下载与 WebInstaller：强制单流整包下载。
  // GitHub Releases CDN (objects.githubusercontent.com) 在国内网络和代理环境下，
  // 对密集的 Range 切片请求极易直接重置连接 (net::ERR_CONNECTION_RESET)。
  // 单流整包下载具有更高的穿透能力，且完全受各类 HTTP/SOCKS 代理与加速器支持。
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.disableWebInstaller = true;

  // 同步环境变量代理规则到 updater 的独立 netSession
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    process.env.all_proxy;
  if (envProxy && autoUpdater.netSession?.setProxy) {
    try {
      autoUpdater.netSession.setProxy({ proxyRules: envProxy });
      log(`[shell-updater] 已同步代理规则到更新会话: ${envProxy}`);
    } catch (e) {
      log(`[shell-updater] 设置更新会话代理失败: ${e.message}`);
    }
  }

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
    if (autoUpdater.netSession?.resolveProxy) {
      autoUpdater.netSession
        .resolveProxy('https://github.com')
        .then((proxy) => log(`[shell-updater] 目标代理解析: ${proxy}`))
        .catch(() => {});
    }
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

  function quitAndInstall(isSilent = true, isForceRunAfter = true) {
    autoUpdater.quitAndInstall(isSilent, isForceRunAfter);
  }

  return { isSupported: true, checkAndDownload, quitAndInstall };
}

module.exports = { createShellAutoUpdater, isSupported };
