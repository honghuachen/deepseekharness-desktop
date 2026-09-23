'use strict';

const { app } = require('electron');

/**
 * 生成主窗口在服务就绪前展示的轻量 Splash 加载界面 HTML。
 * 纯本地离线秒开，支持深浅色自适应、品牌动效、动态状态文案与超时自动日志展开。
 */
function getSplashHtml({ version, kernelVersion = '' } = {}) {
  const v = version || (app ? app.getVersion() : '1.7.1');
  const kvText = kernelVersion ? ` · 内核 v${kernelVersion}` : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>DSH Web</title>
<style>
  :root {
    color-scheme: light dark;
    --bg-light: #f6f7f9;
    --text-light: #1d2129;
    --sub-light: #86909c;
    --border-light: rgba(0, 0, 0, 0.08);
    --log-bg-light: #ffffff;

    --bg-dark: #17181a;
    --text-dark: #e6edf3;
    --sub-dark: #8b949e;
    --border-dark: rgba(255, 255, 255, 0.1);
    --log-bg-dark: #121314;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    width: 100vw; height: 100vh;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    background: var(--bg-light);
    color: var(--text-light);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    user-select: none;
    -webkit-user-select: none;
    overflow: hidden;
  }
  @media (prefers-color-scheme: dark) {
    body {
      background: var(--bg-dark);
      color: var(--text-dark);
    }
  }

  .splash-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    max-width: 480px;
    width: 90%;
    animation: fadeIn 0.25s ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .logo-wrap {
    position: relative;
    width: 72px;
    height: 72px;
    margin-bottom: 20px;
  }

  .logo-glow {
    position: absolute;
    inset: -12px;
    background: radial-gradient(circle, rgba(77, 107, 254, 0.35) 0%, rgba(0, 210, 255, 0) 70%);
    border-radius: 50%;
    animation: pulseGlow 2.5s ease-in-out infinite;
  }

  @keyframes pulseGlow {
    0%, 100% { opacity: 0.35; transform: scale(0.95); }
    50% { opacity: 0.85; transform: scale(1.1); }
  }

  .logo-icon {
    position: relative;
    width: 72px;
    height: 72px;
    border-radius: 18px;
    background: linear-gradient(135deg, #3b5bdb 0%, #4d6bfe 50%, #00b4d8 100%);
    box-shadow: 0 8px 24px rgba(59, 91, 219, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #ffffff;
  }

  .app-name {
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.2px;
    margin: 0 0 6px 0;
  }

  .app-version {
    font-size: 12px;
    color: var(--sub-light);
    margin-bottom: 20px;
    font-weight: 400;
  }
  @media (prefers-color-scheme: dark) {
    .app-version { color: var(--sub-dark); }
  }

  .progress-track {
    width: 260px;
    height: 4px;
    background: rgba(127, 127, 127, 0.16);
    border-radius: 99px;
    overflow: hidden;
    margin-bottom: 14px;
    position: relative;
  }

  .progress-bar {
    width: 40%;
    height: 100%;
    background: linear-gradient(90deg, #3b5bdb, #00d2ff);
    border-radius: 99px;
    position: absolute;
    animation: shimmer 1.4s ease-in-out infinite;
  }

  @keyframes shimmer {
    0% { left: -40%; }
    100% { left: 100%; }
  }

  .status-text {
    font-size: 13px;
    color: var(--sub-light);
    margin: 0 0 16px 0;
    min-height: 20px;
    line-height: 1.5;
    transition: color 0.15s ease;
  }
  @media (prefers-color-scheme: dark) {
    .status-text { color: var(--sub-dark); }
  }

  .log-panel {
    width: 100%;
    max-height: 140px;
    overflow-y: auto;
    background: var(--log-bg-light);
    border: 1px solid var(--border-light);
    border-radius: 8px;
    padding: 10px 12px;
    text-align: left;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 11px;
    line-height: 1.55;
    color: #4e5969;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
    opacity: 0;
    transform: translateY(4px);
    transition: opacity 0.3s ease, transform 0.3s ease;
    pointer-events: none;
  }
  @media (prefers-color-scheme: dark) {
    .log-panel {
      background: var(--log-bg-dark);
      border-color: var(--border-dark);
      color: #9aa0a6;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3);
    }
  }

  .log-panel.visible {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
  }

  .log-line {
    white-space: pre-wrap;
    word-break: break-all;
  }

  .error-box {
    display: none;
    margin-top: 10px;
    gap: 10px;
  }
  .retry-btn {
    padding: 6px 14px;
    font-size: 12.5px;
    font-weight: 500;
    color: #ffffff;
    background: #3b5bdb;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.15s ease;
  }
  .retry-btn:hover { background: #4c6ef5; }
</style>
</head>
<body>
  <div class="splash-container">
    <div class="logo-wrap">
      <div class="logo-glow"></div>
      <div class="logo-icon">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>
      </div>
    </div>
    <h1 class="app-name">DSH Web</h1>
    <div class="app-version" id="app-version-text">v${v}${kvText}</div>
    <div class="progress-track" id="progress-track">
      <div class="progress-bar"></div>
    </div>
    <div class="status-text" id="status-text">正在启动服务…</div>
    <div class="log-panel" id="log-panel"></div>
    <div class="error-box" id="error-box">
      <button class="retry-btn" onclick="window.__dshRelaunch && window.__dshRelaunch()">重新尝试</button>
    </div>
  </div>

  <script>
    window.__dshUpdateStatus = function(text, sub) {
      const el = document.getElementById('status-text');
      if (el && text) el.textContent = text;
      if (sub) {
        const vEl = document.getElementById('app-version-text');
        if (vEl) vEl.textContent = sub;
      }
      const panel = document.getElementById('log-panel');
      if (panel && text) {
        const line = document.createElement('div');
        line.className = 'log-line';
        line.textContent = text;
        panel.appendChild(line);
        panel.scrollTop = panel.scrollHeight;
        while (panel.childNodes.length > 40) panel.removeChild(panel.firstChild);
      }
    };

    window.__dshShowLogs = function() {
      const panel = document.getElementById('log-panel');
      if (panel) panel.classList.add('visible');
    };

    window.__dshShowError = function(msg) {
      const el = document.getElementById('status-text');
      if (el) {
        el.textContent = msg || '服务启动失败';
        el.style.color = '#ff5252';
      }
      const pt = document.getElementById('progress-track');
      if (pt) pt.style.display = 'none';
      const eb = document.getElementById('error-box');
      if (eb) eb.style.display = 'flex';
      window.__dshShowLogs();
    };

    // 超过 4 秒若仍处于 Splash 状态（说明是首次下载/重度初始化等），平滑展示详细日志
    setTimeout(() => {
      window.__dshShowLogs();
    }, 4000);
  </script>
</body>
</html>`;
}

function splashDataUrl(opts) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(getSplashHtml(opts))}`;
}

module.exports = { getSplashHtml, splashDataUrl };
