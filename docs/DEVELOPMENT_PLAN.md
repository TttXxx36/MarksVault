# MarksVault 开发计划与执行规格

> 文档状态：Approved for implementation planning  
> 目标仓库：`TttXxx36/MarksVault`  
> 审计基线：`main@6b946bc0ef82b59eb7fc1d5e6fa50ef104ccf5d1`  
> 基线版本：`1.5.0`  
> 编写日期：2026-08-25  
> 主要执行代理：GPT-5.6 Luna（后续实现时）

## 1. 文档目的

本文档是 MarksVault 后续开发的唯一主计划（canonical implementation plan）。它不是功能愿望清单，而是面向执行代理的工程规格，包含：

- 当前代码与发布状态的可验证基线；
- 必须遵守的安全、数据、隐私和跨浏览器约束；
- 目标架构和数据模型；
- 分阶段任务、任务依赖、预期修改文件、验收标准和测试要求；
- Firefox、GitHub 备份与 AI 分类的完整交付路径；
- 发布、迁移、回滚和失败恢复要求。

执行代理在开始任何实现前必须完整阅读本文档及仓库根目录的 `CONTEXT.md`。如果代码现状与本文档不一致，应先记录差异并更新计划，不能静默改变约定。

## 2. 执行总原则

### 2.1 发布顺序

开发分成两个公开版本，不允许把所有风险一次性塞进同一个版本：

1. `v1.6.0`：安全与兼容版本。
   - 修复恢复、回滚、配置导入、权限和 GitHub API 风险；
   - 完成 Firefox 的稳定 ID、数据传输声明、构建、测试和发布流程；
   - 不包含 AI 自动修改书签功能。
2. `v2.0.0`：AI 分类版本。
   - 支持用户配置 AI 请求地址、认证方式、API Key 和模型；
   - 支持分类生成、批量分配、预览、确认、执行、取消和回滚；
   - 保持不配置 AI 时的全部原有功能可用。

### 2.3 用户确认的 AI 供应商配置边界

- AI 服务不内置、代管或自动选择任何供应商，用户自行填写 API 地址、API Key、认证方式、协议、模型和优化提示词。
- v2.0 UI 必须提供 API 地址、API Key、Responses API / Chat Completions / 自定义兼容请求、模型列表/手工模型、提示词、批量大小、分类数量、连接测试和启用开关。
- API Key 只作为请求认证头发送给用户指定的服务；不得进入书签提示词、storage.sync、配置导出、GitHub 备份、任务快照或日志。
- Responses API 和 Chat Completions 可根据服务根地址补齐常见 /v1 端点；custom 协议直接使用用户填写的地址和结构化 JSON 请求，不执行远程脚本或模板。
- 用户已确认 v2.0 采用 storage.local 持久保存 AI secret；不提供 session-only 模式，浏览器重启后配置仍保留，但 secret 永不进入 sync、导出、备份、任务快照或日志。
- Firefox v2 当前沿用 MV2 基线；任意自定义 AI origin 的动态权限策略需要单独确认，不得静默扩大权限范围。

### 2.2 实现策略

- 采用增量重构，不做一次性推倒重写。
- 每个阶段结束时，Chrome、Edge、Firefox 构建都必须保持可用。
- 先建立数据安全和恢复能力，再实现 AI 分类。
- AI 只能生成经过验证的分类计划，不能直接调用书签写入 API。
- 所有破坏性操作都必须先完成预览、安全快照和可验证回滚。
- 新数据格式必须版本化，并提供从旧格式迁移或兼容读取的路径。
- 不允许为了“兼容任意 API”加入可执行脚本、任意模板代码或 `eval`。

## 3. 当前基线

### 3.1 技术栈

- WXT `^0.20.0`
- React `^18.2.0`
- TypeScript `^5.0.4`
- Material UI `^5.13.0`
- Jest + ts-jest
- Chrome/Edge：Manifest V3
- Firefox：WXT 默认 Manifest V2
- GitHub REST Contents API：备份与推送

依赖升级必须单独提交并先验证行为，不允许与大规模业务重构混在同一个提交中。不得直接把所有依赖升级到最新主版本后再处理错误。

### 3.2 代码规模

- 约 80 个生产 TypeScript/TSX 文件；
- 生产代码约 23,300 行；
- 测试代码约 3,300 行；
- 现有测试约 113 个；
- 当前未发现生产模块循环依赖；
- 当前未发现 `eval`、`new Function` 或 `dangerouslySetInnerHTML`。

主要超大文件：

- `src/services/task-executor.ts`：约 1,779 行；
- `src/services/backup-service.ts`：约 1,578 行；
- `src/popup/components/BookmarksView/BookmarksView.tsx`：约 1,254 行；
- `src/popup/components/TasksView/TaskForm/TaskActionForm.tsx`：约 1,119 行。

### 3.3 已有能力

- 通过 `wxt/browser` 统一访问 WebExtension API；
- 书签列表、网格、搜索、拖拽、编辑和重复项提示；
- GitHub 私有仓库备份和恢复；
- 配置备份、HTML 推送和选择性推送；
- 任务、触发器、执行历史、执行租约、写书签租约和任务快照；
- 网络、限流和 GitHub 服务端错误的结构化重试分类；
- Firefox `toolbar...` 书签栏 ID 的初步兼容和单元测试；
- Chrome、Edge、Firefox 构建与打包脚本。

### 3.4 发布差距

- 源码版本已经是 `1.5.0`，但原项目最后公开 Release 仍为 `1.0.0`。
- `TttXxx36/MarksVault` 当前没有自己的 Release、Tag 和 Actions 运行记录。
- 当前 `build.yml` 只执行 Chrome 构建，不执行 lint 和 Firefox/Edge 构建。
- README 和 Release 工作流仍有多处链接指向 `rbetree/MarksVault`。

## 4. 不可违反的安全约束

以下规则优先级高于开发速度和界面体验：

1. 不允许在没有可用安全快照的情况下删除或批量移动书签。
2. 不允许把“已写入安全快照”当作“已经具备回滚”；必须提供实际回滚实现和测试。
3. 不允许恢复流程只恢复书签栏而静默丢弃其他根目录。
4. 不允许 AI 输出直接作为 `browser.bookmarks.*` 参数使用。
5. 不允许 AI 分类第一版删除书签、删除旧文件夹或修改 URL。
6. 不允许 API Key、GitHub Token 出现在日志、错误文本、任务快照、配置导出或 `storage.sync` 中。
7. 不允许把 `<all_urls>` 设为必需安装权限。
8. 不允许在未获得用户明确许可前把书签标题、URL、域名或路径发送到 AI、Google 或其他第三方。
9. 不允许配置导入采用“先清空、写入失败后无回滚”的流程。
10. 不允许通过字符串错误消息推断所有重试行为；应使用错误类型和状态码。
11. 不允许在持久化执行记录或租约失败后继续执行书签写操作。
12. 不允许用真实用户 GitHub Token 或真实付费 AI API 运行 CI。
13. 不允许新增隐式遥测、分析 SDK 或远程日志。
14. 不允许提交私钥、真实 API Key、真实 Token 或包含用户书签的测试夹具。

## 5. 已确认问题清单

### 5.1 P0：数据安全

#### P0-1 恢复失败没有自动回滚

当前 `backup-service.ts` 会在删除前把书签栏写入 `pending_restore_backup`，但失败后没有自动回滚入口。发生部分删除或部分创建时，用户仍可能处于不完整状态。

必须实现：

- 恢复计划预览；
- 写操作日志；
- 自动逆向回滚；
- 手动“恢复到操作前状态”入口；
- 扩展后台中断后的恢复判定；
- 回滚失败时保留明确的可恢复状态，不得清理证据。

#### P0-2 备份和恢复的根目录范围不一致

备份读取完整 `bookmarks.getTree()`，恢复却只定位书签栏。这会丢失“其他书签”、Firefox Bookmarks Menu、Mobile Bookmarks 等内容。

必须改为语义根目录模型，而不是依赖浏览器节点 ID 或本地化标题。

#### P0-3 Firefox `storage.sync` 缺少稳定 Add-on ID

当前 Manifest 未配置 `browser_specific_settings.gecko.id`。Firefox 的 `storage.sync` 依赖固定 Add-on ID，GitHub 凭据和同步数据可能无法可靠持久化。

#### P0-4 配置导入不是事务

`storage-service.ts` 当前会清空 `storage.local` 再写入导入数据。若写入因配额、数据格式或浏览器错误失败，用户配置会丢失。

### 5.2 P1：跨浏览器、隐私和功能正确性

#### P1-1 Firefox 数据传输声明缺失

GitHub 备份会传输认证信息和书签数据；AI 分类也会传输用户选择的数据。Firefox 新扩展需要声明数据类型并取得同意。

#### P1-2 favicon 隐私泄漏

Firefox 当前会把每个书签域名发给 Google favicon 服务。该行为不是核心功能、没有显式同意，也会增加 AMO 审核风险。

#### P1-3 在线死链接检查权限和判定错误

- Manifest 只允许访问 GitHub API，无法可靠跨域请求任意书签 URL；
- `GET(no-cors)` 成功返回不代表目标页面有效；
- `filters` 为空时，整理服务返回根节点而不是扁平书签列表，导致操作语义错误。

#### P1-4 Firefox 特有节点丢失

当前以 `!node.url` 判断文件夹，无法正确区分 Firefox `separator` 和 `unmodifiable` 节点。

#### P1-5 GitHub 大文件读取不完整

当前始终假定 Contents API 返回 Base64 `content`。文件大于 1 MB 时，GitHub 可能要求 raw/object 媒体类型，现有代码会解析失败。

#### P1-6 秒级备份文件名可能冲突

同一秒内的两次备份会得到相同路径，第二次创建未携带 SHA 时可能返回 422。

### 5.3 P2：可维护性和发布质量

- `task-executor.ts` 存在手动任务和带输入任务的重复执行框架；
- `executeTaskAction` 等逻辑存在疑似未使用路径；
- 服务大量返回 `{ success, data, error }`，但 `data`/`error` 类型不统一；
- `GitHubCredentials` 在多个文件重复定义；
- 配置、备份和 AI 返回值缺少统一运行时 schema；
- 生产代码中日志数量过多，缺少级别、环境和敏感字段过滤；
- 7.4 MB 的 README 概览图片位于 `public`，会进入扩展安装包；
- 设置页面中 `maxBackupsPerType || 10` 导致合法值 `0` 显示为 `10`；
- CI 没有 lint、三端构建、Manifest 断言、AMO lint 和端到端烟雾测试；
- 当前仓库发布链接、徽章、安装说明和实际 Release 所有者不一致。

## 6. 目标架构

目标目录采用逐步迁移方式。旧文件在调用者完成迁移后才能删除。

```text
src/
├─ core/
│  ├─ bookmarks/
│  │  ├─ types.ts
│  │  ├─ root-role.ts
│  │  ├─ sanitizer.ts
│  │  └─ operation-plan.ts
│  ├─ backup/
│  │  ├─ schema-v1.ts
│  │  ├─ schema-v2.ts
│  │  ├─ migrate-v1-to-v2.ts
│  │  ├─ restore-planner.ts
│  │  └─ restore-journal.ts
│  ├─ tasks/
│  │  ├─ execution-state.ts
│  │  ├─ errors.ts
│  │  └─ action-runner.ts
│  └─ ai/
│     ├─ types.ts
│     ├─ schemas.ts
│     ├─ taxonomy.ts
│     ├─ assignment.ts
│     ├─ classification-plan.ts
│     └─ prompt.ts
├─ adapters/
│  ├─ browser/
│  │  ├─ bookmark-repository.ts
│  │  ├─ permission-service.ts
│  │  └─ secret-store.ts
│  ├─ github/
│  │  ├─ github-client.ts
│  │  ├─ github-backup-repository.ts
│  │  └─ github-errors.ts
│  └─ ai/
│     ├─ ai-provider.ts
│     └─ openai-compatible-provider.ts
├─ storage/
│  ├─ keys.ts
│  ├─ schema-version.ts
│  ├─ migrations/
│  └─ ai-job-store.ts
└─ popup/features/
   └─ ai-classification/
```

### 6.1 核心接口

```ts
interface BookmarkRepository {
  getTree(): Promise<BookmarkRoot[]>;
  getNode(id: string): Promise<BookmarkNode | null>;
  createFolder(input: CreateFolderInput): Promise<BookmarkNode>;
  move(id: string, destination: BookmarkDestination): Promise<BookmarkNode>;
  remove(id: string): Promise<void>;
}

interface BackupRepository {
  list(type: BackupType): Promise<BackupDescriptor[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string, options: WriteOptions): Promise<BackupDescriptor>;
  remove(path: string, version: string): Promise<void>;
}

interface AiProvider {
  testConnection(config: AiProviderPublicConfig, secret: AiSecret): Promise<AiConnectionResult>;
  generateTaxonomy(input: TaxonomyRequest, signal: AbortSignal): Promise<TaxonomyResponse>;
  assignBookmarks(input: AssignmentRequest, signal: AbortSignal): Promise<AssignmentResponse>;
}

interface SecretStore {
  save(id: string, value: string, persistence: 'session' | 'local'): Promise<void>;
  read(id: string): Promise<string | null>;
  remove(id: string): Promise<void>;
}
```

核心层不得直接导入 React、MUI、`fetch`、`browser` 或 GitHub 实现。

### 6.2 统一错误模型

新增结构化错误基类或判别联合：

```ts
type AppError =
  | { kind: 'validation'; code: string; message: string; details?: unknown }
  | { kind: 'permission'; code: string; message: string; origin?: string }
  | { kind: 'credential'; code: string; message: string }
  | { kind: 'network'; code: string; message: string; retryable: true }
  | { kind: 'rate_limit'; code: string; message: string; retryAfterMs?: number }
  | { kind: 'conflict'; code: string; message: string; retryable: boolean }
  | { kind: 'storage'; code: string; message: string }
  | { kind: 'operation_uncertain'; code: string; message: string };
```

UI 可把错误映射为用户提示，但业务逻辑不得根据中文提示文本判断错误类别。

## 7. 数据模型

### 7.1 统一书签节点

```ts
type BookmarkNodeType = 'bookmark' | 'folder' | 'separator';
type BookmarkRootRole = 'toolbar' | 'menu' | 'other' | 'mobile' | 'managed' | 'unknown';

interface BookmarkNodeV2 {
  id: string;
  parentId?: string;
  type: BookmarkNodeType;
  title: string;
  url?: string;
  index?: number;
  dateAdded?: number;
  dateGroupModified?: number;
  unmodifiable?: string;
  children?: BookmarkNodeV2[];
}

interface BookmarkRoot {
  role: BookmarkRootRole;
  nativeId: string;
  title: string;
  children: BookmarkNodeV2[];
}
```

规则：

- 运行时 ID 仅用于当前浏览器会话，不写入跨浏览器恢复目标；
- 备份必须保存 `role`；
- 恢复时通过 `role` 映射目标根目录；
- 无法映射的根目录默认恢复到一个明确命名的导入文件夹，不得丢弃；
- `separator` 在不支持的目标浏览器中跳过并记录 warning；
- `unmodifiable` 节点不得删除、移动或覆盖。

### 7.2 备份格式 v2

```ts
interface MarksVaultBookmarkBackupV2 {
  schemaVersion: 2;
  app: 'MarksVault';
  createdAt: string;
  source: {
    extensionVersion: string;
    browser: string;
    manifestVersion: 2 | 3;
    platform?: string;
  };
  roots: Array<{
    role: BookmarkRootRole;
    originalTitle: string;
    children: BookmarkNodeV2[];
  }>;
  stats: {
    bookmarks: number;
    folders: number;
    separators: number;
    maxDepth: number;
  };
}
```

要求：

- 新备份只写 v2；
- 继续读取旧版 `version: '1.0'` 格式；
- v1 → v2 映射必须有 Chrome、Edge、Firefox 夹具测试；
- 恢复前执行完整 schema、深度、数量、字符串长度、URL 协议校验；
- 使用迭代遍历或显式栈，避免深层递归导致调用栈溢出；
- 节点限制应成为配置常量，并对 5,000、10,000、20,000 节点做性能测试；
- 超出安全限制时必须在任何删除前失败。

### 7.3 AI 供应商配置

根据用户确认，v2.0 支持用户自配置的 Responses API、Chat Completions 和自定义兼容请求；MarksVault 不内置或代管 API Key，也不把自定义 API 当作可执行脚本。

```ts
interface AiProviderPublicConfig {
  id: string;
  name: string;
  protocol: 'responses' | 'chat-completions' | 'custom';
  endpointUrl: string;        // 用户填写的服务根地址或完整兼容端点
  modelsUrl?: string;         // 可选模型列表地址
  model: string;
  authType: 'bearer' | 'api-key-header' | 'none';
  apiKeyHeader?: string;      // authType=api-key-header 时使用
  timeoutMs: number;          // 默认 60000，范围 5000..120000
  batchSize: number;          // 默认 80，范围 10..200
  maxCategories: number;      // 默认 16，范围 3..50
  maxDepth: 1 | 2;            // 默认 2
  language: string;           // 默认 zh-CN
  temperature: number;        // 默认 0.1，范围 0..1
  secretPersistence: 'session' | 'local';
}
```

要求：

- `endpointUrl` 必须是 HTTPS；仅 `localhost` 和 `127.0.0.1` 可使用 HTTP；
- 保存配置前标准化 URL，但不得擅自追加 `/v1`；
- 权限按 `new URL(endpointUrl).origin` 精确申请；
- `apiKeyHeader` 只允许合法 HTTP header name；
- 禁止 `Cookie`、`Host`、`Origin`、`Referer` 等受保护或高风险自定义头；
- API Key 与公开配置分离存储；
- 任务快照只保存公开配置和 secret 引用 ID，不保存 secret 值；
- 本项目发布策略已确认使用 local-only secret；设置页必须明确提示本地扩展存储风险，不得把 secret 复制到 sync 或导出文件。

### 7.4 AI 分类返回协议

#### 分类体系

```ts
interface AiTaxonomyResponseV1 {
  schemaVersion: 1;
  categories: Array<{
    id: string;
    name: string;
    description: string;
    parentId: string | null;
  }>;
}
```

校验：

- ID 唯一且只允许 `[a-zA-Z0-9_-]`；
- 名称 trim 后 1..80 字符；
- 去除控制字符；
- 分类名大小写不敏感去重；
- 总分类数不超过配置；
- 深度不超过配置；
- `parentId` 必须存在且不能形成环；
- 禁止把路径分隔符当作层级协议；层级只通过 `parentId` 表达。

#### 书签分配

```ts
interface AiAssignmentResponseV1 {
  schemaVersion: 1;
  assignments: Array<{
    bookmarkId: string;
    categoryId: string;
    confidence: number;
  }>;
  unassigned: Array<{
    bookmarkId: string;
    reason: string;
  }>;
}
```

校验：

- 只能返回当前批次的书签 ID；
- 不能重复 ID；
- `categoryId` 必须来自已批准 taxonomy；
- `confidence` 必须位于 0..1；
- assignments 与 unassigned 合并后必须覆盖全部输入 ID；
- 缺失 ID 自动进入本地 `unassigned`，不得静默忽略；
- 非法返回最多执行一次 JSON 修复请求；再次失败则把整批标记为失败，禁止猜测解析；
- AI 返回的说明文本不得参与浏览器写操作。

### 7.5 AI 分类任务

```ts
type AiJobStatus =
  | 'draft'
  | 'generating_taxonomy'
  | 'assigning'
  | 'awaiting_review'
  | 'applying'
  | 'rolling_back'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'uncertain';

interface AiClassificationJob {
  id: string;
  status: AiJobStatus;
  scope: ClassificationScope;
  providerConfigSnapshot: AiProviderPublicConfig;
  taxonomy?: AiTaxonomyResponseV1;
  completedBatchIds: string[];
  assignments: AiAssignmentResponseV1['assignments'];
  unassigned: AiAssignmentResponseV1['unassigned'];
  createdAt: number;
  updatedAt: number;
  error?: AppError;
}
```

大型任务、批次结果和回滚日志存入 IndexedDB；设置、状态摘要和当前任务 ID 存入 `storage.local`。不要把完整 AI 任务塞入 `storage.sync`。

## 8. AI 分类产品流程

### 8.1 数据范围

第一版默认只发送：

- 不透明书签 ID；
- 标题；
- URL；
- 从 URL 本地提取的域名；
- 当前文件夹路径；
- 用户选择的分类语言。

第一版不发送：

- 网页正文；
- 浏览历史；
- Cookie；
- 页面截图；
- 本地备注或其他扩展数据；
- GitHub Token；
- 其他 AI 供应商配置。

发送前必须显示“将发送的数据字段、书签数量、目标服务域名”。

### 8.2 分类算法

采用两阶段流程：

1. 本地预处理。
   - 标准化 URL 和域名；
   - 去除完全重复项用于 taxonomy 采样，但保留所有真实 ID；
   - 生成域名分布；
   - 大于 500 条时按域名和现有路径分层采样，最多发送 500 条代表项生成 taxonomy。
2. 生成 taxonomy。
   - 分类数量由用户设置约束；
   - 最多两层；
   - 提示模型把书签内容视为不可信数据，不能遵循标题或 URL 中的指令。
3. 用户审核 taxonomy。
   - 可以改名、合并、删除或新增分类；
   - taxonomy 未确认前不得进行全量分配。
4. 批量分配。
   - 默认批次 80；
   - 默认并发 1；
   - 每批持久化后再开始下一批；
   - 429 尊重 `Retry-After`；
   - 网络/5xx 使用带抖动指数退避；
   - 401/403 凭据错误不自动重试。
5. 本地合并与校验。
   - 检查覆盖率、重复项、未知分类和低置信度项；
   - 低于默认阈值 0.65 的项目进入待确认区；
   - 用户可以逐项修改。
6. 生成只读移动计划。
   - 列出将创建的文件夹；
   - 列出每个书签的原父目录、原 index、目标分类；
   - 文件夹名称冲突策略必须明确显示；
   - 默认不删除变空的旧文件夹。
7. 用户确认后执行。

### 8.3 分类范围与结构策略

UI 必须让用户明确选择：

- 仅当前文件夹直接包含的书签；
- 当前文件夹及所有子文件夹；
- 手动选择的书签；
- 未分类书签。

默认策略：

- 只移动书签，不移动或删除原文件夹；
- 在用户指定目标根下创建分类文件夹；
- 文件夹同名时默认复用，但必须在预览中标出；
- 用户可选择“创建带后缀的新文件夹”；
- 已位于正确目标中的书签标记为 no-op；
- 不允许把文件夹移动到自身后代；
- 不允许处理受管理策略保护的节点。

### 8.4 执行与回滚

执行前创建：

- 分类计划哈希；
- 每个书签的 `id / parentId / index` 快照；
- 计划创建的文件夹逻辑 ID；
- 写书签租约；
- IndexedDB 操作日志。

执行顺序：

1. 校验当前书签树与预览时的关键节点仍一致；
2. 创建分类文件夹，并记录实际 ID；
3. 按计划逐条移动；
4. 每次成功移动后立即写 journal；
5. 失败时停止后续动作；
6. 逆序把已移动书签恢复到原 `parentId/index`；
7. 仅删除本次创建且确认为空的文件夹；
8. 写入最终结果；
9. 最后释放租约。

若扩展后台中断：

- 下次初始化读取 `applying`/`rolling_back` job；
- 通过 journal 判断已完成步骤；
- 不自动继续可能存在外部副作用的未知步骤；
- UI 显示“继续回滚”“保留当前状态”“查看详情”；
- 未经用户选择不得再次提交 AI 请求或重复移动。

## 9. Firefox 目标规格

### 9.1 Manifest

在 `wxt.config.ts` 中按浏览器生成：

- Chrome/Edge：MV3；
- Firefox 首个稳定版本：MV2；
- Gecko ID：建议固定为 `marksvault@tttxxx36.github.io`，在正式提交 AMO 前由仓库所有者最终确认；
- Firefox `strict_min_version`：`140.0`，以使用内置数据同意机制；
- `data_collection_permissions.required`: `['none']`；
- `data_collection_permissions.optional`: 至少包含 `authenticationInfo`、`bookmarksInfo`；
- 若 AMO 实际分类要求不同，以提交时 Mozilla 官方分类为准，并在 PR 中记录依据。

### 9.2 权限

必需权限：

- `bookmarks`
- `storage`
- Chromium 的 `favicon`
- GitHub API 主机权限（GitHub 备份属于现有核心集成）

可选权限：

- `https://*/*`
- `http://localhost/*`
- `http://127.0.0.1/*`

可选通配符只作为运行时精确 origin 请求的声明范围，不能安装时一次性请求全部主机。

在线死链接检测：

- 默认只进行 URL 语法、协议和重复检查；
- 用户主动启用“在线可达性检查”时，单独说明需要的权限；
- 若选择全库检查，可请求 HTTP/HTTPS 全域可选权限，但必须有明确二次确认；
- 不得继续使用 `no-cors` 响应作为“页面有效”的证据。

### 9.3 Firefox 节点兼容

必须覆盖以下夹具：

- `root________`
- `toolbar_____`
- `menu________`
- `unfiled_____`
- `mobile______`
- separator 节点
- `unmodifiable` 节点
- 本地化标题不匹配但语义 ID 可识别的情况
- 未知根目录的保底映射

### 9.4 favicon

- Firefox 默认显示本地生成的字母/颜色占位图标；
- 不再自动访问 Google favicon；
- Chromium 继续使用 `_favicon`；
- 若未来支持远程 favicon，必须是独立的显式可选功能和权限。

## 10. GitHub 客户端目标规格

重构 `src/services/github-service.ts`，但保持上层功能兼容。

要求：

- 统一 `Accept: application/vnd.github+json`；
- 使用 `Authorization: Bearer`；
- 使用集中定义的 GitHub API version header；
- owner、repo、path 分别按段编码；
- 提供统一超时和 AbortSignal；
- 解析 `Retry-After`、`X-RateLimit-Remaining`、`X-RateLimit-Reset`；
- 401/403 凭据错误、403 rate limit、404、409、422、429、5xx 分开建模；
- `getFileContent` 根据文件大小使用适当媒体类型；
- 对超出应用安全上限的备份拒绝读取并提示；
- 写入同一路径遇到 409/422 时重新读取 SHA 后做有限重试；
- 备份文件名使用毫秒加随机后缀，避免同秒冲突；
- 列表分页不能假定只有一页；
- 清理旧备份必须串行删除，并只删除符合精确文件名规则的文件；
- 日志不得包含 Authorization header、Token 或完整响应请求配置。

GitHub Token：

- 从 `storage.sync` 迁移到 `storage.local`；
- 迁移顺序必须是“读旧值 → 成功写入 local → 校验可读 → 删除 sync”；
- 任一步失败都保留旧值并返回可见错误；
- 推荐 fine-grained PAT，权限文档明确说明只需目标仓库 Contents read/write；
- 自动创建仓库所需权限与已有仓库写入权限分开说明。

## 11. 分阶段任务清单

任务 ID 是后续提交、PR、测试和进度汇报的固定引用。

### Phase 0：建立可复现基线

#### BASE-001 锁定基线并记录环境

修改：

- `README.md`
- 新增 `docs/BASELINE.md`

步骤：

1. 从最新 `main` 创建工作分支；
2. 记录 Node、npm、WXT 和三端构建目标；
3. 运行 `npm ci`、typecheck、lint、test、build:all；
4. 保存测试数量、warning、产物大小和生成 Manifest 摘要；
5. 不在该任务中修复业务问题。

验收：

- 基线命令和结果可复现；
- 如任何现有检查失败，先记录为 baseline defect；
- 不得把失败伪装为通过。

#### BASE-002 CI 三端矩阵

修改：

- `.github/workflows/build.yml`
- `package.json`

步骤：

1. 增加 lint；
2. 单独执行 typecheck 和 Jest；
3. 用 matrix 构建 chrome、edge、firefox；
4. 上传三端产物和 Manifest；
5. 增加 Manifest 断言脚本；
6. Firefox 增加 `web-ext lint`；
7. 缓存仅作为加速，不得影响干净安装验证。

验收：

- PR 必须同时通过 lint、typecheck、test、三端 build；
- CI 不访问真实 GitHub/AI 服务；
- 任何浏览器失败都会阻止合并。

#### BASE-003 移除安装包无关资源

修改：

- 将 `public/assets/images/marksvault_summary.png` 和 README 截图移动到 `docs/assets/`；
- 更新 `README.md` 图片路径；
- 保留扩展运行真正需要的图标。

验收：

- 三端包内不包含 README 大图；
- README 图片仍正常显示；
- 记录优化前后 ZIP 大小。

#### BASE-004 仓库身份和发布链接

修改：

- `README.md`
- `.github/workflows/release.yml`
- `package.json` author/repository/homepage（如确定）

验收：

- TttXxx36 仓库的徽章、clone、Release 和文档链接不再错误跳到原仓库；
- 若仍保留 upstream 致谢，应明确标为 upstream，而不是安装地址。

### Phase 1：数据安全和备份恢复

#### SAFE-001 统一书签节点和语义根目录

新增/修改：

- 新增 `src/core/bookmarks/types.ts`
- 新增 `src/core/bookmarks/root-role.ts`
- 修改 `src/utils/bookmark-service.ts`
- 修改相关类型和测试

依赖：BASE-001

验收：

- Chrome/Edge/Firefox 根目录映射使用语义 role；
- 支持 separator 和 unmodifiable；
- 不再以 `!url` 作为唯一文件夹判断；
- 旧 `BookmarkItem` 调用者在迁移期有明确适配层。

#### SAFE-002 备份 schema v2 与 v1 迁移

新增/修改：

- `src/core/backup/schema-v1.ts`
- `src/core/backup/schema-v2.ts`
- `src/core/backup/migrate-v1-to-v2.ts`
- `src/types/backup.ts`
- `src/services/backup-service.ts`

依赖：SAFE-001

验收：

- 新备份保存所有语义根目录；
- v1 备份仍能读取；
- 未知根目录有保底恢复位置；
- 恶意或损坏备份在写操作前拒绝；
- 夹具覆盖三种浏览器。

#### SAFE-003 恢复计划与预览

新增/修改：

- `src/core/backup/restore-planner.ts`
- `src/popup/components/SyncView/` 或新的恢复对话框
- `src/taskconfig/components/BackupRestoreExecutor.tsx`

依赖：SAFE-002

验收：

- 支持 merge、replace-selected-root、replace-all-supported-roots；
- 默认使用 merge；
- replace 必须二次确认；
- 预览显示创建、移动、删除、跳过、冲突和不可修改节点；
- 预览不执行任何写操作。

#### SAFE-004 写操作 journal 与自动回滚

新增/修改：

- `src/core/backup/restore-journal.ts`
- `src/storage/ai-job-store.ts` 或通用 operation store
- `src/services/backup-service.ts`
- `src/services/task-executor.ts`

依赖：SAFE-003

验收：

- 每个成功步骤即时持久化；
- 任意第 N 步故障可逆序回滚；
- 后台中断后能识别未完成操作；
- 操作成功但最终记录失败时标记为 uncertain，而不是失败或成功；
- 失败夹具覆盖删除失败、创建失败、移动失败、存储失败和中断。

#### SAFE-005 配置导入事务化

修改：

- `src/utils/storage-service.ts`
- `src/popup/components/SettingsView/SettingsActions.tsx`
- `src/utils/storage-service.test.ts`

依赖：BASE-001

步骤：

1. 完整 schema 验证；
2. 读取当前配置形成 rollback snapshot；
3. 在内存中合并并验证目标状态；
4. 执行写入；
5. 回读验证；
6. 失败时恢复旧状态；
7. 保留执行租约和运行态 key。

验收：

- 配额失败、非法 JSON、部分写失败均不会丢失原配置；
- GitHub/AI secrets 默认不导入导出；
- 旧 settings-only 文件继续兼容。

#### SAFE-006 修复备份数量为 0 的 UI

修改：

- `src/popup/components/SettingsView/GeneralSettings.tsx`

验收：

- `0` 正确显示并表示不限量；
- 空输入、负数、大于 100 和非数字有明确处理；
- 添加对应纯函数测试或组件测试。

### Phase 2：GitHub、整理服务和凭据

#### GH-001 GitHub 客户端拆分与错误模型

新增/修改：

- `src/adapters/github/github-client.ts`
- `src/adapters/github/github-errors.ts`
- `src/services/github-service.ts` 迁移适配

依赖：BASE-002

验收：满足第 10 节全部 GitHub 规格，并为 401、403 credential、403 rate limit、404、409、422、429、500、网络异常和超时建立测试。

#### GH-002 大文件、分页和冲突处理

依赖：GH-001

验收：

- 1 MB 以下、1..10 MB、超过应用限制三种路径可预测；
- 目录分页完整；
- 同秒备份不冲突；
- 409/422 重试有限且不会产生重复提交风暴。

#### SEC-001 GitHub Token 从 sync 迁移到 local

新增/修改：

- `src/adapters/browser/secret-store.ts`
- `src/storage/migrations/`
- `src/utils/storage-service.ts`

依赖：GH-001

验收：

- 迁移幂等；
- 成功后 sync 中不再保留 token；
- 失败不删除旧 token；
- 导出配置不含 token；
- 日志和错误不含 token。

#### ORG-001 修复过滤和在线验证

修改：

- `src/services/organize-service.ts`
- `wxt.config.ts`
- `src/services/organize-service.test.ts`

验收：

- 无 filters 时仍正确扁平化书签；
- 本地 URL 检查无需主机权限；
- 在线检查在缺少权限时返回 permission error；
- 不用 `no-cors` 成功推断页面有效；
- 404/410、5xx、超时、DNS、拒绝 HEAD 等结果定义清晰；
- 用户取消权限不会导致任务误报成功。

### Phase 3：Firefox 完整支持

#### FF-001 Manifest、Gecko ID 和数据声明

修改：

- `wxt.config.ts`
- `README.md`
- 新增 `docs/FIREFOX.md`

依赖：SEC-001、ORG-001

验收：

- Firefox Manifest 含稳定 ID；
- 数据传输声明符合 AMO 当前要求；
- Chrome/Edge Manifest 不受 Firefox 字段影响；
- 生成 Manifest snapshot 测试。

#### FF-002 Firefox 节点与恢复集成测试

依赖：SAFE-004、FF-001

验收：

- toolbar/menu/unfiled/mobile 映射正确；
- separator 按能力恢复或 warning；
- unmodifiable 永不写入；
- Firefox → Chrome、Chrome → Firefox 备份互相恢复；
- 未映射根目录不丢数据。

#### FF-003 隐私友好 favicon

修改：

- `src/utils/favicon-service.ts`
- `src/services/favicon-warmup-service.ts`
- Bookmark List/Grid 项目组件

验收：

- Firefox 不再请求 Google favicon；
- 无 favicon 时 UI 稳定；
- Chromium `_favicon` 保持；
- 测试不依赖外网。

#### FF-004 Firefox 包和 AMO 检查

修改：

- `package.json`
- `.github/workflows/build.yml`
- `.github/workflows/release.yml`

验收：

- `wxt build -b firefox` 通过；
- `wxt zip -b firefox` 生成扩展包和 sources 包；
- `web-ext lint` 无 error；
- 文档包含临时加载、签名安装、权限和数据传输说明。

### Phase 4：架构收敛

#### ARCH-001 统一类型与运行时 schema

新增：

- `src/core/shared/result.ts`
- `src/core/shared/errors.ts`
- schema 依赖及封装

要求：优先使用成熟的运行时 schema 库；默认选择 Zod。若 bundle 增量明显，先记录 gzip 影响再决定是否换轻量方案，不得自制不完整验证器。

验收：

- 新功能不使用裸 `any` 作为跨层协议；
- 外部 JSON、配置导入、备份和 AI 返回全部运行时验证；
- UI 获得结构化错误。

#### ARCH-002 合并任务执行公共路径

修改：

- `src/services/task-executor.ts`
- `src/services/task-executor.test.ts`
- 新增 `src/core/tasks/action-runner.ts`

依赖：SAFE-004、ARCH-001

验收：

- `executeTask` 与 `executeTaskWithData` 共用一个内部执行管线；
- 租约、快照、超时、重试和 finalize 只有一套实现；
- 删除确认未使用的执行函数；
- 现有 43+ 执行器测试保持并补充带输入路径。

#### ARCH-003 拆分备份服务

修改：

- 把序列化、GitHub 存储、恢复计划、执行和统计拆成独立模块；
- 保留旧 `backupService` facade，逐步迁移调用者。

验收：

- 单个新核心文件建议不超过 500 行；
- 纯逻辑无需 mock browser/fetch 即可测试；
- UI 不直接调用 GitHub adapter。

#### ARCH-004 拆分超大 UI

修改：

- `BookmarksView.tsx`
- `TaskActionForm.tsx`
- 相关 hooks/components

验收：

- 数据加载、选择、搜索、键盘、拖拽和视图渲染拆分；
- hook 有稳定依赖，避免 render loop；
- 行为保持，不在同一提交重设计视觉系统。

#### ARCH-005 日志服务

新增：

- `src/core/shared/logger.ts`

要求：

- 开发和生产级别不同；
- 默认生产不输出大对象、书签树、URL 全量和请求配置；
- 自动脱敏 token/apiKey/authorization；
- 操作日志与调试日志分离。

### Phase 5：AI 基础设施

#### AI-001 AI 配置、SecretStore 和迁移

新增/修改：

- `src/core/ai/types.ts`
- `src/core/ai/schemas.ts`
- `src/adapters/browser/secret-store.ts`
- `src/storage/keys.ts`
- `src/storage/migrations/`

依赖：ARCH-001、SEC-001

验收：

- 公开配置和 secret 分离；
- session/local 两种模式；
- 配置导出不含 secret；
- 删除供应商同步删除 secret；
- 复制错误/日志不含 secret。

#### AI-002 运行时主机权限

新增/修改：

- `src/adapters/browser/permission-service.ts`
- `wxt.config.ts`
- AI 设置 UI

依赖：FF-001

验收：

- 保存配置不自动申请权限；
- 测试连接时申请精确 origin；
- 已授权时不重复弹窗；
- URL 变更时重新评估权限；
- 用户拒绝后保留配置但标记未授权；
- Firefox/Chrome 均有测试。

#### AI-003 OpenAI-compatible Provider

新增：

- `src/adapters/ai/ai-provider.ts`
- `src/adapters/ai/openai-compatible-provider.ts`

依赖：AI-001、AI-002、GH-001 的错误模型

验收：

- 支持 bearer、API key header、none；
- 支持 AbortSignal、超时、429/5xx 重试；
- 支持 JSON schema response_format，供应商不支持时回退到 JSON-only 提示；
- 连接测试不发送真实书签；
- 错误区分 URL、权限、认证、模型、限流、服务端和格式问题；
- 测试使用本地 fake fetch。

#### AI-004 AI 设置页面

新增：

- `src/popup/features/ai-classification/AiProviderSettings.tsx`
- `src/popup/features/ai-classification/AiConnectionTest.tsx`
- Settings 导航入口

验收：

- 支持新增、编辑、删除、选择默认供应商；
- API Key 字段不会回显完整内容；
- “测试连接”显示目标域名和模型；
- 表单逐字段验证；
- 模型列表读取失败时仍允许手工输入；
- 提供清除 secret 操作。

#### AI-005 Prompt 与恶意输入防护

新增：

- `src/core/ai/prompt.ts`
- `src/core/ai/prompt.test.ts`
- fixtures

验收：

- 系统指令明确把书签文本视为数据；
- 书签标题含“忽略前文”“输出密钥”等内容时仍只返回 schema；
- 不把 secret、扩展配置和其他书签批次拼入 prompt；
- prompt 版本号写入任务记录，便于回归。

### Phase 6：AI 分类、预览和执行

#### AI-006 分类范围与本地预处理

新增：

- `src/core/ai/classification-scope.ts`
- `src/core/ai/preprocess.ts`

验收：

- 四种范围选择正确；
- 去重只影响采样，不丢真实 ID；
- 不支持的 URL 协议进入 unassigned；
- 20,000 节点预处理不会阻塞 UI；
- 不发送网页正文。

#### AI-007 Taxonomy 生成和审核

新增：

- `src/core/ai/taxonomy.ts`
- `src/popup/features/ai-classification/TaxonomyEditor.tsx`

依赖：AI-003、AI-005、AI-006

验收：

- 大库采样可复现；
- schema、数量、深度、去重和环检测完整；
- 用户可编辑并重新验证；
- 未确认 taxonomy 不进入 assignment。

#### AI-008 批量分配和持久化

新增：

- `src/core/ai/assignment.ts`
- `src/storage/ai-job-store.ts`
- background 消息处理

依赖：AI-007

验收：

- 每批完成后持久化；
- 中断后从下一未完成批次继续；
- 不重复计费已完成批次；
- 覆盖率和 ID 校验严格；
- 用户取消会 Abort 当前请求并停止新批次；
- 取消不删除已有结果。

#### AI-009 分类预览

新增：

- `src/core/ai/classification-plan.ts`
- `src/popup/features/ai-classification/ClassificationPreview.tsx`

依赖：AI-008、SAFE-003

验收：

- 展示 folders/moves/no-op/skipped/conflicts/unassigned；
- 支持按分类、原目录、置信度筛选；
- 支持逐项修改目标；
- 计划哈希随任何编辑更新；
- 预览阶段 browser.bookmarks 写方法调用数为 0。

#### AI-010 执行、回滚和恢复

新增/修改：

- `src/core/ai/apply-plan.ts`
- `src/core/ai/operation-journal.ts`
- `src/services/task-executor.ts` 或新的 action runner
- background message handlers

依赖：AI-009、SAFE-004、ARCH-002

验收：

- 确认后的计划才能执行；
- 执行前重新校验计划哈希和节点位置；
- 逐步 journal；
- 任意失败自动逆序回滚；
- 回滚不删除用户原有文件夹；
- SW 中断后能识别和继续回滚；
- 同时只能有一个书签写任务；
- AI 请求任务可与只读操作并行，但不能绕过写租约。

#### AI-011 结果报告和撤销入口

新增：

- `ClassificationResult.tsx`
- 设置或任务页面的最近 AI 操作列表

验收：

- 报告显示移动、跳过、失败、回滚和未分类数量；
- 在安全窗口内提供“撤销本次分类”；
- 撤销前检测后续人工修改冲突；
- 冲突时提供逐项选择，不盲目覆盖。

### Phase 7：测试、性能和发布

#### QA-001 单元与契约测试

范围：

- schema/migration；
- 根目录映射；
- restore planner/journal/rollback；
- GitHub 错误和大文件；
- permission service；
- secret store；
- AI provider；
- taxonomy/assignment validator；
- classification plan/apply/rollback。

要求：

- 新核心模块行覆盖率建议不低于 85%；
- 关键失败分支必须有测试，不能只追求总体覆盖率；
- 不使用真实外部服务。

#### QA-002 浏览器集成测试

最少场景：

1. Chrome 安装、创建书签、移动、备份预览；
2. Firefox 临时安装、固定 ID、storage 持久化；
3. Chrome 备份在 Firefox 恢复；
4. Firefox 备份在 Chrome 恢复；
5. separator/unmodifiable；
6. 任务执行时 SW 重启；
7. AI 权限拒绝、认证失败、429、格式错误、取消；
8. AI 预览确认、移动中失败、自动回滚；
9. 升级前后的设置和 token 迁移。

#### QA-003 性能和容量

数据集：100、1,000、5,000、10,000、20,000 节点。

记录：

- 首次加载时间；
- 搜索延迟；
- 备份序列化大小和时间；
- 恢复预览时间；
- AI 预处理时间；
- IndexedDB 占用；
- UI 长任务响应；
- ZIP 大小。

目标：

- 纯本地预处理避免超过 100ms 的长主线程块，必要时分片；
- 10,000 节点预览不崩溃；
- 超出配置上限给出明确提示，不进入破坏性阶段。

#### QA-004 安全与隐私审查

检查：

- secrets 搜索；
- 日志脱敏；
- 配置导出；
- host permissions；
- Firefox 数据声明；
- prompt injection fixtures；
- 恶意备份 JSON；
- URL/header 校验；
- CSP 和远程代码；
- 第三方依赖许可证与供应链风险。

#### REL-001 发布 v1.6.0

包含：Phase 0..4 和 Firefox，不包含 AI 分类写操作。

发布门槛：

- 三端 CI 全绿；
- Firefox lint 通过；
- 数据恢复和回滚演练通过；
- 从 v1.0/v1.5 配置升级通过；
- README、CHANGELOG、隐私说明、checksums 完整；
- Chrome/Edge/Firefox ZIP 和 Firefox sources ZIP 可下载；
- 发布后从产物重新安装做一次烟雾测试。

#### REL-002 发布 v2.0.0

包含：Phase 5..7 AI 功能。

发布门槛：

- 不配置 AI 时行为与 v1.6 一致；
- 至少一个 OpenAI-compatible 云端服务和一个 localhost fake 服务手工验证；
- 不使用真实用户数据录制演示；
- AI 分类预览、取消、回滚和中断恢复全部通过；
- AMO/商店隐私声明更新；
- 发布说明明确数据发送字段和用户控制范围。

## 12. 测试矩阵

| 能力 | Chrome MV3 | Edge MV3 | Firefox MV2 | 单元 | 集成/手工 |
|---|---:|---:|---:|---:|---:|
| 书签 CRUD | 必须 | 必须 | 必须 | 是 | 是 |
| 根目录映射 | 必须 | 必须 | 必须 | 是 | 是 |
| separator/unmodifiable | N/A/兼容 | N/A/兼容 | 必须 | 是 | 是 |
| GitHub 备份 | 必须 | 必须 | 必须 | fake | 是 |
| 完整恢复 | 必须 | 必须 | 必须 | 是 | 是 |
| 自动回滚 | 必须 | 必须 | 必须 | 是 | 是 |
| storage 迁移 | 必须 | 必须 | 必须 | 是 | 是 |
| AI 主机权限 | 必须 | 必须 | 必须 | 是 | 是 |
| AI 连接测试 | 必须 | 必须 | 必须 | fake | 是 |
| AI 分类预览 | 必须 | 必须 | 必须 | 是 | 是 |
| AI 执行/撤销 | 必须 | 必须 | 必须 | 是 | 是 |
| SW/后台中断 | 必须 | 必须 | 适配验证 | 是 | 是 |
| 商店包检查 | 必须 | 建议 | 必须 | 脚本 | 手工 |

## 13. Definition of Done

单个任务只有同时满足以下条件才算完成：

- 实现与任务范围一致，没有夹带无关重构；
- 类型检查通过；
- lint 无新增 warning；
- 相关单元测试通过；
- 三端构建通过；
- 新外部数据有运行时 schema；
- 新权限有用户说明和拒绝路径；
- 新持久化数据有版本或迁移说明；
- 新错误有结构化类型和用户可理解提示；
- 不泄露 secret；
- 破坏性操作有失败与回滚测试；
- 文档和 CHANGELOG 更新；
- 最终汇报明确说明“实际验证了什么”和“尚未验证什么”。

## 14. 推荐提交切片

禁止一个提交同时包含整个 v1.6 或 v2.0。推荐顺序：

1. `chore(ci): establish multi-browser quality gates`
2. `chore(package): remove documentation assets from extension bundle`
3. `refactor(bookmarks): add semantic cross-browser node model`
4. `feat(backup): add v2 schema and v1 migration`
5. `feat(restore): add restore planning and preview`
6. `feat(restore): add operation journal and rollback`
7. `fix(storage): make config import transactional`
8. `refactor(github): add typed client and conflict handling`
9. `fix(organize): correct filtering and permission-aware validation`
10. `feat(firefox): add stable identity and AMO declarations`
11. `fix(firefox): remove third-party favicon leakage`
12. `refactor(tasks): unify task execution pipeline`
13. `release: prepare v1.6.0`
14. `feat(ai): add provider configuration and secret store`
15. `feat(ai): add runtime origin permissions and connection test`
16. `feat(ai): add taxonomy generation and validation`
17. `feat(ai): add resumable batched assignment`
18. `feat(ai): add classification preview`
19. `feat(ai): add journaled apply and rollback`
20. `release: prepare v2.0.0`

每个提交都应保持可构建；需要中间兼容层时先保留，不要为了“目录最终漂亮”制造不可运行状态。

## 15. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---:|---:|---|
| 恢复或 AI 移动造成书签丢失 | 中 | 极高 | preview、journal、回滚、写租约、故障注入 |
| Firefox storage 因 ID 变化丢配置 | 高 | 高 | 固定 Gecko ID、迁移测试、发布升级测试 |
| 任意 AI 地址需要广泛可选权限 | 高 | 中 | 安装不请求、运行时精确 origin、清晰说明 |
| AI 输出 JSON 不兼容 | 高 | 中 | schema、一次修复、失败批次、禁止猜测 |
| 大书签库导致超时或配额失败 | 中 | 高 | IndexedDB、批处理、容量预检、性能基线 |
| MV3 SW 在长任务中被回收 | 中 | 高 | 分批持久化、租约、journal、恢复状态机 |
| GitHub API 限流/冲突 | 中 | 中 | headers、Retry-After、SHA 重读、有限重试 |
| AMO 数据声明不通过 | 中 | 高 | v1.6 前完成官方要求复核和 web-ext lint |
| 依赖大版本升级引发 UI 回归 | 中 | 中 | 单独升级、锁文件、三端构建、视觉烟测 |
| 原仓库与当前仓库身份混乱 | 高 | 中 | 统一链接、明确 upstream、独立 Release |

## 16. Luna 执行协议

后续 GPT-5.6 Luna 执行时应遵循：

1. 首先确认 `main` HEAD；若不是本文基线，比较变更并更新 `docs/BASELINE.md`。
2. 检查工作区已有改动，保留用户改动，不覆盖无关文件。
3. 一次只领取一个 Phase 或一组明确依赖的任务 ID。
4. 开工前列出本轮任务 ID、预计修改文件和验证命令。
5. 每完成一个任务立即运行相关测试，不把验证全部拖到最后。
6. 遇到现有测试失败时，先判断 baseline defect 还是本轮回归。
7. 任何恢复/移动/删除实现都必须加入故障注入测试。
8. 任何外部请求都必须加入权限拒绝、超时、认证失败和限流测试。
9. 不得真实调用用户 AI API 或消耗额度，除非用户单独明确授权测试。
10. 不得直接发布、创建 Release、提交 AMO 或推送商店，除非用户明确要求。
11. 每轮交付报告必须包含：
    - 完成的任务 ID；
    - 修改文件；
    - 实际运行的检查及结果；
    - 未完成项；
    - 风险和下一步。

### Luna 第一轮建议范围

第一轮只执行：

- BASE-001
- BASE-002
- BASE-003
- BASE-004
- SAFE-006

该轮不修改备份恢复核心逻辑，不加入 AI。目的是先建立可信基线、三端质量门槛、正确仓库身份和小型确定性修复。完成后再进入 SAFE-001..SAFE-005。

## 17. 最终成功标准

MarksVault 达到以下状态时，本计划才算全部完成：

- 用户可以在 Chrome、Edge、Firefox 中稳定安装、升级和保留配置；
- 备份真实覆盖全部支持的书签根目录；
- 恢复和 AI 分类不会在失败时把用户留在不可恢复的部分状态；
- Firefox 不再隐式向 Google 泄漏书签域名；
- GitHub Token 和 AI Key 不进入同步存储、日志或导出文件；
- 用户能够配置 OpenAI-compatible 请求地址、认证、模型并测试连接；
- AI 分类采用 taxonomy → assignment → preview → confirm → apply 流程；
- 用户可以取消、恢复中断任务、查看报告并撤销最近一次分类；
- CI 对三端执行完整质量门槛；
- v1.6 和 v2.0 都有可验证、可回退的独立发布产物；
- 文档描述与实际代码、权限、隐私和 Release 完全一致。


