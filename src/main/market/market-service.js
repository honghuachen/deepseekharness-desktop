'use strict';

/**
 * 社区插件市场服务：
 *   1. 聚合主流社区插件市场（dsh-1024store、dsh-market 等）高星与高推荐插件
 *   2. 规范化去重（GitHub 仓库与包名去重，保留最高评价与详细描述）
 *   3. 统一多维分类映射
 *   4. 支持网络拉取、12h 本地缓存与内置 Top 100 种子无缝降级
 */

const fs = require('node:fs');
const path = require('node:path');

const CATEGORIES = [
  { id: 'all', name: '全部', icon: '🌟' },
  { id: 'tools', name: '工具与能力', icon: '🛠️' },
  { id: 'ui', name: 'UI 增强', icon: '🎨' },
  { id: 'dev', name: '开发与运行时', icon: '💻' },
  { id: 'skill', name: '技能包', icon: '⚡' },
  { id: 'session', name: '会话与消息', icon: '💬' },
  { id: 'model', name: '模型与接入', icon: '🤖' },
  { id: 'workflow', name: '工作流自动化', icon: '🔄' },
  { id: 'memory', name: '记忆管理', icon: '🧠' },
  { id: 'theme', name: '主题外观', icon: '🎭' },
  { id: 'notify', name: '通知集成', icon: '🔔' },
  { id: 'fun', name: '趣味娱乐', icon: '🎮' },
];

const CATEGORY_NAMES = {
  tools: '工具与能力',
  ui: 'UI 增强',
  dev: '开发与运行时',
  skill: '技能包',
  session: '会话与消息',
  model: '模型与接入',
  workflow: '工作流自动化',
  memory: '记忆管理',
  theme: '主题外观',
  notify: '通知集成',
  fun: '趣味娱乐',
};

const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
const CACHE_VERSION = 5;

const GENERIC_NAMES = new Set([
  'dsh',
  'dsh-plugin',
  'deepseek-harness',
  'dsh-runtime',
  'dsh-memory-plugin',
  'dsh-plugin-desktop',
  'coding-agents',
  'typescript',
  'packages',
  'plugins',
  'integrations',
  'app-wework',
  'design-studio',
  'base',
  'bundle',
  'core',
  'plugin',
  'desktop',
  'web',
  'client',
]);

/**
 * 判断插件是否为官方推荐/官方出品：
 * 1. 包名以 @deepseek-ai/ 开头
 * 2. 仓库所属组织为 deepseek-ai 或 deepseek
 * 3. 安装命令或依赖规格包含 @deepseek-ai/
 * 4. 原始数据标记了 official / isOfficial / recommended
 */
function isOfficialPlugin(item = {}, naming = {}) {
  const pkg = String(naming.packageName || item.name || '').toLowerCase();
  const owner = String(naming.owner || item.owner || '').toLowerCase();
  const repo = String(naming.repoFullName || item.repository || '').toLowerCase();
  const spec = String(naming.installSpec || item.install || '').toLowerCase();

  return (
    pkg.startsWith('@deepseek-ai/') ||
    owner === 'deepseek-ai' ||
    owner === 'deepseek' ||
    repo.startsWith('deepseek-ai/') ||
    spec.includes('@deepseek-ai/') ||
    item.official === true ||
    item.isOfficial === true ||
    item.recommended === true
  );
}

function normalizeRepoUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
}

/** 从安装命令中解析出要添加的规范 (包名、github:repo 等) */
function parseInstallCommand(installCmd) {
  if (!installCmd || typeof installCmd !== 'string') return null;
  const tokens = installCmd.trim().split(/\s+/);
  const addIdx = tokens.indexOf('add');
  if (addIdx === -1) return null;
  for (let i = addIdx + 1; i < tokens.length; i++) {
    if (!tokens[i].startsWith('-')) {
      return tokens[i];
    }
  }
  return null;
}

/** 从 installSpec 或 URL 中提取合法 npm / bundle 包名 */
function extractPackageName(parsedSpec, fallbackName = '', repo = '') {
  if (parsedSpec) {
    if (parsedSpec.startsWith('github:') || parsedSpec.startsWith('git+') || parsedSpec.startsWith('http')) {
      const hashMatch = parsedSpec.match(/#path:(?:packages\/|extensions\/|integrations\/)?([^&]+)/);
      if (hashMatch) return hashMatch[1].split('/').pop();
      if (fallbackName && !GENERIC_NAMES.has(fallbackName.toLowerCase())) return fallbackName;
      const repoMatch = parsedSpec.match(/github:[^/]+\/([^/#\s]+)/);
      if (repoMatch) return repoMatch[1];
      return fallbackName || repo;
    }
    // parsedSpec 为标准 npm 包名，如 @tt-a1i/archify-dsh
    return parsedSpec;
  }
  if (fallbackName && !GENERIC_NAMES.has(fallbackName.toLowerCase())) {
    return fallbackName;
  }
  return repo || fallbackName;
}

/**
 * 智能推导开源项目展示名称与实际包名，确保与开源仓库项目名保持一致
 */
function resolveProjectNaming(item) {
  const rawName = String(item.name || '').trim();
  let repo = String(item.repository || '').trim();
  let owner = String(item.owner || '').trim();
  const url = item.githubUrl || item.url || (repo ? `https://github.com/${repo}` : '');

  if ((!repo || !owner) && url && url.includes('github.com/')) {
    const match = url.match(/github\.com\/([^/]+)\/([^/#\s]+)/);
    if (match) {
      if (!owner) owner = match[1];
      if (!repo) repo = match[2];
    }
  }

  const parsedSpec = parseInstallCommand(item.install);
  const installSpec = parsedSpec || item.installSpec || (url ? `github:${owner}/${repo}` : rawName);
  const packageName = extractPackageName(parsedSpec || item.installSpec, rawName, repo);

  const rawLower = rawName.toLowerCase();
  const repoLower = repo.toLowerCase();

  let displayName = rawName;
  if (GENERIC_NAMES.has(rawLower) || rawLower === 'dsh' || rawLower === 'typescript') {
    // 强制使用开源项目仓库名
    displayName = repo || rawName;
  } else if (repo && rawLower !== repoLower) {
    if (rawLower.includes(repoLower) || repoLower.includes(rawLower)) {
      // 如 WeKnora (raw: dsh-weknora), MemOS (raw: memos-local-plugin)
      displayName = repo;
    } else {
      displayName = rawName;
    }
  }

  const repoFullName = owner && repo ? `${owner}/${repo}` : (repo || displayName);

  return {
    rawName,
    displayName,
    packageName,
    repo,
    owner,
    repoFullName,
    installSpec,
    githubUrl: url || (repoFullName ? `https://github.com/${repoFullName}` : ''),
  };
}

/**
 * 纯逻辑：对原始插件列表进行清洗、去重、补全并按星级排序取前 100
 * @param {Array<object>} rawList 原始插件列表
 * @returns {Array<object>} 去重排序后的 Top 100 插件
 */
function dedupAndRankPlugins(rawList = [], { perCategoryLimit = 10 } = {}) {
  if (!Array.isArray(rawList)) return [];

  const seenRepos = new Map();
  const seenNames = new Map();
  const cleaned = [];

  for (const item of rawList) {
    if (!item || !item.name) continue;
    const naming = resolveProjectNaming(item);
    const repoKey = normalizeRepoUrl(naming.githubUrl || naming.repoFullName);
    const nameKey = (naming.displayName || naming.packageName || naming.rawName).toLowerCase();

    // 如果同一个仓库或项目已存在，合并优选
    const existing = (repoKey && seenRepos.get(repoKey)) || seenNames.get(nameKey);
    if (existing) {
      // 优选 Stars 更高或描述更全的
      if ((item.stars || 0) > (existing.stars || 0)) {
        existing.stars = item.stars;
      }
      if (!existing.description || existing.description === '暂无描述') {
        const desc = typeof item.description === 'object'
          ? (item.description.zh || item.description.en || '')
          : (item.description || item.descriptionZh || '');
        if (desc) existing.description = desc;
      }
      continue;
    }

    const descZh = typeof item.description === 'object'
      ? (item.description.zh || item.description.en || '')
      : (item.descriptionZh || item.description || '');
    const descEn = typeof item.description === 'object'
      ? (item.description.en || item.description.zh || '')
      : (item.description || '');

    const catId = item.category && CATEGORY_NAMES[item.category] ? item.category : 'tools';
    const catLabel = item.categoryLabel || CATEGORY_NAMES[catId] || '工具与能力';

    const plugin = {
      id: item.id || `${naming.owner || 'community'}/${naming.displayName}`,
      name: naming.packageName || naming.rawName,
      displayName: naming.displayName,
      packageName: naming.packageName,
      repository: naming.repo,
      owner: naming.owner,
      repoFullName: naming.repoFullName,
      stars: typeof item.stars === 'number' ? item.stars : 0,
      installs: typeof item.installs30d === 'number' ? item.installs30d : (item.installs || item.installCount || 0),
      category: catId,
      categoryLabel: catLabel,
      official: isOfficialPlugin(item, naming),
      description: descZh || descEn || '暂无描述',
      descriptionEn: descEn || descZh || 'No description',
      githubUrl: naming.githubUrl,
      installSpec: naming.installSpec,
      installCommand: typeof item.install === 'string' ? item.install : `dsh plugin --profile web add ${naming.installSpec}`,
    };

    if (repoKey) seenRepos.set(repoKey, plugin);
    seenNames.set(nameKey, plugin);
    cleaned.push(plugin);
  }

  // 按分类分组，并在每个分类内部按综合得分降序排序，取前 perCategoryLimit (默认 10) 个
  const categoryGroups = new Map();
  for (const p of cleaned) {
    const list = categoryGroups.get(p.category) || [];
    list.push(p);
    categoryGroups.set(p.category, list);
  }

  const result = [];
  const orderedCatKeys = Object.keys(CATEGORY_NAMES);
  for (const catId of orderedCatKeys) {
    const list = categoryGroups.get(catId) || [];
    list.sort((a, b) => {
      const scoreA = (a.stars || 0) * 1.0 + (a.installs || 0) * 1.5;
      const scoreB = (b.stars || 0) * 1.0 + (b.installs || 0) * 1.5;
      return scoreB - scoreA;
    });

    const topItems = list.slice(0, perCategoryLimit);
    topItems.forEach((item, index) => {
      item.categoryRank = index + 1;
      result.push(item);
    });
  }

  // 若存在未在 CATEGORY_NAMES 中的其他分类，也一并补充
  for (const [catId, list] of categoryGroups.entries()) {
    if (!orderedCatKeys.includes(catId)) {
      list.sort((a, b) => (b.stars || 0) - (a.stars || 0));
      list.slice(0, perCategoryLimit).forEach((item, index) => {
        item.categoryRank = index + 1;
        result.push(item);
      });
    }
  }

  return result;
}

/** 读取内置 Top 100 种子数据 */
function loadSeedPlugins() {
  try {
    const seedPath = path.join(__dirname, 'market-seed.json');
    if (fs.existsSync(seedPath)) {
      const data = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
      if (Array.isArray(data) && data.length > 0) return data;
    }
  } catch {}
  return [];
}

/** 读取本地磁盘缓存 */
function readCacheFile(cacheFilePath) {
  if (!cacheFilePath || !fs.existsSync(cacheFilePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
    if (raw && Array.isArray(raw.plugins) && raw.savedAt && raw.version === CACHE_VERSION) {
      return raw;
    }
  } catch {}
  return null;
}

/** 写入本地磁盘缓存 */
function writeCacheFile(cacheFilePath, plugins) {
  if (!cacheFilePath) return;
  try {
    const data = {
      version: CACHE_VERSION,
      savedAt: Date.now(),
      plugins,
    };
    fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
    fs.writeFileSync(cacheFilePath, JSON.stringify(data, null, 2) + '\n');
  } catch {}
}

/**
 * 获取插件市场 Top 100 插件列表
 * @param {object} opts
 * @param {string} opts.dshHome
 * @param {boolean} [opts.forceRefresh]
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.fetchFn]
 * @param {Function} [opts.log]
 */
async function fetchMarketTop100({
  dshHome,
  forceRefresh = false,
  timeoutMs = 6000,
  fetchFn = globalThis.fetch,
  log = () => {},
} = {}) {
  const cacheFile = dshHome ? path.join(dshHome, '.market-cache.json') : null;

  // 1. 如果非强制刷新，优先检查本地有效缓存（12 小时内）
  if (!forceRefresh && cacheFile) {
    const cached = readCacheFile(cacheFile);
    if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
      log('[market] 使用 12h 内本地缓存');
      return {
        plugins: cached.plugins,
        categories: CATEGORIES,
        fromCache: true,
        updatedAt: new Date(cached.savedAt).toISOString(),
      };
    }
  }

  // 2. 尝试拉取远端市场数据
  try {
    log('[market] 正在向社区市场获取最新排行与插件…');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetchFn('https://deepseek1024.com/api/v3/rankings', {
      signal: controller.signal,
      headers: { 'User-Agent': 'DeepseekHarnessApp/PluginMarket' },
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const json = await res.json();
      const rawList = [];
      if (json.rankings && typeof json.rankings === 'object') {
        for (const v of Object.values(json.rankings)) {
          if (Array.isArray(v)) rawList.push(...v);
        }
      }
      const topPlugins = dedupAndRankPlugins(rawList, { perCategoryLimit: 10 });

      if (topPlugins.length > 0) {
        log(`[market] 成功获取并清洗出各分类 Top 10（共 ${topPlugins.length} 个）推荐插件`);
        if (cacheFile) writeCacheFile(cacheFile, topPlugins);
        return {
          plugins: topPlugins,
          categories: CATEGORIES,
          fromCache: false,
          updatedAt: new Date().toISOString(),
        };
      }
    }
  } catch (err) {
    log(`[market] 网络拉取市场数据失败: ${err.message}，启动降级策略`);
  }

  // 3. 降级策略：使用过期缓存或内置 Seed
  if (cacheFile) {
    const staleCache = readCacheFile(cacheFile);
    if (staleCache && staleCache.plugins?.length > 0) {
      log('[market] 降级使用过期本地缓存');
      return {
        plugins: staleCache.plugins,
        categories: CATEGORIES,
        fromCache: true,
        updatedAt: new Date(staleCache.savedAt).toISOString(),
      };
    }
  }

  log('[market] 降级使用内置 Top 100 种子数据');
  const seedPlugins = loadSeedPlugins();
  return {
    plugins: seedPlugins,
    categories: CATEGORIES,
    fromCache: true,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = {
  CATEGORIES,
  CATEGORY_NAMES,
  normalizeRepoUrl,
  dedupAndRankPlugins,
  fetchMarketTop100,
  loadSeedPlugins,
};
