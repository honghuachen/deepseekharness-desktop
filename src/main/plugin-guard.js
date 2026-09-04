'use strict';

/**
 * 插件守卫 / 插件清单：
 *   - inventoryProfile(): 盘点一个 profile 的依赖、bundles、补丁层插入块
 *   - removePluginsFromProfile(): 按「包名」精准移除（依赖 + bundle 引用 + 补丁块）
 *   - sanitizeProfile(): 一键恢复官方默认（= 移除全部第三方，首次启动守卫用）
 *
 * 分类规则：@deepseek-ai/* 前缀为官方包；其余视为第三方社区包。
 * 补丁层里引用官方包的配置（如 Funplay 的 dsh-mcp-client 端点）不会被按名误删。
 */

const fsSync = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const OFFICIAL_PREFIX = '@deepseek-ai/';
const CANONICAL_PKG = {
  name: 'dsh-profile-web',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
};

function isOfficial(name) {
  return String(name).startsWith(OFFICIAL_PREFIX);
}

function readJson(file) {
  try {
    return JSON.parse(fsSync.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 解析 cordis.patch.yml 里的 "- insert:" 块，提取每块的 id 与 name。
 * 返回 [{id, name}]；解析失败返回 []。
 */
function parsePatchInserts(patchText) {
  const inserts = [];
  if (!patchText) return inserts;
  const lines = patchText.split('\n');
  let cur = null;
  const flush = () => {
    if (cur && (cur.id || cur.name)) inserts.push(cur);
    cur = null;
  };
  for (const line of lines) {
    if (/^- insert:\s*$/.test(line)) {
      flush();
      cur = {};
      continue;
    }
    if (!cur) continue;
    const mId = /^\s+(?:-\s+)?id:\s*(.+)$/.exec(line);
    const mName = /^\s+(?:-\s+)?name:\s*(.+)$/.exec(line);
    if (mId && cur.id === undefined) cur.id = mId[1].trim().replace(/^['"]|['"]$/g, '');
    if (mName && cur.name === undefined) cur.name = mName[1].trim().replace(/^['"]|['"]$/g, '');
    // 新的顶层元素 = 当前块结束
    if (/^\S/.test(line) && !/^#/.test(line)) flush();
  }
  flush();
  return inserts;
}

/**
 * 盘点一个 profile。
 * @returns {{dir:string, exists:boolean, deps:Array<{name,range,official}>, bundles:string[],
 *            inserts:Array<{id,name,official}>, hasNodeModules:boolean}}
 */
function inventoryProfile(profileDir) {
  const pkgFile = path.join(profileDir, 'package.json');
  const pkg = readJson(pkgFile);
  if (!pkg || !fsSync.existsSync(pkgFile)) {
    return { dir: profileDir, exists: false, deps: [], bundles: [], inserts: [], hasNodeModules: false };
  }
  const deps = Object.entries(pkg.dependencies ?? {}).map(([name, range]) => ({
    name,
    range: String(range),
    official: isOfficial(name),
  }));
  const bundles = (pkg.dsh?.profile?.bundles ?? []).map(String);
  const inserts = parsePatchInserts(
    fsSync.existsSync(path.join(profileDir, 'cordis.patch.yml'))
      ? fsSync.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
      : '',
  ).map((b) => ({ ...b, official: isOfficial(b.name ?? '') }));
  return {
    dir: profileDir,
    exists: true,
    deps,
    bundles,
    inserts,
    hasNodeModules: fsSync.existsSync(path.join(profileDir, 'node_modules')),
  };
}

/** 从文本中剔除引用了 removedNames（按块的 name 字段匹配）的 "- insert:" 块 */
function stripForeignInsertBlocks(text, removedNames) {
  const lines = text.split('\n');
  const out = [];
  let block = null;
  let blockName = null;
  const flush = () => {
    if (!block) return;
    if (!blockName || !removedNames.has(blockName)) out.push(...block);
    block = null;
    blockName = null;
  };
  for (const line of lines) {
    if (/^- insert:\s*$/.test(line)) {
      flush();
      block = [line];
      blockName = null;
      continue;
    }
    if (block) {
      const m = /^\s+(?:-\s+)?name:\s*(.+)$/.exec(line);
      if (m && blockName === null) blockName = m[1].trim().replace(/^['"]|['"]$/g, '');
      if (/^\S/.test(line) && !/^#/.test(line)) {
        flush();
        out.push(line);
        continue;
      }
      block.push(line);
      continue;
    }
    out.push(line);
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function runPnpm(nodeBin, pnpmCjs, args, cwd, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [pnpmCjs, ...args], {
      cwd,
      env: { ...process.env, npm_config_loglevel: 'error', CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errTail = '';
    const forward = (chunk, isError) => {
      if (isError) errTail = (errTail + chunk.toString()).slice(-4000);
      for (const l of chunk.toString().split(/\r?\n/)) if (l.trim()) onLine?.(l.trim());
    };
    child.stdout.on('data', (c) => forward(c, false));
    child.stderr.on('data', (c) => forward(c, true));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('pnpm 超时'));
    }, 10 * 60 * 1000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`pnpm 退出码 ${code}\n${errTail.slice(-1500)}`));
    });
  });
}

/**
 * npm registry 短缓存：按包名缓存最新版本与时间戳，TTL 默认 5 分钟。
 * 用于插件管理 UI 的「检查更新」按钮，避免每个 profile 打开都打 registry。
 */
function createRegistryChecker({ ttlMs = 5 * 60 * 1000, log = () => {} } = {}) {
  const cache = new Map(); // name -> { version, etag, expiresAt }
  const inflight = new Map(); // name -> Promise<string|null>

  function registryUrl(name) {
    // scoped 包：@scope/name → /@scope%2Fname
    let p;
    if (name.startsWith('@')) {
      const slash = name.indexOf('/');
      if (slash < 0) throw new Error(`非法的包名 ${name}`);
      const scope = name.slice(1, slash);
      const sub = name.slice(slash + 1);
      p = `@${encodeURIComponent(scope)}%2F${encodeURIComponent(sub)}`;
    } else {
      p = encodeURIComponent(name);
    }
    return `https://registry.npmjs.org/${p}/latest`;
  }

  async function fetchLatest(name) {
    if (inflight.has(name)) return inflight.get(name);
    const cached = cache.get(name);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.version;

    const p = (async () => {
      try {
        const headers = { accept: 'application/json' };
        if (cached?.etag) headers['if-none-match'] = cached.etag;
        const res = await fetch(registryUrl(name), { headers, signal: AbortSignal.timeout(12_000) });
        if (res.status === 304 && cached) {
          cache.set(name, { ...cached, expiresAt: now + ttlMs });
          return cached.version;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const manifest = await res.json();
        const v = manifest && manifest.version;
        if (typeof v !== 'string' || !v) throw new Error('manifest 无 version  字段');
        cache.set(name, {
          version: v,
          etag: res.headers.get('etag') || null,
          expiresAt: now + ttlMs,
        });
        return v;
      } catch (err) {
        log(`[registry] 查询 ${name} 失败：${err.message}`);
        return null;
      } finally {
        inflight.delete(name);
      }
    })();
    inflight.set(name, p);
    return p;
  }

  /** 批量并发查询，限流 6 个；返回 Map<name, version|null> */
  async function fetchLatestMany(names) {
    const out = new Map();
    const queue = [...new Set(names.filter(Boolean))];
    const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
      while (queue.length) {
        const n = queue.shift();
        out.set(n, await fetchLatest(n));
      }
    });
    await Promise.all(workers);
    return out;
  }

  function clear() {
    cache.clear();
    inflight.clear();
  }

  return { fetchLatest, fetchLatestMany, clear };
}

/** 把 semver range（如 ^0.8.1、~1.2.0、>=2.0.0）粗略规整为可比较的字符串 */
function normalizeRange(range) {
  if (!range) return '';
  return String(range).trim();
}

/**
 * 对比当前 range 与 latest：
 *   - range 形如 ^0.8.1 → 取首个数字作为「当前」基准，与 latest 走 semver 比较
 *   - range 为 git/url/workspace 协议时无法比较，视为 unknown
 *   - latest 为 null（registry 失败）时也视为 unknown
 */
function compareRangeToLatest(range, latest) {
  if (!latest) return 'unknown';
  const r = normalizeRange(range);
  if (!r) return 'unknown';
  // 协议型依赖：git+https、github:、file:、workspace:*、link:、portal:
  if (/^(git\+|github:|gitlab:|bitbucket:|file:|workspace:|link:|portal:|http:|https:)/.test(r)) return 'unknown';
  // 提取首段 semver
  const m = r.match(/(?:[\^~>=<]+\s*)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/);
  if (!m) return 'unknown';
  const { compareVersions } = require('./semver');
  return compareVersions(latest, m[1]) > 0 ? 'outdated' : 'current';
}

/**
 * 检查一个 profile 的全部依赖（仅第三方）是否有更新。
 * @returns {Promise<Array<{name, range, latest, status:'outdated'|'current'|'unknown', error?:string}>>}
 */
async function checkProfileUpdates(profileDir, { registry, log = () => {} } = {}) {
  const inv = inventoryProfile(profileDir);
  if (!inv.exists) return [];
  const third = inv.deps.filter((d) => !d.official);
  if (third.length === 0) return [];
  const reg = registry || createRegistryChecker({ log });
  const latestMap = await reg.fetchLatestMany(third.map((d) => d.name));
  return third.map((d) => {
    const latest = latestMap.get(d.name) ?? null;
    return {
      name: d.name,
      range: d.range,
      latest,
      status: compareRangeToLatest(d.range, latest),
    };
  });
}

/**
 * 把单个第三方依赖升级到指定版本（默认 latest）。
 * 步骤：备份 package.json → 写新 range → pnpm install 收敛 node_modules。
 * @returns {Promise<{name, from, to, ok, error?:string}>}
 */
async function updatePlugin(profileDir, name, { targetVersion, nodeBin, pnpmCjs, log = () => {} } = {}) {
  if (!name) return { name, ok: false, error: '缺少包名' };
  const pkgFile = path.join(profileDir, 'package.json');
  const pkg = readJson(pkgFile);
  if (!pkg) return { name, ok: false, error: 'profile 不存在或 package.json 解析失败' };
  if (isOfficial(name)) return { name, ok: false, error: `官方包 ${name} 不可通过此通道更新` };
  const oldRange = pkg.dependencies?.[name];
  if (!oldRange) return { name, ok: false, error: `${name} 不在该 profile 的 dependencies 中` };

  const target = targetVersion || 'latest';
  const backupDir = path.join(profileDir, `.sanitized-backup-${Date.now()}`);
  await fsPromises.mkdir(backupDir, { recursive: true });
  await fsPromises.copyFile(pkgFile, path.join(backupDir, 'package.json'));

  pkg.dependencies[name] = target === 'latest' ? 'latest' : target;
  await fsPromises.writeFile(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
  log(`[guard] ${path.basename(profileDir)}: ${name} ${oldRange} → ${pkg.dependencies[name]}`);

  if (!nodeBin || !pnpmCjs) {
    return { name, from: oldRange, to: pkg.dependencies[name], ok: false, error: '缺少 nodeBin/pnpmCjs，未实际执行 pnpm install' };
  }
  const nmDir = path.join(profileDir, 'node_modules');
  if (!fsSync.existsSync(nmDir)) {
    return { name, from: oldRange, to: pkg.dependencies[name], ok: false, error: 'profile 无 node_modules，无法执行 pnpm install' };
  }
  try {
    await runPnpm(nodeBin, pnpmCjs, ['install', '--no-frozen-lockfile'], profileDir, (l) => log(`[guard]   ${l}`));
    // pnpm install 不会把 package.json 里的 "latest" 改写成具体版本号，
    // 需要从安装结果里读出实际版本，重新规范为 ^x.y.z，否则 range 会永久留着字面量 "latest"
    const refreshed = readJson(pkgFile);
    let finalRange = refreshed?.dependencies?.[name] ?? pkg.dependencies[name];
    if (finalRange === 'latest' || finalRange === target) {
      const installed = readJson(path.join(profileDir, 'node_modules', name, 'package.json'));
      if (installed?.version && refreshed?.dependencies) {
        finalRange = `^${installed.version}`;
        refreshed.dependencies[name] = finalRange;
        await fsPromises.writeFile(pkgFile, JSON.stringify(refreshed, null, 2) + '\n');
      }
    }
    return { name, from: oldRange, to: finalRange, ok: true };
  } catch (err) {
    // 失败回滚 package.json
    try {
      await fsPromises.copyFile(path.join(backupDir, 'package.json'), pkgFile);
    } catch {}
    const error = String(err.message || err);
    log(`[guard]   ✗ ${path.basename(profileDir)}: ${name} 更新失败：${error}`);
    return { name, from: oldRange, to: pkg.dependencies[name], ok: false, error };
  }
}

/**
 * 从 profile 中按名字移除插件（依赖、bundle 引用、补丁层同名插入块）。
 * @param {string[]} names 要移除的包名
 * @param {object} opts {nodeBin, pnpmCjs, log}
 * @returns {Promise<{removed:string[], reconciled:'none'|'pruned'|'reinstall'}>}
 */
async function removePluginsFromProfile(profileDir, names, { nodeBin, pnpmCjs, log = () => {} } = {}) {
  const pkgFile = path.join(profileDir, 'package.json');
  const pkg = readJson(pkgFile);
  if (!pkg || names.length === 0) return { removed: [], reconciled: 'none' };

  const want = new Set(names);
  const backupDir = path.join(profileDir, `.sanitized-backup-${Date.now()}`);
  await fsPromises.mkdir(backupDir, { recursive: true });

  // 1) 重写 package.json：剔除选中项（其余字段原样保留）
  await fsPromises.copyFile(pkgFile, path.join(backupDir, 'package.json'));
  const removedFromDeps = Object.keys(pkg.dependencies ?? {}).filter((n) => want.has(n));
  for (const n of removedFromDeps) delete pkg.dependencies[n];
  const beforeBundles = pkg.dsh?.profile?.bundles ?? [];
  const removedFromBundles = beforeBundles.filter((b) => want.has(b));
  if (pkg.dsh?.profile) pkg.dsh.profile.bundles = beforeBundles.filter((b) => !want.has(b));
  await fsPromises.writeFile(pkgFile, JSON.stringify(pkg, null, 2) + '\n');

  // 2) 补丁层：剔除 name 命中的插入块
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  if (fsSync.existsSync(patchFile)) {
    const original = await fsPromises.readFile(patchFile, 'utf8');
    const cleaned = stripForeignInsertBlocks(original, want);
    if (cleaned !== original) {
      await fsPromises.copyFile(patchFile, path.join(backupDir, 'cordis.patch.yml'));
      await fsPromises.writeFile(patchFile, cleaned);
    }
  }

  // 3) node_modules 对账：无剩余「第三方」依赖 → 直接清掉（官方 bundle 由运行时解析，
  //    profile 无需安装包）；仍有第三方 → pnpm install 收敛
  const remainingNames = Object.keys(pkg.dependencies ?? {});
  const thirdRemaining = remainingNames.filter((n) => !isOfficial(n));
  let reconciled = 'none';
  const nmDir = path.join(profileDir, 'node_modules');
  if (thirdRemaining.length === 0) {
    if (fsSync.existsSync(nmDir)) {
      log(`[guard] ${path.basename(profileDir)}: 清理 node_modules 与锁文件`);
      await fsPromises.rm(nmDir, { recursive: true, force: true }).catch(() => {});
      await fsPromises.rm(path.join(profileDir, 'pnpm-lock.yaml'), { force: true }).catch(() => {});
      reconciled = 'pruned';
    }
  } else if (nodeBin && pnpmCjs && fsSync.existsSync(nmDir)) {
    log(`[guard] ${path.basename(profileDir)}: 运行 pnpm install 收敛剩余依赖 …`);
    await runPnpm(nodeBin, pnpmCjs, ['install', '--no-frozen-lockfile'], profileDir, (l) => log(`[guard]   ${l}`));
    reconciled = 'reinstall';
  }

  const removed = [...new Set([...removedFromDeps, ...removedFromBundles])].filter((n) => want.has(n));
  log(`[guard] ${path.basename(profileDir)}: 已移除 ${removed.length} 项（备份 ${path.basename(backupDir)}）`);
  return { removed, reconciled };
}

/**
 * 一键恢复官方默认：移除该 profile 全部第三方包。
 */
async function sanitizeProfile(profileDir, opts = {}) {
  const inv = inventoryProfile(profileDir);
  if (!inv.exists) return { changed: false, removed: [] };
  const foreign = [
    ...inv.deps.filter((d) => !d.official).map((d) => d.name),
    ...inv.bundles.filter((b) => !isOfficial(b)),
  ];
  const unique = [...new Set(foreign)];
  if (unique.length === 0) return { changed: false, removed: [] };
  const { removed } = await removePluginsFromProfile(profileDir, unique, opts);
  return { changed: removed.length > 0, removed };
}

/** 是否已经清洗过（marker 落在 DSH_HOME 根） */
function sanitizedMarker(home) {
  return path.join(home, '.dsh-web-sanitized');
}

async function markSanitized(home) {
  await fsPromises.writeFile(sanitizedMarker(home), new Date().toISOString() + '\n');
}

function hasSanitizeMarker(home) {
  return fsSync.existsSync(sanitizedMarker(home));
}

module.exports = {
  isOfficial,
  inventoryProfile,
  parsePatchInserts,
  stripForeignInsertBlocks,
  removePluginsFromProfile,
  sanitizeProfile,
  markSanitized,
  hasSanitizeMarker,
  createRegistryChecker,
  checkProfileUpdates,
  updatePlugin,
  compareRangeToLatest,
  CANONICAL_PKG,
};
