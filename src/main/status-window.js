'use strict';

/**
 * 启动期状态窗口：纯文本展示更新/启动进度，官方页面就绪后自动关闭。
 * 这是容器的加载反馈，不是产品界面——产品界面始终是官方 web 壳。
 */

const { BrowserWindow, app } = require('electron');

const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 18px 20px;
    font: 13px/1.7 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
    background: #f6f7f9; color: #1d2129;
  }
  @media (prefers-color-scheme: dark) { body { background: #17181a; color: #d6d9dd; } }
  h1 { font-size: 14px; margin: 0 0 10px; display:flex; align-items:center; gap:8px;}
  .dot { width:9px; height:9px; border-radius:50%; background:#4d6bfe; animation:pulse 1.2s infinite ease-in-out;}
  @keyframes pulse { 0%,100%{opacity:.35} 50%{opacity:1} }
  #log { white-space: pre-wrap; word-break: break-all; opacity:.85; max-height: 220px; overflow:hidden;
         display:flex; flex-direction:column; justify-content:flex-end; }
</style>
</head>
<body>
  <h1><span class="dot"></span>DSH Web v${app.getVersion()} 正在准备…</h1>
  <div id="log"></div>
  <script>
    window.appendLine = (text) => {
      const el = document.getElementById('log');
      const line = document.createElement('div');
      line.textContent = text;
      el.appendChild(line);
      while (el.childNodes.length > 40) el.removeChild(el.firstChild);
    };
  </script>
</body>
</html>`;

function createStatusWindow() {
  const win = new BrowserWindow({
    width: 520,
    height: 320,
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: `DSH Web v${app.getVersion()}`,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE_HTML)}`);
  win.once('ready-to-show', () => win.show());

  let queue = [];
  function push(text) {
    if (!win.webContents || win.isDestroyed()) return;
    // executeJavaScript 需要等页面加载完成；先入队
    if (!win.webContents.isLoading()) {
      win.webContents.executeJavaScript(`window.appendLine(${JSON.stringify(String(text))})`).catch(() => {});
    } else {
      queue.push(String(text));
      win.webContents.once('did-finish-load', () => {
        const pending = queue;
        queue = [];
        for (const t of pending) {
          win.webContents.executeJavaScript(`window.appendLine(${JSON.stringify(t)})`).catch(() => {});
        }
      });
    }
  }

  function close() {
    if (!win.isDestroyed()) win.close();
  }

  function setTitle(t) {
    if (!win.isDestroyed()) win.setTitle(t);
  }

  return { win, push, close, setTitle };
}

module.exports = { createStatusWindow };
