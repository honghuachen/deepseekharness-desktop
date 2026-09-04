'use strict';

/**
 * 「Token 用量统计」窗口：独立 BrowserWindow + IPC，展示 DeepSeek Harness 的用量/费用。
 * 页面每 60 秒自动重新扫盘一次（与 Swift 版本 StatsWindowController 的刷新节奏一致），
 * 窗口关闭时停掉定时器，不在后台空跑。
 */

const { BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');

const { createTokenUsageService } = require('./service');
const { loadPricingCatalog } = require('./pricing');
const dateRange = require('./date-range');
const { aggregate } = require('./aggregator');

const CHANNEL = 'token-usage';
const REFRESH_INTERVAL_MS = 60_000;

let win = null;
let service = null;
let refreshTimer = null;
let ipcRegistered = false;

function rangeFromSpec(spec) {
  const now = new Date();
  switch (spec && spec.rangeKey) {
    case 'yesterday':
      return dateRange.yesterday(now);
    case 'thisWeek':
      return dateRange.thisWeek(now);
    case 'thisMonth':
      return dateRange.thisMonth(now);
    case 'all':
      return dateRange.all(now);
    case 'custom': {
      const start = spec.customStart ? new Date(spec.customStart) : now;
      const end = spec.customEnd ? new Date(spec.customEnd) : now;
      return dateRange.custom(start, end);
    }
    case 'today':
    default:
      return dateRange.today(now);
  }
}

function registerIpcHandlers({ dataRoot, log }) {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle(`${CHANNEL}:reload`, async () => {
    if (!service) return 0;
    const records = await service.reload();
    return records.length;
  });

  ipcMain.handle(`${CHANNEL}:get-aggregate`, (_evt, spec) => {
    if (!service) return null;
    const models = loadPricingCatalog(dataRoot);
    const range = rangeFromSpec(spec);
    return aggregate(service.getRecords(), range, models);
  });

  ipcMain.handle(`${CHANNEL}:open-path`, async (_evt, targetPath) => {
    if (typeof targetPath !== 'string' || !targetPath) return false;
    // `shell.openPath` 从 Electron 8 起是异步的，返回 Promise<string>——
    // resolve 出空字符串才算成功，非空字符串是失败原因，不能当同步字符串判真假。
    const errorMessage = await shell.openPath(targetPath);
    if (errorMessage) log(`[token-usage] 打开目录失败 ${targetPath}: ${errorMessage}`);
    return !errorMessage;
  });
}

function stopRefreshTimer() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function startRefreshTimer() {
  stopRefreshTimer();
  refreshTimer = setInterval(async () => {
    if (!service || !win || win.isDestroyed()) return;
    await service.reload();
    win.webContents.send(`${CHANNEL}:records-updated`);
  }, REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();
}

function openTokenUsageWindow({ dshHome, dataRoot, log = () => {} }) {
  if (!service) {
    service = createTokenUsageService({ dshHome, dataRoot, log });
  }
  registerIpcHandlers({ dataRoot, log });

  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }

  win = new BrowserWindow({
    width: 560,
    height: 640,
    minWidth: 460,
    minHeight: 420,
    title: 'Token 用量统计',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  win.loadFile(path.join(__dirname, 'stats-window.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.once('did-finish-load', async () => {
    await service.reload();
    if (win && !win.isDestroyed()) win.webContents.send(`${CHANNEL}:records-updated`);
  });
  win.on('closed', () => {
    win = null;
    stopRefreshTimer();
  });

  startRefreshTimer();
}

module.exports = { openTokenUsageWindow };
