'use strict';

/**
 * 官方运行时进程管理：以子进程拉起 `dsh web`，轮询健康检查，优雅退出。
 * 与 Electron 解耦，纯 node 可测。
 */

const { spawn } = require('node:child_process');
const fsSync = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const DSH_ENTRY = 'node_modules/@deepseek-ai/dsh/lib/bin.js';
const READY_TIMEOUT_FIRST_MS = 150_000; // 首次启动（可能含 profile 初始化）
const READY_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 500;

/** 探测端口是否空闲 */
function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/** 从首选端口开始找到第一个可用端口（最多向后试探 10 个） */
async function pickPort(preferred) {
  for (let p = preferred; p < preferred + 10; p += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p)) return { port: p, adjusted: p !== preferred };
  }
  throw new Error(`端口 ${preferred}~${preferred + 9} 均被占用`);
}

async function probeHealth(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500), redirect: 'manual' });
    // 任何 HTTP 响应都说明服务已监听；200/30x 视为就绪
    return res.status < 500;
  } catch {
    return false;
  }
}

function createRunner({ nodeBin, paths, log = () => {} }) {
  let child = null;
  let stopping = false;
  const exitListeners = new Set();

  function emitExit(info) {
    for (const cb of exitListeners) {
      try {
        cb(info);
      } catch {}
    }
  }

  /**
   * 启动官方 web 服务。
   * @param {object} opts
   * @param {Record<string,string>} [opts.envOverride] 额外注入子进程的环境变量（如 DSH_HOME）
   * @returns {Promise<{url:string, port:number}>} 就绪后 resolve
   */
  async function start(version, port, { isFirstBoot = false, envOverride = {} } = {}) {
    if (child) throw new Error('运行时已在运行');
    const vdir = paths.versionDir(version);
    const entry = path.join(vdir, DSH_ENTRY);
    if (!fsSync.existsSync(entry)) throw new Error(`运行时入口不存在: ${entry}`);

    const picked = await pickPort(port);
    const url = `http://127.0.0.1:${picked.port}`;
    if (picked.adjusted) log(`[runner] 端口 ${port} 被占用，改用 ${picked.port}`);

    log(`[runner] 启动 dsh web (${version}) @ ${url}`);
    const nodeDir = path.dirname(nodeBin);
    const pathSep = process.platform === 'win32' ? ';' : ':';
    child = spawn(nodeBin, [entry, 'web', '--no-open', '--host', '127.0.0.1', '--port', String(picked.port)], {
      cwd: vdir,
      env: {
        ...process.env,
        PATH: nodeDir + pathSep + (process.env.PATH || ''),
        ...envOverride,
      },
      detached: true, // 独立进程组，便于整体终止 cordis 派生的 worker
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const prefix = '[dsh]';
    // 新版内核（如 v0.1.2-rc.1）给本地服务加了 token 鉴权，实际可用地址
    // 会带 ?token=... 打印在 stdout 里，不能再用自己拼的裸 URL 去加载。
    let printedUrl = null;
    const captureUrl = (line) => {
      const m = /^dsh web:\s+(\S+)/.exec(line.trim());
      if (m) printedUrl = m[1];
    };
    child.stdout.on('data', (c) => String(c).split(/\r?\n/).filter(Boolean).forEach((l) => { log(`${prefix} ${l}`); captureUrl(l); }));
    child.stderr.on('data', (c) => String(c).split(/\r?\n/).filter(Boolean).forEach((l) => log(`${prefix} ${l}`)));

    let earlyExit = null;
    child.on('exit', (code, signal) => {
      earlyExit = { code, signal };
      child = null;
      emitExit({ code, signal, url, port: picked.port });
    });

    // 就绪判定：连续两次探活通过且进程仍存活（防「绑定后即崩」的假就绪）
    const deadline = Date.now() + (isFirstBoot ? READY_TIMEOUT_FIRST_MS : READY_TIMEOUT_MS);
    let confirmedOnce = false;
    while (Date.now() < deadline) {
      if (earlyExit) {
        throw new Error(`dsh web 提前退出（code=${earlyExit.code} signal=${earlyExit.signal}），详见日志`);
      }
      // eslint-disable-next-line no-await-in-loop
      const ok = await probeHealth(url);
      if (ok && confirmedOnce) {
        log('[runner] 官方 Web 服务已就绪（二次确认）');
        return { url: printedUrl || url, port: picked.port };
      }
      if (ok && !confirmedOnce) {
        confirmedOnce = true;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 1200)); // 稍候再确认一次
        continue;
      }
      confirmedOnce = false;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    await stop();
    throw new Error('等待服务就绪超时');
  }

  /** 订阅服务意外退出（app 层用于自动重启）；返回取消函数 */
  function onExit(cb) {
    exitListeners.add(cb);
    return () => exitListeners.delete(cb);
  }

  async function stop() {
    if (!child) return;
    stopping = true;
    const c = child;
    child = null;
    await new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        forceKill(c.pid);
        resolve();
      }, 6000);
      c.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
      gracefulKill(c.pid);
    });
    stopping = false;
  }

  /** Windows 用 taskkill 结束整棵进程树；类 unix 杀负 pid 进程组 */
  function gracefulKill(pid) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {}
    }
  }

  function forceKill(pid) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }
  }

  function isRunning() {
    return !!child;
  }

  return { start, stop, isRunning, onExit };
}

module.exports = { createRunner, pickPort, isPortFree, probeHealth };
