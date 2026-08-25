# v1.6.0 — 跨浏览器基础与安全权限

本版本建立 MarksVault 的跨浏览器稳定基线，为后续 AI 分类版本提供可回滚的基础。

## 已完成

- Firefox 构建使用固定 Add-on ID：`marksvault@tttxxx36.github.io`，避免 `storage.sync` 在升级后丢失命名空间。
- Chromium 生产包明确声明 favicon 预热所需的 `tabs` / `windows` 权限；Firefox 不申请这些权限。
- 统一 Firefox/Chromium 运行时判断，减少通过 User-Agent 字符串散落在业务代码中的分支。
- 保留 Firefox 对 Chromium `_favicon` 端点的安全回退路径。
- 版本号提升到 `1.6.0`。

## 兼容与隐私

- Firefox 不使用 Chromium 专用 `_favicon` API。
- v1.6.0 不包含 AI 分类写入功能。
- 不新增必需的任意站点访问权限。
- Firefox 固定 ID 在提交 AMO 前仍需由发布者确认是否与最终上架 ID 一致。
