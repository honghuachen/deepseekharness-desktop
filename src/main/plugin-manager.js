'use strict';

/**
 * 第三方插件管理器：浏览各 profile 的插件清单，勾选移除、检查更新、单包升级。
 * UI 为本地静态页（pages/plugins.html），经 preload 暴露若干 IPC 方法。
 */

const path = require('node:path');
const fsSync = require('node:fs');
const { BrowserWindow, ipcMain, shell } = require('electron');
const {
  inventoryProfile,
  removePluginsFromProfile,
  isOfficial,
  isBundlePackage,
  appendPatchInsert,
  parsePatchInserts,
  createRegistryChecker,
  createGitHubChecker,
  checkProfileUpdates,
  updatePlugin,
  updatePlugins,
  installPluginToProfile,
  togglePluginBundle,
  parseGitHubSpec,
  parseRepoUrl,
} = require('./plugin-guard');
const { fetchMarketTop100 } = require('./market/market-service');

let win = null; // 单例窗口
// 进程内单例 registry checker 与 github checker，跨调用复用缓存（5 分钟 TTL）
let registry = null;
function getRegistry(log) {
  if (!registry) registry = createRegistryChecker({ log });
  return registry;
}

let githubChecker = null;
function getGitHubChecker(log) {
  if (!githubChecker) githubChecker = createGitHubChecker({ log });
  return githubChecker;
}

// 缓存内置市场种子元数据，用于增强本地已安装插件的项目显示名称与描述
let marketMetaMap = null;
function getMarketMetaMap() {
  if (marketMetaMap) return marketMetaMap;
  marketMetaMap = new Map();
  try {
    const seedPath = path.join(__dirname, 'market', 'market-seed.json');
    if (fsSync.existsSync(seedPath)) {
      const list = JSON.parse(fsSync.readFileSync(seedPath, 'utf8'));
      if (Array.isArray(list)) {
        for (const item of list) {
          const meta = {
            displayName: item.displayName || item.name,
            description: item.description || '',
            githubUrl: item.githubUrl || null,
          };
          if (item.packageName) marketMetaMap.set(item.packageName.toLowerCase(), meta);
          if (item.name) marketMetaMap.set(item.name.toLowerCase(), meta);
          if (item.id) marketMetaMap.set(item.id.toLowerCase(), meta);
        }
      }
    }
  } catch {}
  return marketMetaMap;
}

// 上次更新检查结果的持久化缓存（dshHome/.plugin-updates.json）：
// 打开插件管理器时先用缓存立即展示「有新版」条目，再后台刷新。
const UPDATES_CACHE_FILE = '.plugin-updates.json';

function updatesCachePath(dshHome) {
  return path.join(dshHome, UPDATES_CACHE_FILE);
}

/** 读缓存；结构 { checkedAt, profiles: { <profile>: [{name,range,latest,status}] } } */
function readUpdatesCache(dshHome) {
  try {
    const raw = JSON.parse(fsSync.readFileSync(updatesCachePath(dshHome), 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch {}
  return null;
}

/** 写缓存（尽量静默失败） */
function writeUpdatesCache(dshHome, data) {
  try {
    fsSync.writeFileSync(updatesCachePath(dshHome), JSON.stringify(data, null, 2) + '\n');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[pm] 写更新缓存失败: ${err.message}`);
  }
}

/**
 * 汇总更新缓存里所有 profile 的「有新版」条目数量，供全局升级徽标使用。
 * 仅读已有缓存（由插件管理器 checkUpdates 写入），不发起新的网络请求。
 */
function getPluginUpdatesSummary(dshHome) {
  const cache = readUpdatesCache(dshHome);
  let count = 0;
  const profiles = cache?.profiles;
  if (profiles && typeof profiles === 'object') {
    for (const list of Object.values(profiles)) {
      if (!Array.isArray(list)) continue;
      count += list.filter((u) => u?.status === 'outdated').length;
    }
  }
  return { hasUpdate: count > 0, count };
}

/**
 * 更新/移除插件成功后，把该插件在持久化缓存里的条目清掉。
 * 不这样做的话，缓存仍保留更新前的「有新版」判定，下次打开或刷新
 * 插件管理器时会用这份过期缓存覆盖刚更新完的正确状态，显示假的更新提示。
 */
function invalidateUpdatesCache(dshHome, profile, names) {
  if (!names || names.length === 0) return;
  const cache = readUpdatesCache(dshHome);
  const list = cache?.profiles?.[profile];
  if (!Array.isArray(list)) return;
  const want = new Set(names);
  cache.profiles[profile] = list.filter((u) => !want.has(u?.name));
  writeUpdatesCache(dshHome, cache);
}

/** 聚合 dshHome 下所有 profile 的插件清单 */
function buildInventory(dshHome) {
  const profilesRoot = path.join(dshHome, 'profiles');
  let entries = [];
  try {
    entries = fsSync
      .readdirSync(profilesRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  return entries
    .map((name) => {
      const dir = path.join(profilesRoot, name);
      const inv = inventoryProfile(dir);
      if (!inv.exists) return null;

      // 默认启用机制：已安装的第三方依赖若未显式加入 disabledBundles，自动确保处于启用状态
      const pkgPath = path.join(dir, 'package.json');
      const patchPath = path.join(dir, 'cordis.patch.yml');
      try {
        const rawPkg = JSON.parse(fsSync.readFileSync(pkgPath, 'utf8'));
        const disabledSet = new Set((rawPkg.dsh?.profile?.disabledBundles || []).map(String));
        const bundleSet = new Set((rawPkg.dsh?.profile?.bundles || []).map(String));
        let pkgChanged = false;
        let patchChanged = false;
        let patchContent = fsSync.existsSync(patchPath) ? fsSync.readFileSync(patchPath, 'utf8') : '';
        const existingInserts = new Set(parsePatchInserts(patchContent).map((ins) => ins.name));

        for (const dep of inv.deps) {
          if (dep.official) continue;
          const isBundle = isBundlePackage(dir, dep.name);

          if (!isBundle) {
            // 非 bundle 包（如 dsh-mcp-manager）绝不能出现在 bundles 中，否则 dsh 启动报错
            if (bundleSet.has(dep.name)) {
              bundleSet.delete(dep.name);
              pkgChanged = true;
            }
            // 若用户未显式禁用，且未在 cordis.patch.yml 中，则默认在 cordis.patch.yml 中启用
            if (!disabledSet.has(dep.name) && !existingInserts.has(dep.name)) {
              patchContent = appendPatchInsert(patchContent, dep.name);
              existingInserts.add(dep.name);
              patchChanged = true;
            }
          } else {
            // 是 bundle 包：若未显式禁用，确保加入 bundles
            if (!disabledSet.has(dep.name) && !bundleSet.has(dep.name)) {
              bundleSet.add(dep.name);
              pkgChanged = true;
            }
          }
        }

        // 清理 bundles 中任何非 bundle 的第三方包（防御性防崩溃）
        for (const b of [...bundleSet]) {
          if (!isOfficial(b) && !isBundlePackage(dir, b)) {
            bundleSet.delete(b);
            pkgChanged = true;
          }
        }

        if (pkgChanged) {
          rawPkg.dsh = rawPkg.dsh || {};
          rawPkg.dsh.profile = rawPkg.dsh.profile || {};
          rawPkg.dsh.profile.bundles = [...bundleSet];
          fsSync.writeFileSync(pkgPath, JSON.stringify(rawPkg, null, 2) + '\n');
          inv.bundles = [...bundleSet];
        }

        if (patchChanged) {
          fsSync.writeFileSync(patchPath, patchContent);
          inv.inserts = parsePatchInserts(patchContent).map((b) => ({ ...b, official: isOfficial(b.name ?? '') }));
        }
      } catch {}

      // 合并依赖与补丁层引用为统一的条目列表
      const byName = new Map();
      for (const d of inv.deps) {
        let githubUrl = null;
        let npmUrl = null;
        let displayName = null;
        let description = null;

        if (!d.official) {
          const ghSpec = parseGitHubSpec(d.range);
          if (ghSpec) {
            githubUrl = `https://github.com/${ghSpec.owner}/${ghSpec.repo}`;
          } else if (!/^(git\+|github:|gitlab:|bitbucket:|file:|workspace:|link:|portal:|http:|https:)/i.test(d.range)) {
            npmUrl = `https://www.npmjs.com/package/${d.name}`;
          }

          // 尝试读取已安装 node_modules/<d.name>/package.json 中的 repository 与 homepage
          const installedPkgPath = path.join(dir, 'node_modules', d.name, 'package.json');
          if (fsSync.existsSync(installedPkgPath)) {
            try {
              const installedPkg = JSON.parse(fsSync.readFileSync(installedPkgPath, 'utf8'));
              const repoUrl = parseRepoUrl(installedPkg.repository) || parseRepoUrl(installedPkg.homepage);
              if (repoUrl) {
                githubUrl = repoUrl;
              }
              if (installedPkg.displayName && typeof installedPkg.displayName === 'string') {
                displayName = installedPkg.displayName;
              }
              if (installedPkg.description && typeof installedPkg.description === 'string') {
                description = installedPkg.description;
              }
            } catch {}
          }

          // 关联社区市场元数据（如 DeepSeek-Balance-Whale-Widget, MemOS 等）
          const meta = getMarketMetaMap().get(d.name.toLowerCase());
          if (meta) {
            if (meta.displayName) displayName = meta.displayName;
            if (meta.description && !description) description = meta.description;
          }
        }

        byName.set(d.name, {
          name: d.name,
          displayName,
          description,
          range: d.range,
          official: d.official,
          inBundle: inv.bundles.includes(d.name),
          inPatch: false,
          githubUrl,
          npmUrl,
        });
      }
      for (const ins of inv.inserts) {
        if (!ins.name) continue;
        const row = byName.get(ins.name);
        if (row) row.inPatch = true;
        else if (!inv.bundles.includes(ins.name)) {
          // 补丁层独有引用（如官方 MCP 端点配置）
          byName.set(ins.name, {
            name: ins.id ? `${ins.name} (${ins.id})` : ins.name,
            rawName: ins.name,
            range: '补丁层配置',
            official: isOfficial(ins.name),
            inBundle: false,
            inPatch: true,
            insertOnly: true,
            githubUrl: null,
            npmUrl: null,
          });
        }
      }
      for (const b of inv.bundles) {
        if (!byName.has(b)) {
          byName.set(b, {
            name: b,
            range: '—',
            official: isOfficial(b),
            inBundle: true,
            inPatch: false,
            githubUrl: null,
            npmUrl: null,
          });
        }
      }

      return {
        profile: name,
        hasNodeModules: inv.hasNodeModules,
        items: [...byName.values()],
      };
    })
    .filter(Boolean);
}

function registerIpc(context) {
  const handler = async (event, cmd, payload) => {
    if (event.sender !== win?.webContents) throw new Error('非法来源');
    if (cmd === 'list') {
      const home = context.dshHome();
      return { profiles: buildInventory(home), updateCache: readUpdatesCache(home) };
    }
    if (cmd === 'remove') {
      const selections = payload?.selections ?? {}; // {profileName: [names]}
      const report = [];
      let totalRemoved = 0;
      for (const [profileName, names] of Object.entries(selections)) {
        if (!Array.isArray(names) || names.length === 0) continue;
        const dir = path.join(context.dshHome(), 'profiles', profileName);
        if (!fsSync.existsSync(path.join(dir, 'package.json'))) {
          report.push({ profile: profileName, removed: [], error: 'profile 不存在' });
          continue;
        }
        try {
          const nodeBin = context.getNodeBin ? await context.getNodeBin() : undefined;
          const r = await removePluginsFromProfile(dir, names, {
            nodeBin,
            pnpmCjs: context.pnpmCjs,
            log: context.log,
          });
          if (r.removed?.length) {
            totalRemoved += r.removed.length;
            invalidateUpdatesCache(context.dshHome(), profileName, r.removed);
          }
          report.push({ profile: profileName, removed: r.removed, reconciled: r.reconciled });
        } catch (err) {
          context.log?.(`[pm] 移除失败 ${profileName}: ${err.message}`);
          report.push({ profile: profileName, removed: [], error: String(err.message || err) });
        }
      }
      return {
        report,
        needsRestart: totalRemoved > 0,
        profiles: buildInventory(context.dshHome()),
      };
    }
    if (cmd === 'checkUpdates') {
      // 可选：仅检查指定 profile；未传则检查所有 profile
      const profileFilter = payload?.profiles; // string[] | undefined
      const profilesRoot = path.join(context.dshHome(), 'profiles');
      let names = [];
      try {
        names = fsSync
          .readdirSync(profilesRoot, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort();
      } catch {}
      if (Array.isArray(profileFilter) && profileFilter.length) {
        names = names.filter((n) => profileFilter.includes(n));
      }
      const reg = getRegistry(context.log);
      const gh = getGitHubChecker(context.log);
      const updates = {};
      await Promise.all(
        names.map(async (p) => {
          const dir = path.join(profilesRoot, p);
          try {
            updates[p] = await checkProfileUpdates(dir, { registry: reg, githubChecker: gh, log: context.log });
          } catch (err) {
            updates[p] = { error: String(err.message || err) };
          }
        }),
      );
      // 持久化成功检查的结果：下次打开插件管理器先用缓存展示，再后台刷新
      const cacheProfiles = {};
      for (const [p, list] of Object.entries(updates)) {
        if (Array.isArray(list)) cacheProfiles[p] = list;
      }
      writeUpdatesCache(context.dshHome(), {
        checkedAt: new Date().toISOString(),
        profiles: cacheProfiles,
      });
      context.onUpdatesCacheChanged?.();
      return { updates };
    }
    if (cmd === 'update') {
      // payload: { profile: string, name: string, target?: string }
      const { profile, name, target } = payload ?? {};
      if (!profile || !name) throw new Error('缺少 profile/name');
      const dir = path.join(context.dshHome(), 'profiles', profile);
      if (!fsSync.existsSync(path.join(dir, 'package.json'))) {
        return { ok: false, error: 'profile 不存在' };
      }
      try {
        const nodeBin = context.getNodeBin ? await context.getNodeBin() : undefined;
        const reg = getRegistry(context.log);
        const gh = getGitHubChecker(context.log);
        const result = await updatePlugin(dir, name, {
          targetVersion: target,
          nodeBin,
          pnpmCjs: context.pnpmCjs,
          log: context.log,
          registry: reg,
          githubChecker: gh,
        });
        if (result.ok && result.from !== result.to) {
          invalidateUpdatesCache(context.dshHome(), profile, [name]);
          context.onUpdatesCacheChanged?.();
        }
        return { ...result, profile, profiles: buildInventory(context.dshHome()) };
      } catch (err) {
        context.log?.(`[pm] 更新失败 ${profile}/${name}: ${err.message}`);
        return { ok: false, name, profile, error: String(err.message || err) };
      }
    }
    if (cmd === 'updateAll') {
      // payload: { profile: string, names?: (string | {name, target})[], targets?: Array<{name, target}> }
      const { profile, names, targets } = payload ?? {};
      const rawList = Array.isArray(targets) ? targets : Array.isArray(names) ? names : [];
      if (!profile || rawList.length === 0) {
        throw new Error('缺少 profile 或 names');
      }
      const dir = path.join(context.dshHome(), 'profiles', profile);
      if (!fsSync.existsSync(path.join(dir, 'package.json'))) {
        return { report: [], error: 'profile 不存在' };
      }
      const items = rawList
        .map((item) => {
          if (typeof item === 'string') return { name: item, target: 'latest' };
          if (item && typeof item === 'object' && item.name) {
            return { name: item.name, target: item.target || 'latest' };
          }
          return null;
        })
        .filter(Boolean);

      const nodeBin = context.getNodeBin ? await context.getNodeBin() : undefined;
      const reg = getRegistry(context.log);
      const gh = getGitHubChecker(context.log);
      const { report } = await updatePlugins(dir, items, {
        nodeBin,
        pnpmCjs: context.pnpmCjs,
        log: context.log,
        registry: reg,
        githubChecker: gh,
      });

      const okNames = report.filter((r) => r.ok && r.from !== r.to).map((r) => r.name);
      if (okNames.length) {
        invalidateUpdatesCache(context.dshHome(), profile, okNames);
        context.onUpdatesCacheChanged?.();
      }
      return { report, profile, profiles: buildInventory(context.dshHome()) };
    }
    if (cmd === 'openExternal') {
      const url = payload?.url;
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        shell.openExternal(url);
        return { ok: true };
      }
      return { ok: false, error: '无效 URL' };
    }
    if (cmd === 'marketList' || cmd === 'marketRefresh') {
      const forceRefresh = cmd === 'marketRefresh';
      const home = context.dshHome();
      const marketData = await fetchMarketTop100({
        dshHome: home,
        forceRefresh,
        log: context.log,
      });

      const inventory = buildInventory(home);
      const installedMap = new Map();
      for (const p of inventory) {
        for (const item of p.items) {
          if (item.official) continue; // 官方系统核心依赖不计入第三方插件市场匹配
          const key = (item.rawName || item.name).toLowerCase();
          const list = installedMap.get(key) || [];
          list.push(p.profile);
          installedMap.set(key, list);
        }
      }

      const enrichedPlugins = marketData.plugins.map((plugin) => {
        const namesToCheck = [
          plugin.packageName,
          plugin.name,
          plugin.displayName,
          plugin.installSpec,
        ]
          .filter(Boolean)
          .map((x) => String(x).toLowerCase())
          .filter((x) => x !== 'dsh' && x !== 'plugin');

        let matchedProfiles = [];
        for (const [installedKey, profiles] of installedMap.entries()) {
          if (namesToCheck.includes(installedKey)) {
            matchedProfiles = [...new Set([...matchedProfiles, ...profiles])];
          }
        }
        return {
          ...plugin,
          isInstalled: matchedProfiles.length > 0,
          installedProfiles: matchedProfiles,
        };
      });

      return {
        ...marketData,
        plugins: enrichedPlugins,
        availableProfiles: inventory.map((p) => p.profile),
      };
    }
    if (cmd === 'toggleBundle') {
      const { profile, name, enable } = payload ?? {};
      if (!profile || !name) throw new Error('缺少 profile 或插件名称');
      const home = context.dshHome();
      const profileDir = path.join(home, 'profiles', profile);
      const isBundle = isBundlePackage(profileDir, name);
      const res = await togglePluginBundle(profileDir, name, enable);
      return {
        ...res,
        profile,
        // Bundle 插件修改 dsh.profile.bundles 后需重启 DSH 服务才能生效；
        // 非 Bundle 插件修改 cordis.patch.yml 后由 DSH 内核自动热重载，无需重启。
        needsRestart: isBundle,
        profiles: buildInventory(home),
      };
    }
    if (cmd === 'restartService') {
      if (typeof context.restartService !== 'function') {
        return { ok: false, error: 'restartService 回调未注册' };
      }
      return await context.restartService();
    }
    if (cmd === 'marketInstall') {
      const { plugin, profile = 'web' } = payload ?? {};
      if (!plugin || (!plugin.name && !plugin.packageName && !plugin.displayName)) {
        throw new Error('缺少要安装的插件信息');
      }

      const home = context.dshHome();
      const profileDir = path.join(home, 'profiles', profile);
      if (!fsSync.existsSync(path.join(profileDir, 'package.json'))) {
        return { ok: false, error: `Profile ${profile} 不存在` };
      }

      const nodeBin = context.getNodeBin ? await context.getNodeBin() : undefined;
      const activeKernelVersion = context.getActiveKernelVersion ? context.getActiveKernelVersion() : null;
      const kernelDir = context.getKernelDir ? context.getKernelDir() : null;
      const res = await installPluginToProfile(profileDir, plugin, {
        nodeBin,
        pnpmCjs: context.pnpmCjs,
        activeKernelVersion,
        kernelDir,
        dshHome: home,
        log: context.log,
      });

      return {
        ...res,
        profile,
        needsRestart: Boolean(res.ok),
        profiles: buildInventory(home),
      };
    }
    throw new Error(`未知命令 ${cmd}`);
  };
  ipcMain.handle('pm', handler);
  return () => ipcMain.removeHandler('pm');
}

function openPluginManager({
  dshHome,
  pnpmCjs,
  getNodeBin,
  getActiveKernelVersion,
  getKernelDir,
  restartService,
  onUpdatesCacheChanged,
  initialTab = 'installed',
  log = () => {},
} = {}) {
  if (!dshHome) throw new Error('openPluginManager 需要 dshHome');
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    if (initialTab) {
      win.webContents.send('pm:switch-tab', initialTab);
    }
    return win;
  }

  const unregister = registerIpc({
    dshHome: typeof dshHome === 'function' ? dshHome : () => dshHome,
    pnpmCjs,
    getNodeBin,
    getActiveKernelVersion,
    getKernelDir,
    restartService,
    onUpdatesCacheChanged,
    log,
  });

  win = new BrowserWindow({
    width: 940,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    title: '第三方插件管理与社区市场',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'plugin-manager-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  win.loadFile(path.join(__dirname, 'pages', 'plugins.html'), {
    query: { tab: initialTab },
  });
  win.webContents.once('did-finish-load', () => {
    if (initialTab) {
      win.webContents.send('pm:switch-tab', initialTab);
    }
  });
  // 开发诊断：DSH_WEB_DEV_PM_DUMP=<路径> 时导出窗口文本
  win.webContents.once('did-finish-load', () => {
    if (!process.env.DSH_WEB_DEV_PM_DUMP) return;
    setTimeout(async () => {
      try {
        const text = await win.webContents.executeJavaScript('document.body.innerText');
        fsSync.writeFileSync(process.env.DSH_WEB_DEV_PM_DUMP, text);
      } catch {}
    }, 2500);
  });
  win.on('closed', () => {
    win = null;
    unregister();
  });
  return win;
}

module.exports = {
  openPluginManager,
  buildInventory,
  readUpdatesCache,
  writeUpdatesCache,
  getPluginUpdatesSummary,
};
