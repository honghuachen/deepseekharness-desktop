#!/usr/bin/env node
/**
 * kernel-switch.js 无头自测（依赖注入 updater，不碰真实文件系统/网络）：
 *   1) 未安装版本：install → activate 依次调用
 *   2) 已安装版本：install 幂等跳过下载，仍会 activate
 *   3) install 失败：不落盘、不修改 settings.pinnedKernelVersion
 *   4) activate 失败：同上
 *   5) pin=true / pin=false / pin 未传三种场景对 pinnedKernelVersion 的影响
 *   6) onLine 回调优先于工厂级 log 转发给 updater.install
 *
 * 退出码 0=全部通过；非 0=有断言失败。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createKernelSwitcher } = require('../src/main/kernel-switch.js');

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

function makeFixture({ installImpl, activateImpl } = {}) {
  const calls = [];
  const settings = { pinnedKernelVersion: '' };
  const savedSnapshots = [];
  const updater = {
    async install(version, onLine) {
      calls.push({ fn: 'install', version });
      if (installImpl) return installImpl(version, onLine);
      onLine?.(`安装 ${version}`);
    },
    async activate(version) {
      calls.push({ fn: 'activate', version });
      if (activateImpl) return activateImpl(version);
    },
  };
  const saveSettings = (_paths, s) => {
    savedSnapshots.push({ ...s });
  };
  const switcher = createKernelSwitcher({ updater, settings, paths: {}, saveSettings });
  return { switcher, calls, settings, savedSnapshots };
}

async function main() {
  await t('未安装版本：先 install 后 activate，顺序正确', async () => {
    const { switcher, calls } = makeFixture();
    await switcher.switchKernelVersion('0.1.2-rc.1', { pin: true });
    assert.deepEqual(calls, [
      { fn: 'install', version: '0.1.2-rc.1' },
      { fn: 'activate', version: '0.1.2-rc.1' },
    ]);
  });

  await t('已安装版本：install 内部幂等跳过下载，仍照常调用 activate', async () => {
    const { switcher, calls } = makeFixture({
      installImpl: async (version, onLine) => onLine?.('该版本已存在且完整，跳过下载'),
    });
    await switcher.switchKernelVersion('0.1.1-rc.1', { pin: true });
    assert.deepEqual(calls, [
      { fn: 'install', version: '0.1.1-rc.1' },
      { fn: 'activate', version: '0.1.1-rc.1' },
    ]);
  });

  await t('install 失败：不调用 activate，不落盘 settings', async () => {
    const { switcher, calls, settings, savedSnapshots } = makeFixture({
      installImpl: async () => {
        throw new Error('磁盘空间不足');
      },
    });
    settings.pinnedKernelVersion = '0.1.0-alpha.1';
    await assert.rejects(
      () => switcher.switchKernelVersion('0.1.2-rc.1', { pin: true }),
      /磁盘空间不足/,
    );
    assert.deepEqual(calls, [{ fn: 'install', version: '0.1.2-rc.1' }]);
    assert.equal(settings.pinnedKernelVersion, '0.1.0-alpha.1', '失败时不应修改 pinnedKernelVersion');
    assert.equal(savedSnapshots.length, 0, '失败时不应调用 saveSettings');
  });

  await t('activate 失败：不落盘 settings，pinnedKernelVersion 保持切换前的值', async () => {
    const { switcher, calls, settings, savedSnapshots } = makeFixture({
      activateImpl: async () => {
        throw new Error('目标目录不完整');
      },
    });
    settings.pinnedKernelVersion = '0.1.0-alpha.1';
    await assert.rejects(
      () => switcher.switchKernelVersion('0.1.2-rc.1', { pin: true }),
      /目标目录不完整/,
    );
    assert.deepEqual(calls, [
      { fn: 'install', version: '0.1.2-rc.1' },
      { fn: 'activate', version: '0.1.2-rc.1' },
    ]);
    assert.equal(settings.pinnedKernelVersion, '0.1.0-alpha.1');
    assert.equal(savedSnapshots.length, 0);
  });

  await t('pin=true → 落盘 pinnedKernelVersion=目标版本', async () => {
    const { switcher, settings, savedSnapshots } = makeFixture();
    await switcher.switchKernelVersion('0.1.2-rc.1', { pin: true });
    assert.equal(settings.pinnedKernelVersion, '0.1.2-rc.1');
    assert.equal(savedSnapshots.at(-1).pinnedKernelVersion, '0.1.2-rc.1');
  });

  await t('pin=false → 清空 pinnedKernelVersion（"恢复自动跟随"场景）', async () => {
    const { switcher, settings, savedSnapshots } = makeFixture();
    settings.pinnedKernelVersion = '0.1.0-alpha.1';
    await switcher.switchKernelVersion('0.1.2-rc.1', { pin: false });
    assert.equal(settings.pinnedKernelVersion, '');
    assert.equal(savedSnapshots.at(-1).pinnedKernelVersion, '');
  });

  await t('pin 未传（undefined）→ 不改动 pinnedKernelVersion，但仍落盘', async () => {
    const { switcher, settings, savedSnapshots } = makeFixture();
    settings.pinnedKernelVersion = '0.1.0-alpha.1';
    await switcher.switchKernelVersion('0.1.2-rc.1', {});
    assert.equal(settings.pinnedKernelVersion, '0.1.0-alpha.1');
    assert.equal(savedSnapshots.length, 1);
  });

  await t('onLine 回调优先于工厂级 log，转发给 updater.install', async () => {
    const lines = [];
    const { switcher } = makeFixture();
    await switcher.switchKernelVersion('0.1.2-rc.1', { pin: true, onLine: (l) => lines.push(l) });
    assert.deepEqual(lines, ['安装 0.1.2-rc.1']);
  });

  await t('BUILD_ALLOWLIST 包含必要原生构建依赖 (fs-ext, koffi, node-pty 等)', async () => {
    const { BUILD_ALLOWLIST } = require('../src/main/config.js');
    assert(BUILD_ALLOWLIST.includes('fs-ext'), 'fs-ext 必须在 BUILD_ALLOWLIST 中以支持会话持久化');
    assert(BUILD_ALLOWLIST.includes('node-pty'), 'node-pty 必须在 BUILD_ALLOWLIST 中');
    assert(BUILD_ALLOWLIST.includes('koffi'), 'koffi 必须在 BUILD_ALLOWLIST 中');
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
