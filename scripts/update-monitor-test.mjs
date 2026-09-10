#!/usr/bin/env node
/**
 * update-monitor.js 无头单测：
 *   1) computeUpdateOverview 组合判定（壳有/无、内核有/无、版本比对、null 容错）
 *   2) createUpdateMonitor 轮询、并发防抖与 onStatusChange 回调
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  computeUpdateOverview,
  createUpdateMonitor,
} = require('../src/main/update-monitor.js');

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

async function main() {
  process.stdout.write('computeUpdateOverview:\n');

  await t('两者均无更新 → hasUpdate=false', async () => {
    const res = computeUpdateOverview({
      currentShellVersion: '1.6.1',
      shellInfo: { latestTag: '1.6.1', hasUpdate: false },
      activeKernelVersion: '0.1.5-rc.1',
      kernelLatestTag: '0.1.5-rc.1',
    });
    assert.equal(res.hasUpdate, false);
    assert.equal(res.shell.hasUpdate, false);
    assert.equal(res.kernel.hasUpdate, false);
  });

  await t('仅壳有更新 → hasUpdate=true', async () => {
    const res = computeUpdateOverview({
      currentShellVersion: '1.6.0',
      shellInfo: { latestTag: '1.6.1', hasUpdate: true },
      activeKernelVersion: '0.1.5-rc.1',
      kernelLatestTag: '0.1.5-rc.1',
    });
    assert.equal(res.hasUpdate, true);
    assert.equal(res.shell.hasUpdate, true);
    assert.equal(res.kernel.hasUpdate, false);
  });

  await t('仅内核有更新 → hasUpdate=true', async () => {
    const res = computeUpdateOverview({
      currentShellVersion: '1.6.1',
      shellInfo: { latestTag: '1.6.1', hasUpdate: false },
      activeKernelVersion: '0.1.4-rc.1',
      kernelLatestTag: '0.1.5-rc.1',
    });
    assert.equal(res.hasUpdate, true);
    assert.equal(res.shell.hasUpdate, false);
    assert.equal(res.kernel.hasUpdate, true);
  });

  await t('壳与内核均有更新 → hasUpdate=true', async () => {
    const res = computeUpdateOverview({
      currentShellVersion: '1.5.0',
      shellInfo: { latestTag: '1.6.1', hasUpdate: true },
      activeKernelVersion: '0.1.2-rc.1',
      kernelLatestTag: '0.1.5-rc.1',
    });
    assert.equal(res.hasUpdate, true);
    assert.equal(res.shell.hasUpdate, true);
    assert.equal(res.kernel.hasUpdate, true);
  });

  await t('shellInfo 为 null（离线/失败）容错 → 壳视为无更新', async () => {
    const res = computeUpdateOverview({
      currentShellVersion: '1.6.1',
      shellInfo: null,
      activeKernelVersion: '0.1.4',
      kernelLatestTag: '0.1.5',
    });
    assert.equal(res.hasUpdate, true);
    assert.equal(res.shell.hasUpdate, false);
    assert.equal(res.kernel.hasUpdate, true);
  });

  await t('仅插件有更新（壳/内核均最新）→ hasUpdate=true', async () => {
    const res = computeUpdateOverview({
      currentShellVersion: '1.6.1',
      shellInfo: { latestTag: '1.6.1', hasUpdate: false },
      activeKernelVersion: '0.1.5-rc.1',
      kernelLatestTag: '0.1.5-rc.1',
      pluginsInfo: { hasUpdate: true, count: 2 },
    });
    assert.equal(res.hasUpdate, true);
    assert.equal(res.shell.hasUpdate, false);
    assert.equal(res.kernel.hasUpdate, false);
    assert.equal(res.plugins.hasUpdate, true);
    assert.equal(res.plugins.count, 2);
  });

  await t('pluginsInfo 未传（未开启插件检测）→ plugins 视为无更新', async () => {
    const res = computeUpdateOverview({
      currentShellVersion: '1.6.1',
      shellInfo: { latestTag: '1.6.1', hasUpdate: false },
      activeKernelVersion: '0.1.5-rc.1',
      kernelLatestTag: '0.1.5-rc.1',
    });
    assert.equal(res.hasUpdate, false);
    assert.equal(res.plugins.hasUpdate, false);
    assert.equal(res.plugins.count, 0);
  });

  process.stdout.write('createUpdateMonitor:\n');

  await t('checkNow 状态变化触发 onStatusChange，并发调用防抖合并', async () => {
    let callCount = 0;
    const notifications = [];
    const monitor = createUpdateMonitor({
      getShellInfo: async () => {
        callCount++;
        return { currentVersion: '1.6.0', latest: { latestTag: '1.6.1', hasUpdate: true } };
      },
      getKernelInfo: async () => {
        return { activeVersion: '0.1.5-rc.1', latestTag: '0.1.5-rc.1' };
      },
      onStatusChange: (status) => {
        notifications.push(status);
      },
    });

    // 并发两个 checkNow，应当只调用一次 getShellInfo
    const [s1, s2] = await Promise.all([monitor.checkNow(), monitor.checkNow()]);
    assert.equal(s1, s2);
    assert.equal(callCount, 1);
    assert.equal(s1.hasUpdate, true);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].hasUpdate, true);

    // 再次调用无变化时，不重复通知
    await monitor.checkNow();
    assert.equal(notifications.length, 1);

    monitor.stop();
  });

  await t('getPluginsInfo 提供插件更新汇总 → 参与综合判定并写入 status.plugins', async () => {
    const monitor = createUpdateMonitor({
      getShellInfo: async () => ({ currentVersion: '1.6.1', latest: { latestTag: '1.6.1', hasUpdate: false } }),
      getKernelInfo: async () => ({ activeVersion: '0.1.5-rc.1', latestTag: '0.1.5-rc.1' }),
      getPluginsInfo: () => ({ hasUpdate: true, count: 3 }),
    });

    const status = await monitor.checkNow();
    assert.equal(status.hasUpdate, true);
    assert.equal(status.shell.hasUpdate, false);
    assert.equal(status.kernel.hasUpdate, false);
    assert.equal(status.plugins.hasUpdate, true);
    assert.equal(status.plugins.count, 3);

    monitor.stop();
  });

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
