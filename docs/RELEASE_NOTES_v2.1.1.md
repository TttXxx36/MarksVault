# MarksVault v2.1.1

这是 v2.1.0 之后的安全维护版本，重点收敛 GitHub 跨浏览器恢复和历史快照的边界。v2.0.1 与 v2.1.0 的公开 Release、标签和资产保持不变。

## 主要修改

- GitHub 书签备份新写 schema v2：保留语义根目录、节点类型和校验统计；读取旧 `version: 1.0` 文件时先迁移为 v2，并在预览中显示兼容警告。
- GitHub 恢复现在只下载、校验并生成本地 `imported` 快照和 RestorePlan；用户在统一快照历史页面查看差异并确认后才会写入书签。
- 已知根目录按 `toolbar/menu/other/mobile` 语义映射；未知根目录使用带时间戳的 `MarksVault Imported - ...` 文件夹，映射写入 journal 并可幂等继续。
- 恢复预览允许取消安全项目；冲突、受保护节点、重复 URL、URL 已变化和路径指纹不唯一的项目默认跳过，绝不修改 URL、删除新增书签或删除非空文件夹。
- 恢复前快照、写入租约、逐项 journal、结果不确定状态和选择性回滚保持 fail-closed；浏览器重启只恢复状态，不自动执行外部写操作。
- GitHub 429/限流/服务端错误携带结构化 Retry-After 与配额重置元数据，认证和权限错误不自动重试。
- 在线书签检查权限被拒绝时返回 `permission_denied` 错误码；运行时消息和诊断日志增加 schema/脱敏边界，不记录 API Key、Token、URL、标题或正文。

## 安全与隐私

- 本版本所有自动化验证仅使用合成书签、模拟浏览器 API、模拟 IndexedDB、模拟 GitHub 响应和假 Token。
- 快照只保存在本地 IndexedDB；不会上传到服务器，也不包含 AI 配置、API Key 或 GitHub Token。

## 生产附件

- `marksvault-2.1.1-chrome.zip`
- `marksvault-2.1.1-firefox.zip`
- `marksvault-2.1.1-edge.zip`
- `marksvault-2.1.1-sources.zip`
- `marksvault-2.1.1-SHA256SUMS.txt`

附件旁的 SHA256 校验文件由同一构建目录生成。Firefox 仍使用 MV2 稳定 Gecko ID；AMO 发布前的账号人工审核由发布者完成。
