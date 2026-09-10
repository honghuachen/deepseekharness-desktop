'use strict';

/**
 * DSH Web —— 窗口化承载官方 DeepSeek Harness Web 壳的桌面容器。
 *
 * 启动流程：
 *   1. 解析 node 运行器（优先内置便携 node，其次系统 PATH node）
 *   2. 查询 npm registry 上 @deepseek-ai/dsh 的最新版本
 *   3. 与本地已装版本比较；有新版则下载安装并原子切换
 *   4. 拉起官方 `dsh web` 服务，健康检查通过后用主窗口加载官方页面
 */

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
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
const { checkShellUpdate } = require('./shell-update');
const { createShellAutoUpdater } = require('./shell-auto-updater');
const { createRunner } = require('./runner');
const { createBadgeWatcher } = require('./badge');
const { createLogger } = require('./logger');
const { createStatusWindow } = require('./status-window');
const { openPluginManager } = require('./plugin-manager');
const { openTokenUsageWindow } = require('./token-usage/window');
const { openUpdateWindow: openUpdateWindowImpl } = require('./update-window');

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
  if (badgeCount === 0) return;
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
      badgeCount = c;
      // 用户正盯着窗口时完成的新任务视为已读，不留角标
      const focused = !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
      if (c > 0 && focused) {
        badgeCount = 0;
      }
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
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    title: 'DSH Web',
    show: false,
    backgroundColor: '#f6f7f9',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  mainWindow.loadURL(url);
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    statusWin?.close();
  });
  // 用户查看窗口即视为已读：清空任务完成角标
  mainWindow.on('focus', () => clearBadge());
  // 开发诊断：DSH_WEB_DEV_SNAPSHOT=<路径> 时，页面加载完自动截窗保存
  if (process.env.DSH_WEB_DEV_SNAPSHOT || process.env.DSH_WEB_DEV_TEXTDUMP) {
    mainWindow.webContents.once('did-finish-load', () => {
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
  });
  // 官方页面的外链交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith(`http://127.0.0.1:${activePort}`)) {
      shell.openExternal(target);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

function focusMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

// ─────────────────────────── 关于面板 ───────────────────────────

/** 内核 = 容器承载的官方运行时 @deepseek-ai/dsh 的当前激活版本 */
function kernelLabel() {
  return activeVersion ? `v${activeVersion}` : '未加载';
}

function aboutLines() {
  return [
    `容器版本：${app.getVersion()}`,
    `内核版本：${kernelLabel()}（@deepseek-ai/dsh）`,
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
  ];
}

function showAbout() {
  const [containerLine, kernelLine, runtimeLine] = aboutLines();
  if (process.platform === 'darwin') {
    // 原生关于面板：Version 行来自 applicationVersion；容器/内核版本写在 Credits 区
    app.setAboutPanelOptions({
      applicationName: 'DSH Web',
      applicationVersion: app.getVersion(),
      credits: [containerLine, kernelLine, runtimeLine].join('\n'),
    });
    app.showAboutPanel();
  } else {
    dialog.showMessageBox({
      type: 'info',
      title: '关于 DSH Web',
      message: `DSH Web ${app.getVersion()}`,
      detail: [kernelLine, runtimeLine].join('\n'),
      buttons: ['好'],
      noLink: true,
    });
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
    // 用户已手动固定版本：尊重这个选择，不查询/比较 latest（除非用户在更新窗口里主动恢复自动跟随）
    const pinned = settings.pinnedKernelVersion;
    statusText(`使用固定内核版本 ${pinned}…`);
    await updater.install(pinned, statusText); // install() 本身已幂等，已装过则跳过下载
    await updater.activate(pinned);
    installed = pinned;
    await updater.prune(2, [installed]);
  } else {
    const latest = settings.autoCheckUpdates ? await updater.getLatestVersion() : null;
    installed = await updater.getCurrentVersion();

    if (latest && compareVersions(latest, installed ?? '0.0.0') > 0) {
      statusText(
        installed
          ? `检测到新版本 ${latest}（当前 ${installed}），开始更新…`
          : `首次运行：正在安装官方运行时 ${latest}…`,
      );
      await updater.install(latest, statusText);
      await updater.activate(latest);
      installed = latest;
      await updater.prune(2, [installed]);
    } else if (installed) {
      statusText(latest ? `已是最新版本 ${installed}` : `离线：使用已装版本 ${installed}`);
    } else {
      throw new Error(
        '本地没有任何官方运行时，且无法连接 npm registry。\n请联网后重试。',
      );
    }
  }

  activeVersion = installed;
  const dshHome = resolveDshHome();
  await ensureOfficialProfile(dshHome);
  setupTaskBadge(dshHome);

  // 状态窗口标题同时带上容器与内核版本
  statusWin?.setTitle(`DSH Web v${app.getVersion()} · 内核 v${activeVersion}`);
  statusText(`启动官方 Web 服务（v${activeVersion}）…`);
  const { url, port } = await runner.start(activeVersion, settings.port, {
    isFirstBoot: isFirstBootOfApp,
    envOverride: { DSH_HOME: dshHome },
  });
  activePort = port;
  createMainWindow(url);
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
    mainWindow.webContents.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<body style="font:15px -apple-system,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#666">服务连接中断，正在重启…</body>',
        ),
    ).catch(() => {});
  }
  const attempt = async () => {
    const { hasSanitizeMarker } = require('./plugin-guard');
    const dshHome = resolveDshHome();

    // 从未清洗过且又崩了 → 先按官方形态清理插件，再重试（视为第一次尝试）
    if (!hasSanitizeMarker(dshHome)) {
      try {
        await ensureOfficialProfile(dshHome, { force: true });
      } catch (err) {
        logLine(`[guard] 清理失败：${err.message}`);
      }
      restartAttempts = 0;
    }

    if (restartAttempts >= 3) {
      dialog.showMessageBox({
        type: 'error',
        message: '官方服务反复崩溃，已停止自动重启',
        detail:
          '请查看日志（菜单：打开日志文件夹）。\n' +
          '常见原因：profiles 中存在与当前版本不兼容的插件。\n' +
          '可尝试菜单：DSH Web → 管理第三方插件…',
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
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(url).catch(() => {});
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

/** 菜单动作：打开第三方插件管理器（浏览 / 勾选移除） */
function openManager() {
  try {
    openPluginManager({
      dshHome: resolveDshHome(),
      pnpmCjs: pnpmCjsPath(),
      getNodeBin: async () => (await resolveNode()) ?? 'node',
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

/** 更新窗口：内核当前激活/固定状态 + npm registry 全部已发布版本（拉取失败返回 entries: null） */
async function getKernelInfo() {
  const versions = await fetchAllKernelVersions({ log: logLine });
  return {
    activeVersion,
    pinnedVersion: settings.pinnedKernelVersion || '',
    latestTag: versions?.latestTag || null,
    entries: versions?.entries || null,
  };
}

/**
 * 切换内核到指定版本，供"启动时激活固定版本"（bootstrap 内联处理）和
 * "更新窗口里手动切换"共用。任一步失败都不推进 activeVersion/pinnedKernelVersion，
 * 并尽量把之前的服务重新拉起来，不留半成品状态。
 */
async function switchKernelVersion(version, { pin, onLine } = {}) {
  const dshHome = resolveDshHome();
  const wasRunning = runner?.isRunning();
  const previousVersion = activeVersion;
  const previousPinned = settings.pinnedKernelVersion;
  if (wasRunning) await runner.stop();

  try {
    await kernelSwitcher.switchKernelVersion(version, { pin, onLine });
    activeVersion = version;
    await updater.prune(2, [activeVersion, settings.pinnedKernelVersion].filter(Boolean));
    const { url } = await runner.start(activeVersion, settings.port, {
      envOverride: { DSH_HOME: dshHome },
    });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(url).catch(() => {});
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
      getShellInfo,
      getKernelInfo,
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
          label: '任务完成时显示 Dock 角标',
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
          label: '管理第三方插件…',
          click: () => openManager(),
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

  statusWin = createStatusWindow();
  for (const line of logger.recentLines()) statusWin.push(line);

  try {
    await bootstrap();
  } catch (err) {
    logLine(`启动失败：${err.stack || err}`);
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
  if (!mainWindow && runner?.isRunning()) {
    createMainWindow(`http://127.0.0.1:${activePort}`);
  }
});

app.on('before-quit', async (event) => {
  appQuitting = true;
  badgeWatcher?.stop();
  if (runner?.isRunning()) {
    event.preventDefault();
    await runner.stop().catch(() => {});
    app.exit(0);
  }
});
