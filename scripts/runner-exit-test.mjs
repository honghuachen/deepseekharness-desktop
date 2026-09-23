#!/usr/bin/env node
/**
 * Runner 退出通知测试：
 * 1. 已就绪的内核意外崩溃 → onExit 监听触发（驱动 main.js 自动重启）
 * 2. stop() 主动停止 → 不触发
 * 3. 启动期即退出 → start() 抛错，不触发（避免与调用方错误处理重复重启）
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createRunner } = require('../src/main/runner.js');

let failed = false;
function assert(cond, msg) {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed = true;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runner-exit-'));
const binDir = path.join(root, 'v1', 'node_modules/@deepseek-ai/dsh/lib');
fs.mkdirSync(binDir, { recursive: true });
// 假内核：监听 --port 打印授权地址；FAKE_MODE=crash-later 就绪后自行崩溃，early-exit 启动即退出
fs.writeFileSync(
  path.join(binDir, 'bin.js'),
  `const mode = process.env.FAKE_MODE;
if (mode === 'early-exit') process.exit(3);
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
require('node:net').createServer().listen(port, '127.0.0.1', () => {
  console.log('dsh web: http://127.0.0.1:' + port + '/?token=fake');
  if (mode === 'crash-later') setTimeout(() => process.exit(7), 300);
});
process.on('SIGTERM', () => process.exit(0));`,
);
const paths = { rootDir: root, versionDir: () => path.join(root, 'v1') };
const port = () => 44100 + Math.floor(Math.random() * 300);

function waitExitEvent(runner, ms) {
  return new Promise((resolve) => {
    const off = runner.onExit((info) => {
      off();
      clearTimeout(timer);
      resolve(info);
    });
    const timer = setTimeout(() => {
      off();
      resolve(null);
    }, ms);
  });
}

console.log('=== Runner 退出通知测试 ===');
{
  const runner = createRunner({ nodeBin: process.execPath, paths });
  await runner.start('1', port(), { envOverride: { FAKE_MODE: 'crash-later' } });
  const info = await waitExitEvent(runner, 3000);
  assert(info && info.code === 7, `就绪后崩溃 → onExit 触发 (code=${info?.code})`);
  assert(!runner.isRunning(), '崩溃后 isRunning() 为 false');
}
{
  const runner = createRunner({ nodeBin: process.execPath, paths });
  await runner.start('1', port(), { envOverride: { FAKE_MODE: 'stay' } });
  const pending = waitExitEvent(runner, 1500);
  await runner.stop();
  assert((await pending) === null, 'stop() 主动停止 → onExit 不触发');
  // 同一 runner 可再次启动，且新进程崩溃仍能通知
  await runner.start('1', port(), { envOverride: { FAKE_MODE: 'crash-later' } });
  const info = await waitExitEvent(runner, 3000);
  assert(info && info.code === 7, 'stop 后重新启动的内核崩溃 → onExit 仍触发');
}
{
  const runner = createRunner({ nodeBin: process.execPath, paths });
  const pending = waitExitEvent(runner, 1500);
  let threw = false;
  try {
    await runner.start('1', port(), { envOverride: { FAKE_MODE: 'early-exit' } });
  } catch {
    threw = true;
  }
  assert(threw, '启动期退出 → start() 抛错');
  assert((await pending) === null, '启动期退出 → onExit 不触发');
}

fs.rmSync(root, { recursive: true, force: true });
if (failed) {
  console.error('\n❌ 测试未完全通过');
  process.exit(1);
} else {
  console.log('\n🎉 Runner 退出通知测试全部通过！');
}
