'use strict';

/**
 * DSH Web 主窗口 Preload 脚本：
 *   1. 接收来自主进程的更新可用通知（update:status-changed）
 *   2. 在侧边栏底部的「设置」按钮旁边动态挂载升级标识按钮
 *   3. 点击升级按钮时通知主进程打开「检查更新」窗口
 */

const { ipcRenderer } = require('electron');

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
 * DOM 监听器：应对 React 重新渲染和侧边栏切换
 */
let debounceTimer = null;
function setupObserver() {
  if (isObserverActive) return;
  isObserverActive = true;

  const observer = new MutationObserver(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      syncButtonMount();
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

  // 向主进程查询当前更新状态
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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
