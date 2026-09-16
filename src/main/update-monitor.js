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
 *
 * 可靠性保障（更新标记不能"闪烁"）：
 *   - 粘性结果：壳/内核单次检测失败（网络异常、GitHub 限流 403）时沿用最近一次成功的结果，
 *     已确认的更新不会被后续失败清掉；只有检测成功且确认无新版后才解除。
 *   - 落盘恢复：壳的粘性结果可写入 persistPath，重启后即使首次检测失败也能立即显示更新标记；
 *     hasUpdate 始终用缓存的 latestTag 与当前版本重新比较，升级后不会误报。
 *   - 快速重试：检测失败时按 retryIntervalMs（默认 90 秒）重试，成功后恢复 intervalMs（默认 30 分钟）。
 *   - ingest()：「检查更新」窗口完成实时检测后把结果同步回监测器，升级徽标即时反映，不再等轮询。
 */

const fsSync = require('node:fs');
const path = require('node:path');
const { compareVersions } = require('./semver');

/**
 * 版本阶段权重，用于判定预发布版本是否符合升级条件：
 * alpha/beta 等预览版 < rc 候选版 < stable 正式版
 */
const TAG_WEIGHT = {
  alpha: 1,
  beta: 1,
  rc: 2,
  stable: 3,
};

function getTagWeight(tag) {
  return TAG_WEIGHT[tag] || 1;
}

/**
 * 推断内核版本分类标签（如果 entry 中已有 tag 则优先使用）
 */
function inferKernelTag(version) {
  if (typeof version !== 'string') return 'stable';
  if (/-alpha[.-]/i.test(version)) return 'alpha';
  if (/-beta[.-]/i.test(version)) return 'beta';
  if (/-rc[.-]/i.test(version)) return 'rc';
  if (version.includes('-')) return 'alpha';
  return 'stable';
}

/**
 * 在 entries 与 latestTag 中寻找最适合升级的目标版本：
 * 1. 目标版本必须 semver 严格大于已下载/安装的最高版本（避免用户已下载新版后切换回旧版时重复显示升级提示）
 * 2. 候选版本的稳定性等级需 >= 基准版本（例如当前是 rc，则不推荐更低阶的 alpha，但推荐同级 rc 或更高阶 stable）
 * 3. 若版本为 npm 官方推荐版（latestTag 或 recommended: true），无论分类一律符合推荐条件
 * 4. 多个候选版本中，选取 semver 最高的版本作为最新可用版本
 */
function findBestKernelCandidate(activeKernelVersion, entries = [], latestTag = null, installedVersions = []) {
  if (!activeKernelVersion) return null;
  const allInstalled = [activeKernelVersion, ...(Array.isArray(installedVersions) ? installedVersions : [])].filter(Boolean);
  const baselineVersion = allInstalled.reduce((max, cur) => {
    return (!max || compareVersions(cur, max) > 0) ? cur : max;
  }, activeKernelVersion);

  const currentTag = inferKernelTag(baselineVersion || activeKernelVersion);
  const currentWeight = getTagWeight(currentTag);

  let bestVersion = null;

  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const v = typeof entry === 'string' ? entry : entry?.version;
      if (!v) continue;
      // 必须严格高于本地已下载/安装的最高版本
      if (compareVersions(v, baselineVersion) <= 0) continue;

      const tag = (typeof entry === 'object' && entry?.tag) ? entry.tag : inferKernelTag(v);
      const weight = getTagWeight(tag);
      const isRecommended = v === latestTag || (typeof entry === 'object' && Boolean(entry?.recommended));

      if (weight >= currentWeight || isRecommended) {
        if (!bestVersion || compareVersions(v, bestVersion) > 0) {
          bestVersion = v;
        }
      }
    }
  }

  // 兜底保障：若 latestTag 高于已下载的最高版本，也纳入比较
  if (latestTag && compareVersions(latestTag, baselineVersion) > 0) {
    if (!bestVersion || compareVersions(latestTag, bestVersion) > 0) {
      bestVersion = latestTag;
    }
  }

  return bestVersion;
}

/**
 * 纯逻辑函数：根据传入的版本信息计算更新汇总
 * @param {object} params
 * @param {string} params.currentShellVersion 壳应用当前版本
 * @param {object|null} params.shellInfo 包含 latestTag, hasUpdate 等
 * @param {string} params.activeKernelVersion 内核当前激活版本
 * @param {string|null} params.kernelLatestTag 内核最新推荐标签
 * @param {Array|null} [params.kernelEntries] 内核全部已发布版本列表
 * @param {Array} [params.installedKernelVersions] 本地已下载/安装过的内核版本列表
 * @param {{hasUpdate: boolean, count: number}|null} params.pluginsInfo 插件更新缓存汇总
 * @returns {{hasUpdate: boolean, shell: object, kernel: object, plugins: {hasUpdate: boolean, count: number}}}
 */
function computeUpdateOverview({
  currentShellVersion = '0.0.0',
  shellInfo = null,
  activeKernelVersion = '0.0.0',
  kernelLatestTag = null,
  kernelEntries = null,
  installedKernelVersions = [],
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
  let kernelLatest = kernelLatestTag;

  const candidateVersion = findBestKernelCandidate(
    activeKernelVersion,
    kernelEntries,
    kernelLatestTag,
    installedKernelVersions,
  );
  if (candidateVersion) {
    kernelHasUpdate = true;
    kernelLatest = candidateVersion;
  } else if (kernelLatestTag && activeKernelVersion) {
    // 仅在未提供 installedKernelVersions 或 latestTag 确实高于最高已安装版本时触发
    const allInstalled = [activeKernelVersion, ...(Array.isArray(installedKernelVersions) ? installedKernelVersions : [])].filter(Boolean);
    const baseline = allInstalled.reduce((max, cur) => (!max || compareVersions(cur, max) > 0) ? cur : max, activeKernelVersion);
    if (compareVersions(kernelLatestTag, baseline) > 0) {
      kernelHasUpdate = true;
      kernelLatest = kernelLatestTag;
    }
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
      latest: kernelLatest,
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
 * @param {() => string} [options.getCurrentShellVersion] 壳当前版本的实时来源；沿用粘性结果时用它重新比较，避免升级后误报
 * @param {string} [options.persistPath] 壳粘性结果落盘路径；重启后无需等网络即可恢复更新标记
 * @param {(msg: string) => void} [options.log]
 * @param {number} [options.intervalMs] 常规检查间隔（默认 30 分钟）
 * @param {number} [options.retryIntervalMs] 检测失败后的快速重试间隔（默认 90 秒）
 */
function createUpdateMonitor({
  getShellInfo,
  getKernelInfo,
  getPluginsInfo,
  onStatusChange = () => {},
  getCurrentShellVersion = null,
  persistPath = null,
  log = () => {},
  intervalMs = 30 * 60 * 1000,
  retryIntervalMs = 90 * 1000,
}) {
  let timer = null;
  let started = false;
  let nextDelayMs = intervalMs;
  let runningCheck = null;
  let cachedStatus = {
    hasUpdate: false,
    shell: { current: null, latest: null, hasUpdate: false },
    kernel: { current: null, latest: null, hasUpdate: false },
    plugins: { hasUpdate: false, count: 0 },
  };
  // 最近一次成功的检测结果（粘性）：单次检测失败时沿用，更新标记不因失败被清掉
  let lastGoodShell = loadPersistedShell();
  let lastGoodKernel = null;

  function loadPersistedShell() {
    if (!persistPath) return null;
    try {
      const raw = JSON.parse(fsSync.readFileSync(persistPath, 'utf8'));
      const latest = raw?.shell?.latest;
      if (latest && typeof latest.latestTag === 'string') {
        return { currentVersion: null, latest };
      }
    } catch {}
    return null;
  }

  function persistShell() {
    if (!persistPath || !lastGoodShell?.latest) return;
    try {
      fsSync.mkdirSync(path.dirname(persistPath), { recursive: true });
      fsSync.writeFileSync(
        persistPath,
        JSON.stringify({ shell: { latest: lastGoodShell.latest }, savedAt: new Date().toISOString() }, null, 2) + '\n',
      );
    } catch {}
  }

  function resolveCurrentShellVersion() {
    return (
      (typeof getCurrentShellVersion === 'function' && getCurrentShellVersion()) ||
      cachedStatus.shell.current ||
      '0.0.0'
    );
  }

  /** 粘性壳结果：hasUpdate 用 latestTag 与当前版本实时重新比较（缓存里的布尔值可能是过期版本算的） */
  function stickyShellSource() {
    if (!lastGoodShell?.latest) return null;
    const currentVersion = resolveCurrentShellVersion();
    const { latestTag } = lastGoodShell.latest;
    return {
      currentVersion,
      latest: {
        ...lastGoodShell.latest,
        hasUpdate: compareVersions(latestTag, currentVersion) > 0,
      },
    };
  }

  function applyResults({ shellSource, kernelSource, pluginsData }) {
    const newStatus = computeUpdateOverview({
      currentShellVersion: shellSource?.currentVersion || resolveCurrentShellVersion(),
      shellInfo: shellSource?.latest || null,
      activeKernelVersion: kernelSource?.activeVersion || cachedStatus.kernel.current || '0.0.0',
      kernelLatestTag: kernelSource?.latestTag || null,
      kernelEntries: kernelSource?.entries || null,
      installedKernelVersions: kernelSource?.installedVersions || [],
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
  }

  function scheduleNext(delayMs) {
    if (!started) return;
    clearTimeout(timer);
    nextDelayMs = delayMs;
    timer = setTimeout(() => {
      checkNow().catch(() => {});
    }, delayMs);
    timer.unref?.();
  }

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

        // 检测成功（拿到了 latestTag / 版本列表）才刷新粘性结果
        const shellOk = Boolean(shellData && shellData.latest != null);
        const kernelOk = Boolean(kernelData && (kernelData.latestTag != null || kernelData.entries != null));
        if (shellOk) {
          lastGoodShell = shellData;
          persistShell();
        }
        if (kernelOk) {
          lastGoodKernel = kernelData;
        }

        const status = applyResults({
          shellSource: shellOk ? shellData : stickyShellSource(),
          kernelSource: kernelOk ? kernelData : lastGoodKernel,
          pluginsData: pluginsData || null,
        });

        if (!shellOk && lastGoodShell?.latest) {
          log(`[update-monitor] 壳检测失败，沿用上次结果（可升至 ${lastGoodShell.latest.latestTag}），更新标记保持`);
        }
        if (!kernelOk && lastGoodKernel) {
          log('[update-monitor] 内核检测失败，沿用上次结果');
        }

        // 任一检测失败 → 快速重试；全部成功 → 恢复常规间隔
        scheduleNext(!shellOk || !kernelOk ? Math.min(retryIntervalMs, intervalMs) : intervalMs);
        return status;
      } finally {
        runningCheck = null;
      }
    })();

    return runningCheck;
  }

  /**
   * 「检查更新」窗口完成实时检测后，把结果同步回监测器（不触发新的网络请求）。
   * 用户在窗口里看到容器/内核有新版后，侧边栏升级徽标立即出现，无需等待下一次轮询。
   * @param {{shell?: {currentVersion: string, latest: object|null}|null, kernel?: {activeVersion: string|null, latestTag: string|null, entries?: Array|null, installedVersions?: string[]}|null}} [results]
   */
  function ingest({ shell = null, kernel = null } = {}) {
    const shellFresh = Boolean(shell && shell.latest != null);
    const kernelFresh = Boolean(kernel && (kernel.latestTag != null || kernel.entries != null));
    if (shellFresh) {
      lastGoodShell = shell;
      persistShell();
    }
    if (kernelFresh) {
      lastGoodKernel = kernel;
    }
    return applyResults({
      shellSource: shellFresh ? shell : stickyShellSource(),
      kernelSource: kernelFresh ? kernel : lastGoodKernel,
      pluginsData: cachedStatus.plugins,
    });
  }

  function start() {
    if (started) return Promise.resolve(cachedStatus);
    started = true;
    return checkNow().catch(() => cachedStatus);
  }

  function stop() {
    started = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function getStatus() {
    return cachedStatus;
  }

  /** 当前已排队的下次检查间隔（测试用） */
  function getNextDelayMs() {
    return nextDelayMs;
  }

  return {
    start,
    stop,
    checkNow,
    getStatus,
    ingest,
    getNextDelayMs,
  };
}

module.exports = {
  findBestKernelCandidate,
  computeUpdateOverview,
  createUpdateMonitor,
};
