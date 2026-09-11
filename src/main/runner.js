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
const POLL_INTERVAL_MS = 150; // 加快轮询频率，降低就绪感知延迟

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
  // 快速重试原端口若干次（应对刚刚 stop() 后的 TIME_WAIT 释放阶段）
  for (let retry = 0; retry < 5; retry += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(preferred)) return { port: preferred, adjusted: false };
    if (retry < 4) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 60));
    }
  }
  for (let p = preferred + 1; p < preferred + 10; p += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p)) return { port: p, adjusted: true };
  }
  throw new Error(`端口 ${preferred}~${preferred + 9} 均被占用`);
}

/** 用 TCP connect 探测端口是否在监听，比 fetch 更可靠（不受 Electron 网络栈限制） */
function probePort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    // 1 秒超时
    socket.setTimeout(1000, () => done(false));
  });
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
    let urlNotify = null;
    const captureUrl = (line) => {
      const m = /^dsh web:\s+(\S+)/.exec(line.trim());
      if (m) {
        printedUrl = m[1];
        if (urlNotify) {
          urlNotify();
          urlNotify = null;
        }
      }
    };
    child.stdout.on('data', (c) => String(c).split(/\r?\n/).filter(Boolean).forEach((l) => { log(`${prefix} ${l}`); captureUrl(l); }));
    child.stderr.on('data', (c) => String(c).split(/\r?\n/).filter(Boolean).forEach((l) => log(`${prefix} ${l}`)));

    let earlyExit = null;
    child.on('exit', (code, signal) => {
      earlyExit = { code, signal };
      child = null;
      emitExit({ code, signal, url, port: picked.port });
    });

    // 就绪判定：进程存活且端口可连接
    const deadline = Date.now() + (isFirstBoot ? READY_TIMEOUT_FIRST_MS : READY_TIMEOUT_MS);
    let portReady = false; // 端口已就绪标志
    while (Date.now() < deadline) {
      if (earlyExit) {
        throw new Error(`dsh web 提前退出（code=${earlyExit.code} signal=${earlyExit.signal}），详见日志`);
      }

      // 已拿到官方带 token 地址，立即返回
      if (printedUrl) {
        log('[runner] 官方 Web 服务已输出授权地址，就绪');
        return { url: printedUrl, port: picked.port };
      }

      if (!portReady) {
        // eslint-disable-next-line no-await-in-loop
        const ok = await probePort(picked.port);
        if (ok) {
          portReady = true;
          log('[runner] 端口已就绪，等待授权地址…');
        }
      }

      // 端口就绪后等待 printedUrl，持续等待直到 deadline（stdout 可能缓冲延迟）
      // 端口未就绪时快速轮询，或直到 printedUrl 到来被 urlNotify 唤醒
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => {
        const waitMs = portReady ? 1000 : POLL_INTERVAL_MS;
        const timer = setTimeout(r, waitMs);
        urlNotify = () => {
          clearTimeout(timer);
          r();
        };
      });
    }
    await stop();
    // 超时前最后检查一次 printedUrl（可能在最后 poll 时到达）
    if (printedUrl) {
      log('[runner] 官方 Web 服务已输出授权地址（超时前捕获），就绪');
      return { url: printedUrl, port: picked.port };
    }
    if (portReady) {
      // 端口就绪但始终没有输出 token（旧版无鉴权内核）
      log('[runner] 官方 Web 服务已就绪（无鉴权旧版），使用裸地址');
      return { url, port: picked.port };
    }
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
      }, 2500);
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

module.exports = { createRunner, pickPort, isPortFree, probePort };
