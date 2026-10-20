# 《DSH Web v1.7.5 发版清单确认文档》

- **产品名**：DSH Web (deepseekharness-desktop)
- **版本号**：v1.7.5
- **分支**：`main` (Commit: `1092e24`)
- **生成时间**：2026-10-20 13:46:00
- **本次自动检查覆盖范围**：版本号与配置一致性、自动化回归测试套件（15 个测试脚本）、构建产物完整性与 SHA512 校验和、Git 仓库状态。

---

## A. 已自动核验通过

1. **版本号规范递增**：
   - 上一发布版本：`v1.7.4`
   - 本次发布版本：`v1.7.5`（`package.json` 与 `package-lock.json` 已同步递增至 `1.7.5`）。
2. **自动化测试回归**：
   - 运行 `npm test`：共 15 个测试套件（含 badge、plugin-guard、test-plugin-update、token-usage、kernel-versions、shell-update、shell-auto-updater、kernel-switch、update-monitor、preload-dom、market-service、plugin-compatibility、emergency-boot-recovery、startup-splash、runner-exit）**全部 100% 通过**。
3. **构建产物完整性核验**：
   - macOS arm64:
     - `DSH Web-1.7.5-arm64.dmg` (175 MB, SHA512 已计算)
     - `DSH Web-1.7.5-arm64-mac.zip` (179 MB, SHA512 已计算)
     - `latest-mac.yml` (自动更新元数据已生成)
   - Windows x64:
     - `DSH-Web-Setup-1.7.5-x64.exe` (131 MB, SHA512 已计算)
     - `DSH Web-1.7.5-win.zip` (181 MB)
     - `latest.yml` (自动更新元数据已生成)
4. **Git 代码仓状态**：
   - 工作区干净无未提交修改，本地相比 `origin/main` 包含发版与版本升级提交，准备推送。

---

## B. ⚠ 自动检查命中、需人工确认的遗留项

- **无**（所有自动检查项均已完全通过，未发现阻断项或异常残留）。

---

## C. 需 QA 确认

- [ ] 在 macOS arm64 系统上下载 DMG/ZIP 安装并启动，验证是否正常进入主界面。
- [ ] 验证插件管理界面正常打开，且失效插件显示「远端失效(404)」、本地包显示「本地包」。
- [ ] 在 Windows 虚拟机/实体机上验证 NSIS 安装程序（`DSH-Web-Setup-1.7.5-x64.exe`）能否正常安装并启动。

负责人：QA 团队 / 测试负责人

---

## D. 需产品/策划确认

- [ ] Release Notes 更新说明文案确认：
  - 核心修复：修复第三方插件远端失效（404 删库）导致其他插件更新死锁卡死的问题。
  - 新增自愈：遭遇依赖解析 404 时自动提取本地可用副本并转为本地离线包自愈重试。
  - 界面优化：更新报错弹窗卡片恢复错误信息正常展示；失效插件状态标签高亮明确。

负责人：产品 / Release 经理

---

## E. 需程序/发布负责人确认

- [ ] `git push origin main` 推送最新代码。
- [ ] `git tag v1.7.5 && git push origin v1.7.5` 推送发布标签。
- [ ] 上传构建产物至 GitHub Release `v1.7.5`。

负责人：程序负责人

---

## F. 发布后巡检

- **0–24 小时**：
  - 观察 GitHub Release 下载链路是否正常。
  - 巡检已有客户端的更新检测（`update-monitor`）是否能正常拉取并提示 `v1.7.5` 新版本。
  - 监控 GitHub Issues 是否有关于 1.7.5 安装/启动/插件死锁的异常上报。
- **24–48 小时**：
  - 确认主流平台更新平稳，无崩溃率上升反馈。

---

**确认人**：_______________  
**确认时间**：_______________  
**备注**：_______________
