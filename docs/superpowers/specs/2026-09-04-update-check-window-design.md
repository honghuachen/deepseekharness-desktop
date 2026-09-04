# 更新检查窗口:容器版本 + 内核多版本管理

- 状态:已批准,待实施
- 日期:2026-09-04

## 背景与目标

目前"检查更新…"(⌘U)只做一件事:查 npm registry 上 `@deepseek-ai/dsh` 的 `latest` dist-tag,
和本地已装版本比较,有新版就下载安装,询问是否立即应用——全部走系统原生 `dialog`,
且完全没有对"容器(壳 APP 本身)"的更新检测。

目标:把这个入口换成一个独立窗口,同时覆盖:

1. **容器(壳)更新检测**:查 GitHub Releases 上的最新 tag,与当前 `app.getVersion()` 比较,
   有新版则引导用户前往下载页(不做自动下载安装)。
2. **内核(`@deepseek-ai/dsh`)多版本管理**:列出全部已发布版本(按时间倒序),
   标注每个版本是预览版(`alpha`)、候选版(`rc`)还是官方 `latest` 推荐版;
   用户可以手动切换到列表中任意一个版本。
3. **启动时的默认行为**:没有手动固定版本时,继续维持现状——自动检测并更新到 npm `latest`
   dist-tag 指向的版本;一旦用户手动固定过某个版本,启动时尊重这个选择,不再自动跳回 latest,
   除非用户在窗口里主动"恢复自动跟随最新稳定版"。

### 关键约束:官方目前没有真正的"正式版"

查询 npm registry 真实数据(`registry.npmjs.org/@deepseek-ai/dsh`)确认:
截至设计时全部 15 个已发布版本都带预发布后缀(`-rc.N` 或 `-alpha.N`),
`dist-tags` 只有 `latest`(当前指向 `0.1.2-rc.1`)、`alpha`、`next`,没有 `stable` 标签,
也没有任何一个不带后缀的正式版本号。

因此本设计中"稳定版"** 不是**语义上"无预发布后缀的正式版"这个 semver 概念,
而是**运营概念**:直接采用 npm 的 `latest` dist-tag(官方自己维护的推荐标签)。
UI 上一律显示"推荐"/"跟随最新稳定版"字样,不使用 `stable` 这个可能引起误解的词。

## 架构

延续现有代码风格:纯逻辑函数与 Electron 解耦、依赖注入、可脱离 UI 单测。

```
src/main/
├── kernel-versions.js   # 新增:拉取+解析内核全部版本列表(纯逻辑)
├── shell-update.js      # 新增:查 GitHub Releases 判断容器是否有新版(纯逻辑)
├── update-window.js     # 新增:更新检查窗口(BrowserWindow + IPC + HTML),仿照 token-usage/window.js
├── updater.js           # 沿用,新增:switchKernelVersion 相关的安装/激活复用现有 install/activate
├── config.js            # DEFAULT_SETTINGS 新增 pinnedKernelVersion 字段
└── main.js              # bootstrap() 分叉出"固定版本"路径;抽出 switchKernelVersion();
                          # 菜单"检查更新…"改为打开新窗口,删除旧 dialog 流程 manualUpdateCheck
```

### `src/main/kernel-versions.js`

```js
async function fetchAllKernelVersions() // 返回 null 或 { latestTag, entries: [...] }
```

- 请求 `https://registry.npmjs.org/@deepseek-ai%2Fdsh`(完整包信息,而非 `/latest`)。
- 解析 `versions` 的全部 key 与 `time` 字段,得到 `{ version, publishedAt }[]`。
- 对每个版本按版本号本身推断 `tag`:包含 `-alpha.` → `'alpha'`;包含 `-rc.` → `'rc'`;
  否则 → `'stable'`(为未来官方真的发布正式版做兼容,当前不会出现)。
- 按 `publishedAt` 倒序排序。
- 标记 `entries` 中 `version === dist-tags.latest` 的那一项 `recommended: true`。
- 网络失败/响应格式异常 → 返回 `null`(离线容忍,与现有 `getLatestVersion()` 风格一致,
  调用方据此在 UI 上显示"检测失败,点击重试"而不是抛错炸掉整个窗口)。

### `src/main/shell-update.js`

```js
async function checkShellUpdate(currentVersion, {
  repo = 'honghuachen/deepseekharness-desktop',
} = {}) // 返回 null 或 { latestTag, htmlUrl, hasUpdate }
```

- 请求 GitHub Releases API:`https://api.github.com/repos/<repo>/releases/latest`。
- `latestTag` 去掉可能的 `v` 前缀后,用现有 `compareVersions()` 与 `currentVersion` 比较。
- 请求失败(网络、限流、404 无 Release)→ 返回 `null`,UI 显示"无法连接 GitHub"。
- 不做任何下载/安装动作,`htmlUrl` 只用于"前往下载页"按钮 `shell.openExternal`。

### `src/main/config.js`

`DEFAULT_SETTINGS` 新增:

```js
pinnedKernelVersion: '', // 空 = 跟随 npm latest 自动更新;非空 = 固定到具体版本号,启动时不再比较 latest
```

### `src/main/main.js`

**`bootstrap()` 分叉**:

```js
if (settings.pinnedKernelVersion) {
  // 固定版本路径:install() 本身已幂等(已存在则跳过下载),直接调用即可,不查询/比较 latest
  const v = settings.pinnedKernelVersion;
  await updater.install(v, statusText);
  await updater.activate(v);
  installed = v;
} else {
  // 现状不变:查 latest → 比较 → 有新版则装
  ...(现有逻辑原样保留)...
}
```

**抽出 `switchKernelVersion(version, { pin })`**,供"启动时激活固定版本"和"窗口里手动切换"共用:

1. `updater.install(version, onLine)`(幂等,已装过则跳过下载,只做校验)。
2. `runner.stop()`(若正在运行)。
3. `updater.activate(version)`。
4. 更新全局 `activeVersion = version`。
5. 若 `pin === true` → `settings.pinnedKernelVersion = version`;若 `pin === false`(用户点了"恢复自动跟随")→ `settings.pinnedKernelVersion = ''`;写 `saveSettings(paths, settings)`。
6. `runner.start(...)` 重新拉起服务,`mainWindow.loadURL(url)` 刷新。
7. 任何一步失败 → 不修改 `pinnedKernelVersion`、不推进 `activeVersion`,把错误抛给调用方(窗口里展示失败详情,不留半成品状态)。

**`prune()` 保护名单**追加 `settings.pinnedKernelVersion`(和现有 `activeVersion` 一起),
防止用户手动固定的版本被自动清理掉。

**菜单**:"检查更新…"(⌘U)的 `click` 从 `manualUpdateCheck()` 改成 `openUpdateWindow()`;
`manualUpdateCheck` 函数连同它专属的 dialog 流程整体删除(不再需要)。

### `src/main/update-window.js`

仿照 `token-usage/window.js` 的既有模式:创建 BrowserWindow + preload + 注册 IPC handler。
不直接持有 `runner`/`updater`,而是由 `main.js` 传入一组回调:

```js
openUpdateWindow({
  getShellInfo,        // () => Promise<{ currentVersion, latest }>  latest 来自 checkShellUpdate,可能为 null
  getKernelInfo,        // () => Promise<{ activeVersion, pinnedVersion, entries }>  entries 来自 fetchAllKernelVersions,可能为 null
  switchKernelVersion,  // (version, { pin }) => Promise<void>,抛错时窗口展示失败详情
  openExternal,         // (url) => void,用于"前往下载页"
  log,
})
```

IPC 契约(`update:*` 前缀,风格对齐 `token-usage:*` / 插件管理器现有命令):

- `update:get-state` → `{ shell: {...}|null, kernel: {...}|null }`
- `update:refresh` → 重新拉取,同返回结构
- `update:switch-kernel` `{ version, pin }` → 成功/失败 + 错误详情
- `update:clear-pin` → 等价于 `switch-kernel` 到当前 `latest` 版本且 `pin:false`
- `update:open-external` `{ url }`

## UI(风格对齐 Token 用量统计/插件管理器:圆角卡片、`#4d6bfe` 主色、深浅色自适应)

**顶部:容器(壳)卡片**
- 当前版本 `v1.5.0`;GitHub 最新 Release 版本(查得到则显示,查不到显示"无法连接 GitHub,点击重试");
- 有新版 → "发现新版本 vX.Y.Z" + 按钮"前往下载页"(打开 Release 页面,不自动下载安装);
- 已是最新 → 灰字"容器已是最新版本"。

**下方:内核卡片**
- 顶栏:当前激活版本 + 状态标签——"跟随最新稳定版" 或 "已固定到 vX.Y.Z";
  固定态下有"恢复自动跟随最新稳定版"按钮(点击 → `update:clear-pin`);
- 版本列表(时间倒序、可滚动):每行 = 版本号 + 相对发布时间("3 天前") + 标签 badge
  (`rc`/`alpha`/`stable`,`recommended` 额外标绿色"推荐");
- 当前激活行右侧按钮显示"当前使用中"(禁用);其余行显示"切换到此版本";
- 点击"切换到此版本" → 二次确认("切换到 vX.Y.Z?服务会短暂重启,未保存的操作可能丢失")
  → 确认后按钮变"切换中…",流式显示安装日志(复用 pnpm 输出转发风格)
  → 完成后整窗刷新;失败则弹出错误详情,状态不变。

## 错误处理

- 壳卡片、内核卡片的检测请求相互独立、互不阻塞;任一失败只影响对应卡片显示
  "检测失败,点击重试",不影响另一半 UI,也不让整个窗口报错。
- `switchKernelVersion` 失败(网络中断、磁盘空间不足、安装校验不通过等):
  错误信息展示在窗口内(可展开详情,复用现有 `runPnpm` 报错截断逻辑),
  不推进 `activeVersion`、不写入 `pinnedKernelVersion`,保持切换前的状态。

## 测试

- `scripts/kernel-versions-test.mjs`:构造模拟 npm 包 JSON 响应,断言版本分类(stable/rc/alpha 判定)、
  按时间倒序排序、`recommended` 标记正确性、网络失败时返回 `null`。
- `scripts/shell-update-test.mjs`:构造模拟 GitHub Releases API 响应,断言 `hasUpdate` 判断正确
  (含 tag 里 `v` 前缀的处理)、请求失败时返回 `null`。
- `switchKernelVersion` 状态机:在现有 `updater.js`/`runner.js` 依赖注入测试方式基础上补充用例——
  未安装版本先装后激活、已安装版本直接激活、安装失败时不改动 `activeVersion`/`pinnedKernelVersion`。
- 接入 `package.json` 的 `npm test` 串联命令。
- 手工验证:`npm start` 打开新窗口,确认壳/内核两张卡片都能正确显示真实数据;
  手动切换到一个未安装过的旧版本,确认下载、激活、服务重启、主窗口刷新全部正常;
  重启 APP 确认固定版本被尊重(不会自动跳回 latest);点击"恢复自动跟随"后重启确认恢复自动追新。

## 明确不做的事(YAGNI)

- 不做容器(壳)的自动下载安装(`electron-updater`)——当前未签名/未公证,
  Windows/macOS 自动安装的工程量和现有基础设施不匹配,只做检测 + 引导手动下载。
- 不新增"稳定版"这个 semver 概念或 dist-tag——"稳定版"在 UI 上等价于 npm `latest`。
- 不在窗口里做"删除某个已下载的旧版本"之类的管理功能——沿用现有 `prune(keep=2)` 自动清理,
  只是保护名单里加上 `pinnedKernelVersion`。
