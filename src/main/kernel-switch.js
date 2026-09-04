'use strict';

/**
 * 内核版本切换的核心状态机：安装 → 激活 → 落盘 pin 设置。
 * 与 runner/窗口刷新解耦（那部分由 main.js 在调用前后自行处理 stop/start），
 * 依赖注入 updater/settings/paths，可脱离 Electron 用纯 node 测试。
 *
 * install()/activate() 任一步失败都会直接抛出，此时 settings 尚未被改动——
 * 调用方（main.js）据此保持切换前的 activeVersion/pinnedKernelVersion 不变。
 */
function createKernelSwitcher({ updater, settings, paths, saveSettings, log = () => {} }) {
  async function switchKernelVersion(version, { pin, onLine } = {}) {
    await updater.install(version, onLine || log);
    await updater.activate(version);

    if (pin === true) {
      settings.pinnedKernelVersion = version;
    } else if (pin === false) {
      settings.pinnedKernelVersion = '';
    }
    saveSettings(paths, settings);
    return version;
  }

  return { switchKernelVersion };
}

module.exports = { createKernelSwitcher };
