# Changelog

## v2.1.0

- 新增本地 IndexedDB 书签快照、命名/自动快照保留、导入导出和容量校验。
- 新增差异预览、冲突安全匹配、恢复前快照、书签写入租约和逐项恢复日志。
- AI 分类执行前强制校验快照；AI 任务检查点迁移到 IndexedDB，兼容旧版 local 存储。
- 补齐 Firefox separator/unmodifiable 快照语义、快照容量预警与显式保护删除确认。
- GitHub 客户端补齐标准请求头、超时/大文件/分页/有限冲突重试；在线 URL 检查拒绝 opaque 响应。
- Chrome、Firefox、Edge 构建与 Firefox `web-ext lint` 通过。

## v2.0.1

- 修复自定义补充提示词破坏 JSON 契约、多个 JSON/尾随字符和 reasoning 混入解析的问题。
- AI 分类改为后台可恢复任务，支持批次失败重试、预览草稿和配置草稿。

## v2.0.0

- 新增用户自配置 AI 供应商、分类 taxonomy、批量 assignment、预览、确认、执行与撤销。

## v1.6.0

- 完成 Firefox 稳定 ID、隐私友好 favicon、GitHub 错误分类和基础备份恢复安全修复。
