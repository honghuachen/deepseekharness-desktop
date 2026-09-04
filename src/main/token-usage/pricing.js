'use strict';

/**
 * 定价表：内置 pricing.default.json 首次运行时拷贝一份到用户数据目录下的
 * pricing.json，之后优先读这份用户可编辑的副本——手工补充某个 provider/模型的
 * 单价不会被应用更新覆盖掉。
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PRICING_PATH = path.join(__dirname, 'pricing.default.json');

function ensureUserPricingFile(dataRoot) {
  const target = path.join(dataRoot, 'pricing.json');
  if (!fs.existsSync(target)) {
    try {
      fs.mkdirSync(dataRoot, { recursive: true });
      fs.copyFileSync(DEFAULT_PRICING_PATH, target);
    } catch {
      return DEFAULT_PRICING_PATH;
    }
  }
  return target;
}

function readModels(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed.models === 'object' && parsed.models ? parsed.models : {};
}

function loadPricingCatalog(dataRoot) {
  const target = ensureUserPricingFile(dataRoot);
  try {
    return readModels(target);
  } catch {
    try {
      return readModels(DEFAULT_PRICING_PATH);
    } catch {
      return {};
    }
  }
}

/**
 * 按 token 类别拆分成本；模型不在定价表里时返回 `null`（"未知定价"），而不是当作 $0。
 * DeepSeek Harness 记录的 cacheCreationInputTokens 恒为 0，所以 cacheWriteCostUSD
 * 恒为 0——留着这一项只是为了和其它三项保持同一种 breakdown 结构。
 */
function costBreakdown(record, models) {
  const pricing = models[record.model];
  if (!pricing) return null;
  const inputCostUSD = (record.inputTokens / 1_000_000) * (pricing.input_per_million_usd || 0);
  const outputCostUSD =
    ((record.outputTokens + record.reasoningTokens) / 1_000_000) * (pricing.output_per_million_usd || 0);
  const cacheReadCostUSD = (record.cacheReadInputTokens / 1_000_000) * (pricing.cache_read_per_million_usd || 0);
  const cacheWriteCostUSD =
    (record.cacheCreationInputTokens / 1_000_000) * (pricing.cache_write_per_million_usd || 0);
  return { inputCostUSD, outputCostUSD, cacheWriteCostUSD, cacheReadCostUSD };
}

module.exports = { loadPricingCatalog, costBreakdown, DEFAULT_PRICING_PATH };
