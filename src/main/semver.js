'use strict';

/**
 * 极简 semver 比较（覆盖本场景：x.y.z 与 x.y.z-rc.N 形态）。
 * 返回 >0 / 0 / <0，语义遵循 semver 规范：
 *   1.0.0-rc.2 > 1.0.0-rc.1 > 1.0.0-rc.1 的数字段比较；正式版 > 预发布版
 */

function parse(version) {
  const v = String(version).trim().replace(/^v/i, '');
  const dash = v.indexOf('-');
  const core = dash === -1 ? v : v.slice(0, dash);
  const pre = dash === -1 ? '' : v.slice(dash + 1);
  const nums = core.split('.').map((n) => {
    const x = Number(n);
    return Number.isFinite(x) ? x : 0;
  });
  return { nums, pre: pre === '' ? [] : pre.split('.') };
}

function cmpIdentifier(a, b) {
  const numA = /^\d+$/.test(a);
  const numB = /^\d+$/.test(b);
  if (numA && numB) {
    const d = Number(a) - Number(b);
    return d < 0 ? -1 : d > 0 ? 1 : 0;
  }
  if (numA) return -1; // 数字标识符优先级低于字母标识符
  if (numB) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareVersions(a, b) {
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (A.nums[i] || 0) - (B.nums[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (A.pre.length === 0 && B.pre.length === 0) return 0;
  if (A.pre.length === 0) return 1; // 无预发布段 = 正式版，更高
  if (B.pre.length === 0) return -1;
  const len = Math.max(A.pre.length, B.pre.length);
  for (let i = 0; i < len; i += 1) {
    const x = A.pre[i];
    const y = B.pre[i];
    if (x === undefined) return -1; // 前缀短者更低（1.0.0-rc < 1.0.0-rc.1）
    if (y === undefined) return 1;
    const c = cmpIdentifier(x, y);
    if (c !== 0) return c;
  }
  return 0;
}

module.exports = { compareVersions };
