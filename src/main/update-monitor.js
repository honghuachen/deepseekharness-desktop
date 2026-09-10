'use strict';

/**
 * 综合更新监测器：汇总壳应用（GitHub Releases）、内核（npm registry）与第三方插件的更新状态。
 *
 * 判定规则：
 *   - 壳应用有更新：GitHub Releases 最新 Tag 高于当前运行的 app.getVersion()
 *   - 内核有更新：npm registry 推荐 Tag（latestTag）高于当前激活的 activeVersion
 *   - 插件有更新：插件管理器「检查更新」缓存中存在 status === 'outdated' 的条目
 *     （只读已有缓存，不主动发起插件更新检查的网络请求）
 *   - 综合判定：三者之一有更新，即视为有更新可用（hasUpdate = true）
 */

const { compareVersions } = require('./semver');

/**
 * 纯逻辑函数：根据传入的版本信息计算更新汇总
 * @param {object} params
 * @param {string} params.currentShellVersion 壳应用当前版本
 * @param {object|null} params.shellInfo 包含 latestTag, hasUpdate 等
 * @param {string} params.activeKernelVersion 内核当前激活版本
 * @param {string|null} params.kernelLatestTag 内核最新推荐标签
 * @param {{hasUpdate: boolean, count: number}|null} params.pluginsInfo 插件更新缓存汇总
 * @returns {{hasUpdate: boolean, shell: object, kernel: object, plugins: {hasUpdate: boolean, count: number}}}
 */
function computeUpdateOverview({
  currentShellVersion = '0.0.0',
  shellInfo = null,
  activeKernelVersion = '0.0.0',
  kernelLatestTag = null,
  pluginsInfo = null,
} = {}) {
  let shellHasUpdate = false;
  const shellLatestTag = shellInfo?.latestTag || null;
  if (typeof shellInfo?.hasUpdate === 'boolean') {
    shellHasUpdate = shellInfo.hasUpdate;
  } else if (shellLatestTag && currentShellVersion) {
    shellHasUpdate = compareVersions(shellLatestTag, currentShellVersion) > 0;
  }

  let kernelHasUpdate = false;
  if (kernelLatestTag && activeKernelVersion) {
    kernelHasUpdate = compareVersions(kernelLatestTag, activeKernelVersion) > 0;
  }

  const pluginsHasUpdate = Boolean(pluginsInfo?.hasUpdate);
  const pluginsCount = Number(pluginsInfo?.count) || 0;

  return {
    hasUpdate: Boolean(shellHasUpdate || kernelHasUpdate || pluginsHasUpdate),
    shell: {
      current: currentShellVersion,
      latest: shellLatestTag,
      hasUpdate: shellHasUpdate,
    },
    kernel: {
      current: activeKernelVersion,
      latest: kernelLatestTag,
      hasUpdate: kernelHasUpdate,
    },
    plugins: {
      hasUpdate: pluginsHasUpdate,
      count: pluginsCount,
    },
  };
}

/**
 * 创建更新监测器实例
 * @param {object} options
 * @param {() => Promise<{currentVersion: string, latest: object|null}>} options.getShellInfo
 * @param {() => Promise<{activeVersion: string, latestTag: string|null}>} options.getKernelInfo
 * @param {() => ({hasUpdate: boolean, count: number}|Promise<{hasUpdate: boolean, count: number}>)} [options.getPluginsInfo] 读插件更新缓存（同步或异步均可），不传则不参与判定
 * @param {(status: object) => void} [options.onStatusChange]
 * @param {(msg: string) => void} [options.log]
 * @param {number} [options.intervalMs] 检查间隔（默认 30 分钟）
 */
function createUpdateMonitor({
  getShellInfo,
  getKernelInfo,
  getPluginsInfo,
  onStatusChange = () => {},
  log = () => {},
  intervalMs = 30 * 60 * 1000,
}) {
  let timer = null;
  let runningCheck = null;
  let cachedStatus = {
    hasUpdate: false,
    shell: { current: null, latest: null, hasUpdate: false },
    kernel: { current: null, latest: null, hasUpdate: false },
    plugins: { hasUpdate: false, count: 0 },
  };

  async function checkNow() {
    if (runningCheck) return runningCheck;

    runningCheck = (async () => {
      try {
        const [shellRes, kernelRes, pluginsRes] = await Promise.allSettled([
          Promise.resolve().then(() => getShellInfo?.()),
          Promise.resolve().then(() => getKernelInfo?.()),
          Promise.resolve().then(() => getPluginsInfo?.()),
        ]);

        const shellData = shellRes.status === 'fulfilled' ? shellRes.value : null;
        const kernelData = kernelRes.status === 'fulfilled' ? kernelRes.value : null;
        const pluginsData = pluginsRes.status === 'fulfilled' ? pluginsRes.value : null;

        if (shellRes.status === 'rejected') {
          log(`[update-monitor] 获取壳应用信息异常: ${shellRes.reason?.message || shellRes.reason}`);
        }
        if (kernelRes.status === 'rejected') {
          log(`[update-monitor] 获取内核信息异常: ${kernelRes.reason?.message || kernelRes.reason}`);
        }
        if (pluginsRes.status === 'rejected') {
          log(`[update-monitor] 获取插件更新缓存异常: ${pluginsRes.reason?.message || pluginsRes.reason}`);
        }

        const newStatus = computeUpdateOverview({
          currentShellVersion: shellData?.currentVersion || cachedStatus.shell.current || '0.0.0',
          shellInfo: shellData?.latest || null,
          activeKernelVersion: kernelData?.activeVersion || cachedStatus.kernel.current || '0.0.0',
          kernelLatestTag: kernelData?.latestTag || null,
          pluginsInfo: pluginsData || null,
        });

        const changed =
          newStatus.hasUpdate !== cachedStatus.hasUpdate ||
          newStatus.shell.hasUpdate !== cachedStatus.shell.hasUpdate ||
          newStatus.kernel.hasUpdate !== cachedStatus.kernel.hasUpdate ||
          newStatus.shell.latest !== cachedStatus.shell.latest ||
          newStatus.kernel.latest !== cachedStatus.kernel.latest ||
          newStatus.plugins.hasUpdate !== cachedStatus.plugins.hasUpdate ||
          newStatus.plugins.count !== cachedStatus.plugins.count;

        cachedStatus = newStatus;
        log(
          `[update-monitor] 检测完成: hasUpdate=${cachedStatus.hasUpdate} ` +
            `(shell=${cachedStatus.shell.hasUpdate ? `可升至 ${cachedStatus.shell.latest}` : '最新'}, ` +
            `kernel=${cachedStatus.kernel.hasUpdate ? `可升至 ${cachedStatus.kernel.latest}` : '最新'}, ` +
            `plugins=${cachedStatus.plugins.hasUpdate ? `${cachedStatus.plugins.count} 个有新版` : '最新'})`,
        );

        if (changed) {
          try {
            onStatusChange(cachedStatus);
          } catch (err) {
            log(`[update-monitor] onStatusChange 回调异常: ${err.message}`);
          }
        }
        return cachedStatus;
      } finally {
        runningCheck = null;
      }
    })();

    return runningCheck;
  }

  function start() {
    if (timer) return;
    checkNow().catch(() => {});
    timer = setInterval(() => {
      checkNow().catch(() => {});
    }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getStatus() {
    return cachedStatus;
  }

  return {
    start,
    stop,
    checkNow,
    getStatus,
  };
}

module.exports = {
  computeUpdateOverview,
  createUpdateMonitor,
};
