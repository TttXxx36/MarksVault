# v2.0.1 — AI 分类稳定性与后台任务

## 重点修复

- 自定义内容现在作为“补充提示词”追加，不能覆盖内置 JSON、安全和字段约束；补充文本会限制长度并移除控制字符。
- Responses、Chat Completions 和兼容文本响应统一提取最终 assistant 内容；代码围栏、嵌套对象、拼接 JSON、尾随字符和截断 JSON 都会进入结构化格式错误流程。
- 每个格式错误批次最多发起一次修复请求；修复仍失败时保留失败批次，不执行不确定的书签写入；20 条批次可一次拆为 10 条子批次。
- AI 分类移入后台任务：关闭 Popup、切换页面不会取消任务；批次检查点、取消、失败批次重试和浏览器重启后的“用户继续”状态会保存在本地。
- 设置页增加本地配置草稿；获取模型列表前先保存草稿。API Key 仍单独保存在 `storage.local`，不会写入任务、导出、同步或 GitHub 备份。
- 认证方式默认 Bearer，API Key Header 和 None 收入高级设置折叠项。

## 构建产物

- `marksvault-2.0.1-chrome.zip`
- `marksvault-2.0.1-firefox.zip`
- `marksvault-2.0.1-edge.zip`
- `marksvault-2.0.1-sources.zip`
- `marksvault-2.0.1-SHA256SUMS.txt`

## 验证

- Jest：15 个测试套件、137 个测试通过。
- TypeScript 类型检查通过。
- ESLint：0 个错误；保留 23 个既有警告。
- Chrome、Firefox、Edge WXT production build 和 manifest contract 校验通过。
- Firefox `web-ext lint`：0 个错误、0 个 notices、2 个第三方打包代码警告。

本版本的测试只使用模拟 API 响应、模拟 API Key 和模拟书签数据。
