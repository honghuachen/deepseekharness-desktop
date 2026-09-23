'use strict';

/**
 * DSH Web —— 窗口化承载官方 DeepSeek Harness Web 壳的桌面容器。
 *
 * 启动流程：
 *   1. 解析 node 运行器（优先内置便携 node，其次系统 PATH node）
 *   2. 确定内核运行时：优先使用本地已安装版本直接启动（仅首次运行且无本地内核时才在线下载）
 *   3. 拉起官方 `dsh web` 服务，健康检查通过后用主窗口加载官方页面
 *   4. 就绪后在后台静默运行更新监测器，发现新版本通过侧边栏徽标与更新面板提示用户
 */

const { app, BrowserWindow, Menu, dialog, shell, ipcMain, nativeTheme } = require('electron');
const path = require('node:path');
const fsSync = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { makePaths, loadSettings, saveSettings, DEFAULT_PORT } = require('./config');
const { compareVersions } = require('./semver');
const { createUpdater } = require('./updater');
const { createKernelSwitcher } = require('./kernel-switch');
const {
  fetchAllKernelVersions,
  fetchKernelReleases,
  clearKernelReleasesCache,
} = require('./kernel-versions');
const {
  checkShellUpdate,
  fetchShellReleases,
  clearShellReleasesCache,
} = require('./shell-update');
const { createShellAutoUpdater } = require('./shell-auto-updater');
const { createUpdateMonitor } = require('./update-monitor');
const { createRunner } = require('./runner');
const { createBadgeWatcher } = require('./badge');
const { createLogger } = require('./logger');
const { createStatusWindow } = require('./status-window');
const { openPluginManager, getPluginUpdatesSummary, checkPluginUpdates } = require('./plugin-manager');
const { openAboutWindow } = require('./about-window');
const { openTokenUsageWindow } = require('./token-usage/window');
const { openUpdateWindow: openUpdateWindowImpl } = require('./update-window');
const { splashDataUrl } = require('./splash');

const execFileP = promisify(execFile);

// ─────────────────────────── 单实例锁 ───────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    focusMainWindow();
  });
}

// ─────────────────────────── 全局状态 ───────────────────────────
/** @type {ReturnType<makePaths>} */
let paths;
let logger;
let settings;
let updater;
let kernelSwitcher;
let runner;
let statusWin;
let mainWindow = null;
let isSplashActive = false;
let updateMonitor = null;
let activeVersion = null;
let activePort = DEFAULT_PORT;

// ── 任务完成角标状态 ──
let badgeWatcher = null;
let badgeCount = 0;
let badgePersistTimer = null;

const isPackaged = app.isPackaged;
const resourcesVendor = isPackaged
  ? path.join(process.resourcesPath, 'vendor')
  : path.join(__dirname, '..', '..', 'vendor');
// 开发期数据目录放仓库下，避免污染 ~/Library/Application Debug 数据
const dataRoot = isPackaged
  ? app.getPath('userData')
  : path.join(__dirname, '..', '..', '.data');

// ─────────────────────────── node 解析 ───────────────────────────

function tryBundledNode() {
  const dir = path.join(resourcesVendor, `node-${process.platform}-${process.arch}`);
  // Windows 发行版的 node.exe 在根目录；类 unix 在 bin/node
  const bin = process.platform === 'win32'
    ? path.join(dir, 'node.exe')
    : path.join(dir, 'bin', 'node');
  return fsSync.existsSync(bin) ? bin : null;
}

async function nodeSatisfies(bin) {
  try {
    const { stdout } = await execFileP(bin, ['--version'], { timeout: 5000 });
    const m = /v(\d+)\.(\d+)\.(\d+)/.exec(stdout);
    if (!m) return false;
    const [major, minor] = [Number(m[1]), Number(m[2])];
    // 对齐 @deepseek-ai/dsh 的 engines：^22.19.0 || >=24.0.0
    return (major === 22 && minor >= 19) || major >= 24;
  } catch {
    return false;
  }
}

async function whichNode() {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileP('where', ['node'], { timeout: 5000 });
      const first = stdout.split(/\r?\n/).find(Boolean)?.trim();
      if (first && (await nodeSatisfies(first))) return first;
    } catch {}
    return null;
  }
  const candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node'];
  try {
    const { stdout } = await execFileP('/usr/bin/which', ['node'], { timeout: 5000 });
    if (stdout.trim()) candidates.unshift(stdout.trim());
  } catch {}
  for (const c of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (fsSync.existsSync(c) && (await nodeSatisfies(c))) return c;
  }
  return null;
}

async function resolveNode() {
  const bundled = tryBundledNode();
  if (bundled) {
    logLine(`使用内置 Node: ${bundled}`);
    return bundled;
  }
  logLine('未找到内置 Node，尝试系统 PATH …');
  const sys = await whichNode();
  if (sys) {
    logLine(`使用系统 Node: ${sys}`);
    return sys;
  }
  return null;
}

// ─────────────────────────── 工具函数 ───────────────────────────

function logLine(text) {
  logger?.log(text);
}

function statusText(text) {
  logLine(text);
  if (mainWindow && !mainWindow.isDestroyed() && isSplashActive) {
    const clean = String(text).replace(/[\r\n]+/g, ' ');
    mainWindow.webContents
      .executeJavaScript(`if (window.__dshUpdateStatus) window.__dshUpdateStatus(${JSON.stringify(clean)})`)
      .catch(() => {});
  }
  statusWin?.push(text);
}

function pnpmCjsPath() {
  const p = path.join(resourcesVendor, 'pnpm', 'bin', 'pnpm.cjs');
  if (!fsSync.existsSync(p)) throw new Error(`缺少 ${p}，请先运行 npm run fetch-tools`);
  return p;
}

/**
 * 解析会话数据根（DSH_HOME）。
 * 默认官方标准 ~/.dsh —— 与官方 CLI 完全一致，会话历史无缝延续；
 * 可通过 settings.dshHome 或环境变量 DSH_WEB_APP_DSH_HOME 指向别处。
 */
function resolveDshHome() {
  const expand = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
  const explicit = settings.dshHome || process.env.DSH_WEB_APP_DSH_HOME || '';
  const home = explicit ? expand(explicit) : path.join(os.homedir(), '.dsh');
  fsSync.mkdirSync(home, { recursive: true });
  return home;
}

// ─────────────────────────── 任务完成角标 ───────────────────────────

function badgeStateFile() {
  return path.join(paths.rootDir, 'badge-state.json');
}

function applyBadge() {
  if (!app.isReady()) return;
  try {
    if (process.platform === 'darwin') {
      app.dock.setBadge(badgeCount > 0 ? String(badgeCount) : '');
    } else if (process.platform === 'win32') {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.flashFrame(badgeCount > 0);
      }
    } else if (typeof app.setBadgeCount === 'function') {
      app.setBadgeCount(Math.max(0, badgeCount));
    }
  } catch {}
}

/** 计数落盘（防抖 500ms），重启后可恢复未读数 */
function persistBadgeState() {
  clearTimeout(badgePersistTimer);
  badgePersistTimer = setTimeout(() => {
    try {
      fsSync.writeFileSync(badgeStateFile(), JSON.stringify({ count: badgeCount }));
    } catch {}
  }, 500);
}

function clearBadge() {
  const watcherHasCount = !!(badgeWatcher && typeof badgeWatcher.getCount === 'function' && badgeWatcher.getCount() > 0);
  if (badgeWatcher) {
    badgeWatcher.clear();
  }
  if (badgeCount === 0 && !watcherHasCount) return;
  badgeCount = 0;
  persistBadgeState();
  applyBadge();
}

function setupTaskBadge(dshHome) {
  if (!settings.taskBadge || badgeWatcher) return;
  // 恢复上次未读计数
  try {
    const raw = JSON.parse(fsSync.readFileSync(badgeStateFile(), 'utf8'));
    badgeCount = Number.isFinite(raw?.count) && raw.count > 0 ? Math.floor(raw.count) : 0;
  } catch {
    badgeCount = 0;
  }

  badgeWatcher = createBadgeWatcher({
    sessionsDir: path.join(dshHome, 'sessions'),
    log: logLine,
    onCount(c) {
      // 用户正盯着窗口时完成的新任务视为已读，不留角标并同步清空监听计数
      const focused = !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
      if (c > 0 && focused) {
        badgeCount = 0;
        badgeWatcher?.clear?.();
        return;
      }
      const prevCount = badgeCount;
      badgeCount = c;
      if (c === 0 && prevCount === 0) return;
      logLine(`[badge] onCount=${c} 窗口聚焦=${focused} → 计数 ${badgeCount}`);
      persistBadgeState();
      applyBadge();
    },
  });
  badgeWatcher.start(badgeCount);
  applyBadge();
}


/**
 * 确保官方 profile 干净（每个 DSH_HOME 只自动执行一次）：
 * 第三方社区插件与官方新版本常不兼容，会拖垮整个 web 服务。
 */
async function ensureOfficialProfile(dshHome, { force = false } = {}) {
  const { sanitizeProfile, markSanitized, hasSanitizeMarker } = require('./plugin-guard');
  if (!force && hasSanitizeMarker(dshHome)) return;
  const webProfile = path.join(dshHome, 'profiles', 'web');
  if (fsSync.existsSync(webProfile)) {
    const { changed, removed } = await sanitizeProfile(webProfile, { log: logLine });
    if (changed && removed.length) {
      statusText(`已移除不兼容的第三方插件：${removed.join('、')}`);
    }
  }
  await markSanitized(dshHome);
}

function ensureDirs() {
  fsSync.mkdirSync(paths.versionsDir, { recursive: true });
  fsSync.mkdirSync(paths.logsDir, { recursive: true });
}

// ─────────────────────────── 主窗口 ───────────────────────────

function createMainWindow(url) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (url) {
      isSplashActive = false;
      mainWindow.loadURL(url).catch(() => {});
    }
    focusMainWindow();
    return mainWindow;
  }

  isSplashActive = !url;
  const isDark = nativeTheme?.shouldUseDarkColors ?? true;
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    title: 'DSH Web',
    show: false,
    backgroundColor: isDark ? '#17181a' : '#f6f7f9',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      preload: path.join(__dirname, 'main-window-preload.cjs'),
    },
  });

  const initialUrl = url || splashDataUrl({ version: app.getVersion(), kernelVersion: activeVersion });
  mainWindow.loadURL(initialUrl);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    statusWin?.close();
  });

  // 页面加载完成后同步一次更新状态（仅在非 Splash 页面执行）
  mainWindow.webContents.on('did-finish-load', () => {
    if (!isSplashActive && updateMonitor && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:status-changed', updateMonitor.getStatus());
    }
  });

  // 用户查看窗口即视为已读：清空任务完成角标
  mainWindow.on('focus', () => clearBadge());

  // 开发诊断：DSH_WEB_DEV_SNAPSHOT=<路径> 时，页面加载完自动截窗保存
  if (process.env.DSH_WEB_DEV_SNAPSHOT || process.env.DSH_WEB_DEV_TEXTDUMP) {
    mainWindow.webContents.on('did-finish-load', () => {
      if (isSplashActive) return;
      setTimeout(async () => {
        try {
          if (process.env.DSH_WEB_DEV_SNAPSHOT) {
            const image = await mainWindow.webContents.capturePage();
            fsSync.writeFileSync(process.env.DSH_WEB_DEV_SNAPSHOT, image.toPNG());
            logLine(`[dev] 窗口快照已保存 ${process.env.DSH_WEB_DEV_SNAPSHOT}`);
          }
          if (process.env.DSH_WEB_DEV_TEXTDUMP) {
            const info = await mainWindow.webContents.executeJavaScript(
              `JSON.stringify({title: document.title, text: document.body.innerText.slice(0, 600), nodes: document.querySelectorAll('*').length})`,
            );
            fsSync.writeFileSync(process.env.DSH_WEB_DEV_TEXTDUMP, info);
            logLine(`[dev] DOM 文本已保存 ${process.env.DSH_WEB_DEV_TEXTDUMP}`);
          }
        } catch (err) {
          logLine(`[dev] 诊断失败: ${err.message}`);
        }
      }, 4000);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    isSplashActive = false;
  });

  // 官方页面的外链交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith(`http://127.0.0.1:${activePort}`)) {
      shell.openExternal(target);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  return mainWindow;
}

function navigateToApp(url) {
  isSplashActive = false;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow(url);
    return;
  }
  mainWindow.loadURL(url).catch((err) => {
    logLine(`[main] loadURL 失败: ${err.message}`);
  });
}

function focusMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

// ─────────────────────────── 关于面板 ───────────────────────────

/**
 * 自定义"关于"窗口：原生 About 面板（macOS setAboutPanelOptions / Windows 消息框）
 * 都不支持在版本信息里放可点击链接，所以用独立窗口展示，并可跳转容器/内核各自的 GitHub 仓库。
 */
function showAbout() {
  try {
    openAboutWindow({
      activeVersion,
      kernelDir: activeVersion ? paths.versionDir(activeVersion) : null,
    });
  } catch (err) {
    dialog.showMessageBox({ type: 'error', message: '无法打开关于窗口', detail: String(err.message || err) });
  }
}

// ─────────────────────────── 更新 + 启动编排 ───────────────────────────

async function bootstrap({ isFirstBootOfApp = true } = {}) {
  ensureDirs();

  const nodeBin = await resolveNode();
  if (!nodeBin) {
    throw new Error(
      '未找到可用的 Node.js（需要 v22.19+ 或 v24+）。\n' +
        '请安装：brew install node@22\n' +
        '或重新打包以内置便携 Node（npm run dist）。',
    );
  }

  updater = createUpdater({ nodeBin, pnpmCjs: pnpmCjsPath(), paths, log: logLine });
  kernelSwitcher = createKernelSwitcher({ updater, settings, paths, saveSettings, log: logLine });
  runner = createRunner({ nodeBin, paths, log: logLine });

  let installed;
  if (settings.pinnedKernelVersion) {
    // 1. 用户手动固定了版本：检查本地是否已完整安装
    const pinned = settings.pinnedKernelVersion;
    if (updater.isVersionComplete(pinned)) {
      statusText(`使用固定内核版本 ${pinned}…`);
      const current = await updater.getCurrentVersion();
      if (current !== pinned) {
        await updater.activate(pinned);
      }
      installed = pinned;
    } else {
      statusText(`下载并安装固定内核版本 ${pinned}…`);
      await updater.install(pinned, statusText);
      await updater.activate(pinned);
      installed = pinned;
      recordDownloadedKernel(installed);
      await updater.prune(2, [installed]);
    }
  } else {
    // 2. 跟随模式：优先使用本地已安装且完备的内核秒起服务，彻底移除启动期的外网同步阻塞
    const current = await updater.getCurrentVersion();
    if (current && updater.isVersionComplete(current)) {
      installed = current;
      statusText(`使用本地内核版本 ${installed}…`);
    } else {
      // 容错自愈：当前软链接若异常，尝试查找本地其他完整安装的版本
      const installedCandidates = getInstalledKernelVersions().filter((v) => updater.isVersionComplete(v));
      if (installedCandidates.length > 0) {
        installedCandidates.sort((a, b) => compareVersions(b, a));
        installed = installedCandidates[0];
        statusText(`恢复使用本地已装内核 ${installed}…`);
        await updater.activate(installed);
      } else {
        // 本地没有任何可用运行时（全新首次运行）：阻断查询 registry 并执行初始安装
        statusText('首次运行：正在查询官方最新运行时…');
        const latest = await updater.getLatestVersion();
        if (!latest) {
          throw new Error(
            '本地没有任何官方运行时，且无法连接 npm registry。\n请检查网络连接后重试。',
          );
        }
        statusText(`首次运行：正在安装官方运行时 ${latest}…`);
        await updater.install(latest, statusText);
        await updater.activate(latest);
        installed = latest;
        recordDownloadedKernel(installed);
        await updater.prune(2, [installed]);
      }
    }
  }
  recordDownloadedKernel(installed);

  activeVersion = installed;
  if (settings.pinnedKernelVersion !== installed) {
    settings.pinnedKernelVersion = installed;
    saveSettings(paths, settings);
  }
  const dshHome = resolveDshHome();
  await ensureOfficialProfile(dshHome);

  // 状态窗口与主窗口启动屏标题同时带上容器与内核版本
  if (mainWindow && !mainWindow.isDestroyed() && isSplashActive) {
    mainWindow.webContents
      .executeJavaScript(
        `if (window.__dshUpdateStatus) window.__dshUpdateStatus("启动官方 Web 服务…", "v${app.getVersion()} · 内核 v${activeVersion}")`
      )
      .catch(() => {});
  }
  statusWin?.setTitle(`DSH Web v${app.getVersion()} · 内核 v${activeVersion}`);
  statusText(`启动官方 Web 服务（v${activeVersion}）…`);

  // setupTaskBadge 启动后台监听，不阻塞核心服务拉起
  setupTaskBadge(dshHome);

  const { url, port } = await runner.start(activeVersion, settings.port, {
    isFirstBoot: isFirstBootOfApp,
    envOverride: { DSH_HOME: dshHome },
  });
  activePort = port;
  navigateToApp(url);

  if (!updateMonitor) {
    updateMonitor = createUpdateMonitor({
      getShellInfo,
      getKernelInfo,
      getPluginsInfo,
      onStatusChange(status) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update:status-changed', status);
        }
      },
      // 沿用粘性结果时用当前版本重新比较，避免升级后误报
      getCurrentShellVersion: () => app.getVersion(),
      // 壳更新粘性结果落盘：重启后即使首次 GitHub 检测失败（限流/断网），升级徽标也立即恢复
      persistPath: path.join(paths.rootDir, 'update-monitor-cache.json'),
      retryIntervalMs: 90 * 1000,
      log: logLine,
    });
    updateMonitor.start();
  } else {
    updateMonitor.checkNow().catch(() => {});
  }

  // 插件更新以前只会在插件管理器点击“检查全部更新”时访问 npm/GitHub；
  // 因此重启后的监测器只能读取旧缓存，永远发现不了刚发布的新版。服务和主窗口
  // 就绪后在后台检查一次，不阻塞应用启动；完成后立即让更新监测器读取新缓存。
  logLine('[plugins] 启动后台检查第三方插件更新…');
  checkPluginUpdates(dshHome, { log: logLine })
    .then(() => updateMonitor?.checkNow())
    .catch((err) => logLine(`[plugins] 启动后台检查第三方插件更新失败：${err.message}`));

  // 开发诊断：DSH_WEB_DEV_PM=1 时自动打开插件管理器
  if (process.env.DSH_WEB_DEV_PM) {
    setTimeout(() => {
      try {
        openManager();
      } catch {}
    }, 3000);
  }
  // 开发诊断：DSH_WEB_DEV_UPDATE=1 时自动打开检查更新窗口
  if (process.env.DSH_WEB_DEV_UPDATE) {
    setTimeout(() => {
      try {
        openUpdateWindow();
      } catch {}
    }, 3000);
  }
  return url;
}

/** 服务意外退出时的自动重启（最多 3 次，指数退避）；崩溃源于坏插件时先清洗再试 */
let restartAttempts = 0;
let appQuitting = false;

function handleServerExit({ code, signal }) {
  if (appQuitting || !app.isReady()) return;
  logLine(`[runner] 服务意外退出 (code=${code} signal=${signal})`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    isSplashActive = true;
    mainWindow
      .loadURL(splashDataUrl({ version: app.getVersion(), kernelVersion: activeVersion }))
      .then(() => {
        statusText('服务连接中断，正在自动重启…');
      })
      .catch(() => {});
  }
  const attempt = async () => {
    const { hasSanitizeMarker } = require('./plugin-guard');
    const dshHome = resolveDshHome();

    // 从未清洗过且又崩了 → 先按官方形态清理插件，再重试（视为第一次尝试）
    if (!hasSanitizeMarker(dshHome)) {
      try {
        await ensureOfficialProfile(dshHome, { force: true });
        const { changed, removed } = await sanitizeProfile(path.join(dshHome, 'profiles', 'web'), {
          log: logLine,
        });
        if (changed && removed.length) {
          logLine(`[guard] 已清洗坏插件：${removed.join('、')}`);
        }
      } catch (err) {
        logLine(`[guard] 清理失败：${err.message}`);
      }
    }
    if (restartAttempts >= 3) {
      dialog.showMessageBox({
        type: 'error',
        message: '官方 Web 服务多次异常退出',
        detail: `已尝试重启 3 次均失败。\n最后退出状态：code=${code} signal=${signal}\n请通过菜单「查看运行日志」排查原因。`,
      });
      return;
    }
    restartAttempts += 1;
    const delay = 2000 * restartAttempts;
    setTimeout(async () => {
      try {
        const { url } = await runner.start(activeVersion, settings.port, {
          envOverride: { DSH_HOME: dshHome },
        });
        restartAttempts = 0;
        navigateToApp(url);
        logLine('[runner] 重启成功');
      } catch (err) {
        logLine(`[runner] 重启失败：${err.message}`);
        attempt();
      }
    }, delay);
  };
  attempt();
}

/** 菜单动作：打开 Token 用量统计窗口 */
function openTokenUsage() {
  try {
    openTokenUsageWindow({
      dshHome: resolveDshHome(),
      dataRoot,
      log: logLine,
    });
  } catch (err) {
    dialog.showMessageBox({ type: 'error', message: '无法打开用量统计', detail: String(err.message || err) });
  }
}

/**
 * 重启 DSH 内核服务（不退出 Electron），用于插件启用/停用后立即生效。
 * 仅重启子进程（约 3-5 秒），主窗口自动刷新，无需重启整个 APP。
 * 并发调用（如短时间内连续切换多个 Bundle 插件）会共享同一次重启，避免 stop/start 交叉竞态。
 */
let restartInFlight = null;
async function restartDshService() {
  if (restartInFlight) return restartInFlight;
  restartInFlight = (async () => {
    const dshHome = resolveDshHome();
    logLine('[runner] 插件配置变更，正在重启 DSH 服务…');
    if (mainWindow && !mainWindow.isDestroyed()) {
      // 在当前页面上方注入平滑加载蒙层，避免直接 loadURL data: 导致页面销毁和白屏闪烁
      mainWindow.webContents.executeJavaScript(`
        (() => {
          let mask = document.getElementById('__dsh_restart_mask');
          if (!mask) {
            mask = document.createElement('div');
            mask.id = '__dsh_restart_mask';
            mask.style.cssText = 'position:fixed;inset:0;background:rgba(255,255,255,0.85);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#333;transition:opacity 0.2s ease;';
            mask.innerHTML = '<div style="display:inline-block;width:34px;height:34px;border:3px solid rgba(0,102,204,0.2);border-radius:50%;border-top-color:#0066cc;animation:dsh_spin 0.8s linear infinite;margin-bottom:14px"></div><div style="font-size:15px;font-weight:500;color:#1d1d1f">插件配置已变更，正在重启服务…</div><style>@keyframes dsh_spin{to{transform:rotate(360deg)}}</style>';
            document.body.appendChild(mask);
          }
        })()
      `).catch(() => {});
    }
    await runner.stop();
    const { url } = await runner.start(activeVersion, settings.port, {
      envOverride: { DSH_HOME: dshHome },
    });
    restartAttempts = 0;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(url).catch(() => {});
    }
    logLine('[runner] DSH 服务重启完成');
    return { ok: true };
  })();
  try {
    return await restartInFlight;
  } finally {
    restartInFlight = null;
  }
}

/** 菜单动作：打开第三方插件管理器（浏览 / 勾选移除 / 社区插件市场） */
function openManager(initialTab = 'installed') {
  try {
    openPluginManager({
      dshHome: resolveDshHome(),
      pnpmCjs: pnpmCjsPath(),
      getNodeBin: async () => (await resolveNode()) ?? 'node',
      getActiveKernelVersion: () => activeVersion,
      getKernelDir: () => (activeVersion ? paths.versionDir(activeVersion) : null),
      restartService: restartDshService,
      onUpdatesCacheChanged: () => updateMonitor?.checkNow().catch(() => {}),
      initialTab,
      log: logLine,
    });
  } catch (err) {
    dialog.showMessageBox({ type: 'error', message: '无法打开插件管理器', detail: String(err.message || err) });
  }
}

// 容器自动更新：仅 Windows 支持（未签名的 mac 版本无法走 Squirrel.Mac 自动更新，见 shell-auto-updater.js）
const shellAutoUpdater = createShellAutoUpdater({ log: logLine });

/** 更新窗口：容器(壳)当前版本 + GitHub Releases 最新版检测（检测失败/无 Release 返回 latest: null） */
async function getShellInfo() {
  const latest = await checkShellUpdate(app.getVersion(), { log: logLine });
  return { currentVersion: app.getVersion(), latest, autoUpdateSupported: shellAutoUpdater.isSupported };
}

/** 升级徽标：读插件管理器已写入的更新检查缓存，不主动发起新的插件更新检查 */
function getPluginsInfo() {
  return getPluginUpdatesSummary(resolveDshHome());
}

function getInstalledKernelVersions() {
  const versions = new Set(Array.isArray(settings.downloadedKernelVersions) ? settings.downloadedKernelVersions : []);
  try {
    const names = fsSync.readdirSync(paths.versionsDir);
    for (const name of names) {
      if (name.startsWith('v')) {
        const v = name.replace(/^v/, '');
        if (v) versions.add(v);
      }
    }
  } catch {}
  if (activeVersion) versions.add(activeVersion);
  return Array.from(versions);
}

function recordDownloadedKernel(version) {
  if (!version) return;
  if (!Array.isArray(settings.downloadedKernelVersions)) {
    settings.downloadedKernelVersions = [];
  }
  if (!settings.downloadedKernelVersions.includes(version)) {
    settings.downloadedKernelVersions.push(version);
    saveSettings(paths, settings);
  }
}

/** 更新窗口：内核当前激活/固定状态 + npm registry 全部已发布版本（拉取失败返回 entries: null） */
async function getKernelInfo() {
  const versions = await fetchAllKernelVersions({ log: logLine });
  return {
    activeVersion,
    pinnedVersion: settings.pinnedKernelVersion || '',
    latestTag: versions?.latestTag || null,
    entries: versions?.entries || null,
    installedVersions: getInstalledKernelVersions(),
  };
}

/**
 * 切换内核到指定版本，供"启动时激活固定版本"（bootstrap 内联处理）和
 * "更新窗口里手动切换"共用。任一步失败都不推进 activeVersion/pinnedKernelVersion，
 * 并尽量把之前的服务重新拉起来，不留半成品状态。
 */
async function switchKernelVersion(version, { pin = true, onLine } = {}) {
  const dshHome = resolveDshHome();
  const wasRunning = runner?.isRunning();
  const previousVersion = activeVersion;
  const previousPinned = settings.pinnedKernelVersion;
  if (wasRunning) await runner.stop();

  try {
    await kernelSwitcher.switchKernelVersion(version, { pin: true, onLine });
    activeVersion = version;
    recordDownloadedKernel(version);
    await updater.prune(2, [activeVersion, settings.pinnedKernelVersion].filter(Boolean));
    const { url } = await runner.start(activeVersion, settings.port, {
      envOverride: { DSH_HOME: dshHome },
    });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(url).catch(() => {});
    updateMonitor?.checkNow().catch(() => {});
    return url;
  } catch (err) {
    logLine(`[switch] 切换到 ${version} 失败：${err.message}，正在回滚…`);
    if (previousVersion) {
      activeVersion = previousVersion;
      settings.pinnedKernelVersion = previousPinned;
      saveSettings(paths, settings);
      await updater.activate(previousVersion).catch(() => {});
      if (wasRunning) {
        const rollbackResult = await runner
          .start(previousVersion, settings.port, { envOverride: { DSH_HOME: dshHome } })
          .catch((e) => {
            logLine(`[switch] 回滚启动旧版本 ${previousVersion} 也失败：${e.message}`);
            return null;
          });
        if (rollbackResult && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(rollbackResult.url).catch(() => {});
        }
      }
    }
    throw new Error(`切换到 ${version} 失败（已回滚至 ${previousVersion || '原版本'}）：${err.message}`);
  }
}

/** 菜单动作：打开检查更新窗口（容器+内核） */
function openUpdateWindow() {
  try {
    openUpdateWindowImpl({
      // 窗口的实时检测结果同步回监测器（ingest）：用户在窗口里看到容器/内核有新版后，
      // 主界面侧边栏的升级徽标立即出现，无需等待下一次 30 分钟轮询
      getShellInfo: async () => {
        const info = await getShellInfo();
        updateMonitor?.ingest?.({ shell: info });
        return info;
      },
      getKernelInfo: async () => {
        const info = await getKernelInfo();
        updateMonitor?.ingest?.({ kernel: info });
        return info;
      },
      getShellChangelogs: (opts) => fetchShellReleases({ ...opts, log: logLine }),
      clearShellReleasesCache,
      getKernelChangelogs: (opts) => fetchKernelReleases({ ...opts, log: logLine }),
      clearKernelReleasesCache,
      switchKernelVersion,
      downloadShellUpdate: (onProgress) => shellAutoUpdater.checkAndDownload(onProgress),
      installShellUpdate: () => shellAutoUpdater.quitAndInstall(),
      openExternal: (url) => shell.openExternal(url),
      openPluginManager: () => openManager(),
      log: logLine,
    });
  } catch (err) {
    dialog.showMessageBox({ type: 'error', message: '无法打开更新窗口', detail: String(err.message || err) });
  }
}

// ─────────────────────────── 主窗口更新状态 IPC ───────────────────────────

ipcMain.on('update:open-window', () => {
  openUpdateWindow();
});

// 升级徽标：仅插件有更新时（壳/内核均最新），点击直接跳转插件管理器而非"检查更新"窗口
ipcMain.on('plugin-manager:open', () => {
  openManager();
});

ipcMain.handle('update:get-status', async () => {
  return updateMonitor?.getStatus() || { hasUpdate: false };
});

// ─────────────────────────── 启动故障应急恢复 IPC ───────────────────────────

ipcMain.handle('emergency:disable-plugin', async (_event, { profile = 'web', pluginName }) => {
  if (!pluginName) return { ok: false, error: '缺少插件名称' };
  try {
    const { togglePluginBundle } = require('./plugin-guard');
    const home = resolveDshHome();
    const profileDir = path.join(home, 'profiles', profile);
    logLine(`[emergency] 正在停用故障插件：${pluginName} (profile=${profile})`);
    await togglePluginBundle(profileDir, pluginName, false);
    await restartDshService();
    return { ok: true };
  } catch (err) {
    logLine(`[emergency] 停用插件 ${pluginName} 失败：${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('emergency:disable-all', async (_event, { profile = 'web', pluginNames = [] }) => {
  if (!Array.isArray(pluginNames) || pluginNames.length === 0) {
    return { ok: false, error: '未指定需要停用的插件' };
  }
  try {
    const { togglePluginBundle } = require('./plugin-guard');
    const home = resolveDshHome();
    const profileDir = path.join(home, 'profiles', profile);
    logLine(`[emergency] 正在一键批量停用故障插件：${pluginNames.join(', ')} (profile=${profile})`);
    for (const name of pluginNames) {
      try {
        await togglePluginBundle(profileDir, name, false);
      } catch (err) {
        logLine(`[emergency] 停用 ${name} 警告：${err.message}`);
      }
    }
    await restartDshService();
    return { ok: true };
  } catch (err) {
    logLine(`[emergency] 一键停用故障插件失败：${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('emergency:remove-plugin', async (_event, { profile = 'web', pluginName }) => {
  if (!pluginName) return { ok: false, error: '缺少插件名称' };
  try {
    const { removePluginsFromProfile } = require('./plugin-guard');
    const home = resolveDshHome();
    const profileDir = path.join(home, 'profiles', profile);
    const nodeBin = (await resolveNode()) ?? 'node';
    logLine(`[emergency] 正在卸载删除故障插件：${pluginName} (profile=${profile})`);
    await removePluginsFromProfile(profileDir, [pluginName], {
      nodeBin,
      pnpmCjs: pnpmCjsPath(),
      log: logLine,
    });
    await restartDshService();
    return { ok: true };
  } catch (err) {
    logLine(`[emergency] 删除插件 ${pluginName} 失败：${err.message}`);
    return { ok: false, error: err.message };
  }
});

// ─────────────────────────── 菜单 ───────────────────────────

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { label: '关于 DSH Web', click: () => showAbout() },
        { type: 'separator' },
        {
          label: '检查更新…',
          accelerator: 'CmdOrCtrl+U',
          click: () => openUpdateWindow(),
        },
        { type: 'separator' },
        {
          label: process.platform === 'darwin' ? '任务完成时显示 Dock 角标' : '任务完成时任务栏闪烁提醒',
          type: 'checkbox',
          checked: !!settings.taskBadge,
          click(item) {
            settings.taskBadge = item.checked;
            saveSettings(paths, settings);
            if (item.checked) {
              setupTaskBadge(resolveDshHome());
            } else if (badgeWatcher) {
              badgeWatcher.stop();
              badgeWatcher = null;
              badgeCount = 0;
              persistBadgeState();
              applyBadge();
            }
          },
        },
        {
          label: '社区插件市场…',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => openManager('market'),
        },
        {
          label: '管理第三方插件…',
          click: () => openManager('installed'),
        },
        {
          label: 'Token 用量统计…',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => openTokenUsage(),
        },
        {
          label: '打开日志文件夹',
          click: () => shell.openPath(paths.logsDir),
        },
        {
          label: '打开设置文件',
          click: () => {
            saveSettings(paths, settings);
            shell.openPath(paths.settingsFile);
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: '显示',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] },
    {
      label: '帮助',
      submenu: [
        {
          label: '项目主页（deepseek-harness）',
          click: () => shell.openExternal('https://github.com/deepseek-ai/deepseek-harness'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─────────────────────────── 生命周期 ───────────────────────────

app.whenReady().then(async () => {
  paths = makePaths(dataRoot);
  logger = createLogger(paths.logsDir);
  settings = loadSettings(paths);
  buildMenu();

  ipcMain.on('app:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  // 毫秒级展示主窗口原生加载壳（<300ms 快速可见，彻底告别 520x320 小弹窗的等待与闪烁感）
  createMainWindow();

  try {
    await bootstrap();
  } catch (err) {
    logLine(`启动失败：${err.stack || err}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents
        .executeJavaScript(`if (window.__dshShowError) window.__dshShowError(${JSON.stringify(String(err.message || err))})`)
        .catch(() => {});
    }
    const { response } = await dialog.showMessageBox({
      type: 'error',
      message: 'DSH Web 启动失败',
      detail: String(err.message || err),
      buttons: ['重试', '退出'],
      defaultId: 0,
    });
    if (response === 0) {
      app.relaunch();
    }
    app.exit(1);
  }
});

app.on('window-all-closed', () => {
  // macOS 惯例：关窗不退出，保留服务与 dock 图标
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', async () => {
  clearBadge();
  if (!mainWindow) {
    if (runner?.isRunning() && activePort) {
      createMainWindow(`http://127.0.0.1:${activePort}`);
    } else {
      createMainWindow();
    }
  } else {
    focusMainWindow();
  }
});

app.on('before-quit', async (event) => {
  appQuitting = true;
  badgeWatcher?.stop();
  updateMonitor?.stop();
  if (runner?.isRunning()) {
    event.preventDefault();
    await runner.stop().catch(() => {});
    app.exit(0);
  }
});
