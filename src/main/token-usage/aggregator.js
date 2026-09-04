'use strict';

/**
 * 去重 + 按日期区间过滤后，分别按「项目」「模型」「会话」三个维度聚合。
 * 不含「按来源」——这个 App 里只有 DeepSeek Harness 一个数据源，没有来源维度。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { deduplicate, totalTokens } = require('./dedup');
const { contains } = require('./date-range');
const { costBreakdown } = require('./pricing');

const MAX_SESSIONS = 50;

function cacheHitRate(inputTokens, cacheCreationInputTokens, cacheReadInputTokens) {
  const denominator = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  if (denominator <= 0) return null;
  return cacheReadInputTokens / denominator;
}

/** `git worktree add` 的 checkout 里 `.git` 是个指向主仓库内部数据目录的文件，
 * 解析出它指向的主仓库根目录，让同一个仓库的所有 worktree 归并到一行里。 */
function mainRepoRootForWorktreeGitFile(gitFile) {
  let contentsText;
  try {
    contentsText = fs.readFileSync(gitFile, 'utf8');
  } catch {
    return null;
  }
  const line = contentsText.split('\n').find((l) => l.startsWith('gitdir:'));
  if (!line) return null;
  const gitDirPath = line.slice('gitdir:'.length).trim();
  let candidate = path.resolve(path.dirname(gitFile), gitDirPath);
  while (path.basename(candidate) !== '.git' && path.dirname(candidate) !== candidate) {
    candidate = path.dirname(candidate);
  }
  if (path.basename(candidate) !== '.git') return null;
  return path.dirname(candidate);
}

/** 沿 cwd 向上找最近的 `.git`，把同一个仓库不同子目录/worktree 下的会话归并到一个项目行。
 * `cache` 由调用方每次 aggregate() 时新建一份，避免跨调用缓存到已改名/删除的目录。 */
function projectRootFor(cwd, cache) {
  if (cache.has(cwd)) return cache.get(cwd);
  const homeDir = os.homedir();
  let dir = cwd;
  let resolved = null;
  while (dir !== path.dirname(dir) && dir !== homeDir) {
    const gitPath = path.join(dir, '.git');
    let stat = null;
    try {
      stat = fs.statSync(gitPath);
    } catch {
      stat = null;
    }
    if (stat) {
      resolved = stat.isDirectory() ? dir : mainRepoRootForWorktreeGitFile(gitPath) || dir;
      break;
    }
    dir = path.dirname(dir);
  }
  const finalRoot = resolved || cwd;
  cache.set(cwd, finalRoot);
  return finalRoot;
}

function sumField(records, field) {
  let total = 0;
  for (const r of records) total += r[field];
  return total;
}

function summarizeCost(records, models) {
  let inputCostUSD = 0;
  let outputCostUSD = 0;
  let cacheWriteCostUSD = 0;
  let cacheReadCostUSD = 0;
  let hasUnknown = false;
  for (const record of records) {
    const breakdown = costBreakdown(record, models);
    if (!breakdown) {
      hasUnknown = true;
      continue;
    }
    inputCostUSD += breakdown.inputCostUSD;
    outputCostUSD += breakdown.outputCostUSD;
    cacheWriteCostUSD += breakdown.cacheWriteCostUSD;
    cacheReadCostUSD += breakdown.cacheReadCostUSD;
  }
  return {
    inputCostUSD,
    outputCostUSD,
    cacheWriteCostUSD,
    cacheReadCostUSD,
    totalCostUSD: inputCostUSD + outputCostUSD + cacheWriteCostUSD + cacheReadCostUSD,
    hasUnknown,
  };
}

function aggregate(records, range, models) {
  const filtered = deduplicate(records).filter((r) => contains(range, r.timestamp));

  const totalInputTokens = sumField(filtered, 'inputTokens');
  const totalCacheCreationInputTokens = sumField(filtered, 'cacheCreationInputTokens');
  const totalCacheReadInputTokens = sumField(filtered, 'cacheReadInputTokens');
  const totalSummary = summarizeCost(filtered, models);

  const projectRootCache = new Map();

  const byProjectMap = new Map();
  for (const record of filtered) {
    const root = projectRootFor(record.cwd, projectRootCache);
    if (!byProjectMap.has(root)) byProjectMap.set(root, []);
    byProjectMap.get(root).push(record);
  }
  const byProject = [...byProjectMap.entries()]
    .map(([cwd, recs]) => {
      const summary = summarizeCost(recs, models);
      const inputTokens = sumField(recs, 'inputTokens');
      const cacheCreationInputTokens = sumField(recs, 'cacheCreationInputTokens');
      const cacheReadInputTokens = sumField(recs, 'cacheReadInputTokens');
      return {
        cwd,
        totalTokens: recs.reduce((s, r) => s + totalTokens(r), 0),
        estimatedCostUSD: summary.totalCostUSD,
        includesUnknownPricedModel: summary.hasUnknown,
        inputTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
        cacheHitRate: cacheHitRate(inputTokens, cacheCreationInputTokens, cacheReadInputTokens),
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens || a.cwd.localeCompare(b.cwd));

  const byModelMap = new Map();
  for (const record of filtered) {
    if (!byModelMap.has(record.model)) byModelMap.set(record.model, []);
    byModelMap.get(record.model).push(record);
  }
  const byModel = [...byModelMap.entries()]
    .map(([model, recs]) => {
      const summary = summarizeCost(recs, models);
      const inputTokens = sumField(recs, 'inputTokens');
      const outputTokens = sumField(recs, 'outputTokens');
      const cacheCreationInputTokens = sumField(recs, 'cacheCreationInputTokens');
      const cacheReadInputTokens = sumField(recs, 'cacheReadInputTokens');
      const known = !summary.hasUnknown;
      return {
        model,
        totalTokens: recs.reduce((s, r) => s + totalTokens(r), 0),
        estimatedCostUSD: known ? summary.totalCostUSD : null,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
        cacheHitRate: cacheHitRate(inputTokens, cacheCreationInputTokens, cacheReadInputTokens),
        inputCostUSD: known ? summary.inputCostUSD : null,
        outputCostUSD: known ? summary.outputCostUSD : null,
        cacheWriteCostUSD: known ? summary.cacheWriteCostUSD : null,
        cacheReadCostUSD: known ? summary.cacheReadCostUSD : null,
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));

  const bySessionMap = new Map();
  for (const record of filtered) {
    const key = record.sessionId || `unknown:${record.cwd}`;
    if (!bySessionMap.has(key)) bySessionMap.set(key, []);
    bySessionMap.get(key).push(record);
  }
  const bySession = [...bySessionMap.entries()]
    .map(([sessionId, recs]) => {
      const summary = summarizeCost(recs, models);
      let earliest = recs[0];
      let latest = recs[0];
      for (const r of recs) {
        if (r.timestamp < earliest.timestamp) earliest = r;
        if (r.timestamp > latest.timestamp) latest = r;
      }
      const cwd = projectRootFor(earliest.cwd, projectRootCache);
      const inputTokens = sumField(recs, 'inputTokens');
      const outputTokens = sumField(recs, 'outputTokens');
      const cacheCreationInputTokens = sumField(recs, 'cacheCreationInputTokens');
      const cacheReadInputTokens = sumField(recs, 'cacheReadInputTokens');
      return {
        sessionId,
        cwd,
        lastActivity: latest.timestamp,
        totalTokens: recs.reduce((s, r) => s + totalTokens(r), 0),
        estimatedCostUSD: summary.totalCostUSD,
        includesUnknownPricedModel: summary.hasUnknown,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
        cacheHitRate: cacheHitRate(inputTokens, cacheCreationInputTokens, cacheReadInputTokens),
        inputCostUSD: summary.inputCostUSD,
        outputCostUSD: summary.outputCostUSD,
        cacheWriteCostUSD: summary.cacheWriteCostUSD,
        cacheReadCostUSD: summary.cacheReadCostUSD,
      };
    })
    .sort(
      (a, b) =>
        b.lastActivity - a.lastActivity || b.totalTokens - a.totalTokens || a.sessionId.localeCompare(b.sessionId),
    )
    .slice(0, MAX_SESSIONS);

  return {
    totalTokens: filtered.reduce((s, r) => s + totalTokens(r), 0),
    estimatedCostUSD: totalSummary.totalCostUSD,
    includesUnknownPricedModels: totalSummary.hasUnknown,
    inputTokens: totalInputTokens,
    cacheCreationInputTokens: totalCacheCreationInputTokens,
    cacheReadInputTokens: totalCacheReadInputTokens,
    cacheHitRate: cacheHitRate(totalInputTokens, totalCacheCreationInputTokens, totalCacheReadInputTokens),
    byProject,
    byModel,
    bySession,
  };
}

module.exports = { aggregate };
