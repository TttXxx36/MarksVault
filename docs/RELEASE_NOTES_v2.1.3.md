# MarksVault v2.1.3

v2.1.3 是 AI 分类后台可靠性维护版本，针对 Manifest V3 Service Worker 回收、闹钟丢失和长任务恢复进行补强。

## 主要更新

- AI 分类任务启动时创建 one-shot 后台闹钟；已有任务在 Worker 重新初始化时会检查并恢复闹钟。
- 每个 AI 批次检查点都会续期闹钟，Worker 被回收后可以从已持久化的完成批次继续，不重复发送已完成批次。
- 闹钟丢失且任务仍处于 `classifying` 时，任务会进入“可恢复”状态；不会自动调用 AI，也不会自动写入书签。
- 浏览器启动时 queued/classifying 任务会暂停并等待用户明确点击“继续分类”，符合隐私和配额安全边界。
- 任务完成、取消或失败后清理后台闹钟，避免无意义唤醒。
- 增加 Service Worker 回收、闹钟丢失、长任务检查点、浏览器重启和非 AI 闹钟隔离回归测试。

## 安全与隐私

- 恢复流程只读取本地持久化任务状态和合成测试数据；不自动执行 `browser.bookmarks.move`。
- 不使用真实 API Key、真实书签、真实 AI 响应或 GitHub 数据。
- Release 资产不包含任何密钥、Token 或用户书签内容。

## 验证结果

- Jest、TypeScript、ESLint：通过。
- Chrome、Firefox、Edge 构建：通过。
- 三端 DOM-less Service Worker 启动检查：通过。
- 三端 Manifest 权限合同检查：通过。
