# 可复现工程基线

本文件记录 MarksVault 在继续修复开发计划遗漏前的可复现质量基线，以及本轮修复后的验证命令。测试只使用合成书签、模拟浏览器 API、模拟 IndexedDB、模拟网络响应和假凭据。

## 环境

- 仓库：`TttXxx36/MarksVault`
- 审计日期：2026-08-26
- 当前发布线：`v2.1.0`
- Node.js：`v24.19.0`（本地 Codex 运行时）
- WXT：`0.20.27`
- Chrome/Edge：Manifest V3
- Firefox：Manifest V2，固定 Gecko ID `marksvault@tttxxx36.github.io`

## 质量命令

在仓库根目录运行：

```text
npm ci
npm run typecheck
npm test -- --runInBand
npm run lint
npm run build
npm run build:firefox
npm run build:edge
npm run verify:manifests
npm run lint:firefox
```

## 已验证结果

| 检查 | 结果 |
| --- | --- |
| TypeScript 类型检查 | 通过 |
| Jest | 18 个套件 / 157 个测试通过 |
| ESLint | 0 错误；23 条既有警告 |
| Chrome / Firefox / Edge 构建 | 通过 |
| Manifest 合同检查 | 通过 |
| Firefox `web-ext lint` | 0 errors / 0 notices；2 条第三方构建产物警告 |
| 20,000 节点快照性能/容量基线 | 通过 |

本轮构建产物（2026-08-26）：Chrome `419,213` bytes，Firefox `445,384` bytes，Edge `419,213` bytes，源码包 `8,013,229` bytes。三端 Manifest 均通过合同检查；Chrome/Edge/Firefox 均声明 3 个运行时可选 origin，Firefox 使用 MV2 `optional_permissions`。

对应 SHA256 已写入 `marksvault-2.1.0-SHA256SUMS.txt`；校验结果为四个生产文件全部匹配。

## 约束

- 不使用真实用户书签、真实 GitHub Token、真实 AI API Key 或真实付费 API。
- CI 不上传书签、快照、任务内容或任何密钥。
- 生产构建必须只包含扩展运行所需的图标；README 大图和截图位于 `docs/assets/`，不进入安装包。
- 发布产物及其 SHA256 校验文件由对应 Release 保存。
