'use strict';

/**
 * `service.js` 在 worker 线程里跑的实际扫描逻辑：扫目录、走缓存、解压、解析，
 * 把结果 postMessage 回主线程。
 *
 * 之所以要单开一个线程：解压/解析是纯 CPU 工作，且量可能不小（本机真实
 * ~/.dsh/sessions 有 46MB 压缩数据，纯 JS fzstd 兜底路径要跑 10+ 秒）——放在
 * Electron 主进程里跑会把整个应用（所有窗口、菜单）冻住那么久，装了系统 zstd 的
 * 机器上虽然快很多，但没法保证每台机器都有，所以线程隔离是必须的，不只是"锦上添花"。
 */

const fsPromises = require('node:fs/promises');
const { parentPort, workerData } = require('node:worker_threads');

const { findSessionFiles } = require('./scanner');
const { readSessionText } = require('./decompress');
const { parseSessionText } = require('./parser');
const { UsageCache } = require('./cache');

async function run() {
  const { sessionsRoot, cacheFilePath } = workerData;
  const log = (line) => parentPort.postMessage({ type: 'log', line });
  const cache = new UsageCache(cacheFilePath);

  let files = [];
  try {
    files = await findSessionFiles(sessionsRoot);
  } catch (err) {
    log(`[token-usage] 扫描会话目录失败：${err.message}`);
  }

  const allRecords = [];
  for (const file of files) {
    let stat;
    try {
      // eslint-disable-next-line no-await-in-loop
      stat = await fsPromises.stat(file);
    } catch {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const fileRecords = await cache.resilientRecords(file, stat.mtimeMs, stat.size, async () => {
      const text = await readSessionText(file, { log });
      if (text == null) return null;
      return parseSessionText(text);
    });
    allRecords.push(...fileRecords);
  }

  if (cache.hasUnsavedChanges) {
    try {
      cache.save();
    } catch (err) {
      log(`[token-usage] 缓存写入失败：${err.message}`);
    }
  }

  parentPort.postMessage({ type: 'done', records: allRecords });
}

run().catch((err) => {
  parentPort.postMessage({ type: 'error', message: err && err.stack ? err.stack : String(err) });
});
