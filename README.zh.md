[English](README.md) | 中文

# DSH Web —— 官方 DeepSeek Harness 桌面容器

一个极薄的跨平台（macOS + Windows）桌面容器：**窗口里运行的始终是 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 官方 Web 壳**，容器本身不做任何业务界面。

核心能力：**每次启动自动检测并更新到官方最新版本**。

```
┌─────────────────────────────────────────────────────┐
│  DSH Web.app (Electron 薄壳)                         │
│                                                     │
│  1. 查 npm registry: @deepseek-ai/dsh latest        │
│  2. 有新版 → pnpm 装进 versions/<新版本>/            │
│  3. current 符号链接原子切换 → 回滚兜底              │
│  4. 启动官方 dsh web 服务 (127.0.0.1:<port>)         │
│  5. 窗口加载官方页面 ←—— 界面 100% 官方               │
└─────────────────────────────────────────────────────┘
```

## 设计原则

| 决策 | 理由 |
| --- | --- |
| 壳零业务逻辑，只做「更新 + 拉起 + 开窗」 | 官方迭代飞快，薄壳永不与上游冲突 |
| 运行时按版本号装入独立目录，符号链接切换 | 升级失败秒回旧版；旧版本保留用于回滚 |
| pnpm 构建脚本白名单（`allowBuilds`）预置 | 只允许 node-pty/koffi 等已知原生模块执行脚本 |
| 便携 Node v22 随 APP 分发 | 不依赖系统 Node 版本；ABI 与原生模块一致 |
| 数据目录独立于壳 | 会话数据在 `~/.dsh`，升级/重装壳均不受影响 |

## 快速开始

### 开发模式

```bash
npm install          # 安装 Electron 等 devDependencies
npm run fetch-tools  # 下载 vendor/pnpm + vendor/node（便携 Node）
npm start
```

首次启动会下载官方运行时（约 1–2 分钟，视网络），之后启动只在有新版时才下载。

### 打包成 APP

```bash
npm run dist         # 产出 macOS (dmg/zip) + Windows (NSIS 安装器/zip)
```

一次构建双平台（electron-builder 交叉打包，Windows 目标在 macOS 上直接构建）：

| 平台 | 产物 |
| --- | --- |
| macOS arm64 | `DSH Web-<ver>-arm64.dmg` / `-mac.zip` |
| Windows x64 | `DSH Web-Setup-<ver>-x64.exe` / `-win.zip` |

Windows 说明：

- 未签名，首次运行会有 SmartScreen 提示（「仍要运行」即可）；安装器为辅助模式，可选安装目录
- 随包内置便携 `node.exe` 与 pnpm；版本切换用 NTFS junction（无需管理员权限），受限环境自动回退指针文件
- 任务完成角标以任务栏叠加数字呈现；会话日志解析依赖系统 `zstd` 命令（如无则角标功能静默降级，可用 `scoop install zstd` 补上）

## 更新机制

每次启动：

1. `GET https://registry.npmjs.org/@deepseek-ai/dsh/latest` 取最新版本；
2. 与本地激活版本 semver 比较（支持 `-rc.N` 预发布排序）；
3. 有新版：下载安装到 `<数据目录>/runtime/versions/v<版本>/`，成功后把 `runtime/current` 符号链接原子切换过去；失败则保留原版本继续用旧的；
4. 自动清理：仅保留最近 2 个版本。

离线时跳过检测，直接用已装版本；本地无任何版本且离线才报错。

手动触发：菜单栏 **DSH Web → 检查更新…**（⌘U），下载完成后可选择立即应用或下次启动生效。

菜单 **关于 DSH Web** 会同时显示容器版本与内核版本（官方运行时 `@deepseek-ai/dsh` 的当前激活版本）。

## 目录布局

```
<数据目录>/                      # 打包后 ~/Library/Application Support/DSH Web；开发期仓库下 .data/
├── runtime/
│   ├── versions/v0.1.1-rc.2/   # 每个版本一套完整 node_modules
│   └── current -> versions/v0.1.1-rc.2
├── pnpm-store/                 # 内容寻址存储，多版本间去重
├── logs/app-YYYY-MM-DD.log     # 运行日志
└── settings.json               # 用户配置
```

## 配置

`settings.json`（菜单可打开）：

```json
{
  "port": 43130,             // web 服务端口，被占用时自动向后试探
  "channel": "latest",       // 更新频道（当前为 npm latest）
  "autoCheckUpdates": true,  // 关闭后每次启动不再检测
  "dshHome": "",             // 留空 = 官方标准 ~/.dsh；可指向自定义目录隔离
  "taskBadge": true          // 会话任务完成后在 Dock/任务栏图标显示完成数量角标
}
```

## 与第三方壳的数据关系

APP 默认使用官方标准数据目录 `~/.dsh`，会话历史与官方 CLI 完全互通。

第三方容器（如旧版 DSH Desktop）可能通过插件市场往 profile 里塞社区插件，
它们常与官方新版本不兼容，会导致 web 服务启动即崩（表现为窗口白屏）。对此本 APP 提供：

1. **插件管理器**（菜单：DSH Web → 管理第三方插件…）：按 profile 浏览全部插件，
   区分官方 / 第三方及其引用位置（bundle、补丁层），勾选后精准移除；
   移除前二次确认，原文件自动备份到 profile 目录的 `.sanitized-backup-*`。
2. **首次启动自动清理**：web profile 若被污染则恢复官方默认形态，
   保留 Funplay MCP 等官方组件的用户层配置；
3. **崩溃自愈**：服务意外退出自动重启；若从未清理过则先清理再重启。

> 注意：`desktop` profile 属于旧版 DSH Desktop。移除其中的插件会让旧壳的市场功能失效
> （这正是去污染的目的）；建议先退出旧壳再操作。如需安装插件，请用官方方式：
> `dsh plugin --profile <name> add <package>`。

## Token 用量统计（成本估算）

菜单 **DSH Web → Token 用量统计…**（⌘⇧T）打开一个独立窗口，统计 `~/.dsh/sessions` 下所有会话的 token 用量与估算花费：

- **时间范围**：今日 / 昨天 / 本周 / 本月 / 全部 / 自定义区间
- **分组维度**：按项目（沿 `.git` 向上归并到仓库根，支持 worktree）/ 按模型 / 按会话（最多显示 50 条，按最近活跃排序）
- 每行显示 token 总量、缓存命中率、估算费用；按模型/按会话额外显示 输入/输出/缓存写入/缓存读取 的分项花费
- 点击项目/会话行会在 Finder（Windows 上是资源管理器）里打开对应目录
- 窗口打开后每 60 秒自动重新扫描一次

**费用估算基于本地可编辑的定价表**：首次打开会把内置的 `pricing.default.json` 拷贝一份到应用数据目录下的 `pricing.json`，之后只读写这份用户副本（不会被应用更新覆盖）。DeepSeek Harness 可以路由到任意 provider/模型（社区实测出现过 OpenRouter、SenseNova、Zhipu、Google 等各家模型），这份定价表只内置了 DeepSeek 官方模型；其余模型会显示"未知定价"，需要自己按同样的 JSON 结构补充单价。DeepSeek 官方 API 按 UTC 高峰/非高峰时段分时计价，这里只取"非高峰"（较低）价位做单一近似估算，费用是 ≈ 估算值，不是精确账单。

**性能与跨平台**：解压 `.zstd` 会话日志优先使用系统安装的 `zstd` 命令行（实测比纯 JS 快一个数量级），没有的话（典型是没额外装过命令行工具的 Windows 机器）自动落回纯 JS 的 [`fzstd`](https://www.npmjs.com/package/fzstd) 库，两条路径都不依赖任何原生编译，保证 Windows 上也能正常工作。整个扫描/解压/解析过程跑在独立的 worker 线程里，不会阻塞主进程或界面。

## 注意事项

- **不要同时运行两个 DSH 容器**（如旧的 DSH Desktop.app）：两者共用 `~/.dsh` 会话数据，并行写有风险。迁移到本 APP 后建议退出/删除旧壳。
- 默认端口 `43130`，避开旧 DSH Desktop 的 `43120`。
- 原生模块（node-pty、koffi）全部使用官方 prebuilt 二进制，无需 Xcode 命令行工具。
- 如需分发给别人，配置 Apple 签名（`CSC_LINK` 环境变量）后重新 `npm run dist`。

## 工程结构

```
src/main/
├── main.js              # 启动编排、窗口、菜单、生命周期、崩溃自愈
├── config.js            # 路径与常量（registry URL、构建白名单）
├── updater.js           # 更新引擎：检测/安装/原子切换/清理（纯 node，可测）
├── runner.js            # 官方服务进程管理：拉起/双重健康检查/优雅退出
├── plugin-guard.js      # 第三方插件守卫：外科手术式恢复官方 profile
├── plugin-manager.js    # 第三方插件管理器窗口
├── badge.js             # 任务完成 Dock/任务栏角标监听
├── semver.js            # 预发布感知的版本比较
├── status-window.js     # 启动进度窗口（纯文本，非产品界面）
├── logger.js            # 文件日志
└── token-usage/         # Token 用量统计：扫描/解压/解析/去重/聚合/定价/统计窗口
    ├── scanner.js        # 递归找 session.jsonl(.zstd)
    ├── decompress.js     # 优先系统 zstd，兜底纯 JS fzstd
    ├── parser.js         # 解析会话事件为用量记录
    ├── dedup.js          # 按 requestId 去重（流式快照会重复写）
    ├── aggregator.js     # 按项目/模型/会话聚合 + 估算费用
    ├── pricing.js        # 定价表加载（内置默认 + 用户可编辑副本）
    ├── cache.js           # 按文件 mtime/size 的增量缓存
    ├── scan-worker.js     # worker 线程里跑实际扫描，不阻塞主进程
    ├── service.js         # 编排以上各步
    ├── window.js          # 统计窗口 + IPC
    └── stats-window.html  # 统计窗口 UI
scripts/
├── fetch-tools.mjs        # 构建期下载 pnpm/便携 Node 到 vendor/
├── e2e-update-test.mjs    # 无头端到端测试（真实 registry 全链路）
├── test-plugin-update.mjs # 第三方插件更新逻辑自测
├── test-token-usage.mjs   # Token 用量统计模块自测（含真实文件解压回归）
├── badge-test.mjs         # 任务完成角标自测
├── plugin-guard-test.mjs  # 插件守卫自测
├── repair-session.mjs     # 修复损坏的 session.jsonl(.zstd) 序号
└── verify-session-file.cjs # 校验 session 文件的 zstd 分帧/序号连续性
```

## 测试

```bash
npm test          # 快速回归套件：角标 / 插件守卫 / 插件更新 / Token 用量统计（无网络依赖）
npm run test:e2e  # 端到端更新流程测试（真实连 npm registry，较慢）
```

## 贡献

欢迎提 Issue / PR。提交前请先看 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)（含开发流程与提交信息规范）。

## 许可协议

[MIT](LICENSE)
