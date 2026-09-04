'use strict';

/**
 * 日期区间：`start` 可选（`null` = 不设下限），`end` 必填。两端都是闭区间。
 * 全部用本地时区计算，时间戳统一用毫秒级 epoch（JS Date 原生单位）。
 */

function startOfDay(date) {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date) {
  const d = new Date(date.getTime());
  d.setHours(23, 59, 59, 999);
  return d;
}

function contains(range, timestampMillis) {
  if (range.start != null && timestampMillis < range.start) return false;
  return timestampMillis <= range.end;
}

function today(now = new Date()) {
  return { start: startOfDay(now).getTime(), end: now.getTime() };
}

/** 昨天整天，从昨日零点到今日零点前 1 毫秒——避免恰好落在零点的记录被今天/昨天重复计入。 */
function yesterday(now = new Date()) {
  const startToday = startOfDay(now);
  const startYesterday = new Date(startToday.getTime());
  startYesterday.setDate(startYesterday.getDate() - 1);
  return { start: startYesterday.getTime(), end: startToday.getTime() - 1 };
}

/** 本周从最近一个周一零点算起（固定周一起始，不跟随系统地区设置）。 */
function thisWeek(now = new Date()) {
  const startToday = startOfDay(now);
  const weekday = startToday.getDay(); // 0=周日 .. 6=周六
  const daysSinceMonday = (weekday + 6) % 7;
  const start = new Date(startToday.getTime());
  start.setDate(start.getDate() - daysSinceMonday);
  return { start: start.getTime(), end: now.getTime() };
}

function thisMonth(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  return { start: start.getTime(), end: now.getTime() };
}

function all(now = new Date()) {
  return { start: null, end: now.getTime() };
}

/** 自定义区间：结束日整天都算在内（比原生 Date 输入更符合"选个日期范围"的直觉）。 */
function custom(startDate, endDate) {
  return { start: startOfDay(startDate).getTime(), end: endOfDay(endDate).getTime() };
}

module.exports = { contains, today, yesterday, thisWeek, thisMonth, all, custom };
