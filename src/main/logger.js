'use strict';

/**
 * 文件日志 + 环形缓冲（供状态窗口回显最近若干行）。
 */

const fsSync = require('node:fs');
const path = require('node:path');

function createLogger(logsDir, { alsoConsole = true } = {}) {
  fsSync.mkdirSync(logsDir, { recursive: true });
  const file = path.join(
    logsDir,
    `app-${new Date().toISOString().slice(0, 10)}.log`,
  );
  const recent = [];
  const RECENT_MAX = 200;

  function log(line) {
    const text = typeof line === 'string' ? line : JSON.stringify(line);
    const stamped = `[${new Date().toISOString()}] ${text}`;
    try {
      fsSync.appendFileSync(file, stamped + '\n');
    } catch {}
    recent.push(text);
    if (recent.length > RECENT_MAX) recent.shift();
    if (alsoConsole) console.log(text);
  }

  return {
    log,
    logFile: file,
    recentLines: () => [...recent],
  };
}

module.exports = { createLogger };
