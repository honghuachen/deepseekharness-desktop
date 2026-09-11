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
const semver = require('semver');

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

/**
 * 向 cordis.patch.yml 追加一个插件的 insert 块（若尚未存在）
 */
function appendPatchInsert(patchText, pluginName) {
  const inserts = parsePatchInserts(patchText);
  if (inserts.some((ins) => ins.name === pluginName)) {
    return patchText;
  }
  const block = `\n- insert:\n    - id: ${pluginName}\n      name: ${pluginName}\n`;
  return (patchText.trimEnd() + '\n' + block).replace(/^\n+/, '');
}

/**
 * 判断某个已安装插件是否为 DSH Bundle（即自身 package.json 声明了 dsh.bundle.patch）。
 * 只有具备 dsh.bundle 声明的插件才可以写入 package.json 的 dsh.profile.bundles，
 * 否则 DSH 启动时会抛错：profile bundle "..." declares no dsh.bundle in its package.json。
 */
function isBundlePackage(profileDir, pkgName) {
  try {
    const nmPkgPath = path.join(profileDir, 'node_modules', ...pkgName.split('/'), 'package.json');
    if (fsSync.existsSync(nmPkgPath)) {
      const data = JSON.parse(fsSync.readFileSync(nmPkgPath, 'utf8'));
      return Boolean(data.dsh?.bundle?.patch);
    }
  } catch {}
  // 若 node_modules 中不存在（如单元测试桩环境或未安装阶段），若 bundles 中已有该项则保留为 true
  try {
    const pfile = path.join(profileDir, 'package.json');
    if (fsSync.existsSync(pfile)) {
      const pdata = JSON.parse(fsSync.readFileSync(pfile, 'utf8'));
      if (pdata.dsh?.profile?.bundles?.includes(pkgName)) return true;
    }
  } catch {}
  return true;
}

function runPnpm(nodeBin, pnpmCjs, args, cwd, onLine) {
  return new Promise((resolve, reject) => {
    const nodeDir = path.dirname(nodeBin);
    const pathSep = process.platform === 'win32' ? ';' : ':';
    const child = spawn(nodeBin, [pnpmCjs, ...args], {
      cwd,
      env: {
        ...process.env,
        PATH: nodeDir + pathSep + (process.env.PATH || ''),
        npm_config_loglevel: 'error',
        CI: 'true',
        pnpm_config_dangerously_allow_all_builds: 'true',
        pnpm_config_strict_dep_builds: 'false',
        PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS: 'true',
        PNPM_CONFIG_STRICT_DEP_BUILDS: 'false',
      },
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

/**
 * 解析 GitHub 依赖规格（如 github:owner/repo、github:owner/repo#branch、git+https://github.com/owner/repo.git）。
 * 返回 { owner, repo, ref } 或 null。
 */
function parseGitHubSpec(range) {
  if (!range || typeof range !== 'string') return null;
  const s = range.trim();
  // 1) github:owner/repo(#ref)?
  let m = s.match(/^github:([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+?)(?:\.git)?(?:#(.*))?$/i);
  if (m) {
    return { owner: m[1], repo: m[2], ref: m[3] || 'HEAD' };
  }
  // 2) (git+)?https?://github.com/owner/repo(.git)?(#ref)?
  m = s.match(/^(?:git\+)?https?:\/\/github\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+?)(?:\.git)?(?:#(.*))?$/i);
  if (m) {
    return { owner: m[1], repo: m[2], ref: m[3] || 'HEAD' };
  }
  // 3) git@github.com:owner/repo(.git)?(#ref)?
  m = s.match(/^git@github\.com:([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+?)(?:\.git)?(?:#(.*))?$/i);
  if (m) {
    return { owner: m[1], repo: m[2], ref: m[3] || 'HEAD' };
  }
  return null;
}

/**
 * 解析 package.json 中的 repository 字段或 homepage 字段，提取标准开源仓库 URL。
 * 支持：
 *   - "github:owner/repo"
 *   - "owner/repo"
 *   - "git+https://github.com/owner/repo.git"
 *   - "https://github.com/owner/repo"
 *   - "git://github.com/owner/repo.git"
 *   - "git@github.com:owner/repo.git"
 *   - "ssh://git@github.com/owner/repo.git"
 *   - { type: 'git', url: '...' }
 *   - 其它通用 http(s) URL
 * 返回规整后的 URL（如 https://github.com/owner/repo），无法解析返回 null。
 */
function parseRepoUrl(repo) {
  if (!repo) return null;
  const raw = typeof repo === 'string' ? repo.trim() : (typeof repo.url === 'string' ? repo.url.trim() : '');
  if (!raw) return null;

  // 1) 匹配各种形式的 GitHub 仓库引用
  const m = raw.match(/(?:(?:github\.com[/:|])|github:|^)([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+?)(?:\.git)?(?:[#?].*)?$/i);
  if (m) {
    return `https://github.com/${m[1]}/${m[2]}`;
  }

  // 2) 其它标准 http(s) 链接（如 GitLab / Gitee 等）
  if (/^https?:\/\//i.test(raw)) {
    return raw.replace(/\.git$/i, '').replace(/#.*$/, '');
  }

  return null;
}

/**
 * 从 profile 的 pnpm-lock.yaml 中提取指定包当前锁定的 git commit SHA（40 位哈希）。
 */
function getInstalledGitCommit(profileDir, pkgName) {
  const lockFile = path.join(profileDir, 'pnpm-lock.yaml');
  try {
    const content = fsSync.readFileSync(lockFile, 'utf8');
    const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 在 importers / dependencies 下匹配 specifier 为 github 或 git，提取紧随的 tar.gz/<sha> 或 version 里的 sha
    const reg1 = new RegExp(`['"]?${escaped}['"]?:[\\s\\S]*?version:\\s*.*?([0-9a-f]{40})`, 'i');
    const m1 = content.match(reg1);
    if (m1) return m1[1];
    // 或在 packages 段匹配包名对应的 key，提取 40 位 sha
    const reg2 = new RegExp(`['"]?${escaped}@[^'"]*?([0-9a-f]{40})`, 'i');
    const m2 = content.match(reg2);
    if (m2) return m2[1];
  } catch {}
  return null;
}

/**
 * GitHub 远端版本与 Commit 检测器：
 *   - 优先通过 Smart Git HTTP 协议 (info/refs?service=git-upload-pack) 查询，免除 GitHub REST API 60次/小时的 Rate Limit
 *   - 备选降级至 GitHub REST API (/repos/:owner/:repo/commits/:ref)
 *   - 5 分钟 TTL 内存缓存与并发去重
 */
function createGitHubChecker({ ttlMs = 5 * 60 * 1000, log = () => {} } = {}) {
  const cache = new Map(); // cacheKey -> { sha, shortSha, tag, expiresAt }
  const inflight = new Map(); // cacheKey -> Promise<object|null>

  async function fetchLatest(spec) {
    const parsed = typeof spec === 'string' ? parseGitHubSpec(spec) : spec;
    if (!parsed || !parsed.owner || !parsed.repo) return null;
    const { owner, repo, ref = 'HEAD' } = parsed;
    const cacheKey = `${owner.toLowerCase()}/${repo.toLowerCase()}#${ref}`;

    if (inflight.has(cacheKey)) return inflight.get(cacheKey);
    const cached = cache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached;

    const p = (async () => {
      try {
        // 方法 1：Smart Git HTTP 协议，免 GitHub API Rate Limit 限制
        const gitUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git/info/refs?service=git-upload-pack`;
        const res = await fetch(gitUrl, {
          headers: {
            'User-Agent': 'DeepseekHarnessApp',
            'Accept': '*/*',
          },
          signal: AbortSignal.timeout(12_000),
        });

        if (res.ok) {
          const text = await res.text();
          let headSha = null;
          const tags = new Map(); // sha -> tagName
          const branches = new Map(); // branchName -> sha

          for (const line of text.split('\n')) {
            const m = line.match(/([0-9a-f]{40})\s+([^\s\0]+)/i);
            if (!m) continue;
            const sha = m[1].toLowerCase();
            const refName = m[2];
            if (refName === 'HEAD') {
              headSha = sha;
            } else if (refName.startsWith('refs/heads/')) {
              branches.set(refName.slice('refs/heads/'.length), sha);
            } else if (refName.startsWith('refs/tags/')) {
              const tagName = refName.slice('refs/tags/'.length).replace(/\^{}$/, '');
              tags.set(sha, tagName);
            }
          }

          let targetSha = null;
          let targetTag = null;

          if (!ref || ref === 'HEAD') {
            targetSha = headSha || branches.get('main') || branches.get('master') || null;
          } else if (branches.has(ref)) {
            targetSha = branches.get(ref);
          } else {
            for (const [sha, tName] of tags.entries()) {
              if (tName === ref) {
                targetSha = sha;
                targetTag = tName;
                break;
              }
            }
          }

          if (targetSha) {
            targetTag = targetTag || tags.get(targetSha) || null;
            const result = {
              sha: targetSha,
              shortSha: targetSha.slice(0, 7),
              tag: targetTag,
              expiresAt: now + ttlMs,
            };
            cache.set(cacheKey, result);
            return result;
          }
        }
      } catch (err) {
        log(`[github-checker] Smart HTTP 查询 ${owner}/${repo} 失败: ${err.message}，尝试 API 降级…`);
      }

      // 方法 2：降级至 GitHub REST API
      try {
        const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref || 'HEAD')}`;
        const res = await fetch(apiUrl, {
          headers: {
            'User-Agent': 'DeepseekHarnessApp',
            'Accept': 'application/vnd.github.v3+json',
          },
          signal: AbortSignal.timeout(12_000),
        });
        if (res.ok) {
          const data = await res.json();
          if (data && typeof data.sha === 'string' && /^[0-9a-f]{40}$/i.test(data.sha)) {
            const sha = data.sha.toLowerCase();
            const result = {
              sha,
              shortSha: sha.slice(0, 7),
              tag: null,
              expiresAt: now + ttlMs,
            };
            cache.set(cacheKey, result);
            return result;
          }
        }
      } catch (err) {
        log(`[github-checker] GitHub API 查询 ${owner}/${repo} 失败: ${err.message}`);
      }

      return null;
    })().finally(() => {
      inflight.delete(cacheKey);
    });

    inflight.set(cacheKey, p);
    return p;
  }

  async function fetchLatestMany(specs) {
    const out = new Map();
    const queue = [...specs];
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const s = queue.shift();
        if (s) {
          const res = await fetchLatest(s);
          const key = typeof s === 'string' ? s : `${s.owner}/${s.repo}#${s.ref || 'HEAD'}`;
          out.set(key, res);
        }
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
 * 支持 npm registry 与 GitHub 仓库依赖。
 * @returns {Promise<Array<{name, range, latest, status:'outdated'|'current'|'unknown', from?:string, isGitHub?:boolean, error?:string}>>}
 */
async function checkProfileUpdates(profileDir, { registry, githubChecker, log = () => {} } = {}) {
  const inv = inventoryProfile(profileDir);
  if (!inv.exists) return [];
  const third = inv.deps.filter((d) => !d.official);
  if (third.length === 0) return [];

  const reg = registry || createRegistryChecker({ log });
  const gh = githubChecker || createGitHubChecker({ log });

  const npmDeps = [];
  const ghDeps = [];

  for (const d of third) {
    const ghSpec = parseGitHubSpec(d.range);
    if (ghSpec) {
      ghDeps.push({ dep: d, spec: ghSpec });
    } else {
      npmDeps.push(d);
    }
  }

  const [npmLatestMap] = await Promise.all([
    reg.fetchLatestMany(npmDeps.map((d) => d.name)),
    gh.fetchLatestMany(ghDeps.map((g) => g.spec)),
  ]);

  const results = [];

  for (const d of npmDeps) {
    const latest = npmLatestMap.get(d.name) ?? null;
    results.push({
      name: d.name,
      range: d.range,
      latest,
      status: compareRangeToLatest(d.range, latest),
    });
  }

  for (const { dep, spec } of ghDeps) {
    const remote = await gh.fetchLatest(spec);
    const installedSha = getInstalledGitCommit(profileDir, dep.name);
    const installedVer = readJson(path.join(profileDir, 'node_modules', dep.name, 'package.json'))?.version;

    if (!remote || !installedSha) {
      results.push({
        name: dep.name,
        range: dep.range,
        latest: remote ? (remote.tag ? `${remote.tag} (${remote.shortSha})` : remote.shortSha) : null,
        status: 'unknown',
        isGitHub: true,
      });
      continue;
    }

    const isMatch = remote.sha.toLowerCase() === installedSha.toLowerCase();
    const latestLabel = remote.tag ? `${remote.tag} (${remote.shortSha})` : remote.shortSha;
    const installedLabel = installedVer ? `${installedVer} (${installedSha.slice(0, 7)})` : installedSha.slice(0, 7);

    results.push({
      name: dep.name,
      range: dep.range,
      latest: latestLabel,
      from: installedLabel,
      status: isMatch ? 'current' : 'outdated',
      isGitHub: true,
      installedSha,
      remoteSha: remote.sha,
    });
  }

  return results;
}

/**
 * 批量升级一个 profile 内的多个第三方依赖。
 * 步骤：备份 package.json → 为 npm 插件写新 range（若未指定或 latest 则向 registry 解析实际版本）；
 *      对 GitHub 插件保留原 range → 调用 pnpm install / pnpm update 收敛 node_modules
 *      → 校验各包实际版本与 commit SHA 并写回 package.json。
 * @param {string} profileDir profile 目录
 * @param {Array<{name: string, target?: string}>} items 待升级插件列表
 * @param {object} opts {nodeBin, pnpmCjs, log, registry, githubChecker}
 * @returns {Promise<{report: Array<{name, from, to, ok, error?:string}>, anyChanged: boolean}>}
 */
async function updatePlugins(profileDir, items, { nodeBin, pnpmCjs, log = () => {}, registry, githubChecker } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return { report: [], anyChanged: false };
  }
  const pkgFile = path.join(profileDir, 'package.json');
  const pkg = readJson(pkgFile);
  if (!pkg) {
    return {
      report: items.map((i) => ({ name: i?.name || 'unknown', ok: false, error: 'profile 不存在或 package.json 解析失败' })),
      anyChanged: false,
    };
  }

  const reg = registry || createRegistryChecker({ log });
  const validItems = [];
  const report = [];

  for (const item of items) {
    const name = item?.name;
    if (!name) continue;
    if (isOfficial(name)) {
      report.push({ name, ok: false, error: `官方包 ${name} 不可通过此通道更新` });
      continue;
    }
    const oldRange = pkg.dependencies?.[name];
    if (!oldRange) {
      report.push({ name, ok: false, error: `${name} 不在该 profile 的 dependencies 中` });
      continue;
    }

    const ghSpec = parseGitHubSpec(oldRange);
    if (ghSpec) {
      const oldSha = getInstalledGitCommit(profileDir, name);
      const oldVer = readJson(path.join(profileDir, 'node_modules', name, 'package.json'))?.version;
      validItems.push({
        name,
        oldRange,
        target: item.target || 'latest',
        targetRange: oldRange, // GitHub 依赖严禁改写为 npm 版本
        isGitHub: true,
        oldSha,
        oldVer,
      });
      continue;
    }

    let target = item.target || 'latest';
    // 若未指定或为 latest，尝试向 registry 查询最新版本号
    if (target === 'latest') {
      try {
        const latestVer = await reg.fetchLatest(name);
        if (latestVer) target = latestVer;
      } catch {}
    }

    // 规范写入范围：若有具体版本且不以 ^ 开头，规范为 ^x.y.z；若仍为 latest 则保留
    const targetRange = target === 'latest' ? 'latest' : (target.startsWith('^') ? target : `^${target}`);
    validItems.push({ name, oldRange, target, targetRange, isGitHub: false });
  }

  if (validItems.length === 0) {
    return { report, anyChanged: false };
  }

  const backupDir = path.join(profileDir, `.sanitized-backup-${Date.now()}`);
  await fsPromises.mkdir(backupDir, { recursive: true });
  await fsPromises.copyFile(pkgFile, path.join(backupDir, 'package.json'));

  let pkgModified = false;
  for (const v of validItems) {
    if (!v.isGitHub) {
      pkg.dependencies[v.name] = v.targetRange;
      log(`[guard] ${path.basename(profileDir)}: ${v.name} ${v.oldRange} → ${v.targetRange}`);
      pkgModified = true;
    }
  }
  if (pkgModified) {
    await fsPromises.writeFile(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
  }

  if (!nodeBin || !pnpmCjs) {
    for (const v of validItems) {
      report.push({
        name: v.name,
        from: v.oldRange,
        to: v.targetRange,
        ok: false,
        error: '缺少 nodeBin/pnpmCjs，未实际执行 pnpm install',
      });
    }
    return { report, anyChanged: false };
  }

  const nmDir = path.join(profileDir, 'node_modules');
  if (!fsSync.existsSync(nmDir)) {
    for (const v of validItems) {
      report.push({
        name: v.name,
        from: v.oldRange,
        to: v.targetRange,
        ok: false,
        error: 'profile 无 node_modules，无法执行 pnpm install',
      });
    }
    return { report, anyChanged: false };
  }

  const githubItems = validItems.filter((v) => v.isGitHub);
  const npmItems = validItems.filter((v) => !v.isGitHub);

  try {
    // 1) 如果包含 npm 依赖更新，执行 pnpm install
    if (npmItems.length > 0) {
      await runPnpm(
        nodeBin,
        pnpmCjs,
        [
          'install',
          '--no-frozen-lockfile',
          '--config.dangerously-allow-all-builds=true',
          '--config.strict-dep-builds=false',
        ],
        profileDir,
        (l) => log(`[guard]   ${l}`),
      );
    }

    // 2) 如果包含 GitHub 依赖更新，调用 pnpm update 强制拉取远端最新 commit
    if (githubItems.length > 0) {
      const ghNames = githubItems.map((v) => v.name);
      await runPnpm(
        nodeBin,
        pnpmCjs,
        [
          'update',
          ...ghNames,
          '--config.dangerously-allow-all-builds=true',
          '--config.strict-dep-builds=false',
        ],
        profileDir,
        (l) => log(`[guard]   ${l}`),
      );
    }

    const refreshed = readJson(pkgFile) || pkg;
    let pkgFinalModified = false;

    for (const v of validItems) {
      const installed = readJson(path.join(profileDir, 'node_modules', v.name, 'package.json'));

      if (v.isGitHub) {
        const newSha = getInstalledGitCommit(profileDir, v.name);
        const newVer = installed?.version;

        const shaChanged = newSha && v.oldSha && newSha.toLowerCase() !== v.oldSha.toLowerCase();
        const verChanged = newVer && v.oldVer && newVer !== v.oldVer;

        const fromLabel = v.oldSha ? v.oldSha.slice(0, 7) : (v.oldVer || v.oldRange);
        const toLabel = newSha ? newSha.slice(0, 7) : (newVer || 'latest');

        if (shaChanged || verChanged) {
          report.push({
            name: v.name,
            from: fromLabel,
            to: toLabel,
            ok: true,
          });
        } else {
          report.push({
            name: v.name,
            from: fromLabel,
            to: toLabel,
            ok: false,
            error: `已装版本未提升（Commit 未变更），更新未生效`,
          });
        }
      } else {
        let finalRange = refreshed?.dependencies?.[v.name] ?? v.targetRange;
        if (installed?.version && refreshed?.dependencies) {
          finalRange = `^${installed.version}`;
          refreshed.dependencies[v.name] = finalRange;
          pkgFinalModified = true;
        }

        // 验证版本是否真正发生变更（排除由于 lockfile 锁定未更新并写回旧版的情形）
        if (installed?.version && finalRange === v.oldRange) {
          report.push({
            name: v.name,
            from: v.oldRange,
            to: finalRange,
            ok: false,
            error: `已装版本未提升（仍为 ${v.oldRange}），更新未生效`,
          });
        } else {
          report.push({
            name: v.name,
            from: v.oldRange,
            to: finalRange,
            ok: true,
          });
        }
      }
    }

    if (pkgFinalModified) {
      await fsPromises.writeFile(pkgFile, JSON.stringify(refreshed, null, 2) + '\n');
    }

    const anyChanged = report.some((r) => r.ok && r.from !== r.to);
    return { report, anyChanged };
  } catch (err) {
    // 失败回滚 package.json
    try {
      await fsPromises.copyFile(path.join(backupDir, 'package.json'), pkgFile);
    } catch {}
    const error = String(err.message || err);
    log(`[guard]   ✗ ${path.basename(profileDir)}: 批量更新失败：${error}`);

    // 若多个项批量更新失败，尝试逐个单独重试
    if (validItems.length > 1) {
      log(`[guard]   ${path.basename(profileDir)}: 降级为逐个单包更新…`);
      for (const v of validItems) {
        try {
          const r = await updatePlugin(profileDir, v.name, {
            targetVersion: v.target,
            nodeBin,
            pnpmCjs,
            log,
            registry: reg,
            githubChecker,
          });
          report.push(r);
        } catch (e2) {
          report.push({ name: v.name, from: v.oldRange, to: v.targetRange, ok: false, error: String(e2.message || e2) });
        }
      }
      const anyChanged = report.some((r) => r.ok && r.from !== r.to);
      return { report, anyChanged };
    }

    for (const v of validItems) {
      report.push({ name: v.name, from: v.oldRange, to: v.targetRange, ok: false, error });
    }
    return { report, anyChanged: false };
  }
}

/**
 * 把单个第三方依赖升级到指定版本（默认 latest）。
 * 步骤：备份 package.json → 写新 range → pnpm install / update 收敛 node_modules。
 * @returns {Promise<{name, from, to, ok, error?:string}>}
 */
async function updatePlugin(profileDir, name, { targetVersion, nodeBin, pnpmCjs, log = () => {}, registry, githubChecker } = {}) {
  const { report } = await updatePlugins(profileDir, [{ name, target: targetVersion }], {
    nodeBin,
    pnpmCjs,
    log,
    registry,
    githubChecker,
  });
  return report[0] || { name, ok: false, error: '未知错误' };
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
    await runPnpm(
      nodeBin,
      pnpmCjs,
      [
        'install',
        '--no-frozen-lockfile',
        '--config.dangerously-allow-all-builds=true',
        '--config.strict-dep-builds=false',
      ],
      profileDir,
      (l) => log(`[guard]   ${l}`),
    );
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

/**
 * 校验插件与当前内核版本的兼容性（静态约束 + 动态配置预检）。
 * @param {object} pluginPkg 插件 package.json
 * @param {string|null} activeKernelVersion 当前激活内核版本（如 '0.1.5-rc.1'）
 * @param {object} [opts]
 * @param {string} [opts.kernelDir] 内核运行时目录
 * @param {string} [opts.profileDir] profile 目录
 * @param {string} [opts.nodeBin] Node 可执行文件
 * @param {string} [opts.dshHome] DSH_HOME 根目录
 * @param {Function} [opts.log] 日志函数
 * @returns {Promise<{compatible: boolean, reason?: string}>}
 */
async function checkPluginKernelCompatibility(pluginPkg, activeKernelVersion, {
  kernelDir,
  profileDir,
  nodeBin,
  dshHome,
  log = () => {},
} = {}) {
  const kernelVer = String(activeKernelVersion || '').trim().replace(/^v/i, '');
  if (!kernelVer) {
    // 未提供或未知内核版本时不进行版本阻断
    return { compatible: true };
  }

  // 1. peerDependencies: 校验官方内核 API 依赖版本
  const peerDeps = pluginPkg?.peerDependencies || {};
  for (const [depName, range] of Object.entries(peerDeps)) {
    if (typeof range !== 'string' || !range.trim()) continue;
    // 官方 @deepseek-ai/* 相关内核 API 包与 @deepseek-ai/dsh 统一版本对齐
    if (depName === '@deepseek-ai/dsh' || depName.startsWith('@deepseek-ai/dsh-')) {
      let isSatisfied = false;
      try {
        isSatisfied = semver.satisfies(kernelVer, range, { includePrerelease: true });
      } catch {
        isSatisfied = true;
      }
      if (!isSatisfied) {
        log(`[guard] 兼容性冲突: ${pluginPkg?.name} 要求 ${depName}@${range}，当前内核为 v${kernelVer}`);
        return {
          compatible: false,
          reason: `插件要求内核 API 依赖 ${depName}@${range}，与当前内核版本 v${kernelVer} 不兼容`,
        };
      }
    }
  }

  // 2. dsh.compatibility 声明
  const dshCompat = pluginPkg?.dsh?.compatibility;
  if (dshCompat) {
    if (dshCompat.dshReleases && typeof dshCompat.dshReleases === 'object') {
      const releaseStatus = dshCompat.dshReleases[kernelVer] || dshCompat.dshReleases[`v${kernelVer}`];
      if (releaseStatus === 'incompatible' || releaseStatus === false) {
        return {
          compatible: false,
          reason: `插件明确标记不支持当前内核版本 v${kernelVer}`,
        };
      }
    }
    const kernelRange = dshCompat.kernel || dshCompat.version;
    if (typeof kernelRange === 'string' && kernelRange.trim()) {
      let isSatisfied = false;
      try {
        isSatisfied = semver.satisfies(kernelVer, kernelRange, { includePrerelease: true });
      } catch {
        isSatisfied = true;
      }
      if (!isSatisfied) {
        return {
          compatible: false,
          reason: `插件限定内核版本范围为 ${kernelRange}，当前内核版本 v${kernelVer} 不在兼容范围内`,
        };
      }
    }
    if (dshCompat.minVersion && typeof dshCompat.minVersion === 'string') {
      try {
        if (semver.lt(kernelVer, dshCompat.minVersion)) {
          return {
            compatible: false,
            reason: `插件要求最低内核版本为 v${dshCompat.minVersion}，当前内核版本为 v${kernelVer}`,
          };
        }
      } catch {}
    }
    if (dshCompat.maxVersion && typeof dshCompat.maxVersion === 'string') {
      try {
        if (semver.gt(kernelVer, dshCompat.maxVersion)) {
          return {
            compatible: false,
            reason: `插件要求最高内核版本为 v${dshCompat.maxVersion}，当前内核版本为 v${kernelVer}`,
          };
        }
      } catch {}
    }
  }

  // 3. engines 声明
  const dshEngine = pluginPkg?.engines?.dsh || pluginPkg?.engines?.['@deepseek-ai/dsh'];
  if (typeof dshEngine === 'string' && dshEngine.trim()) {
    let isSatisfied = false;
    try {
      isSatisfied = semver.satisfies(kernelVer, dshEngine, { includePrerelease: true });
    } catch {
      isSatisfied = true;
    }
    if (!isSatisfied) {
      return {
        compatible: false,
        reason: `插件 engines 限定内核版本为 ${dshEngine}，当前内核版本为 v${kernelVer}`,
      };
    }
  }

  return { compatible: true };
}

/**
 * 执行官方内核 dsh --dump-config 编排预检
 */
async function checkKernelDumpConfig({ kernelDir, nodeBin, profileDir, dshHome, log = () => {} }) {
  if (!kernelDir || !nodeBin || !profileDir || !dshHome) return { compatible: true };
  const dshBin = path.join(kernelDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fsSync.existsSync(dshBin)) return { compatible: true };

  const profileName = path.basename(profileDir);
  return new Promise((resolve) => {
    const child = spawn(nodeBin, [dshBin, '--profile', profileName, '--dump-config'], {
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ compatible: true });
    }, 8000);
    child.on('error', (err) => {
      clearTimeout(timer);
      log(`[guard] dump-config 预检启动失败: ${err.message}`);
      resolve({ compatible: true });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ compatible: true });
      } else {
        const lines = stderr.split(/\r?\n/).filter(Boolean);
        const errLine = lines.find((l) => l.includes('Error:') || l.includes('error:')) || lines[0] || '配置或补丁解析异常';
        log(`[guard] dump-config 预检未通过 (code=${code}): ${errLine}`);
        resolve({
          compatible: false,
          reason: `内核配置与补丁解析异常: ${errLine.replace(/^Error:\s*/i, '').trim()}`,
        });
      }
    });
  });
}

/**
 * 向 profile 中安装单个第三方插件。
 * 1. 验证非官方包、profileDir 存在；
 * 2. 写入 package.json dependencies 并确保加入 dsh.profile.bundles；
 * 3. 运行 pnpm install 并校验；
 * 4. 检测插件与当前激活内核的 API 与配置兼容性；
 * 5. 失败自动回滚 package.json 与 patch 并清理已安装目录。
 */
async function installPluginToProfile(
  profileDir,
  pluginInfo,
  { nodeBin, pnpmCjs, activeKernelVersion, kernelDir, dshHome, log = () => {} } = {},
) {
  const name = (pluginInfo?.packageName || pluginInfo?.name)?.trim();
  if (!name) throw new Error('缺少插件名称');
  if (isOfficial(name)) throw new Error(`官方包 ${name} 不允许通过此途径安装`);

  const pkgFile = path.join(profileDir, 'package.json');
  const pkg = readJson(pkgFile);
  if (!pkg) throw new Error('profile 目录不存在或 package.json 无效');

  pkg.dependencies = pkg.dependencies || {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];

  let rawSpec = String(pluginInfo.installSpec || pluginInfo.targetVersion || '').trim();
  let targetRange = 'latest';
  if (
    rawSpec.startsWith('github:') ||
    rawSpec.startsWith('git+') ||
    rawSpec.startsWith('http:') ||
    rawSpec.startsWith('https:') ||
    rawSpec.startsWith('file:')
  ) {
    targetRange = rawSpec;
  } else if (!rawSpec || rawSpec === name || rawSpec === 'latest') {
    targetRange = 'latest';
  } else if (/^[\^~>=<]/.test(rawSpec)) {
    targetRange = rawSpec;
  } else if (/^\d+\.\d+/.test(rawSpec)) {
    targetRange = `^${rawSpec}`;
  } else {
    targetRange = 'latest';
  }

  // 备份 package.json 与 cordis.patch.yml
  const backupDir = path.join(profileDir, `.sanitized-backup-${Date.now()}`);
  await fsPromises.mkdir(backupDir, { recursive: true });
  await fsPromises.copyFile(pkgFile, path.join(backupDir, 'package.json'));

  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  let hadPatchFile = false;
  if (fsSync.existsSync(patchFile)) {
    hadPatchFile = true;
    await fsPromises.copyFile(patchFile, path.join(backupDir, 'cordis.patch.yml'));
  }

  try {
    pkg.dependencies[name] = targetRange;
    pkg.dsh.profile.disabledBundles = (pkg.dsh.profile.disabledBundles || []).filter((b) => b !== name);
    // 先保存 dependencies，安装后再根据 node_modules 检查是否为 bundle
    await fsPromises.writeFile(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
    log(`[guard] 开始安装插件 ${name} (${targetRange}) 到 ${path.basename(profileDir)}…`);

    if (!nodeBin || !pnpmCjs) {
      return { ok: false, name, error: '缺少 Node 或 pnpm 执行环境' };
    }

    await runPnpm(
      nodeBin,
      pnpmCjs,
      [
        'install',
        '--no-frozen-lockfile',
        '--config.dangerously-allow-all-builds=true',
        '--config.strict-dep-builds=false',
      ],
      profileDir,
      (l) => log(`[guard]   ${l}`),
    );

    const nmPkgFile = path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json');
    if (!fsSync.existsSync(nmPkgFile)) {
      throw new Error(`pnpm install 完成后未找到 ${name} 的 node_modules 目录`);
    }

    const installed = readJson(nmPkgFile);
    const installedVer = installed?.version || 'unknown';

    if (targetRange === 'latest' && installedVer !== 'unknown') {
      pkg.dependencies[name] = `^${installedVer}`;
    }

    // 1. 静态内核 API 兼容性检测
    const compat = await checkPluginKernelCompatibility(installed, activeKernelVersion, {
      kernelDir,
      profileDir,
      nodeBin,
      dshHome,
      log,
    });
    if (!compat.compatible) {
      throw new Error(`由于兼容性问题安装失败：${compat.reason || '与当前内核版本不兼容'}`);
    }

    // 安装成功后默认启用：根据是否具备 dsh.bundle 声明分流
    if (isBundlePackage(profileDir, name)) {
      if (!pkg.dsh.profile.bundles.includes(name)) {
        pkg.dsh.profile.bundles.push(name);
      }
    } else {
      // 非 bundle 插件：绝不能在 bundles 中，挂载到 cordis.patch.yml
      const patchContent = fsSync.existsSync(patchFile) ? fsSync.readFileSync(patchFile, 'utf8') : '';
      const newPatchContent = appendPatchInsert(patchContent, name);
      await fsPromises.writeFile(patchFile, newPatchContent);
      pkg.dsh.profile.bundles = (pkg.dsh.profile.bundles || []).filter((b) => b !== name);
    }

    await fsPromises.writeFile(pkgFile, JSON.stringify(pkg, null, 2) + '\n');

    // 2. 动态编排预检：内核能否正确解析包含该插件的 profile
    if (kernelDir && nodeBin && dshHome) {
      const dynamicCheck = await checkKernelDumpConfig({
        kernelDir,
        nodeBin,
        profileDir,
        dshHome,
        log,
      });
      if (!dynamicCheck.compatible) {
        throw new Error(`由于兼容性问题安装失败：${dynamicCheck.reason}`);
      }
    }

    log(`[guard] 插件 ${name} (v${installedVer}) 安装成功并通过内核兼容性检测，已默认启用`);
    return {
      ok: true,
      name,
      version: installedVer,
      range: pkg.dependencies[name],
    };
  } catch (err) {
    log(`[guard] 安装插件 ${name} 失败: ${err.message}，正在回滚…`);
    await fsPromises.copyFile(path.join(backupDir, 'package.json'), pkgFile).catch(() => {});
    if (hadPatchFile) {
      await fsPromises.copyFile(path.join(backupDir, 'cordis.patch.yml'), patchFile).catch(() => {});
    } else if (fsSync.existsSync(patchFile)) {
      await fsPromises.unlink(patchFile).catch(() => {});
    }
    // 清理该插件已安装的文件目录
    const modDir = path.join(profileDir, 'node_modules', ...name.split('/'));
    if (fsSync.existsSync(modDir)) {
      await fsPromises.rm(modDir, { recursive: true, force: true }).catch(() => {});
    }
    return {
      ok: false,
      name,
      error: err.message,
    };
  }
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

async function togglePluginBundle(profileDir, pluginName, enable = true) {
  const pkgFile = path.join(profileDir, 'package.json');
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const pkg = readJson(pkgFile);
  if (!pkg) throw new Error('profile 目录不存在或 package.json 无效');

  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  const bundles = (pkg.dsh.profile.bundles || []).map(String);
  const disabledBundles = (pkg.dsh.profile.disabledBundles || []).map(String);
  const isBundle = isBundlePackage(profileDir, pluginName);

  let patchContent = fsSync.existsSync(patchFile) ? fsSync.readFileSync(patchFile, 'utf8') : '';

  if (isBundle) {
    if (enable) {
      if (!bundles.includes(pluginName)) bundles.push(pluginName);
      pkg.dsh.profile.disabledBundles = disabledBundles.filter((b) => b !== pluginName);
      pkg.dsh.profile.bundles = [...new Set(bundles)];
    } else {
      if (!disabledBundles.includes(pluginName)) disabledBundles.push(pluginName);
      pkg.dsh.profile.disabledBundles = [...new Set(disabledBundles)];
      pkg.dsh.profile.bundles = bundles.filter((b) => b !== pluginName);
    }
  } else {
    // 非 bundle 插件：绝不能在 bundles 中，通过 cordis.patch.yml 挂载启用或移除停用
    pkg.dsh.profile.bundles = bundles.filter((b) => b !== pluginName);
    if (enable) {
      patchContent = appendPatchInsert(patchContent, pluginName);
      pkg.dsh.profile.disabledBundles = disabledBundles.filter((b) => b !== pluginName);
      await fsPromises.writeFile(patchFile, patchContent);
    } else {
      patchContent = stripForeignInsertBlocks(patchContent, new Set([pluginName]));
      if (!disabledBundles.includes(pluginName)) disabledBundles.push(pluginName);
      pkg.dsh.profile.disabledBundles = [...new Set(disabledBundles)];
      await fsPromises.writeFile(patchFile, patchContent);
    }
  }

  await fsPromises.writeFile(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
  return { ok: true, name: pluginName, enabled: enable, bundles: pkg.dsh.profile.bundles };
}

module.exports = {
  isOfficial,
  inventoryProfile,
  parsePatchInserts,
  stripForeignInsertBlocks,
  appendPatchInsert,
  isBundlePackage,
  removePluginsFromProfile,
  sanitizeProfile,
  installPluginToProfile,
  checkPluginKernelCompatibility,
  togglePluginBundle,
  markSanitized,
  hasSanitizeMarker,
  createRegistryChecker,
  createGitHubChecker,
  parseGitHubSpec,
  parseRepoUrl,
  getInstalledGitCommit,
  checkProfileUpdates,
  updatePlugin,
  updatePlugins,
  compareRangeToLatest,
  CANONICAL_PKG,
};
