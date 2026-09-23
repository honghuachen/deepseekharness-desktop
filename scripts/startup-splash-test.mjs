#!/usr/bin/env node
/**
 * 启动屏与后台 Runner 优化测试：
 * 1. splash.js 模块结构、数据 URI 与 DOM 结构校验
 * 2. runner.js 模块结构与关键导出校验
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { getSplashHtml, splashDataUrl } = require('../src/main/splash.js');
const { createRunner, pickPort, isPortFree, probePort } = require('../src/main/runner.js');

let failed = false;
function assert(cond, msg) {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed = true;
}

console.log('=== 启动屏 (splash.js) 测试 ===');
{
  const html = getSplashHtml({ version: '1.7.1', kernelVersion: '0.1.5-rc.1' });
  assert(typeof html === 'string' && html.length > 500, 'getSplashHtml 生成完整 HTML 页面');
  assert(html.includes('id="status-text"'), '包含状态文本容器 #status-text');
  assert(html.includes('class="progress-bar"'), '包含进度条元素 .progress-bar');
  assert(html.includes('id="log-panel"'), '包含日志容器 #log-panel');
  assert(html.includes('id="error-box"'), '包含异常重试容器 #error-box');
  assert(html.includes('__dshUpdateStatus'), '包含动态状态更新客户端方法 __dshUpdateStatus');
  assert(html.includes('__dshShowError'), '包含错误展示客户端方法 __dshShowError');
  assert(html.includes('__dshShowLogs'), '包含日志展开客户端方法 __dshShowLogs');
  assert(html.includes('<svg') && html.includes('DSH Web'), '包含品牌 SVG 矢量图标与应用标题');
  assert(html.includes('v1.7.1 · 内核 v0.1.5-rc.1'), '正确渲染外壳与内核版本');

  const dataUrl = splashDataUrl({ version: '1.7.1' });
  assert(dataUrl.startsWith('data:text/html;charset=utf-8,'), 'splashDataUrl 格式为标准 data:text/html');
  assert(dataUrl.includes(encodeURIComponent('DSH Web')), 'splashDataUrl 正确 URL 编码页面内容');
}

console.log('\n=== Runner (runner.js) 启动优化测试 ===');
{
  const testPaths = {
    versionDir: () => os.tmpdir(),
    rootDir: path.join(os.tmpdir(), 'dsh-test-root'),
    logFile: path.join(os.tmpdir(), 'dsh-test.log'),
  };

  const runner = createRunner({ nodeBin: '/mock/bin/node', paths: testPaths });
  assert(typeof runner.start === 'function', 'createRunner 包含 start 方法');
  assert(typeof runner.stop === 'function', 'createRunner 包含 stop 方法');
  assert(typeof runner.isRunning === 'function', 'createRunner 包含 isRunning 方法');
  assert(typeof runner.onExit === 'function', 'createRunner 包含 onExit 方法');
  assert(typeof pickPort === 'function' && typeof isPortFree === 'function' && typeof probePort === 'function', '导出端口探测辅助函数');
}

if (failed) {
  console.error('\n❌ 测试未完全通过');
  process.exit(1);
} else {
  console.log('\n🎉 全部启动屏与 Runner 优化测试通过！');
}
