'use strict';

/**
 * 自定义"关于"窗口：替代 Electron 原生 About 面板。
 * 原生面板（macOS setAboutPanelOptions / Windows dialog.showMessageBox）都不支持
 * 在版本信息里放可点击链接，所以用独立 BrowserWindow 展示容器/内核版本，
 * 并可跳转到各自的 GitHub 开源仓库。
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const fsSync = require('node:fs');
const { parseRepoUrl } = require('./plugin-guard');

const rootPkg = require('../../package.json');

let win = null;

/** 读当前激活内核版本目录下 @deepseek-ai/dsh 的 package.json，解析出其 GitHub 仓库地址 */
function getKernelRepoUrl(kernelDir) {
  try {
    const pkgPath = path.join(kernelDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    const pkg = JSON.parse(fsSync.readFileSync(pkgPath, 'utf8'));
    return parseRepoUrl(pkg.repository);
  } catch {
    return null;
  }
}

function registerIpc(context) {
  ipcMain.handle('about:get-state', () => ({
    containerVersion: app.getVersion(),
    kernelVersion: context.activeVersion ? `v${context.activeVersion}` : '未加载',
    containerRepoUrl: parseRepoUrl(rootPkg.repository),
    kernelRepoUrl: context.kernelDir ? getKernelRepoUrl(context.kernelDir) : null,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }));

  ipcMain.handle('about:open-external', (_evt, payload) => {
    const url = payload?.url;
    // 仅放行 GitHub 链接：本窗口的跳转目的只有容器/内核仓库两处，收窄比复用通用 https 白名单更安全
    if (typeof url === 'string' && /^https:\/\/github\.com\//i.test(url)) {
      shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false };
  });

  return () => {
    ipcMain.removeHandler('about:get-state');
    ipcMain.removeHandler('about:open-external');
  };
}

/**
 * @param {object} [context]
 * @param {string|null} [context.activeVersion] 当前激活的内核版本号（不带 v 前缀）
 * @param {string} [context.kernelDir] 该内核版本所在目录，用于读取其 package.json
 */
function openAboutWindow(context = {}) {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return win;
  }

  const unregister = registerIpc(context);

  win = new BrowserWindow({
    width: 340,
    height: 420,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: '关于 DSH Web',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'about-window-preload.cjs'),
    },
  });

  win.loadFile(path.join(__dirname, 'pages', 'about.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
    unregister();
  });
  return win;
}

module.exports = { openAboutWindow };
