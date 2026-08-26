# Firefox 支持说明

## 构建

```bash
npm run dev:firefox
npm run build:firefox
npm run zip:firefox
```

开发构建输出在 `.output/firefox-mv2-dev`，可通过
`about:debugging#/runtime/this-firefox` 的“临时扩展”加载
`manifest.json`。生产包使用固定 Add-on ID：

`marksvault@tttxxx36.github.io`

Firefox 构建声明 `strict_min_version: 140.0`，以使用当前扩展数据同意机制；声明为不需要必选数据收集（`required: ["none"]`），用户主动启用 GitHub 或 AI 功能时才可能涉及 `authenticationInfo` 或 `bookmarksInfo` 可选类别。

发布前需要由发布者确认该 ID 与 AMO 上架 ID 一致，并使用 Firefox 的扩展签名流程。

## 权限与隐私

- Firefox 使用 `bookmarks` 和 `storage`，不申请 Chromium 的 `favicon`、`tabs`、`windows` 权限。
- Firefox 将 HTTPS 任意来源和本机 HTTP 来源声明为 `optional_permissions`；安装时不申请，在线检查或自定义 AI 连接时只请求用户实际填写的 origin。
- Firefox 不调用 Chromium `_favicon` 端点，也不请求 Google favicon 服务；无图标时使用本地默认图标。
- GitHub 访问仅用于用户明确配置的备份操作。
- AI 访问仅在用户配置供应商、测试连接或确认分类时进行；Chromium MV3 可按目标 origin 申请可选权限，Firefox v2 当前保持 MV2，任意自定义 origin 必须由供应商允许扩展 CORS，插件不会静默申请任意网站权限。
- 书签标题、URL、域名和路径不会自动发送到第三方服务；发送前会显示目标服务和字段范围。
