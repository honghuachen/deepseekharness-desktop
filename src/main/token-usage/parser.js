'use strict';

/**
 * 解析已解压的 DeepSeek Harness session.jsonl 文本。
 *
 * 与官方 Claude Code 的逐行自包含格式不同，用量和模型分属两种事件：
 * `assistant/message` 带这一步完成后的 usage，但不带模型名；`request/context`
 * 带模型名，但不带 usage。这里从头到尾走一遍文件，记住最近一次见到的模型
 * （以及文件开头 `session` 行里的 cwd/id），在遇到 `assistant/message` 时
 * 把当前模型盖到这条记录上。
 *
 * 字段名与真实落盘数据核对过（本机 ~/.dsh/sessions 下的真实 session 文件）。
 */

function parseSessionText(text) {
  const records = [];
  let sessionId;
  let sessionCwd;
  let currentModel;

  const lines = text.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event.type !== 'string') continue;

    switch (event.type) {
      case 'session': {
        if (typeof event.id === 'string') sessionId = event.id;
        if (typeof event.cwd === 'string') sessionCwd = event.cwd;
        break;
      }

      case 'request/context': {
        const model = event.data && event.data.model;
        if (typeof model === 'string' && model) currentModel = model;
        break;
      }

      case 'assistant/message': {
        const usage = event.data && event.data.usage;
        const seq = event.seq;
        const time = event.time;
        if (!usage || typeof seq !== 'number' || typeof time !== 'number') continue;

        records.push({
          timestamp: time, // 已经是毫秒级 epoch，JS Date 原生单位，无需再换算
          model: currentModel || 'unknown',
          cwd: sessionCwd || 'unknown',
          inputTokens: usage.inputTokens || 0,
          outputTokens: usage.outputTokens || 0,
          cacheCreationInputTokens: 0, // DeepSeek Harness 从不上报缓存写入 token
          cacheReadInputTokens: usage.cacheReadTokens || 0,
          reasoningTokens: usage.reasoningTokens || 0,
          requestId: `${sessionId || 'unknown'}:${seq}`,
          sessionId: sessionId || null,
        });
        break;
      }

      default:
        break;
    }
  }

  return records;
}

module.exports = { parseSessionText };
