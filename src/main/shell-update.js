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

function normalizeShellReleaseTag(tag) {
  if (typeof tag !== 'string' || !tag) return '';
  return tag.replace(/^v/i, '').trim();
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
      const ver = normalizeShellReleaseTag(title);
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
    log(`[shell-update] Atom 降级拉取失败：${err.message}`);
    return null;
  }
}

/**
 * 优先查 GitHub Releases API 判断容器（壳 APP 本身）是否有新版；
 * 若 API 受限（403）或网络错误，自动降级从 releases.atom 解析。
 */
async function checkShellUpdate(currentVersion, { repo = DEFAULT_REPO, log = () => {} } = {}) {
  try {
    const headers = getGitHubHeaders();
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const release = await res.json();
      const rawTag = release && release.tag_name;
      if (typeof rawTag === 'string' && rawTag) {
        const latestTag = rawTag.replace(/^v/i, '');
        const hasUpdate = compareVersions(latestTag, currentVersion) > 0;
        return {
          latestTag,
          htmlUrl: release.html_url || null,
          hasUpdate,
          body: release.body || '',
          publishedAt: release.published_at || null,
        };
      }
    }
    log(`[shell-update] GitHub API HTTP ${res.status}，尝试 Atom 降级…`);
  } catch (err) {
    log(`[shell-update] 检测容器更新失败：${err.message}，尝试 Atom 降级…`);
  }

  // Atom 降级
  const atomReleases = await fetchReleasesFromAtom(repo, { log });
  if (atomReleases) {
    const firstVer = Object.keys(atomReleases)[0];
    if (firstVer) {
      const rel = atomReleases[firstVer];
      const latestTag = rel.version;
      const hasUpdate = compareVersions(latestTag, currentVersion) > 0;
      return {
        latestTag,
        htmlUrl: rel.htmlUrl,
        hasUpdate,
        body: rel.body || '',
        publishedAt: rel.publishedAt || null,
      };
    }
  }

  return null;
}

let shellChangelogsCache = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 从 GitHub Releases 拉取壳应用更新记录，并构建版本号到 Release 详情的映射表。
 * 遇到 API 限流（403）时自动降级从 releases.atom 拉取。
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
    const headers = getGitHubHeaders();
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const releases = await res.json();
      if (Array.isArray(releases)) {
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
      }
    }
    log(`[shell-update] 拉取 GitHub Releases HTTP ${res.status}，尝试 Atom 降级…`);
  } catch (err) {
    log(`[shell-update] 拉取 GitHub Releases 失败：${err.message}，尝试 Atom 降级…`);
  }

  // Atom 降级
  const atomReleases = await fetchReleasesFromAtom(repo, { log });
  if (atomReleases) {
    shellChangelogsCache = { timestamp: now, data: atomReleases };
    return atomReleases;
  }

  return null;
}

function clearShellReleasesCache() {
  shellChangelogsCache = null;
}

module.exports = {
  checkShellUpdate,
  fetchShellReleases,
  clearShellReleasesCache,
  normalizeShellReleaseTag,
  fetchReleasesFromAtom,
  DEFAULT_REPO,
};
