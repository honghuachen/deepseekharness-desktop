'use strict';

/**
 * 更新引擎：检测 npm registry 最新版 → 安装到版本化目录 → 原子切换 current 符号链接。
 * 与 Electron 完全解耦（依赖注入 nodeBin / pnpmCjs / paths），可在纯 node 下测试。
 */

const { spawn } = require('node:child_process');
const fsPromises = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { DSH_PACKAGE, REGISTRY_LATEST_URL, BUILD_ALLOWLIST } = require('./config');

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000; // 首次安装给足 15 分钟
const PNPM_BIN_NAME = 'node_modules/@deepseek-ai/dsh/lib/bin.js';

function createUpdater({ nodeBin, pnpmCjs, paths, log = () => {} }) {
  if (!nodeBin) throw new Error('createUpdater 需要 nodeBin');
  if (!pnpmCjs) throw new Error('createUpdater 需要 pnpmCjs');

  /** 查询 npm registry 上的最新版本；失败返回 null（离线容忍） */
  async function getLatestVersion() {
    try {
      const res = await fetch(REGISTRY_LATEST_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
      const manifest = await res.json();
      const version = manifest && manifest.version;
      if (typeof version !== 'string' || !version) throw new Error('manifest 无 version 字段');
      return version;
    } catch (err) {
      log(`[update] 查询 registry 失败：${err.message}`);
      return null;
    }
  }

  /** 当前激活版本：优先读符号链接，Windows 无权限时回退读指针文件 */
  async function getCurrentVersion() {
    try {
      const target = await fsPromises.readlink(paths.currentLink);
      return path.basename(target).replace(/^v/, '');
    } catch {}
    try {
      const raw = await fsPromises.readFile(paths.currentLink + '.json', 'utf8');
      const v = JSON.parse(raw)?.version;
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  }

  function runPnpm(args, cwd, onLine) {
    return new Promise((resolve, reject) => {
      const child = spawn(nodeBin, [pnpmCjs, ...args], {
        cwd,
        env: {
          ...process.env,
          PNPM_HOME: undefined,
          npm_config_loglevel: 'warn',
          npm_config_store_dir: paths.storeDir,
          CI: 'true', // 关闭交互提示
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let bufferedErr = '';
      const forward = (chunk, isError) => {
        const text = chunk.toString();
        if (isError) bufferedErr = (bufferedErr + text).slice(-8000);
        for (const line of text.split(/\r?\n/)) {
          const t = line.trim();
          if (t) onLine?.(t);
        }
      };
      child.stdout.on('data', (c) => forward(c, false));
      child.stderr.on('data', (c) => forward(c, true));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`pnpm ${args[0]} 超时`));
      }, INSTALL_TIMEOUT_MS);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`pnpm ${args.join(' ')} 退出码 ${code}\n${bufferedErr.slice(-2000)}`));
      });
    });
  }

  /** 生成 allowBuilds 白名单的 YAML（pnpm v11 在 pnpm-workspace.yaml 中读取） */
  function allowBuildsYaml() {
    const lines = BUILD_ALLOWLIST.map(
      (name) => `  '${name.replace(/'/g, "''")}': true`,
    );
    return `allowBuilds:\n${lines.join('\n')}\n`;
  }

  /**
   * 安装指定版本到 versions/<v>/ 独立目录。
   * 步骤：写 package.json + 预放行构建脚本 → pnpm add → 校验入口存在。
   */
  async function install(version, onLine = () => {}) {
    const vdir = paths.versionDir(version);
    onLine(`准备目录 ${path.basename(vdir)} …`);
    await fsPromises.mkdir(vdir, { recursive: true });

    // 幂等：已完整安装则跳过
    if (fsSync.existsSync(path.join(vdir, PNPM_BIN_NAME))) {
      onLine('该版本已存在且完整，跳过下载');
      return vdir;
    }

    const pkgJson = {
      name: 'dsh-runtime',
      private: true,
      dependencies: { [DSH_PACKAGE]: version },
    };
    await fsPromises.writeFile(
      path.join(vdir, 'package.json'),
      JSON.stringify(pkgJson, null, 2) + '\n',
    );
    // 构建脚本白名单必须在 install 前就位，否则 CI 模式下 pnpm 以错误退出
    await fsPromises.writeFile(path.join(vdir, 'pnpm-workspace.yaml'), allowBuildsYaml());

    onLine(`正在下载 ${DSH_PACKAGE}@${version} 及其依赖 …`);
    await runPnpm(['add', `${DSH_PACKAGE}@${version}`, '--store-dir=' + paths.storeDir], vdir, onLine);

    if (!fsSync.existsSync(path.join(vdir, PNPM_BIN_NAME))) {
      throw new Error(`安装后未找到 ${PNPM_BIN_NAME}，安装不完整`);
    }
    onLine(`✓ ${version} 安装完成`);
    return vdir;
  }

  /** 原子切换 current 指向：类 unix 用符号链接（rename 原子覆盖）；
   *  Windows 优先 junction（无需管理员权限），受限环境回退指针文件。 */
  async function activate(version) {
    const target = paths.versionDir(version);
    if (!fsSync.existsSync(path.join(target, PNPM_BIN_NAME))) {
      throw new Error(`无法激活 ${version}：目标目录不完整`);
    }
    const tmp = `${paths.currentLink}.tmp-${process.pid}-${Date.now()}`;
    try {
      if (process.platform === 'win32') {
        await fsPromises.symlink(target, tmp, 'junction');
      } else {
        await fsPromises.symlink(target, tmp);
      }
      await fsPromises.rename(tmp, paths.currentLink);
      log(`[update] current -> ${path.basename(target)} (symlink)`);
      return;
    } catch {
      // 符号链接不可用（Windows 未开开发者模式、受限盘符等）→ 指针文件兜底
      await fsPromises.rm(tmp, { force: true }).catch(() => {});
    }
    await fsPromises.mkdir(paths.runtimeDir, { recursive: true });
    await atomicWriteJson(`${paths.currentLink}.json`, { version });
    log(`[update] current -> ${path.basename(target)} (pointer file)`);
  }

  async function atomicWriteJson(file, data) {
    const tmp = `${file}.tmp-${process.pid}`;
    await fsPromises.writeFile(tmp, JSON.stringify(data) + '\n');
    await fsPromises.rename(tmp, file);
  }

  /**
   * 只保留最近 keep 个版本（含 protect 指定的版本，如当前激活版本、用户固定版本），
   * 清理更旧的以控制磁盘占用。protect 可传单个版本号或数组。
   */
  async function prune(keep = 2, protect = null) {
    const { compareVersions } = require('./semver');
    let entries = [];
    try {
      entries = await fsPromises.readdir(paths.versionsDir);
    } catch {
      return;
    }
    const sorted = entries
      .filter((name) => name.startsWith('v'))
      .sort((a, b) => compareVersions(b.slice(1), a.slice(1)));
    const protectList = Array.isArray(protect) ? protect : [protect];
    const protectedNames = new Set(protectList.filter(Boolean).map((v) => `v${v}`));
    for (const name of sorted.slice(keep)) {
      if (protectedNames.has(name)) continue;
      const dir = path.join(paths.versionsDir, name);
      const resolvedCurrent = await fsPromises
        .realpath(paths.currentLink)
        .catch(() => null);
      if (resolvedCurrent && resolvedCurrent.startsWith(dir + path.sep)) continue;
      onLogPrune(name);
      await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  function onLogPrune(name) {
    log(`[update] 清理旧版本 ${name}`);
  }

  return { getLatestVersion, getCurrentVersion, install, activate, prune };
}

module.exports = { createUpdater };
