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

/**
 * 从 GitHub Releases 拉取内核更新记录，并构建版本号到 Release 详情的映射表。
 * 网络失败或响应异常时返回 null。
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
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
      headers: {
        accept: 'application/vnd.github+json',
        'User-Agent': 'DSH-Desktop',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
    const releases = await res.json();
    if (!Array.isArray(releases)) throw new Error('releases 返回非数组');

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
  } catch (err) {
    log(`[kernel-versions] 拉取 GitHub Releases 失败：${err.message}`);
    return null;
  }
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
  REGISTRY_PACKAGE_URL,
  DEFAULT_KERNEL_REPO,
};
