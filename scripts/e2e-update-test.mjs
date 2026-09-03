#!/usr/bin/env node
/**
 * 无头端到端测试：在临时目录里完整走一遍「安装旧版 → 启动 → 检测新版 → 更新 → 再启动」。
 * 不依赖 Electron，直接驱动 src/main 的 updater / runner / semver。
 *
 * 前置：npm run fetch-tools（vendor/pnpm.cjs 就位；node 用系统 PATH）
 */

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { makePaths, BUILD_ALLOWLIST } = require('../src/main/config.js');
const { compareVersions } = require('../src/main/semver.js');
const { createUpdater } = require('../src/main/updater.js');
const { createRunner } = require('../src/main/runner.js');

const OLD_VERSION = '0.1.0-rc.8'; // 故意装一个旧版，验证升级路径
const TEST_PORT = 43971;

function assert(cond, msg) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

async function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const vendorDir = path.resolve('vendor');
  const pnpmCjs = path.join(vendorDir, 'pnpm', 'bin', 'pnpm.cjs');
  if (!fsSync.existsSync(pnpmCjs)) {
    console.error('缺少 vendor/pnpm/bin/pnpm.cjs —— 先运行 npm run fetch-tools -- --no-node');
    process.exit(1);
  }
  const nodeBin = process.execPath.includes('electron') ? 'node' : process.execPath;

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-e2e-'));
  const paths = makePaths(root);
  await fs.mkdir(paths.versionsDir, { recursive: true });

  const lines = [];
  const log = (t) => {
    lines.push(t);
    console.log(`  | ${t}`);
  };

  const updater = createUpdater({ nodeBin, pnpmCjs, paths, log });
  const runner = createRunner({ nodeBin, paths, log });

  // ── 0. semver 单测 ──
  assert(compareVersions('0.1.1-rc.2', '0.1.1-rc.1') > 0, 'semver: rc.2 > rc.1');
  assert(compareVersions('0.1.1', '0.1.1-rc.2') > 0, 'semver: 正式版 > 预发布');
  assert(compareVersions('0.2.0', '0.1.9-rc.99') > 0, 'semver: 0.2.0 > 0.1.9-rc.99');
  assert(compareVersions('1.0.0', 'v1.0.0') === 0, 'semver: v 前缀归一');

  // ── 1. 安装旧版并激活 ──
  console.log(`\n[1] 安装旧版 ${OLD_VERSION} …`);
  await updater.install(OLD_VERSION, log);
  await updater.activate(OLD_VERSION);
  assert(
    (await updater.getCurrentVersion()) === OLD_VERSION,
    `current 指向 ${OLD_VERSION}`,
  );

  // ── 2. 用旧版启动服务 → 健康检查 → 停止（隔离 HOME：旧版可能读不了新版凭据格式）──
  console.log('\n[2] 启动旧版 web 服务 …');
  const envOverride = { DSH_HOME: path.join(root, 'dsh-home') };
  const boot1 = await runner.start(OLD_VERSION, TEST_PORT, { isFirstBoot: true, envOverride });
  const res1 = await fetch(`${boot1.url}/`);
  assert(res1.status < 500, `旧版服务可访问 (HTTP ${res1.status})`);
  await runner.stop();
  assert(!runner.isRunning(), '服务已停止');

  // ── 3. 检测最新版 → 应大于旧版 → 升级 → 原子切换 ──
  console.log('\n[3] 检测 registry 最新版 …');
  const latest = await updater.getLatestVersion();
  assert(!!latest, `registry 可达，latest=${latest ?? 'null'}`);
  assert(compareVersions(latest, OLD_VERSION) > 0, `${latest} > ${OLD_VERSION}`);

  console.log(`\n[4] 升级到 ${latest} …`);
  await updater.install(latest, log);
  await updater.activate(latest);
  assert((await updater.getCurrentVersion()) === latest, `current 切换到 ${latest}`);

  // ── 5. 新版本再启动 ──
  console.log('\n[5] 启动新版 web 服务 …');
  const boot2 = await runner.start(latest, TEST_PORT + 1, { envOverride });
  const res2 = await fetch(`${boot2.url}/`);
  assert(res2.status < 500, `新版服务可访问 (HTTP ${res2.status})`);
  await runner.stop();

  // ── 6. 清理策略 ──
  await updater.prune(2, latest);
  const kept = (await fs.readdir(paths.versionsDir)).sort();
  assert(kept.length <= 2, `prune 后仅保留 ≤2 个版本: [${kept.join(', ')}]`);

  console.log('\n════ E2E 全部通过 ════');
  console.log(`测试目录（保留供排查）: ${root}`);
  await runner.stop().catch(() => {});
}

main().catch(async (err) => {
  console.error('\nE2E 失败:', err.stack || err);
  process.exit(1);
});
