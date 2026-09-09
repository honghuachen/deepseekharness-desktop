#!/usr/bin/env node
/**
 * shell-auto-updater.js 单元测试：
 * 覆盖：
 *   1) isSupported 平台与打包检测
 *   2) 禁用差量下载 (disableDifferentialDownload=true) 与 WebInstaller
 *   3) 环境变量代理 (HTTPS_PROXY / HTTP_PROXY) 自动同步到 netSession
 *   4) checkAndDownload 生命周期事件流转（update-available、update-not-available、update-downloaded、error、download-progress）
 *   5) quitAndInstall 转发
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createShellAutoUpdater, isSupported } = require('../src/main/shell-auto-updater.js');

let failed = 0;
async function t(name, fn) {
  try {
    await fn();
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failed++;
    process.stdout.write(`  ✗ ${name}\n    ${err.stack || err}\n`);
  }
}

function createMockUpdater() {
  const emitter = new EventEmitter();
  const updater = Object.assign(emitter, {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    disableDifferentialDownload: false,
    disableWebInstaller: false,
    logger: null,
    netSession: {
      proxyConfig: null,
      setProxy(cfg) {
        this.proxyConfig = cfg;
      },
      resolveProxy: async (_url) => 'DIRECT',
    },
    downloadUpdate: async () => {},
    checkForUpdates: async () => {},
    quitAndInstallCalled: false,
    quitAndInstallArgs: null,
    quitAndInstall: (isSilent, isForceRunAfter) => {
      updater.quitAndInstallCalled = true;
      updater.quitAndInstallArgs = [isSilent, isForceRunAfter];
    },
  });
  return updater;
}

async function main() {
  await t('isSupported: 仅在 win32 且打包环境下返回 true', () => {
    assert.equal(isSupported('darwin', { isPackaged: true }), false);
    assert.equal(isSupported('linux', { isPackaged: true }), false);
    assert.equal(isSupported('win32', { isPackaged: false }), false);
    assert.equal(isSupported('win32', { isPackaged: true }), true);
  });

  await t('未支持环境：checkAndDownload 返回 ok: false 错误提示', async () => {
    const su = createShellAutoUpdater({ isSupported: false });
    assert.equal(su.isSupported, false);
    const res = await su.checkAndDownload();
    assert.equal(res.ok, false);
    assert.match(res.error, /不支持/);
  });

  await t('支持环境：强制设置 disableDifferentialDownload=true 及 disableWebInstaller=true', () => {
    const mock = createMockUpdater();
    const su = createShellAutoUpdater({ isSupported: true, updater: mock });
    assert.equal(su.isSupported, true);
    assert.equal(mock.autoDownload, false);
    assert.equal(mock.autoInstallOnAppQuit, false);
    assert.equal(mock.disableDifferentialDownload, true, '必须禁用差量分块下载以防止连接重置');
    assert.equal(mock.disableWebInstaller, true);
  });

  await t('代理同步：若存在 HTTPS_PROXY 环境变量，自动配置 updater.netSession.setProxy', () => {
    const origProxy = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    try {
      const mock = createMockUpdater();
      createShellAutoUpdater({ isSupported: true, updater: mock });
      assert.ok(mock.netSession.proxyConfig);
      assert.equal(mock.netSession.proxyConfig.proxyRules, 'http://127.0.0.1:7890');
    } finally {
      if (origProxy !== undefined) {
        process.env.HTTPS_PROXY = origProxy;
      } else {
        delete process.env.HTTPS_PROXY;
      }
    }
  });

  await t('checkAndDownload: 成功下载流程 (update-available -> downloadUpdate -> update-downloaded)', async () => {
    const mock = createMockUpdater();
    const progressList = [];
    mock.checkForUpdates = async () => {
      process.nextTick(() => {
        mock.emit('update-available', {});
      });
    };
    mock.downloadUpdate = async () => {
      mock.emit('download-progress', { percent: 45.2 });
      process.nextTick(() => {
        mock.emit('download-progress', { percent: 100 });
        mock.emit('update-downloaded', {});
      });
    };

    const su = createShellAutoUpdater({ isSupported: true, updater: mock });
    const res = await su.checkAndDownload((p) => progressList.push(p));

    assert.deepEqual(res, { ok: true });
    assert.deepEqual(progressList, [45, 100]);
  });

  await t('checkAndDownload: 无新版本 (update-not-available)', async () => {
    const mock = createMockUpdater();
    mock.checkForUpdates = async () => {
      process.nextTick(() => {
        mock.emit('update-not-available', {});
      });
    };

    const su = createShellAutoUpdater({ isSupported: true, updater: mock });
    const res = await su.checkAndDownload();

    assert.equal(res.ok, false);
    assert.equal(res.error, '当前已是最新版本');
  });

  await t('checkAndDownload: 网络异常抛错 (error event: net::ERR_CONNECTION_RESET)', async () => {
    const mock = createMockUpdater();
    mock.checkForUpdates = async () => {
      process.nextTick(() => {
        mock.emit('error', new Error('net::ERR_CONNECTION_RESET'));
      });
    };

    const su = createShellAutoUpdater({ isSupported: true, updater: mock });
    const res = await su.checkAndDownload();

    assert.equal(res.ok, false);
    assert.match(res.error, /ERR_CONNECTION_RESET/);
  });

  await t('quitAndInstall: 正确转发到 updater.quitAndInstall 且默认静默安装并自动重启', () => {
    const mock = createMockUpdater();
    const su = createShellAutoUpdater({ isSupported: true, updater: mock });
    assert.equal(mock.quitAndInstallCalled, false);
    su.quitAndInstall();
    assert.equal(mock.quitAndInstallCalled, true);
    assert.deepEqual(mock.quitAndInstallArgs, [true, true]);
  });

  if (failed) {
    process.stdout.write(`\n共 ${failed} 项断言失败\n`);
    process.exit(1);
  }
  process.stdout.write('\n✓ 全部通过\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
