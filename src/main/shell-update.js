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
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
    const release = await res.json();
    const rawTag = release && release.tag_name;
    if (typeof rawTag !== 'string' || !rawTag) throw new Error('release 无 tag_name 字段');
    const latestTag = rawTag.replace(/^v/i, '');
    const hasUpdate = compareVersions(latestTag, currentVersion) > 0;
    return { latestTag, htmlUrl: release.html_url || null, hasUpdate };
  } catch (err) {
    log(`[shell-update] 检测容器更新失败：${err.message}`);
    return null;
  }
}

module.exports = { checkShellUpdate, DEFAULT_REPO };
