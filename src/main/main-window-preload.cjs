'use strict';

/**
 * DSH Web 主窗口 Preload 脚本：
 *   1. 接收来自主进程的更新可用通知（update:status-changed）
 *   2. 在侧边栏底部的「设置」按钮旁边动态挂载升级标识按钮
 *   3. 点击升级按钮时通知主进程打开「检查更新」窗口
 */

let ipcRenderer = null;
try {
  ipcRenderer = require('electron').ipcRenderer;
} catch (_) {
  // Pure Node test environment
}

let currentStatus = { hasUpdate: false };
let isObserverActive = false;
let updateButtonEl = null;

const UPDATE_BTN_ID = 'dsh-app-update-badge-btn';
const UPDATE_STYLE_ID = 'dsh-app-update-styles';

function injectStyles() {
  if (document.getElementById(UPDATE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = UPDATE_STYLE_ID;
  style.textContent = `
    /* 容器布局：让设置按钮与升级按钮并排显示 */
    .dsh-update-foot-wrapper {
      display: flex !important;
      align-items: center !important;
      gap: 6px !important;
      width: 100% !important;
      box-sizing: border-box !important;
    }
    .dsh-update-foot-wrapper > button:first-child {
      width: auto !important;
      flex: 1 !important;
      min-width: 0 !important;
    }
    /* 折叠侧边栏下的自适应（纵向排列） */
    [class*="collapsed"] .dsh-update-foot-wrapper {
      flex-direction: column !important;
      align-items: center !important;
      gap: 4px !important;
    }
    [class*="collapsed"] #dsh-app-update-badge-btn {
      width: 36px !important;
      height: 36px !important;
      padding: 0 !important;
      justify-content: center !important;
    }
    [class*="collapsed"] #dsh-app-update-badge-btn .dsh-update-text {
      display: none !important;
    }

    /* 升级按钮视觉样式 */
    #dsh-app-update-badge-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 32px;
      padding: 0 10px;
      background: rgba(77, 107, 254, 0.16);
      color: #5c7cfa;
      border: 1px solid rgba(77, 107, 254, 0.38);
      border-radius: 9999px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      flex-shrink: 0;
      transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
      white-space: nowrap;
      user-select: none;
      position: relative;
      margin-left: 2px;
    }
    #dsh-app-update-badge-btn:hover {
      background: rgba(77, 107, 254, 0.28);
      border-color: rgba(77, 107, 254, 0.65);
      color: #748ffc;
    }
    #dsh-app-update-badge-btn:active {
      transform: scale(0.96);
    }
    #dsh-app-update-badge-btn .dsh-update-icon {
      width: 13px;
      height: 13px;
      stroke: currentColor;
      stroke-width: 2.2;
      stroke-linecap: round;
      stroke-linejoin: round;
      fill: none;
      flex-shrink: 0;
    }
    #dsh-app-update-badge-btn .dsh-update-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background-color: #ff5252;
      box-shadow: 0 0 6px rgba(255, 82, 82, 0.8);
      flex-shrink: 0;
      animation: dsh-pulse 2s infinite;
    }
    @keyframes dsh-pulse {
      0% { transform: scale(0.95); opacity: 0.85; }
      50% { transform: scale(1.15); opacity: 1; }
      100% { transform: scale(0.95); opacity: 0.85; }
    }

    /* 让官方启动卡片容器放宽，避免内部结构化表格被官方默认狭窄样式夹扁 */
    [data-dsh-boot] [class*="card"],
    [data-dsh-boot] > div {
      max-width: 820px !important;
      width: min(820px, 94vw) !important;
    }
    [data-dsh-boot] [class*="failed"] {
      max-width: 100% !important;
      width: 100% !important;
    }

    /* 启动失败插件自愈与应急操作列表面板样式 */
    .dsh-emergency-card {
      margin: 18px auto 0 auto;
      max-width: 820px !important;
      width: 100% !important;
      box-sizing: border-box;
      background: #18181c;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 12px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      color: #e0e0e0;
      text-align: left;
      overflow: hidden;
      animation: dsh-em-fade 0.2s ease-out;
    }
    @keyframes dsh-em-fade {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .dsh-em-header {
      padding: 16px 20px;
      background: linear-gradient(180deg, rgba(255, 170, 0, 0.12) 0%, rgba(255, 170, 0, 0.04) 100%);
      border-bottom: 1px solid rgba(255, 170, 0, 0.2);
      display: flex;
      align-items: flex-start;
      gap: 14px;
    }
    .dsh-em-header-icon {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      background: rgba(255, 170, 0, 0.18);
      border: 1px solid rgba(255, 170, 0, 0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      color: #ffb822;
    }
    .dsh-em-header-content {
      flex: 1;
      min-width: 0;
    }
    .dsh-em-title {
      font-size: 15px;
      font-weight: 600;
      color: #ffc043;
      margin: 0 0 4px 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .dsh-em-title-count {
      font-size: 11.5px;
      font-weight: 500;
      padding: 1px 7px;
      border-radius: 9999px;
      background: rgba(255, 82, 82, 0.2);
      color: #ff8b8b;
      border: 1px solid rgba(255, 82, 82, 0.35);
    }
    .dsh-em-subtitle {
      font-size: 12.5px;
      color: #b5b5ba;
      line-height: 1.45;
      margin: 0;
    }

    /* 列表表格区域 */
    .dsh-em-list-section {
      padding: 0;
      max-height: 360px;
      overflow-y: auto;
      overflow-x: hidden;
    }
    .dsh-em-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12.5px;
      table-layout: fixed;
    }
    .dsh-em-table th {
      background: rgba(255, 255, 255, 0.03);
      padding: 10px 16px;
      font-size: 11.5px;
      font-weight: 500;
      color: #8e8e93;
      letter-spacing: 0.5px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      text-align: left;
    }
    .dsh-em-table th:last-child {
      text-align: right;
      padding-right: 18px;
    }
    .dsh-em-row {
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      transition: background 0.12s ease;
    }
    .dsh-em-row:last-child {
      border-bottom: none;
    }
    .dsh-em-row:hover {
      background: rgba(255, 255, 255, 0.035);
    }
    .dsh-em-col-pkg {
      padding: 12px 16px;
      vertical-align: middle;
      width: 32%;
    }
    .dsh-em-pkg-wrap {
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }
    .dsh-em-pkg-icon {
      font-size: 15px;
      line-height: 1.4;
      opacity: 0.85;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .dsh-em-pkg-name {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12.5px;
      font-weight: 600;
      color: #ffffff;
      white-space: normal !important;
      word-break: break-all !important;
      overflow-wrap: anywhere !important;
      line-height: 1.4;
    }
    .dsh-em-col-reason {
      padding: 12px 14px;
      vertical-align: middle;
      width: 44%;
    }
    .dsh-em-reason-badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 5px;
      font-size: 12px;
      background: rgba(255, 82, 82, 0.12);
      color: #ff8b8b;
      border: 1px solid rgba(255, 82, 82, 0.28);
      line-height: 1.4;
      word-break: break-word;
      white-space: normal;
    }
    .dsh-em-reason-detail {
      font-size: 11px;
      color: #7a7a85;
      margin-top: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      word-break: break-all;
      white-space: normal;
    }
    .dsh-em-col-actions {
      padding: 12px 18px 12px 12px;
      text-align: right;
      vertical-align: middle;
      width: 24%;
      min-width: 160px;
      white-space: nowrap;
      box-sizing: border-box;
    }
    .dsh-em-action-group {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: nowrap;
    }

    /* 按钮基础样式 */
    .dsh-em-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 5px 11px;
      font-size: 12px;
      font-weight: 500;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
      user-select: none;
      border: 1px solid transparent;
      outline: none;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .dsh-em-btn:active {
      transform: scale(0.97);
    }
    .dsh-em-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }

    /* 行内操作按钮：停用 */
    .dsh-em-btn-disable {
      background: rgba(255, 179, 0, 0.12);
      color: #ffbe2e;
      border-color: rgba(255, 179, 0, 0.35);
    }
    .dsh-em-btn-disable:hover:not(:disabled) {
      background: rgba(255, 179, 0, 0.24);
      color: #ffd066;
      border-color: rgba(255, 179, 0, 0.55);
    }

    /* 行内操作按钮：删除 */
    .dsh-em-btn-remove {
      background: rgba(255, 82, 82, 0.12);
      color: #ff7878;
      border-color: rgba(255, 82, 82, 0.3);
    }
    .dsh-em-btn-remove:hover:not(:disabled) {
      background: rgba(255, 82, 82, 0.24);
      color: #ff9b9b;
      border-color: rgba(255, 82, 82, 0.5);
    }

    /* 底部全局工具栏 */
    .dsh-em-footer {
      padding: 14px 20px;
      background: rgba(0, 0, 0, 0.25);
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .dsh-em-footer-left,
    .dsh-em-footer-right {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .dsh-em-btn-primary {
      background: #3b5bdb;
      color: #ffffff;
      border-color: #4c6ef5;
      padding: 7px 14px;
      font-weight: 600;
      font-size: 12.5px;
      box-shadow: 0 2px 8px rgba(59, 91, 219, 0.35);
    }
    .dsh-em-btn-primary:hover:not(:disabled) {
      background: #4c6ef5;
    }
    .dsh-em-btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: #cfcfd4;
      border-color: rgba(255, 255, 255, 0.15);
      padding: 6px 12px;
    }
    .dsh-em-btn-secondary:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.16);
      color: #ffffff;
      border-color: rgba(255, 255, 255, 0.25);
    }

    /* 折叠原始报错日志 */
    .dsh-em-details {
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      background: rgba(0, 0, 0, 0.15);
      padding: 10px 20px;
      font-size: 11.5px;
    }
    .dsh-em-details summary {
      color: #8a8a92;
      cursor: pointer;
      user-select: none;
      outline: none;
      transition: color 0.15s ease;
    }
    .dsh-em-details summary:hover {
      color: #bbbbbf;
    }
    .dsh-em-raw-pre {
      margin: 10px 0 4px 0;
      padding: 10px 12px;
      background: #111114;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      color: #a0a0a5;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 180px;
      overflow-y: auto;
    }
  `;
  document.head?.appendChild(style);
}

/**
 * 寻找侧边栏底部的「设置」按钮
 * @returns {HTMLButtonElement|null}
 */
function findSettingsButton() {
  const buttons = document.querySelectorAll('button');
  // 1. 优先匹配包含“设置”或“Settings”文字的按钮
  for (const btn of buttons) {
    const text = btn.textContent?.trim();
    if (text === '设置' || text === 'Settings') {
      return btn;
    }
  }

  // 2. 匹配 aria-label 为“设置”或“Settings”
  for (const btn of buttons) {
    const aria = btn.getAttribute('aria-label');
    if (aria === '设置' || aria === 'Settings') {
      return btn;
    }
  }

  // 3. 匹配子元素 span 包含“设置”
  for (const btn of buttons) {
    const span = btn.querySelector('span');
    if (span) {
      const text = span.textContent?.trim();
      if (text === '设置' || text === 'Settings') {
        return btn;
      }
    }
  }

  // 4. 兜底：寻找位于 footArea 或 settingsArea 内部的 trigger button
  for (const btn of buttons) {
    if (btn.closest('[class*="settingsArea"]') || btn.closest('[class*="footArea"]')) {
      if (btn.id !== UPDATE_BTN_ID) {
        return btn;
      }
    }
  }

  return null;
}

/**
 * 构建提示文案
 */
function getTooltipText(status) {
  const parts = [];
  if (status?.shell?.hasUpdate) {
    parts.push(`容器有新版 (v${status.shell.latest || ''})`);
  }
  if (status?.kernel?.hasUpdate) {
    parts.push(`内核有新版 (v${status.kernel.latest || ''})`);
  }
  if (status?.plugins?.hasUpdate) {
    parts.push(`${status.plugins.count} 个插件有新版`);
  }
  if (parts.length === 0) {
    return '发现新版本，点击打开检查更新';
  }
  const targetHint = status?.shell?.hasUpdate || status?.kernel?.hasUpdate ? '打开检查更新' : '打开插件管理器';
  return `${parts.join('，')}，点击${targetHint}`;
}

/** 仅插件有更新（壳/内核均最新）时，点击应跳转插件管理器而非"检查更新"窗口 */
function isPluginsOnlyUpdate(status) {
  return Boolean(status?.plugins?.hasUpdate) && !status?.shell?.hasUpdate && !status?.kernel?.hasUpdate;
}

/**
 * 创建或获取升级按钮
 */
function createUpdateButton(status) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = UPDATE_BTN_ID;
  btn.title = getTooltipText(status);
  btn.setAttribute('aria-label', '检查更新');

  btn.innerHTML = `
    <svg class="dsh-update-icon" viewBox="0 0 24 24">
      <path d="M12 19V5M5 12l7-7 7 7"/>
    </svg>
    <span class="dsh-update-text">升级</span>
    <span class="dsh-update-dot"></span>
  `;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isPluginsOnlyUpdate(currentStatus)) {
      ipcRenderer.send('plugin-manager:open');
    } else {
      ipcRenderer.send('update:open-window');
    }
  });

  return btn;
}

/**
 * 确保升级按钮挂载在设置按钮旁边
 */
function syncButtonMount() {
  if (!currentStatus.hasUpdate) {
    // 无更新：如果存在按钮则移除
    const existing = document.getElementById(UPDATE_BTN_ID);
    if (existing) existing.remove();
    updateButtonEl = null;
    return;
  }

  const settingsBtn = findSettingsButton();
  if (!settingsBtn) {
    return;
  }

  injectStyles();

  const parent = settingsBtn.parentElement;
  if (!parent) return;

  // 为父容器加上布局样式类，使两者并排
  if (!parent.classList.contains('dsh-update-foot-wrapper')) {
    parent.classList.add('dsh-update-foot-wrapper');
  }

  let btn = document.getElementById(UPDATE_BTN_ID);
  if (!btn) {
    btn = createUpdateButton(currentStatus);
    updateButtonEl = btn;
  } else {
    btn.title = getTooltipText(currentStatus);
  }

  // 确保放在设置按钮的紧后位置（旁边）
  if (settingsBtn.nextSibling !== btn) {
    settingsBtn.after(btn);
  }
}

/**
 * 接收新的状态
 */
function applyUpdateStatus(status) {
  if (!status) return;
  currentStatus = status;
  syncButtonMount();
}

/**
 * HTML 转义
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 格式化插件失败信息与技术原因
 */
function formatPluginFailure(pluginName, rawReason) {
  const reason = (rawReason || '').trim();
  let friendlyReason = reason;

  const serviceMatch = /waiting for service:\s*([a-zA-Z0-9_.-]+)/i.exec(reason);
  if (serviceMatch) {
    const serviceName = serviceMatch[1];
    if (serviceName === 'settingsScope') {
      friendlyReason = '依赖 settingsScope 服务（新内核已移除，插件不兼容）';
    } else {
      friendlyReason = `等待服务「${serviceName}」（当前内核未提供）`;
    }
  } else if (/^import failed/i.test(reason)) {
    friendlyReason = '代码导入失败（模块缺失或语法不兼容）';
  } else if (/^pending/i.test(reason)) {
    friendlyReason = '激活挂起超时（依赖的基础服务未就绪）';
  } else if (/^failed/i.test(reason)) {
    friendlyReason = '插件激活失败';
  }

  return {
    name: pluginName,
    rawReason: reason,
    friendlyReason,
  };
}

/**
 * 从报错文本中解析出所有失败的插件条目列表
 */
function parseFailedPlugins(rawText) {
  if (!rawText) return [];
  const lines = rawText.split(/\r?\n/);
  const results = [];
  const seen = new Set();
  let currentPlugin = null;
  let currentReason = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^web boot:\s*\d+\s*entries/i.test(line)) continue;
    if (/^failed to load plugins$/i.test(line)) continue;
    if (/^插件加载失败$/i.test(line)) continue;

    const match = /^((?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+)\s*:\s*(.+)$/i.exec(line);
    if (match && !match[1].includes(' ')) {
      if (currentPlugin && !seen.has(currentPlugin)) {
        seen.add(currentPlugin);
        results.push(formatPluginFailure(currentPlugin, currentReason));
      }
      currentPlugin = match[1];
      currentReason = match[2];
    } else if (currentPlugin) {
      currentReason += ' ' + line;
    }
  }

  if (currentPlugin && !seen.has(currentPlugin)) {
    seen.add(currentPlugin);
    results.push(formatPluginFailure(currentPlugin, currentReason));
  }
  return results;
}

/**
 * 寻找启动失败卡片容器
 */
function findFailureContainer() {
  const bootRoot = document.querySelector('[data-dsh-boot]') || document.body;
  if (!bootRoot) return null;

  // 1. 查找包含 "Failed to load plugins" 或 "插件加载失败" 的标题元素
  const candidates = Array.from(bootRoot.querySelectorAll('*'));
  for (const el of candidates) {
    if (el.children.length === 0) {
      const text = el.textContent?.trim();
      if (text === 'Failed to load plugins' || text === '插件加载失败') {
        return el.parentElement;
      }
    }
  }

  // 2. 兜底：查找包含 failed 类名的容器
  const failedClassEl = bootRoot.querySelector('[class*="failed"]');
  if (failedClassEl) {
    return failedClassEl;
  }

  // 3. 兜底：查找包含 "did not activate" 文本的元素
  for (const el of candidates) {
    if (el.textContent?.includes('did not activate')) {
      return el.parentElement;
    }
  }

  return null;
}

function setAllButtonsDisabled(root, disabled) {
  if (!root) return;
  const btns = root.querySelectorAll('button');
  for (const b of btns) {
    b.disabled = disabled;
  }
}

/**
 * 渲染启动失败自愈与应急操作列表面板
 */
let isEmergencyHandling = false;
function renderEmergencyPanel(container, failedPlugins, fullRawText) {
  const existing = document.getElementById('dsh-emergency-panel');
  if (existing) {
    if (existing.dataset.pluginCount === String(failedPlugins.length)) {
      return;
    }
    existing.remove();
  }

  // 放宽父容器卡片宽度，使结构化列表不被原本的启动狭窄容器截断
  let p = container;
  while (p && p !== document.body && !p.hasAttribute('data-dsh-boot')) {
    p.style.maxWidth = '840px';
    p.style.width = 'min(840px, 94vw)';
    p.style.boxSizing = 'border-box';
    p = p.parentElement;
  }

  // 隐藏原始未能成功加载的凌乱文本节点，由我们的列表面板清晰接管
  for (const child of Array.from(container.children)) {
    if (child.id !== 'dsh-emergency-panel') {
      child.style.display = 'none';
    }
  }

  const card = document.createElement('div');
  card.id = 'dsh-emergency-panel';
  card.className = 'dsh-emergency-card';
  card.dataset.pluginCount = String(failedPlugins.length);

  const pluginNames = failedPlugins.map((p) => p.name);
  const count = failedPlugins.length;

  let tableHtml = '';
  if (count > 0) {
    tableHtml = `
      <div class="dsh-em-list-section">
        <table class="dsh-em-table">
          <thead>
            <tr>
              <th style="width: 32%;">故障插件名称</th>
              <th style="width: 44%;">未激活原因 / 状态</th>
              <th style="width: 24%; min-width: 160px; text-align: right;">操作</th>
            </tr>
          </thead>
          <tbody>
            ${failedPlugins
              .map(
                (p) => `
              <tr class="dsh-em-row">
                <td class="dsh-em-col-pkg">
                  <div class="dsh-em-pkg-wrap">
                    <span class="dsh-em-pkg-icon">🧩</span>
                    <span class="dsh-em-pkg-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
                  </div>
                </td>
                <td class="dsh-em-col-reason">
                  <span class="dsh-em-reason-badge">${escapeHtml(p.friendlyReason)}</span>
                  ${p.rawReason && p.rawReason !== p.friendlyReason ? `<div class="dsh-em-reason-detail" title="${escapeHtml(p.rawReason)}">${escapeHtml(p.rawReason)}</div>` : ''}
                </td>
                <td class="dsh-em-col-actions">
                  <div class="dsh-em-action-group">
                    <button class="dsh-em-btn dsh-em-btn-disable" data-action="disable" data-name="${escapeHtml(p.name)}" title="从启动配置中停用此插件并重启服务">
                      🚫 停用
                    </button>
                    <button class="dsh-em-btn dsh-em-btn-remove" data-action="remove" data-name="${escapeHtml(p.name)}" title="彻底卸载删除此插件并重启服务">
                      🗑️ 删除
                    </button>
                  </div>
                </td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  card.innerHTML = `
    <div class="dsh-em-header">
      <div class="dsh-em-header-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
          <line x1="12" y1="9" x2="12" y2="13"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
      </div>
      <div class="dsh-em-header-content">
        <div class="dsh-em-title">
          <span>插件加载异常拦截</span>
          ${count > 0 ? `<span class="dsh-em-title-count">${count} 个插件未激活</span>` : ''}
        </div>
        <p class="dsh-em-subtitle">
          检测到以下插件与当前内核接口不兼容导致启动中断。您可以针对列表中的插件单独进行停用或删除，也可以一键批量修复。
        </p>
      </div>
    </div>

    ${tableHtml}

    <div class="dsh-em-footer">
      <div class="dsh-em-footer-left">
        ${count > 0 ? `
          <button class="dsh-em-btn dsh-em-btn-primary" id="dshEmergencyDisableAllBtn">
            ⚡ 一键停用这 ${count} 个插件并恢复启动
          </button>
        ` : ''}
      </div>
      <div class="dsh-em-footer-right">
        <button class="dsh-em-btn dsh-em-btn-secondary" id="dshEmergencyOpenUpdateBtn">
          🔄 切回稳定内核版本
        </button>
        <button class="dsh-em-btn dsh-em-btn-secondary" id="dshEmergencyOpenPmBtn">
          📦 插件管理器
        </button>
      </div>
    </div>

    ${fullRawText ? `
      <details class="dsh-em-details">
        <summary>查看原始错误输出 (Raw Log)</summary>
        <pre class="dsh-em-raw-pre">${escapeHtml(fullRawText)}</pre>
      </details>
    ` : ''}
  `;

  // 绑定单独停用 / 删除事件
  for (const p of failedPlugins) {
    const disableBtn = Array.from(card.querySelectorAll('button[data-action="disable"]')).find(
      (b) => b.getAttribute('data-name') === p.name
    );
    if (disableBtn) {
      disableBtn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (isEmergencyHandling) return;
        const originalText = disableBtn.innerHTML;
        disableBtn.textContent = '停用中…';
        setAllButtonsDisabled(card, true);
        isEmergencyHandling = true;
        try {
          const res = await ipcRenderer?.invoke('emergency:disable-plugin', { profile: 'web', pluginName: p.name });
          if (res && !res.ok) throw new Error(res.error || '停用失败');
        } catch (e) {
          alert(`停用失败: ${e.message}`);
          disableBtn.innerHTML = originalText;
          setAllButtonsDisabled(card, false);
          isEmergencyHandling = false;
        }
      });
    }

    const removeBtn = Array.from(card.querySelectorAll('button[data-action="remove"]')).find(
      (b) => b.getAttribute('data-name') === p.name
    );
    if (removeBtn) {
      removeBtn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (isEmergencyHandling) return;
        if (!confirm(`确定彻底卸载删除插件「${p.name}」吗？\n删除后该插件将被移出项目，需重新从插件市场安装。`)) return;
        const originalText = removeBtn.innerHTML;
        removeBtn.textContent = '删除中…';
        setAllButtonsDisabled(card, true);
        isEmergencyHandling = true;
        try {
          const res = await ipcRenderer?.invoke('emergency:remove-plugin', { profile: 'web', pluginName: p.name });
          if (res && !res.ok) throw new Error(res.error || '删除失败');
        } catch (e) {
          alert(`删除失败: ${e.message}`);
          removeBtn.innerHTML = originalText;
          setAllButtonsDisabled(card, false);
          isEmergencyHandling = false;
        }
      });
    }
  }

  // 绑定一键批量停用按钮
  const disableAllBtn = card.querySelector('#dshEmergencyDisableAllBtn');
  if (disableAllBtn) {
    disableAllBtn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (isEmergencyHandling) return;
      const originalText = disableAllBtn.innerHTML;
      disableAllBtn.textContent = '正在停用并重启…';
      setAllButtonsDisabled(card, true);
      isEmergencyHandling = true;
      try {
        const res = await ipcRenderer?.invoke('emergency:disable-all', { profile: 'web', pluginNames });
        if (res && !res.ok) throw new Error(res.error || '批量停用失败');
      } catch (e) {
        alert(`恢复启动失败: ${e.message}`);
        disableAllBtn.innerHTML = originalText;
        setAllButtonsDisabled(card, false);
        isEmergencyHandling = false;
      }
    });
  }

  // 快捷跳转
  card.querySelector('#dshEmergencyOpenUpdateBtn')?.addEventListener('click', () => {
    ipcRenderer?.send('update:open-window');
  });

  card.querySelector('#dshEmergencyOpenPmBtn')?.addEventListener('click', () => {
    ipcRenderer?.send('plugin-manager:open');
  });

  container.appendChild(card);
}

/**
 * 检测并渲染启动失败自愈与应急面板
 */
function checkAndMountEmergencyPanel() {
  const failedContainer = findFailureContainer();
  if (!failedContainer) {
    const existing = document.getElementById('dsh-emergency-panel');
    if (existing) existing.remove();
    return;
  }

  injectStyles();

  // 收集容器内所有的原始报错文本
  const itemEls = Array.from(failedContainer.children).filter(
    (el) => el.id !== 'dsh-emergency-panel'
  );
  const fullRawText = itemEls.map((el) => el.textContent || '').join('\n').trim();

  // 解析所有故障插件
  const failedPlugins = parseFailedPlugins(fullRawText);

  // 渲染结构化列表面板
  renderEmergencyPanel(failedContainer, failedPlugins, fullRawText);
}

/**
 * DOM 监听器：应对 React 重新渲染、侧边栏切换与启动故障界面
 */
let debounceTimer = null;
function setupObserver() {
  if (isObserverActive) return;
  isObserverActive = true;

  const observer = new MutationObserver(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      syncButtonMount();
      checkAndMountEmergencyPanel();
    }, 80);
  });

  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
  });
}

// 页面加载完成后启动
function init() {
  setupObserver();
  checkAndMountEmergencyPanel();

  // 向主进程查询当前更新状态
  if (ipcRenderer) {
    ipcRenderer.invoke('update:get-status')
      .then((status) => {
        applyUpdateStatus(status);
      })
      .catch(() => {});

    // 监听来自主进程的状态变更广播
    ipcRenderer.on('update:status-changed', (_event, status) => {
      applyUpdateStatus(status);
    });
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseFailedPlugins,
    formatPluginFailure,
    escapeHtml,
    findSettingsButton,
    findFailureContainer,
    getTooltipText,
    isPluginsOnlyUpdate,
  };
}
