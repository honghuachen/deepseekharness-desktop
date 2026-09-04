'use strict';

/**
 * 编排：在 worker 线程（见 scan-worker.js）里扫描 <dshHome>/sessions、逐个文件走
 * 缓存/解压/解析，攒成内存里的 records 数组，不阻塞 Electron 主进程。
 * 只在显式 reload() 时重新扫盘；aggregate() 的按范围/分组重新聚合完全在内存里做，
 * 不重新触发扫描，切 tab/切日期时才不会卡。
 */

const path = require('node:path');
const { Worker } = require('node:worker_threads');

function createTokenUsageService({ dshHome, dataRoot, log = () => {} }) {
  const sessionsRoot = path.join(dshHome, 'sessions');
  const cacheFilePath = path.join(dataRoot, 'token-usage-cache.json');
  let cachedRecords = [];
  let inFlight = null;

  function runWorker() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const worker = new Worker(path.join(__dirname, 'scan-worker.js'), {
        workerData: { sessionsRoot, cacheFilePath },
      });
      worker.on('message', (msg) => {
        if (!msg) return;
        if (msg.type === 'log') {
          log(msg.line);
        } else if (msg.type === 'done') {
          settled = true;
          resolve(msg.records);
        } else if (msg.type === 'error') {
          settled = true;
          reject(new Error(msg.message));
        }
      });
      worker.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      worker.on('exit', (code) => {
        if (!settled && code !== 0) {
          reject(new Error(`token-usage 扫描 worker 异常退出，code=${code}`));
        }
      });
    });
  }

  async function reload() {
    if (inFlight) return inFlight;
    inFlight = runWorker()
      .then((records) => {
        cachedRecords = records;
        return cachedRecords;
      })
      .catch((err) => {
        log(`[token-usage] 扫描失败：${err.message}`);
        return cachedRecords;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    reload,
    getRecords: () => cachedRecords,
  };
}

module.exports = { createTokenUsageService };
