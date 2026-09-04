'use strict';

/**
 * 按文件路径 + mtime + size 做增量缓存，避免每次刷新都重新解压/解析没变化的会话文件。
 * `resilientRecords` 在这一轮解析失败（返回 `null`，如文件正被截断写入）时保留上一次
 * 缓存的结果，而不是把失败当成"这个文件本来就没数据"覆盖掉。
 */

const fs = require('node:fs');
const path = require('node:path');

const CACHE_VERSION = 1;

class UsageCache {
  constructor(cacheFilePath) {
    this.cacheFilePath = cacheFilePath;
    this.entries = this._load();
    this.hasUnsavedChanges = false;
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.cacheFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object') {
        return parsed.entries;
      }
    } catch {
      // 缺失 / 损坏 / 旧版本 schema：重建，不致命
    }
    return {};
  }

  async resilientRecords(filePath, mtimeMs, size, parseIfMissing) {
    const cached = this.entries[filePath];
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      return cached.records;
    }
    const records = await parseIfMissing();
    if (records == null) {
      return cached ? cached.records : [];
    }
    this.entries[filePath] = { mtimeMs, size, records };
    this.hasUnsavedChanges = true;
    return records;
  }

  save() {
    if (!this.hasUnsavedChanges) return;
    fs.mkdirSync(path.dirname(this.cacheFilePath), { recursive: true });
    fs.writeFileSync(this.cacheFilePath, JSON.stringify({ version: CACHE_VERSION, entries: this.entries }), 'utf8');
    this.hasUnsavedChanges = false;
  }
}

module.exports = { UsageCache };
