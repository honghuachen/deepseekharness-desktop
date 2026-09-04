'use strict';

/**
 * 折叠描述同一次请求的重复记录。
 *
 * 流式响应会把同一个请求的 usage 写好几遍（每次快照一份），只有最后一条才是
 * 完整的 outputTokens；同一个 requestId 出现多条时，保留 token 总量最大的那条
 * ——等价于"取最后一条"，但不依赖文件遍历顺序（扫描目录的顺序本就没有保证）。
 */

function totalTokens(record) {
  return (
    record.inputTokens +
    record.outputTokens +
    record.cacheCreationInputTokens +
    record.cacheReadInputTokens +
    record.reasoningTokens
  );
}

function prefers(candidate, incumbent) {
  const candidateTotal = totalTokens(candidate);
  const incumbentTotal = totalTokens(incumbent);
  if (candidateTotal !== incumbentTotal) return candidateTotal > incumbentTotal;
  if (candidate.timestamp !== incumbent.timestamp) return candidate.timestamp > incumbent.timestamp;
  if (candidate.cwd !== incumbent.cwd) return candidate.cwd < incumbent.cwd;
  return candidate.model < incumbent.model;
}

function deduplicate(records) {
  const winningIndex = new Map();

  records.forEach((record, index) => {
    if (!record.requestId) return;
    const incumbent = winningIndex.get(record.requestId);
    if (incumbent === undefined) {
      winningIndex.set(record.requestId, index);
      return;
    }
    if (prefers(record, records[incumbent])) {
      winningIndex.set(record.requestId, index);
    }
  });

  const kept = [];
  records.forEach((record, index) => {
    if (!record.requestId) {
      kept.push(record);
      return;
    }
    if (winningIndex.get(record.requestId) === index) kept.push(record);
  });
  return kept;
}

module.exports = { deduplicate, totalTokens };
