#!/usr/bin/env node
/**
 * 角标监听器无头测试：
 *   基线不计数 → todo 完成 +1 → 第二项完成再 +1 → goal 完成 +1 → 重写不变不加 → 清零后继续计数
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBadgeWatcher, extractEvents } = require('../src/main/badge.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
function assert(cond, msg) {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed = true;
}

// ── extractEvents 单测 ──
{
  const { todos, goals } = extractEvents(
    [
      JSON.stringify({ type: 'todo/write', seq: 1, data: { todos: [{ content: 'a', status: 'completed' }] } }),
      'not json',
      JSON.stringify({ type: 'goal/change', seq: 2, data: { action: 'complete' } }),
      JSON.stringify({ type: 'goal/change', seq: 3, data: { status: 'blocked', reason: 'x' } }),
      JSON.stringify({ kind: 'todo/write', seq: 4, data: { todos: [{ content: 'b', status: 'pending' }] } }),
    ].join('\n'),
  );
  assert(todos.length === 2 && goals.length === 2, 'extractEvents 识别 todo/write 与 goal/change');
  assert(goals[0].done === true && goals[1].done === false, 'goal 终态判定：complete 计、blocked 不计');
}

// ── 端到端：临时 sessions 树 ──
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-badge-'));
const ws = path.join(root, '--ws1--', 'session-abc1');
await fs.mkdir(ws, { recursive: true });
const logFile = path.join(ws, 'session.jsonl.zstd');

async function writeSession(events) {
  const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  // 用 zstd 压缩，模拟真实布局（.jsonl 直写场景由同一解析器覆盖）
  await new Promise((resolve, reject) => {
    const { spawn } = require('node:child_process');
    const p = spawn('zstd', ['-f', '-o', logFile], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.stdin.end(text);
    p.on('close', resolve);
    p.on('error', reject);
  });
}

let count = -1;
const counts = [];
const watcher = createBadgeWatcher({
  sessionsDir: root,
  log: () => {},
  onCount: (c) => {
    count = c;
    counts.push(c);
  },
});

// 初始：两项待办，其中一项已完成 → 仅建基线
await writeSession([
  { type: 'turn/start', seq: 0 },
  { type: 'todo/write', seq: 1, data: { todos: [{ content: '任务A', status: 'completed' }, { content: '任务B', status: 'pending' }] } },
]);
watcher.start(0);
await wait(1500); // 首轮扫描
assert(count === 0 || count === -1 ? count <= 0 : false, `基线阶段不计历史（count=${count}）`);
assert(counts.every((c) => c === 0), '基线期未触发任何 bump');

// 第二轮：任务B 完成 → +1
await writeSession([
  { type: 'todo/write', seq: 1, data: { todos: [{ content: '任务A', status: 'completed' }, { content: '任务B', status: 'pending' }] } },
  { type: 'todo/write', seq: 2, data: { todos: [{ content: '任务A', status: 'completed' }, { content: '任务B', status: 'completed' }] } },
]);
await wait(4500); // 轮询周期 3s
assert(count === 1, `任务B 完成后 count=1（实际 ${count}）`);

// 第三轮：内容重复重写（同状态）→ 不应重复计数
await writeSession([
  { type: 'todo/write', seq: 2, data: { todos: [{ content: '任务A', status: 'completed' }, { content: '任务B', status: 'completed' }] } },
]);
await wait(4500);
assert(count === 1, `重写相同状态不重复计数（实际 ${count}）`);

// 第四轮：新会话目录出现且 goal 完成 → +1
const ws2 = path.join(root, '--ws2--', 'session-def2');
await fs.mkdir(ws2, { recursive: true });
const text2 =
  JSON.stringify({ type: 'goal/change', seq: 5, data: { action: 'complete' } }) + '\n';
await fs.writeFile(path.join(ws2, 'session.jsonl'), text2);
await wait(4500);
assert(count === 2, `goal 完成后 count=2（实际 ${count}）`);

// 清零后继续计数
watcher.clear();
assert(count === 0, 'clear 归零');

await writeSession([
  { type: 'todo/write', seq: 2, data: { todos: [{ content: '任务A', status: 'completed' }, { content: '任务B', status: 'completed' }] } },
  { type: 'todo/write', seq: 3, data: { todos: [{ content: '任务A', status: 'completed' }, { content: '任务B', status: 'completed' }, { content: '任务C', status: 'completed' }] } },
]);
await wait(4500);
assert(count === 1, `清零后新完成任务C count=1（实际 ${count}）`);

watcher.stop();
console.log(failed ? '\n有失败项' : '\n═══ badge 测试全部通过 ═══');
process.exit(failed ? 1 : 0);
