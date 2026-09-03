#!/usr/bin/env node
/**
 * 会话日志修复（最终版，基于官方加载器语义）：
 *
 * 官方模型（dsh-session-persistence-jsonl + dsh-session）：
 *   - 第 1 行为 session 头记录，不参与编号；
 *   - 每行是一条「存储记录」，解码后展开成若干逻辑事件：
 *       · text/reasoning/tool-call-chunks → 展开 data.texts/args.length 个事件，
 *         各自 seq = seq0 + k（存储的 seq0 被直接采用）；
 *       · 其余记录 → 单事件，seq = 存储的 seq；
 *   - 加载器要求全部逻辑事件的 seq 从 0 开始严格连续。
 *
 * 修复 = 按上述宽度规则重扫全文件，把每条记录的 seq/seq0 改写为其累计起始序号。
 * 布局：修复结果写回时保持「首帧=头记录单帧 + 其余分帧」的 zstd 多帧结构。
 *
 * 用法：node scripts/repair-session.mjs <session.jsonl[.zstd]> [...]
 */

import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import path from 'node:path';

const CHUNK_TAGS = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks']);

function readText(file) {
  if (file.endsWith('.zstd')) {
    return execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 28 }).toString('utf8');
  }
  return fsSync.readFileSync(file, 'utf8');
}

function compressFrames(text) {
  // 首帧 = 头记录单独一帧；其余每 500 行一帧
  const nl = text.indexOf('\n') + 1;
  const header = text.slice(0, nl);
  const rest = text.slice(nl);
  const parts = [execFileSync('zstd', ['-c', '-q'], { input: Buffer.from(header), maxBuffer: 1 << 22 })];
  if (rest.length > 0) {
    parts.push(execFileSync('zstd', ['-c', '-q'], { input: Buffer.from(rest), maxBuffer: 1 << 28 }));
  }
  return Buffer.concat(parts);
}

/** 按官方语义重编所有记录的序号。返回新文本与改写统计 */
function renumber(text) {
  const lines = text.split('\n');
  let c = 0; // 下一个逻辑事件的绝对序号
  let fixed = 0;
  const out = lines.map((line, idx) => {
    if (!line.trim()) return line;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return line;
    }
    if (idx === 0) return line; // header

    const tag = e.type ?? e.kind;
    if (CHUNK_TAGS.has(tag)) {
      const members =
        tag === 'tool-call-chunks' ? (e.data?.args ?? []) : (e.data?.texts ?? []);
      const width = Math.max(1, members.length);
      if (e.seq0 !== c) {
        e.seq0 = c;
        fixed += 1;
      }
      delete e.seq; // chunk 行不应携带单值 seq
      c += width;
      return JSON.stringify(e);
    }

    // 单事件透传记录
    if (e.seq !== c) {
      e.seq = c;
      fixed += 1;
    }
    delete e.seq0;
    c += 1;
    return JSON.stringify(e);
  });
  return { text: out.join('\n'), fixed, totalEvents: c };
}

function writeBack(file, newText) {
  const backupDir = path.join(path.dirname(file), `.repair-backup-${Date.now()}`);
  fsSync.mkdirSync(backupDir, { recursive: true });
  fsSync.copyFileSync(file, path.join(backupDir, path.basename(file)));

  const tmpZ = `${file}.repair-tmp`;
  fsSync.writeFileSync(tmpZ, compressFrames(newText));
  const target = file.endsWith('.zstd') ? file : `${file}.zstd`;
  fsSync.renameSync(tmpZ, target);
  if (target !== file && file.endsWith('.jsonl')) fsSync.rmSync(file, { force: true });

  // 明文副本供人工核对（隐藏目录内）
  fsSync.writeFileSync(path.join(backupDir, 'repaired.jsonl'), newText);
  return path.join(path.basename(backupDir), path.basename(target));
}

for (const file of process.argv.slice(2)) {
  if (!fsSync.existsSync(file)) {
    console.error(`✗ 文件不存在: ${file}`);
    process.exitCode = 1;
    continue;
  }
  const original = readText(file);
  const { text, fixed, totalEvents } = renumber(original);
  if (fixed === 0) {
    console.log(`✓ ${path.basename(path.dirname(file))}: 序号已合规（${totalEvents} 个逻辑事件），无需修复`);
    continue;
  }
  const where = writeBack(file, text);
  console.log(
    `✓ ${path.basename(path.dirname(file))}: 重编 ${fixed} 条记录；共 ${totalEvents} 个逻辑事件；备份 ${where}`,
  );
}
