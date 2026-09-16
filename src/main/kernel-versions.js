'use strict';

/**
 * 拉取 @deepseek-ai/dsh 在 npm registry 上已发布的全部版本，供内核多版本管理界面使用。
 * 与 Electron 完全解耦，可脱离 UI 用纯 node 测试。
 */

const { DSH_PACKAGE_ENCODED } = require('./config');

const REGISTRY_PACKAGE_URL = `https://registry.npmjs.org/${DSH_PACKAGE_ENCODED}`;

/**
 * 根据版本号本身推断分类。截至设计时官方从未发布过不带预发布后缀的正式版，
 * 'stable' 分支是为未来官方真的发布正式版做的兼容。
 */
function classifyTag(version) {
  if (version.includes('-alpha.')) return 'alpha';
  if (version.includes('-rc.')) return 'rc';
  return 'stable';
}

/**
 * 拉取全部已发布版本（按发布时间倒序），并标记 npm latest dist-tag 对应项为 recommended。
 * 网络失败或响应格式异常时返回 null（离线容忍），调用方据此展示"检测失败，点击重试"。
 */
async function fetchAllKernelVersions({ log = () => {} } = {}) {
  try {
    const res = await fetch(REGISTRY_PACKAGE_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
    const manifest = await res.json();
    const versions = manifest && manifest.versions;
    if (!versions || typeof versions !== 'object') throw new Error('manifest 无 versions 字段');
    const time = manifest.time || {};
    const latestTag = manifest['dist-tags']?.latest || null;

    const entries = Object.keys(versions)
      .map((version) => ({
        version,
        publishedAt: time[version] || null,
        tag: classifyTag(version),
        recommended: version === latestTag,
      }))
      .sort((a, b) => {
        const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
        const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
        return tb - ta;
      });

    return { latestTag, entries };
  } catch (err) {
    log(`[kernel-versions] 拉取版本列表失败：${err.message}`);
    return null;
  }
}

const DEFAULT_KERNEL_REPO = 'deepseek-ai/deepseek-harness';

/**
 * 规范化 GitHub Release tag 为与 npm 一致的版本号。
 * 例如：'dsh-v0.1.5-rc.1' -> '0.1.5-rc.1', 'v0.1.5-alpha.2' -> '0.1.5-alpha.2'。
 */
function normalizeReleaseTag(tag) {
  if (typeof tag !== 'string' || !tag) return '';
  return tag.replace(/^dsh-v?/i, '').replace(/^v/i, '').trim();
}

let changelogsCache = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedGhToken = undefined;
let lastTokenCheck = 0;

function getGitHubHeaders() {
  const headers = {
    accept: 'application/vnd.github+json',
    'User-Agent': 'DSH-Desktop',
  };
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) {
    headers['Authorization'] = `Bearer ${envToken}`;
    return headers;
  }
  const now = Date.now();
  if (cachedGhToken !== undefined && now - lastTokenCheck < 60_000) {
    if (cachedGhToken) headers['Authorization'] = `Bearer ${cachedGhToken}`;
    return headers;
  }
  lastTokenCheck = now;
  try {
    const { execSync } = require('node:child_process');
    cachedGhToken = execSync('gh auth token', {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    cachedGhToken = null;
  }
  if (cachedGhToken) headers['Authorization'] = `Bearer ${cachedGhToken}`;
  return headers;
}

/**
 * 当 GitHub API 受限或网络异常时，从公开的 releases.atom 降级拉取版本列表（不受 API 60次/小时限流约束）
 */
async function fetchReleasesFromAtom(repo, { log = () => {} } = {}) {
  try {
    const res = await fetch(`https://github.com/${repo}/releases.atom`, {
      headers: {
        'User-Agent': 'DSH-Desktop',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Atom HTTP ${res.status}`);
    const text = await res.text();
    const entries = text.split('<entry>').slice(1);
    const changelogs = {};
    for (const entry of entries) {
      const titleMatch = entry.match(/<title>([^<]+)<\/title>/);
      const updatedMatch = entry.match(/<updated>([^<]+)<\/updated>/);
      const linkMatch = entry.match(/<link rel="alternate" type="text\/html" href="([^"]+)"\/>/);
      const contentMatch = entry.match(/<content type="html">([\s\S]*?)<\/content>/);
      const title = titleMatch ? titleMatch[1].trim() : '';
      const ver = normalizeReleaseTag(title);
      if (!ver) continue;
      let body = contentMatch ? contentMatch[1] : '';
      body = body
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
      if (!changelogs[ver]) {
        changelogs[ver] = {
          version: ver,
          tag: title,
          name: title,
          publishedAt: updatedMatch ? updatedMatch[1] : null,
          body,
          htmlUrl: linkMatch ? linkMatch[1] : `https://github.com/${repo}/releases/tag/${title}`,
        };
      }
    }
    return Object.keys(changelogs).length > 0 ? changelogs : null;
  } catch (err) {
    log(`[kernel-versions] Atom 降级拉取失败：${err.message}`);
    return null;
  }
}

/**
 * 从 GitHub Releases 拉取内核更新记录，并构建版本号到 Release 详情的映射表。
 * 遇到 API 限流（403）时自动降级从 releases.atom 拉取。
 */
async function fetchKernelReleases({
  repo = DEFAULT_KERNEL_REPO,
  bypassCache = false,
  log = () => {},
} = {}) {
  const now = Date.now();
  if (!bypassCache && changelogsCache && now - changelogsCache.timestamp < CACHE_TTL_MS) {
    return changelogsCache.data;
  }

  try {
    const headers = getGitHubHeaders();
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const releases = await res.json();
      if (Array.isArray(releases)) {
        const changelogs = {};
        for (const rel of releases) {
          const tag = rel && rel.tag_name;
          const ver = normalizeReleaseTag(tag);
          if (!ver) continue;
          if (!changelogs[ver]) {
            changelogs[ver] = {
              version: ver,
              tag,
              name: rel.name || `v${ver}`,
              publishedAt: rel.published_at || null,
              body: rel.body || '',
              htmlUrl: rel.html_url || `https://github.com/${repo}/releases/tag/${tag}`,
            };
          }
        }

        changelogsCache = { timestamp: now, data: changelogs };
        return changelogs;
      }
    }
    log(`[kernel-versions] 拉取 GitHub Releases HTTP ${res.status}，尝试 Atom 降级…`);
  } catch (err) {
    log(`[kernel-versions] 拉取 GitHub Releases 失败：${err.message}，尝试 Atom 降级…`);
  }

  // Atom 降级
  const atomReleases = await fetchReleasesFromAtom(repo, { log });
  if (atomReleases) {
    changelogsCache = { timestamp: now, data: atomReleases };
    return atomReleases;
  }

  return null;
}

function clearKernelReleasesCache() {
  changelogsCache = null;
}

module.exports = {
  fetchAllKernelVersions,
  classifyTag,
  normalizeReleaseTag,
  fetchKernelReleases,
  clearKernelReleasesCache,
  fetchReleasesFromAtom,
  REGISTRY_PACKAGE_URL,
  DEFAULT_KERNEL_REPO,
};
