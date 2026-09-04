'use strict';

/**
 * 读取一份 DeepSeek Harness 会话日志的原始文本。
 *
 * 解压优先用系统装的 `zstd` 命令行（实测比纯 JS 快一个数量级：本机 46MB 的真实
 * 会话数据，系统 zstd 约 1.8 秒，纯 JS fzstd 要 17 秒），装了 zstd 的机器上体验
 * 好得多；没有系统 zstd 时（典型是没额外装过命令行工具的 Windows 机器）落回纯 JS
 * 的 fzstd，保证任何平台都至少能正确解压，不会因为缺一个外部二进制就拿不到数据。
 * 两条路径都已用本机真实的 session.jsonl.zstd 文件验证过，解压结果逐字节一致。
 */

const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const { spawn, spawnSync } = require('node:child_process');

let fzstdModule;
function loadFzstd() {
  if (!fzstdModule) fzstdModule = require('fzstd');
  return fzstdModule;
}

const POSIX_CANDIDATE_PATHS = ['/opt/homebrew/bin/zstd', '/usr/local/bin/zstd', '/opt/local/bin/zstd'];

// undefined = 还没探测过；null = 确认没有；字符串 = 可执行文件路径（或 PATH 里的 'zstd'）
let systemZstdPathCache;

function resolveSystemZstdPath() {
  if (systemZstdPathCache !== undefined) return systemZstdPathCache;

  if (process.platform !== 'win32') {
    for (const candidate of POSIX_CANDIDATE_PATHS) {
      if (fs.existsSync(candidate)) {
        systemZstdPathCache = candidate;
        return systemZstdPathCache;
      }
    }
  }

  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['zstd']);
  systemZstdPathCache = probe.status === 0 ? 'zstd' : null;
  return systemZstdPathCache;
}

/** 把已经读进内存的压缩内容通过 stdin 喂给 `zstd -dc`，避免再读一次文件。 */
function decompressWithSystemZstd(zstdPath, buffer) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(zstdPath, ['-dc'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : null));
    child.stdin.on('error', () => {}); // EPIPE 等；close 事件已经能反映失败
    child.stdin.end(buffer);
  });
}

async function decompressZstd(buffer, { log }) {
  const systemZstdPath = resolveSystemZstdPath();
  if (systemZstdPath) {
    const text = await decompressWithSystemZstd(systemZstdPath, buffer);
    if (text != null) return text;
    // 系统 zstd 失败（比如文件正被追加写入导致帧截断）——落回纯 JS 实现再试一次，
    // 不要直接判定为"这个文件没数据"。
  }

  try {
    const { decompress } = loadFzstd();
    const out = decompress(buffer);
    return Buffer.from(out).toString('utf8');
  } catch (err) {
    log(`[token-usage] zstd 解压失败，本轮跳过: ${err.message}`);
    return null;
  }
}

/**
 * @returns {Promise<string|null>} 解析成功返回文本；`null` 表示这一轮读取/解压失败
 *   （例如文件正被追加写入导致 zstd 帧被截断）——调用方应保留上一次的缓存结果，
 *   而不是把这次的失败当成"文件里本来就没数据"。
 */
async function readSessionText(filePath, { log = () => {} } = {}) {
  let buffer;
  try {
    buffer = await fsPromises.readFile(filePath);
  } catch (err) {
    log(`[token-usage] 读取会话文件失败 ${filePath}: ${err.message}`);
    return null;
  }

  if (!filePath.endsWith('.zstd')) {
    return buffer.toString('utf8');
  }

  return decompressZstd(buffer, { log });
}

module.exports = { readSessionText };
