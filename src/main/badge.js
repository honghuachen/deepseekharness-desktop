'use strict';

/**
 * 任务完成角标：监听 $DSH_HOME/sessions 全树，
 * 从会话日志的 todo/write 与 goal/change 事件中识别「新完成任务」。
 *
 * 计数规则：
 *   - 某个 todo 条目从非 completed 变为 completed → +1
 *   - goal/change 事件携带 complete/completed 终态 → +1
 *   - 每个文件第一次观察到时只建立基线，历史不计入
 *
 * 纯 node 实现（DI 注入目录），Electron 层只负责把计数画到 Dock 角标。
 */

const fsSync = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SESSION_FILE_RE } = require('./token-usage/scanner');

const POLL_INTERVAL_MS = 3000;

/** 解压 zstd 会话日志为文本；普通 jsonl 直接读取 */
function readSessionText(file) {
  if (file.endsWith('.zstd')) {
    const p = spawn('zstd', ['-dc', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    return new Promise((resolve) => {
      const chunks = [];
      p.stdout.on('data', (c) => chunks.push(c));
      p.on('error', () => resolve(''));
      p.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }
  return fsPromises.readFile(file, 'utf8').catch(() => '');
}

/**
 * 从一段会话文本里提取感兴趣的事件。
 * @returns {{todos: Array<{seq:number, todos:Array<{content:string,status:string}>}>, goals: Array<{seq:number, done:boolean}>}}
 */
function extractEvents(text) {
  const todos = [];
  const goals = [];
  for (const line of text.split('\n')) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const type = e.type ?? e.kind;
    const seq = typeof e.seq === 'number' ? e.seq : 0;
    if (type === 'todo/write' && Array.isArray(e.data?.todos)) {
      todos.push({
        seq,
        todos: e.data.todos.map((t) => ({
          content: String(t.content ?? ''),
          status: String(t.status ?? ''),
        })),
      });
    } else if (type === 'goal/change') {
      const flat = JSON.stringify(e.data ?? e);
      // 终态判定：complete/completed/goal-completed；blocked 不算完成
      const done = /"(?:action|status|phase)"\s*:\s*"(?:complete[ds]?|goal-completed)"/.test(flat);
      goals.push({ seq, done });
    }
  }
  return { todos, goals };
}

function createBadgeWatcher({ sessionsDir, log = () => {}, onCount }) {
  /** @type {Map<string, {mtimeMs:number, todoDone:Set<string>, goalSeen:number}>} */
  const known = new Map();
  let timer = null;
  let stopped = false;
  let unacked = 0;
  let baselineDone = false; // 首轮全扫后置真；此后新发现的文件按「运行中会话」从零计数

  function bump(n) {
    if (!n) return;
    unacked += n;
    try {
      onCount(unacked);
    } catch {}
  }

  async function scanFile(file) {
    let stat;
    try {
      stat = await fsPromises.stat(file);
    } catch {
      return;
    }
    const prev = known.get(file);
    if (prev && prev.mtimeMs === stat.mtimeMs) return; // 未变化

    const text = await readSessionText(file);
    if (stopped) return;
    const { todos, goals } = extractEvents(text);

    // 首次见到该文件：
    //   启动基线阶段 → 只记录现状，历史不计数；
    //   运行中新出现 → 视为活跃会话，从零开始计
    if (!prev) {
      if (!baselineDone) {
        const doneSet = new Set();
        for (const t of todos) {
          for (const item of t.todos) {
            if (item.status === 'completed') doneSet.add(item.content);
          }
        }
        const maxGoalSeq = goals.reduce((m, g) => Math.max(m, g.seq), -1);
        known.set(file, { mtimeMs: stat.mtimeMs, todoDone: doneSet, goalSeen: maxGoalSeq });
        return;
      }
      return scanIncrement(file, stat.mtimeMs, todos, goals, { todoDone: new Set(), goalSeen: -1 });
    }
    return scanIncrement(file, stat.mtimeMs, todos, goals, prev);
  }

  /** 与既有基线对比，计算新增完成数 */
  async function scanIncrement(file, mtimeMs, todos, goals, prev) {
    // 增量：todo 新完成数（content -> status，重复内容以最后一次为准）
    let delta = 0;
    const latest = new Map();
    for (const t of todos) {
      for (const item of t.todos) latest.set(item.content, item.status);
    }
    for (const [content, status] of latest) {
      if (status === 'completed' && !prev.todoDone.has(content)) delta += 1;
    }

    // 增量：goal 完成（按 seq 推进水位，避免重复计数）
    const maxGoalSeq = goals.reduce((m, g) => Math.max(m, g.seq), prev.goalSeen);
    for (const g of goals) {
      if (g.done && g.seq > prev.goalSeen) delta += 1;
    }

    // 更新基线状态：已完成集合取最新快照 ∪ 旧集合（防抖动）
    const mergedDone = new Set(prev.todoDone);
    for (const [content, status] of latest) {
      if (status === 'completed') mergedDone.add(content);
    }
    known.set(file, { mtimeMs, todoDone: mergedDone, goalSeen: maxGoalSeq });

    if (delta > 0) {
      log(`[badge] ${path.basename(path.dirname(file))} 新完成 ${delta} 项`);
      bump(delta);
    }
  }

  async function scanAll() {
    let files = [];
    try {
      files = await listSessionLogs(sessionsDir);
    } catch {
      return;
    }
    const alive = new Set(files);
    // 清理已消失文件的基线
    for (const key of [...known.keys()]) {
      if (!alive.has(key)) known.delete(key);
    }
    // 并发受限地逐个处理
    for (const f of files) {
      if (stopped) return;
      // eslint-disable-next-line no-await-in-loop
      await scanFile(f);
    }
    baselineDone = true;
  }

  function start(initialCount = 0) {
    unacked = initialCount;
    // 首轮扫描建立基线后开始轮询
    scanAll().finally(() => {
      if (stopped) return;
      log('[badge] 基线建立完成，开始监听任务完成事件');
      timer = setInterval(scanAll, POLL_INTERVAL_MS);
      timer.unref?.();
    });
  }

  function clear() {
    unacked = 0;
    try {
      onCount(0);
    } catch {}
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
  }

  return { start, clear, stop };
}

/** 递归列出 sessions 下所有 session 日志文件 */
async function listSessionLogs(root) {
  const out = [];
  async function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop
        await walk(full, depth + 1);
      } else if (SESSION_FILE_RE.test(ent.name)) {
        out.push(full);
      }
    }
  }
  await walk(root, 0);
  return out;
}

module.exports = { createBadgeWatcher, extractEvents, readSessionText };
