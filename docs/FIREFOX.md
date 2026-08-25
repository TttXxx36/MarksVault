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

发布前需要由发布者确认该 ID 与 AMO 上架 ID 一致，并使用 Firefox 的扩展签名流程。

## 权限与隐私

- Firefox 使用 `bookmarks` 和 `storage`，不申请 Chromium 的 `favicon`、`tabs`、`windows` 权限。
- Firefox 不调用 Chromium `_favicon` 端点，也不请求 Google favicon 服务；无图标时使用本地默认图标。
- GitHub 访问仅用于用户明确配置的备份操作。
- AI 访问仅在用户配置供应商、测试连接或确认分类时进行；Chromium MV3 可按目标 origin 申请可选权限，Firefox v2 当前保持 MV2，任意自定义 origin 仍受供应商 CORS/Firefox 权限策略限制。
- 书签标题、URL、域名和路径不会自动发送到第三方服务；发送前会显示目标服务和字段范围。
