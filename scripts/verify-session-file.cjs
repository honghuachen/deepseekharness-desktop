#!/usr/bin/env node
/** 校验会话 zstd 日志：首帧单行头 + 官方宽度模型的序号连续性 */
const { execFileSync } = require('node:child_process');
const fsSync = require('node:fs');

const file = process.argv[2];
const buf = fsSync.readFileSync(file);

// ── 首帧边界扫描（官方规则移植）──
let off = 4;
if (buf.readUInt32LE(0) !== 0xfd2fb528) throw new Error('bad magic');
{
  const d = buf.readUInt8(off); off += 1;
  const cs = d >>> 6, ss = (d & 32) !== 0, ck = (d & 4) !== 0;
  const db = (d & 3) === 3 ? 4 : (d & 3);
  const cb = cs === 0 ? (ss ? 1 : 0) : 1 << cs;
  off += (ss ? 0 : 1) + db + cb;
  for (;;) {
    if (buf.length - off < 3) throw new Error('torn');
    const bh = buf.readUIntLE(off, 3); off += 3;
    off += ((bh >>> 1) & 3) === 1 ? 1 : (bh >>> 3);
    if ((bh & 1) !== 0) break;
    if (buf.length - off < 0) break;
  }
  if (ck) off += 4;
}
const first = execFileSync('zstd', ['-dc'], { input: buf.subarray(0, off), maxBuffer: 1 << 22 }).toString();
const okFirst = first.endsWith('\n') && !first.slice(0, -1).includes('\n') && first.includes('"session"');
console.log(okFirst ? '✓ 首帧=单行头记录' : `✗ 首帧异常: ${first.slice(0, 80)}`);

// ── 官方宽度模型连续性 ──
const text = execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 28 }).toString();
const lines = text.split('\n');
let c = 0, bad = 0, firstBad = null;
for (let i = 1; i < lines.length; i++) {
  if (!lines[i].trim()) continue;
  let e; try { e = JSON.parse(lines[i]); } catch { continue; }
  const tag = e.type ?? e.kind;
  let w, stored;
  if (tag === 'text-chunks' || tag === 'reasoning-chunks') { w = Math.max(1, (e.data?.texts ?? []).length); stored = e.seq0; }
  else if (tag === 'tool-call-chunks') { w = Math.max(1, (e.data?.args ?? []).length); stored = e.seq0; }
  else { w = 1; stored = e.seq; }
  if (stored !== c) {
    bad++;
    if (!firstBad) firstBad = { line: i + 1, tag, stored, expect: c };
  }
  c += w;
}
console.log(bad === 0 ? `✓ 序号连续（共 ${c} 个逻辑事件）` : `✗ ${bad} 处不连续，首个: 行${firstBad.line} ${firstBad.tag} 存${firstBad.stored} 应${firstBad.expect}`);
process.exitCode = okFirst && bad === 0 ? 0 : 1;
