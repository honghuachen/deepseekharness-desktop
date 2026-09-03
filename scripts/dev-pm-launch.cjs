'use strict';
/**
 * 开发验证：以隔离的临时 DSH_HOME 打开插件管理器窗口，
 * 配合 DSH_WEB_DEV_PM_DUMP=<path> 导出窗口文本，验证「有新版」条目渲染。
 * 用法：DSH_WEB_DEV_PM_DUMP=/tmp/pm-dump.txt node_modules/.bin/electron scripts/dev-pm-launch.cjs
 */
const { app } = require('electron');
const path = require('node:path');
const { openPluginManager } = require('../src/main/plugin-manager.js');

const TEST_HOME = process.env.DSH_PM_TEST_HOME || path.join(process.env.HOME, '.dsh');

app.whenReady().then(() => {
  openPluginManager({
    dshHome: () => TEST_HOME,
    pnpmCjs: path.join(__dirname, '..', 'vendor', 'pnpm', 'bin', 'pnpm.cjs'),
    getNodeBin: async () => process.env.DSH_PM_NODE || '/opt/homebrew/bin/node',
    log: (...a) => console.log('[pm-test]', ...a),
  });
  // 8 秒后自动退出，便于脚本收尾
  setTimeout(() => app.quit(), 8000);
});
