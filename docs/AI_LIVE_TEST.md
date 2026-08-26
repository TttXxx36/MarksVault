# 安全的 AI 真实接口合成书签测试

该测试默认跳过，只有显式设置 `MARKSVAULT_LIVE_AI=1` 才会运行。测试不会读取浏览器真实书签，也不会调用 `browser.bookmarks.create` 或 `browser.bookmarks.move`；每次请求只发送合成的 1、20、100 条书签。

## 凭据边界

- 先撤销任何曾经粘贴到聊天、日志或截图中的旧 API Key。
- 将轮换后的 Key 仅放在当前本机进程环境中，不写入仓库、`.env`、测试输出或 Release。
- 测试只输出条数、耗时和 assignment 数量，不输出 endpoint、请求正文、响应正文或 Key。

## 环境变量

必需：

- `MARKSVAULT_LIVE_AI=1`
- `MARKSVAULT_LIVE_AI_ENDPOINT`
- `MARKSVAULT_LIVE_AI_KEY`
- `MARKSVAULT_LIVE_AI_MODEL`

可选：

- `MARKSVAULT_LIVE_AI_PROTOCOL`：`responses`（默认）、`chat-completions` 或 `custom`
- `MARKSVAULT_LIVE_AI_AUTH`：`bearer`（默认）、`api-key-header` 或 `none`
- `MARKSVAULT_LIVE_AI_HEADER`：自定义认证头名称，默认 `X-API-Key`

## 运行

在项目目录中通过本机安全环境变量运行：

```text
npm test -- --runInBand src/services/ai-live-smoke.test.ts
```

测试使用批量大小 10、单次请求最多 1 次尝试，只用于测量真实服务耗时；插件正式配置仍使用单次 30 秒、单批 90 秒和最多 2 次尝试的安全预算。
