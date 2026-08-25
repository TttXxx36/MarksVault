# 使用 IndexedDB 保存完整书签快照、storage.local 保存索引

状态：accepted。完整书签树、快照内容和恢复日志放入扩展本地 IndexedDB，`storage.local` 只保存快照索引、当前恢复任务标识、迁移标记和最近状态；快照永远不携带 AI 配置密钥或 GitHub Token。这样可以避免浏览器同步/配额限制，同时把包含完整 URL 的隐私数据留在本机，并允许未来替换存储实现而不改变快照领域模型。

考虑过的方案：把完整快照写入 `storage.local`、同步存储或上传 GitHub。前两者容量和同步语义不适合大型书签树，后者会扩大 URL 隐私边界，因此选择本地 IndexedDB，并保留显式 JSON 导入导出作为用户控制的迁移方式。
