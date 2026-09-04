#!/usr/bin/env node
'use strict';

/**
 * DeepSeek Harness token 用量统计模块的手工回归测试（对齐仓库里其它 scripts/*.mjs
 * 的风格，不依赖 jest）：
 *   1. 用合成的 session/request-context/assistant-message jsonl 跑 parser + dedup +
 *      aggregator，断言 token 总量、按模型分组、费用估算符合预期。
 *   2. 若本机存在真实的 ~/.dsh/sessions/**\/session.jsonl.zstd 且系统装了 zstd，
 *      用 fzstd 解压和 `zstd -dc` 的输出做逐字节比对，防止未来升级 fzstd 引入解压
 *      差异回归。
 *
 * 用法：node scripts/test-token-usage.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseSessionText } from '../src/main/token-usage/parser.js';
import { deduplicate } from '../src/main/token-usage/dedup.js';
import { aggregate } from '../src/main/token-usage/aggregator.js';
import { contains, today } from '../src/main/token-usage/date-range.js';
import { readSessionText } from '../src/main/token-usage/decompress.js';
import { findSessionFiles } from '../src/main/token-usage/scanner.js';

let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${err.message}`);
  }
}

// ── 1. 合成数据：parser + dedup + aggregator ──────────────────────────

function line(obj) {
  return JSON.stringify(obj);
}

const now = Date.now();
const synthetic = [
  line({ type: 'session', version: 0, id: 'session-abc', createdAt: now, cwd: '/tmp/dsh-test-project' }),
  line({ type: 'request/context', seq: 1, time: now, data: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }),
  // 一次请求的两条流式快照，后一条 token 数更大——去重应保留后一条
  line({
    type: 'assistant/message',
    seq: 2,
    time: now + 1000,
    data: { usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 10 } },
  }),
  line({
    type: 'assistant/message',
    seq: 2,
    time: now + 1000,
    data: { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 } },
  }),
  // 切到另一个模型
  line({ type: 'request/context', seq: 3, time: now + 2000, data: { provider: 'openrouter', model: 'some/unknown-model' } }),
  line({
    type: 'assistant/message',
    seq: 4,
    time: now + 3000,
    data: { usage: { inputTokens: 200, outputTokens: 20, reasoningTokens: 30, cacheReadTokens: 0 } },
  }),
  '', // 空行应被忽略
  'not json', // 坏行应被跳过而不是抛异常
];

await check('parser 提取出正确数量的记录，坏行/空行被跳过', () => {
  const records = parseSessionText(synthetic.join('\n'));
  assert.equal(records.length, 3);
  assert.equal(records[0].model, 'deepseek-v4-flash');
  assert.equal(records[0].cwd, '/tmp/dsh-test-project');
  assert.equal(records[2].model, 'some/unknown-model');
  assert.equal(records[2].reasoningTokens, 30);
});

await check('dedup 按 requestId 保留 token 总量更大的那条快照', () => {
  const records = parseSessionText(synthetic.join('\n'));
  const deduped = deduplicate(records);
  assert.equal(deduped.length, 2); // seq=2 的两条快照被折叠成 1 条
  const seq2 = deduped.find((r) => r.requestId === 'session-abc:2');
  assert.equal(seq2.outputTokens, 50);
});

await check('aggregate 按项目/模型/会话分组，且未知模型显示未知定价', () => {
  const records = deduplicate(parseSessionText(synthetic.join('\n')));
  const range = { start: null, end: now + 10_000 };
  const models = {
    'deepseek-v4-flash': {
      input_per_million_usd: 0.22,
      output_per_million_usd: 0.66,
      cache_read_per_million_usd: 0.007,
      cache_write_per_million_usd: 0,
    },
  };
  const result = aggregate(records, range, models);

  assert.equal(result.byProject.length, 1);
  assert.equal(result.byProject[0].cwd, '/tmp/dsh-test-project');

  assert.equal(result.byModel.length, 2);
  const known = result.byModel.find((m) => m.model === 'deepseek-v4-flash');
  const unknown = result.byModel.find((m) => m.model === 'some/unknown-model');
  assert.ok(known.estimatedCostUSD > 0, 'known 模型应该有非零估算费用');
  assert.equal(unknown.estimatedCostUSD, null, '未知模型的费用应为 null，而不是误报 0');

  assert.equal(result.includesUnknownPricedModels, true);
  assert.equal(result.bySession.length, 1);
  assert.equal(result.bySession[0].sessionId, 'session-abc');
});

await check('date-range 双端闭区间语义正确', () => {
  const range = { start: now, end: now + 1000 };
  assert.equal(contains(range, now), true);
  assert.equal(contains(range, now + 1000), true);
  assert.equal(contains(range, now - 1), false);
  assert.equal(contains(range, now + 1001), false);
  const t = today();
  assert.equal(t.start <= Date.now() && t.end >= t.start, true);
});

// ── 2. 真实文件回归：fzstd 解压结果需与系统 zstd 逐字节一致 ──────────────

async function findAnyRealSessionFile() {
  const root = path.join(os.homedir(), '.dsh', 'sessions');
  if (!fs.existsSync(root)) return null;
  const files = await findSessionFiles(root);
  return files.find((f) => f.endsWith('.zstd')) || null;
}

function systemZstdAvailable() {
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const realFile = await findAnyRealSessionFile();
if (realFile && systemZstdAvailable()) {
  const ref = execFileSync('zstd', ['-dc', realFile], { maxBuffer: 1 << 29 }).toString('utf8');

  await check(`readSessionText() 解压结果与系统 zstd -dc 逐字节一致（${path.basename(path.dirname(realFile))}）`, async () => {
    // 本机装了 zstd 时 readSessionText 会优先走系统 zstd 那条路径。
    const actual = await readSessionText(realFile);
    assert.equal(actual, ref);
  });

  await check('纯 JS fzstd 兜底路径（模拟没有系统 zstd 的机器，如 Windows）解压结果也逐字节一致', async () => {
    // 直接调用 fzstd，绕开 readSessionText 对系统 zstd 的优先选择——这是没装 zstd 的
    // 机器（典型是 Windows）实际会走的那条路径，必须单独验证，不能假设"系统 zstd 能跑
    // 就等于两条路径都对"。
    const { decompress } = await import('fzstd');
    const buffer = fs.readFileSync(realFile);
    const actual = Buffer.from(decompress(buffer)).toString('utf8');
    assert.equal(actual, ref);
  });
} else {
  console.log('  skip 真实文件解压回归（本机没有 ~/.dsh/sessions 下的 .zstd 文件，或未安装系统 zstd 用于比对）');
}

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);
