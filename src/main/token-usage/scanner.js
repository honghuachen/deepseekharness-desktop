'use strict';

/**
 * 递归找出 DeepSeek Harness 的会话日志文件（<dshHome>/sessions 下）。
 * 同时兼容压缩（.zstd）与未压缩（纯 .jsonl）两种落盘形态，
 * 与 badge.js 的 listSessionLogs 保持一致的匹配规则。
 */

const fsPromises = require('node:fs/promises');
const path = require('node:path');

const SESSION_FILE_RE = /^session\.jsonl(\.zstd)?$/;

async function findSessionFiles(root) {
  const results = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop
        await walk(full);
      } else if (entry.isFile() && SESSION_FILE_RE.test(entry.name)) {
        results.push(full);
      }
    }
  }

  await walk(root);
  return results;
}

module.exports = { findSessionFiles, SESSION_FILE_RE };
