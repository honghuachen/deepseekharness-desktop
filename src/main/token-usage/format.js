'use strict';

/** token 数量格式化：K → M → 亿 三级，长期使用的账号会破百万甚至上亿。 */

const HUNDRED_MILLION = 100_000_000;

function formattedTokenCount(count) {
  if (count >= HUNDRED_MILLION) return `${(count / HUNDRED_MILLION).toFixed(2)}亿`;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return `${count}`;
}

module.exports = { formattedTokenCount };
