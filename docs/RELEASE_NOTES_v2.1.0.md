# MarksVault v2.1.0

## 快照与安全恢复

- 新增 `BookmarkSnapshot`、`SnapshotIndex`、`SnapshotDiff`、`RestorePlan`、`RestoreJournal` 等快照领域模型。
- 完整书签树和恢复日志保存在本地 IndexedDB；`storage.local` 仅保存索引、当前任务标识、迁移标记和最近状态。
- AI 分类批次检查点也迁移到同一 IndexedDB；旧版 `ai_classification_job` 会在首次读取时兼容迁移，避免把大型任务数据继续塞入 `storage.local`。
- AI 分类确认执行前强制创建并校验“AI 分类前”自动快照；快照失败时绝不调用书签移动/写入 API。
- 支持设置页和任务页创建命名快照、搜索筛选、JSON 导出/导入及 schema、URL 协议、节点数量、最大深度、字节大小和内容哈希校验。
- 自动快照默认只保留最近 20 个；命名快照受保护，不会被自动清理。
- 恢复前显示新增、删除、移动、重命名、冲突和跳过统计；匹配优先稳定 ID，指纹匹配必须唯一，禁止仅凭标题猜测。
- 恢复默认跳过快照之后被修改、已删除或无法安全匹配的节点，不删除快照之后新增书签、不删除非空文件夹、不修改 URL。
- 恢复前自动创建“恢复前”快照；恢复使用书签写入租约和逐节点 journal，异常标记为“结果不确定”，浏览器重启只标记状态、不自动写入。
- 支持明确选择继续、取消或回滚；回滚只处理本次实际修改且之后未再次被用户修改的节点。

## 兼容性与验证

- 保留 v2.0.1 的 AI 预览、后台批次、撤销和配置隐私边界；兼容读取 `ai_last_classification_plan`。
- Chrome MV3、Firefox MV2、Edge MV3 构建通过；Firefox `web-ext lint`：0 errors、0 notices、2 个来自第三方 MUI bundle 的既有 `innerHTML` warning。
- Jest 全量：17 suites / 146 tests passed；TypeScript 类型检查、ESLint（0 errors、23 个既有 warning）、manifest 校验和 SHA256 校验均通过。
- 新增合成书签故障注入覆盖：重复 URL、ID 变化、文件夹冲突、部分写入失败、重启恢复、快照容量失败、哈希不一致、重复点击、取消和 20,000 节点性能基线。

## 生产文件

- `marksvault-2.1.0-chrome.zip`
- `marksvault-2.1.0-firefox.zip`
- `marksvault-2.1.0-edge.zip`
- `marksvault-2.1.0-sources.zip`
- `marksvault-2.1.0-SHA256SUMS.txt`
