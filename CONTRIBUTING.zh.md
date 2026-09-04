[English](CONTRIBUTING.md) | 中文

# 参与贡献 DSH Web

感谢你愿意花时间参与这个项目。这是一个极薄的、跨平台（macOS + Windows）的 Electron 容器，包裹着官方的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)——开始之前建议先看一遍 [README.zh.md](README.zh.md)，了解整体架构和功能范围。

## 环境准备

```bash
npm install          # Electron 等 devDependencies
npm run fetch-tools  # 下载 vendor/pnpm + vendor/node（便携 Node），幂等
npm start             # 开发模式启动 App
```

开始改动前先跑一遍快速测试套件，确认基线是绿的：

```bash
npm test
```

## 工程布局

先看一遍 [README.zh.md](README.zh.md) 的"工程结构"一节，`src/main/` 和 `scripts/` 下每个文件的作用都列在那里。几点提前说明：

- `src/main/**` 全部是普通 CommonJS，没有构建步骤。唯一的例外是 `src/main/token-usage/` 下有一个 `.html` 文件（统计窗口的 UI），直接通过 `BrowserWindow.loadFile` 加载。
- 项目里没有配置 lint 或 formatter。改动时跟随你正在编辑的那个文件已有的风格，不要整体重新格式化。
- `src/main/**` 里的注释都是中文，而且只解释"为什么这么做"（一个不明显的约束、一个变通方案、一个不变量），不复述"这行代码在做什么"。新代码请沿用这个习惯——不要在同一个文件里中英文混用注释风格，也不要写"这一行是在……"这种复述型注释。

## 提交改动的流程

1. Fork 仓库，从 `main` 切一个分支出来。分支命名没有硬性规定，`fix/session-scan-crash` 或 `feat/token-usage-export` 这种描述性的名字就可以。
2. 保持改动聚焦。修 bug 不要顺带夹带无关的重构；加新功能不要顺手改写旁边本来就好好的代码。
3. 视情况补充/更新测试，见下面的[测试](#测试)一节。不是每个改动都要新写一个测试脚本，但如果动了 `src/main/token-usage/**` 或 `src/main/plugin-guard.js`，基本上都应该同步改一下对应的 `scripts/*-test.mjs` / `scripts/test-*.mjs`。
4. 凡是涉及界面的改动（统计窗口、插件管理器窗口、启动状态窗口），提 PR 前请务必 `npm start` 实际点一遍——测试通过只能验证逻辑对不对，不能验证这个功能在真实 App 里能不能用。
5. 对 `main` 发起 PR。描述里说清楚"为什么"要这个改动，而不只是"改了什么"（diff 本身已经说明了改了什么），并注明你测试过什么。

## 提交信息规范

本仓库遵循 [Conventional Commits](https://www.conventionalcommits.org/)（约定式提交）规范：

```
<type>(<scope>): <简短摘要，祈使语气，末尾不加句号>

<可选正文——解释"为什么"，不要复述"改了什么"，diff 本身已经说明了这个>

<可选 footer，比如 "Fixes #12">
```

**type 取值：**

| type | 什么时候用 |
| --- | --- |
| `feat` | 新增一个用户可见的能力 |
| `fix` | 修 bug |
| `docs` | 只改文档（README、本文件、代码注释） |
| `refactor` | 重构代码结构，行为不变 |
| `perf` | 性能优化 |
| `test` | 新增/修复测试，不改生产代码 |
| `build` | 打包/构建工具链（`electron-builder.yml`、`scripts/fetch-tools.mjs`、`package.json` 里的 scripts） |
| `chore` | 其他不属于以上几类的杂项（升级依赖、改 `.gitignore` 等） |

**scope（作用域）可选，但改 `src/main/token-usage/`、`src/main/plugin-guard.js`/`plugin-manager.js`、`src/main/updater.js`/`runner.js` 时建议带上**，比如 `feat(token-usage): ...`、`fix(plugin-guard): ...`。一次改动横跨好几个不相关模块时就不用加了。

**取自本仓库真实历史的例子：**

```
feat: add DeepSeek Harness token/cost usage stats window

Ports the token/cost usage tracking from ClaudeCodeMacTools (native
Swift menu-bar app) into this cross-platform Electron shell: scans
~/.dsh/sessions, decrypts/parses session transcripts, dedupes,
aggregates by project/model/session, and estimates cost against an
editable pricing table. Adds a "Token 用量统计…" menu item that opens
a dedicated stats window.
```

小改动、一看 diff 就懂"为什么"的情况下，单行提交信息完全没问题（比如 `fix: correct off-by-one in yesterday() date range`）——正文是留给那些"为什么"不写清楚就看不出来的情况的。

## 测试

```bash
npm test          # 快速回归套件——不依赖网络
npm run test:e2e  # 完整更新引擎流程，连真实 npm registry（较慢）
```

`npm test` 会依次跑以下几个脚本，全部无头、不依赖网络：

- `scripts/badge-test.mjs` —— 任务完成角标监听器
- `scripts/plugin-guard-test.mjs` —— 第三方插件守卫
- `scripts/test-plugin-update.mjs` —— 第三方插件更新逻辑
- `scripts/test-token-usage.mjs` —— Token 用量统计模块，如果本机有真实的会话文件，还会额外跑一次逐字节的解压回归比对（没有的话会优雅跳过）

如果你在 `src/main/` 下新加了一个纯逻辑模块，请照着现有的风格（不用任何测试框架，纯 `assert` 断言、自包含）在 `scripts/` 下配一个对应脚本，并接进 `package.json` 的 `test` 脚本里。

## 报告问题

提 Issue 时请附上：你的操作系统和 App 版本（菜单 → 关于 DSH Web 里同时能看到容器版本和内核版本）、期望的行为和实际发生的行为、以及日志文件里相关的那几行（菜单 → 打开日志文件夹）。

## 许可协议

参与贡献即代表你同意你的贡献将按项目的 [MIT 许可协议](LICENSE) 授权。
