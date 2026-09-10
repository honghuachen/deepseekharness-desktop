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
  createRegistryChecker,
  createGitHubChecker,
  checkProfileUpdates,
  updatePlugin,
  updatePlugins,
  parseGitHubSpec,
  parseRepoUrl,
} = require('./plugin-guard');

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

      // 合并依赖与补丁层引用为统一的条目列表
      const byName = new Map();
      for (const d of inv.deps) {
        let githubUrl = null;
        let npmUrl = null;

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
            } catch {}
          }
        }

        byName.set(d.name, {
          name: d.name,
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
          if (r.removed?.length) invalidateUpdatesCache(context.dshHome(), profileName, r.removed);
          report.push({ profile: profileName, removed: r.removed, reconciled: r.reconciled });
        } catch (err) {
          context.log?.(`[pm] 移除失败 ${profileName}: ${err.message}`);
          report.push({ profile: profileName, removed: [], error: String(err.message || err) });
        }
      }
      return { report, profiles: buildInventory(context.dshHome()) };
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
        if (result.ok && result.from !== result.to) invalidateUpdatesCache(context.dshHome(), profile, [name]);
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
      if (okNames.length) invalidateUpdatesCache(context.dshHome(), profile, okNames);
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
    throw new Error(`未知命令 ${cmd}`);
  };
  ipcMain.handle('pm', handler);
  return () => ipcMain.removeHandler('pm');
}

function openPluginManager({ dshHome, pnpmCjs, getNodeBin, log = () => {} } = {}) {
  if (!dshHome) throw new Error('openPluginManager 需要 dshHome');
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return win;
  }

  const unregister = registerIpc({
    dshHome: typeof dshHome === 'function' ? dshHome : () => dshHome,
    pnpmCjs,
    getNodeBin,
    log,
  });

  win = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 680,
    minHeight: 480,
    title: '管理第三方插件',
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
  win.loadFile(path.join(__dirname, 'pages', 'plugins.html'));
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

module.exports = { openPluginManager, buildInventory, readUpdatesCache, writeUpdatesCache };
