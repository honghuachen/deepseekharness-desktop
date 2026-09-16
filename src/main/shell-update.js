'use strict';

/**
 * 查 GitHub Releases 判断容器（壳 APP 本身）是否有新版；只做检测，不下载安装——
 * 当前未签名/未公证，自动安装的工程量和现有基础设施不匹配。
 */

const { compareVersions } = require('./semver');

const DEFAULT_REPO = 'honghuachen/deepseekharness-desktop';

/**
 * 网络失败、限流或没有任何 Release 时返回 null（离线容忍），
 * 调用方据此展示"无法连接 GitHub，点击重试"。
 */
async function checkShellUpdate(currentVersion, { repo = DEFAULT_REPO, log = () => {} } = {}) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        accept: 'application/vnd.github+json',
        'User-Agent': 'DSH-Desktop',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
    const release = await res.json();
    const rawTag = release && release.tag_name;
    if (typeof rawTag !== 'string' || !rawTag) throw new Error('release 无 tag_name 字段');
    const latestTag = rawTag.replace(/^v/i, '');
    const hasUpdate = compareVersions(latestTag, currentVersion) > 0;
    return {
      latestTag,
      htmlUrl: release.html_url || null,
      hasUpdate,
      body: release.body || '',
      publishedAt: release.published_at || null,
    };
  } catch (err) {
    log(`[shell-update] 检测容器更新失败：${err.message}`);
    return null;
  }
}

function normalizeShellReleaseTag(tag) {
  if (typeof tag !== 'string' || !tag) return '';
  return tag.replace(/^v/i, '').trim();
}

let shellChangelogsCache = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 从 GitHub Releases 拉取壳应用更新记录，并构建版本号到 Release 详情的映射表。
 * 网络失败或响应异常时返回 null。
 */
async function fetchShellReleases({
  repo = DEFAULT_REPO,
  bypassCache = false,
  log = () => {},
} = {}) {
  const now = Date.now();
  if (!bypassCache && shellChangelogsCache && now - shellChangelogsCache.timestamp < CACHE_TTL_MS) {
    return shellChangelogsCache.data;
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
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
      const ver = normalizeShellReleaseTag(tag);
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

    shellChangelogsCache = { timestamp: now, data: changelogs };
    return changelogs;
  } catch (err) {
    log(`[shell-update] 拉取 GitHub Releases 失败：${err.message}`);
    return null;
  }
}

function clearShellReleasesCache() {
  shellChangelogsCache = null;
}

module.exports = {
  checkShellUpdate,
  fetchShellReleases,
  clearShellReleasesCache,
  normalizeShellReleaseTag,
  DEFAULT_REPO,
};
