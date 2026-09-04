'use strict';

/**
 * 路径与常量集中管理。
 * 所有函数只依赖显式传入的根目录（不 import electron），
 * 便于在无头测试中复用。
 */

const path = require('node:path');

const DSH_PACKAGE = '@deepseek-ai/dsh';
const DSH_PACKAGE_ENCODED = '@deepseek-ai%2Fdsh';
const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${DSH_PACKAGE_ENCODED}/latest`;

/** pnpm 安装时允许执行构建脚本的原生依赖白名单 */
const BUILD_ALLOWLIST = [
  '@deepseek-ai/dsh-subprocess-local',
  '@google/genai',
  'koffi',
  'node-pty',
  'protobufjs',
];

const DEFAULT_PORT = 43130;
const DEFAULT_SETTINGS = {
  port: DEFAULT_PORT,
  channel: 'latest', // 目前仅支持 npm latest 频道
  autoCheckUpdates: true,
  // 会话数据根（DSH_HOME）。留空 = 官方标准 ~/.dsh，会话历史无缝延续。
  // 如需完全隔离可指向自定义目录（例如 "~/Library/Application Support/DSH Web/dsh-home"）。
  dshHome: '',
  // 会话任务完成后在 Dock 图标上显示完成数量角标（聚焦窗口即清零）
  taskBadge: true,
  // 内核版本固定：空 = 跟随 npm latest 自动更新；非空 = 固定到具体版本号，启动时不再比较 latest
  pinnedKernelVersion: '',
};

/**
 * 计算应用的全部工作目录。
 * @param {string} rootDir 数据根目录（打包后为 userData，开发期为仓库下 .data）
 */
function makePaths(rootDir) {
  const runtimeDir = path.join(rootDir, 'runtime');
  const versionsDir = path.join(runtimeDir, 'versions');
  return {
    rootDir,
    runtimeDir,
    versionsDir,
    currentLink: path.join(runtimeDir, 'current'),
    logsDir: path.join(rootDir, 'logs'),
    storeDir: path.join(rootDir, 'pnpm-store'),
    settingsFile: path.join(rootDir, 'settings.json'),
    versionDir(version) {
      // 目录名即版本号；拒绝路径穿越
      if (!/^v?[0-9A-Za-z.+-]+$/.test(version)) {
        throw new Error(`非法版本号: ${version}`);
      }
      const name = version.startsWith('v') ? version : `v${version}`;
      return path.join(versionsDir, name);
    },
  };
}

/** 读取用户设置（缺省合并），坏文件不致命 */
function loadSettings(paths) {
  const fs = require('node:fs');
  try {
    const raw = fs.readFileSync(paths.settingsFile, 'utf8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(paths, settings) {
  const fs = require('node:fs');
  fs.mkdirSync(paths.rootDir, { recursive: true });
  fs.writeFileSync(paths.settingsFile, JSON.stringify(settings, null, 2) + '\n');
}

module.exports = {
  DSH_PACKAGE,
  DSH_PACKAGE_ENCODED,
  REGISTRY_LATEST_URL,
  BUILD_ALLOWLIST,
  DEFAULT_PORT,
  DEFAULT_SETTINGS,
  makePaths,
  loadSettings,
  saveSettings,
};
