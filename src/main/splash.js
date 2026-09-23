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
<title>DeepSeek Harness</title>
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
    border-radius: 14px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #ffffff;
  }

  .logo-icon svg { display: block; border-radius: 14px; }
  /* 深色背景下黑色图标加一圈细描边，避免与背景融为一体 */
  @media (prefers-color-scheme: dark) {
    .logo-icon { box-shadow: 0 0 0 1px var(--border-dark), 0 8px 24px rgba(0, 0, 0, 0.5); }
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
        <!-- 与应用图标 assets/icon-official.svg 一致（内联以保证离线秒开，assets 不进包） -->
        <svg width="72" height="72" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
          <rect width="1024" height="1024" rx="200" fill="#000000"/>
          <g transform="translate(174,174) scale(13.52)">
            <path d="M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z" fill="#ffffff"/>
          </g>
        </svg>
      </div>
    </div>
    <h1 class="app-name">DeepSeek Harness</h1>
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
