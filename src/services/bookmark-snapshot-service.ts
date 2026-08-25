import { browser } from 'wxt/browser';
import {
  BookmarkSnapshot,
  BookmarkSnapshotNode,
  SnapshotDelta,
  SnapshotImportValidationResult,
  SnapshotIndex,
  SnapshotIndexEntry,
  SnapshotMetadata,
  SnapshotRetentionPolicy,
  SnapshotSource,
  SNAPSHOT_SCHEMA_VERSION,
  SNAPSHOT_SOURCES,
  RestoreJournal,
  RestorePlan,
} from '../types/snapshot';
import type { AiClassificationJob } from '../types/ai';

export const SNAPSHOT_INDEX_KEY = 'bookmark_snapshot_index';
export const SNAPSHOT_CURRENT_TASK_KEY = 'bookmark_snapshot_current_task';
export const SNAPSHOT_MIGRATION_KEY = 'bookmark_snapshot_migration';
export const SNAPSHOT_RECENT_STATE_KEY = 'bookmark_snapshot_recent_state';
export const SNAPSHOT_DB_NAME = 'marksvault-snapshots-v1';
export const SNAPSHOT_DB_VERSION = 2;
export const MAX_AUTOMATIC_SNAPSHOTS = 20;
export const MAX_SNAPSHOT_NODES = 100_000;
export const MAX_SNAPSHOT_DEPTH = 100;

const SNAPSHOT_STORE = 'snapshots';
const JOURNAL_STORE = 'restore_journals';
const PLAN_STORE = 'restore_plans';
const AI_JOB_STORE = 'ai_classification_jobs';
const ALLOWED_URL_PROTOCOLS = new Set([
  'http:',
  'https:',
  'ftp:',
  'file:',
  'chrome:',
  'chrome-extension:',
  'moz-extension:',
  'about:',
]);

type BookmarkTreeNode = {
  id: string;
  parentId?: string;
  title?: string;
  url?: string;
  index?: number;
  dateAdded?: number;
  children?: BookmarkTreeNode[];
};

export interface SnapshotRepository {
  getSnapshot(snapshotId: string): Promise<BookmarkSnapshot | null>;
  putSnapshot(snapshot: BookmarkSnapshot): Promise<void>;
  deleteSnapshot(snapshotId: string): Promise<void>;
  listSnapshots(): Promise<BookmarkSnapshot[]>;
  getJournal(journalId: string): Promise<RestoreJournal | null>;
  putJournal(journal: RestoreJournal): Promise<void>;
  listJournals(): Promise<RestoreJournal[]>;
  getPlan(planId: string): Promise<RestorePlan | null>;
  putPlan(plan: RestorePlan): Promise<void>;
  deletePlan(planId: string): Promise<void>;
  /** Large AI task checkpoints are local IndexedDB data, not storage.local. */
  getAiClassificationJob?(): Promise<AiClassificationJob | null>;
  putAiClassificationJob?(job: AiClassificationJob): Promise<void>;
  deleteAiClassificationJob?(): Promise<void>;
}

const clone = <T>(value: T): T => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
};

const createId = (prefix: string): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const isQuotaError = (error: unknown): boolean => {
  const name = error instanceof DOMException ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  return name === 'QuotaExceededError' || /quota|capacity|storage.?full|disk.?full/i.test(message);
};

export class SnapshotCapacityError extends Error {
  readonly code = 'CAPACITY';

  constructor(message = '快照存储空间不足，请导出或删除不再需要的快照后重试') {
    super(message);
    this.name = 'SnapshotCapacityError';
  }
}

export class SnapshotValidationError extends Error {
  readonly code = 'INVALID_SNAPSHOT';

  constructor(message: string) {
    super(message);
    this.name = 'SnapshotValidationError';
  }
}

export class MemorySnapshotRepository implements SnapshotRepository {
  private snapshots = new Map<string, BookmarkSnapshot>();
  private journals = new Map<string, RestoreJournal>();
  private plans = new Map<string, RestorePlan>();
  private aiJob: AiClassificationJob | null = null;

  async getSnapshot(snapshotId: string): Promise<BookmarkSnapshot | null> {
    return clone(this.snapshots.get(snapshotId) ?? null);
  }

  async putSnapshot(snapshot: BookmarkSnapshot): Promise<void> {
    this.snapshots.set(snapshot.snapshotId, clone(snapshot));
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    this.snapshots.delete(snapshotId);
  }

  async listSnapshots(): Promise<BookmarkSnapshot[]> {
    return [...this.snapshots.values()].map(clone);
  }

  async getJournal(journalId: string): Promise<RestoreJournal | null> {
    return clone(this.journals.get(journalId) ?? null);
  }

  async putJournal(journal: RestoreJournal): Promise<void> {
    this.journals.set(journal.journalId, clone(journal));
  }

  async listJournals(): Promise<RestoreJournal[]> {
    return [...this.journals.values()].map(clone);
  }

  async getPlan(planId: string): Promise<RestorePlan | null> {
    return clone(this.plans.get(planId) ?? null);
  }

  async putPlan(plan: RestorePlan): Promise<void> {
    this.plans.set(plan.planId, clone(plan));
  }

  async deletePlan(planId: string): Promise<void> {
    this.plans.delete(planId);
  }

  async getAiClassificationJob(): Promise<AiClassificationJob | null> {
    return clone(this.aiJob);
  }

  async putAiClassificationJob(job: AiClassificationJob): Promise<void> {
    this.aiJob = clone(job);
  }

  async deleteAiClassificationJob(): Promise<void> {
    this.aiJob = null;
  }
}

export class IndexedDbSnapshotRepository implements SnapshotRepository {
  private databasePromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    const idb = globalThis.indexedDB;
    if (!idb) throw new Error('当前环境不支持 IndexedDB');
    this.databasePromise = new Promise((resolve, reject) => {
      const request = idb.open(SNAPSHOT_DB_NAME, SNAPSHOT_DB_VERSION);
      request.onerror = () => reject(request.error ?? new Error('打开快照数据库失败'));
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
          database.createObjectStore(SNAPSHOT_STORE, { keyPath: 'snapshotId' });
        }
        if (!database.objectStoreNames.contains(JOURNAL_STORE)) {
          database.createObjectStore(JOURNAL_STORE, { keyPath: 'journalId' });
        }
        if (!database.objectStoreNames.contains(PLAN_STORE)) {
          database.createObjectStore(PLAN_STORE, { keyPath: 'planId' });
        }
        if (!database.objectStoreNames.contains(AI_JOB_STORE)) {
          database.createObjectStore(AI_JOB_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
    return this.databasePromise;
  }

  private async request<T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = action(transaction.objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('快照数据库操作失败'));
      transaction.onerror = () => reject(transaction.error ?? new Error('快照数据库事务失败'));
    });
  }

  private async getAll<T>(storeName: string): Promise<T[]> {
    return this.request<T[]>(storeName, 'readonly', store => store.getAll());
  }

  async getSnapshot(snapshotId: string): Promise<BookmarkSnapshot | null> {
    return (await this.request<BookmarkSnapshot | undefined>(SNAPSHOT_STORE, 'readonly', store => store.get(snapshotId))) ?? null;
  }

  async putSnapshot(snapshot: BookmarkSnapshot): Promise<void> {
    try {
      await this.request(SNAPSHOT_STORE, 'readwrite', store => store.put(snapshot));
    } catch (error) {
      if (isQuotaError(error)) throw new SnapshotCapacityError();
      throw error;
    }
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    await this.request(SNAPSHOT_STORE, 'readwrite', store => store.delete(snapshotId));
  }

  async listSnapshots(): Promise<BookmarkSnapshot[]> {
    return this.getAll<BookmarkSnapshot>(SNAPSHOT_STORE);
  }

  async getJournal(journalId: string): Promise<RestoreJournal | null> {
    return (await this.request<RestoreJournal | undefined>(JOURNAL_STORE, 'readonly', store => store.get(journalId))) ?? null;
  }

  async putJournal(journal: RestoreJournal): Promise<void> {
    try {
      await this.request(JOURNAL_STORE, 'readwrite', store => store.put(journal));
    } catch (error) {
      if (isQuotaError(error)) throw new SnapshotCapacityError('无法保存恢复日志，存储空间不足；为避免不确定写入，未继续恢复');
      throw error;
    }
  }

  async listJournals(): Promise<RestoreJournal[]> {
    return this.getAll<RestoreJournal>(JOURNAL_STORE);
  }

  async getPlan(planId: string): Promise<RestorePlan | null> {
    return (await this.request<RestorePlan | undefined>(PLAN_STORE, 'readonly', store => store.get(planId))) ?? null;
  }

  async putPlan(plan: RestorePlan): Promise<void> {
    try {
      await this.request(PLAN_STORE, 'readwrite', store => store.put(plan));
    } catch (error) {
      if (isQuotaError(error)) throw new SnapshotCapacityError('无法保存恢复计划，存储空间不足；未执行书签写入');
      throw error;
    }
  }

  async deletePlan(planId: string): Promise<void> {
    await this.request(PLAN_STORE, 'readwrite', store => store.delete(planId));
  }

  async getAiClassificationJob(): Promise<AiClassificationJob | null> {
    const job = await this.request<(AiClassificationJob & { id: string }) | undefined>(AI_JOB_STORE, 'readonly', store => store.get('active'));
    return job ? clone(job) : null;
  }

  async putAiClassificationJob(job: AiClassificationJob): Promise<void> {
    try {
      await this.request(AI_JOB_STORE, 'readwrite', store => store.put({ ...job, id: 'active' }));
    } catch (error) {
      if (isQuotaError(error)) throw new SnapshotCapacityError('无法保存 AI 分类任务检查点，存储空间不足');
      throw error;
    }
  }

  async deleteAiClassificationJob(): Promise<void> {
    await this.request(AI_JOB_STORE, 'readwrite', store => store.delete('active'));
  }
}

let defaultRepository: SnapshotRepository | null = null;

export const getSnapshotRepository = (): SnapshotRepository => {
  if (!defaultRepository) {
    defaultRepository = globalThis.indexedDB ? new IndexedDbSnapshotRepository() : new MemorySnapshotRepository();
  }
  return defaultRepository;
};

export const setSnapshotRepositoryForTesting = (repository: SnapshotRepository | null): void => {
  defaultRepository = repository;
};

const textEncoder = (): TextEncoder => new TextEncoder();

const stableJson = (value: unknown): string => JSON.stringify(value, (_key, nested) => {
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
  return Object.keys(nested as Record<string, unknown>).sort().reduce<Record<string, unknown>>((result, key) => {
    result[key] = (nested as Record<string, unknown>)[key];
    return result;
  }, {});
});

const fallbackHash = (input: string): string => {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const part = (hash >>> 0).toString(16).padStart(8, '0');
  return part.repeat(8);
};

export const sha256Hex = async (input: string): Promise<string> => {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.subtle) {
    const digest = await cryptoApi.subtle.digest('SHA-256', textEncoder().encode(input));
    return Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('');
  }
  return fallbackHash(input);
};

const snapshotContent = (nodes: BookmarkSnapshotNode[]): BookmarkSnapshotNode[] => nodes.map(node => ({
  id: node.id,
  parentId: node.parentId,
  index: node.index,
  title: node.title,
  url: node.url,
  type: node.type,
  path: node.path,
  dateAdded: node.dateAdded,
}));

const getDepth = (node: BookmarkSnapshotNode): number => {
  const pathDepth = node.path ? node.path.split(' / ').filter(Boolean).length : 0;
  return pathDepth + 1;
};

export const computeSnapshotMetrics = async (nodesInput: BookmarkSnapshotNode[]): Promise<{
  nodeCount: number;
  maxDepth: number;
  byteSize: number;
  contentHash: string;
}> => {
  const nodes = snapshotContent(nodesInput);
  const canonical = stableJson(nodes);
  return {
    nodeCount: nodes.length,
    maxDepth: nodes.reduce((max, node) => Math.max(max, getDepth(node)), 0),
    byteSize: textEncoder().encode(canonical).byteLength,
    contentHash: await sha256Hex(canonical),
  };
};

const isSafeUrl = (url: string): boolean => {
  try {
    return ALLOWED_URL_PROTOCOLS.has(new URL(url).protocol.toLowerCase());
  } catch {
    return false;
  }
};

const hasSecretKey = (value: unknown, path = ''): boolean => {
  if (!value || typeof value !== 'object') return false;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/(api.?key|access.?token|github.?token|authorization|secret|password)/i.test(key)) return true;
    if (hasSecretKey(nested, `${path}.${key}`)) return true;
  }
  return false;
};

export const validateSnapshot = async (candidate: unknown): Promise<SnapshotImportValidationResult> => {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!candidate || typeof candidate !== 'object') {
    return { valid: false, errors: ['快照必须是 JSON 对象'], warnings: [] };
  }
  const raw = candidate as Partial<BookmarkSnapshot>;
  if (raw.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) errors.push('不支持的快照 schema 版本');
  if (!raw.snapshotId || typeof raw.snapshotId !== 'string') errors.push('缺少 snapshotId');
  if (!raw.name || typeof raw.name !== 'string') errors.push('缺少快照名称');
  if (!raw.userName || typeof raw.userName !== 'string') errors.push('缺少用户名称');
  if (!Number.isFinite(raw.createdAt)) errors.push('缺少创建时间');
  if (!Array.isArray(raw.nodes)) errors.push('缺少书签节点列表');
  if (hasSecretKey(candidate)) errors.push('快照不得包含 API Key、Token 或其他密钥字段');
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  if (nodes.length > MAX_SNAPSHOT_NODES) errors.push(`节点数量超过上限 ${MAX_SNAPSHOT_NODES}`);
  const ids = new Set<string>();
  for (const node of nodes as BookmarkSnapshotNode[]) {
    if (!node || typeof node !== 'object' || typeof node.id !== 'string' || typeof node.title !== 'string') {
      errors.push('节点字段无效');
      continue;
    }
    if (ids.has(node.id)) errors.push(`节点 ID 重复: ${node.id}`);
    ids.add(node.id);
    if (node.type !== 'bookmark' && node.type !== 'folder') errors.push(`节点类型无效: ${node.id}`);
    if (node.type === 'bookmark' && (!node.url || !isSafeUrl(node.url))) errors.push(`节点 URL 协议不安全: ${node.id}`);
    if (node.type === 'folder' && node.url) errors.push(`文件夹不应包含 URL: ${node.id}`);
    if (typeof node.path !== 'string') errors.push(`节点路径无效: ${node.id}`);
  }
  const metrics = await computeSnapshotMetrics(nodes as BookmarkSnapshotNode[]);
  if (metrics.maxDepth > MAX_SNAPSHOT_DEPTH) errors.push(`最大深度超过上限 ${MAX_SNAPSHOT_DEPTH}`);
  if (typeof raw.nodeCount !== 'number' || raw.nodeCount !== metrics.nodeCount) errors.push('节点数量校验失败');
  if (typeof raw.maxDepth !== 'number' || raw.maxDepth !== metrics.maxDepth) errors.push('最大深度校验失败');
  if (typeof raw.byteSize !== 'number' || raw.byteSize !== metrics.byteSize) errors.push('字节大小校验失败');
  if (typeof raw.contentHash !== 'string' || raw.contentHash !== metrics.contentHash) errors.push('内容哈希校验失败');
  if (raw.validationStatus && raw.validationStatus !== 'valid' && raw.validationStatus !== 'pending') errors.push('校验状态无效');
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    schemaVersion: raw.schemaVersion,
    nodeCount: metrics.nodeCount,
    maxDepth: metrics.maxDepth,
    byteSize: metrics.byteSize,
    contentHash: raw.contentHash,
    computedHash: metrics.contentHash,
  };
};

const flattenBookmarkTree = (nodes: BookmarkTreeNode[], parentPath = '', depth = 0): { nodes: BookmarkSnapshotNode[]; maxDepth: number } => {
  const result: BookmarkSnapshotNode[] = [];
  let maxDepth = depth;
  for (const node of nodes) {
    const title = typeof node.title === 'string' ? node.title : '';
    const isFolder = !node.url;
    const normalized: BookmarkSnapshotNode = {
      id: node.id,
      parentId: node.parentId,
      index: node.index,
      title,
      ...(node.url ? { url: node.url } : {}),
      type: isFolder ? 'folder' : 'bookmark',
      path: parentPath,
      dateAdded: node.dateAdded,
    };
    result.push(normalized);
    maxDepth = Math.max(maxDepth, depth);
    if (node.children?.length) {
      const nextPath = parentPath ? `${parentPath} / ${title}` : title;
      const nested = flattenBookmarkTree(node.children, nextPath, depth + 1);
      result.push(...nested.nodes);
      maxDepth = Math.max(maxDepth, nested.maxDepth);
    }
  }
  return { nodes: result, maxDepth };
};

export const captureBookmarkTree = async (): Promise<BookmarkSnapshotNode[]> => {
  const tree = await browser.bookmarks.getTree() as unknown as BookmarkTreeNode[];
  return flattenBookmarkTree(Array.isArray(tree) ? tree : []).nodes;
};

const formatSnapshotDate = (timestamp: number): string => {
  const date = new Date(timestamp);
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
};

const createMetadata = (options: {
  snapshotId: string;
  name: string;
  userName: string;
  createdAt: number;
  source: SnapshotSource;
  isAutomatic: boolean;
  isProtected: boolean;
  metrics: { nodeCount: number; maxDepth: number; byteSize: number; contentHash: string };
}): SnapshotMetadata => ({
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  snapshotId: options.snapshotId,
  name: options.name,
  userName: options.userName,
  createdAt: options.createdAt,
  source: options.source,
  nodeCount: options.metrics.nodeCount,
  maxDepth: options.metrics.maxDepth,
  byteSize: options.metrics.byteSize,
  contentHash: options.metrics.contentHash,
  validationStatus: 'valid',
  isAutomatic: options.isAutomatic,
  isProtected: options.isProtected,
});

export interface CreateBookmarkSnapshotOptions {
  source: SnapshotSource;
  name?: string;
  userName?: string;
  isAutomatic?: boolean;
  isProtected?: boolean;
  planId?: string;
  affectedBookmarkIds?: string[];
  delta?: SnapshotDelta[];
  now?: number;
  nodes?: BookmarkSnapshotNode[];
  repository?: SnapshotRepository;
}

const saveIndex = async (index: SnapshotIndex): Promise<void> => {
  await browser.storage.local.set({ [SNAPSHOT_INDEX_KEY]: index });
};

export const loadSnapshotIndex = async (): Promise<SnapshotIndex> => {
  const result = await browser.storage.local.get(SNAPSHOT_INDEX_KEY) as Record<string, unknown>;
  const migration = await browser.storage.local.get(SNAPSHOT_MIGRATION_KEY) as Record<string, unknown>;
  if (!migration[SNAPSHOT_MIGRATION_KEY]) {
    await browser.storage.local.set({ [SNAPSHOT_MIGRATION_KEY]: { schemaVersion: SNAPSHOT_SCHEMA_VERSION, migratedAt: Date.now(), legacyAiPlanReadable: true } });
  }
  const raw = result[SNAPSHOT_INDEX_KEY] as Partial<SnapshotIndex> | undefined;
  const entries = Array.isArray(raw?.entries) ? raw.entries as SnapshotIndexEntry[] : [];
  const now = Date.now();
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    createdAt: typeof raw?.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: typeof raw?.updatedAt === 'number' ? raw.updatedAt : now,
    userName: typeof raw?.userName === 'string' ? raw.userName : '本地用户',
    source: raw?.source,
    nodeCount: entries.reduce((sum, entry) => sum + (entry.nodeCount || 0), 0),
    byteSize: entries.reduce((sum, entry) => sum + (entry.byteSize || 0), 0),
    contentHash: '',
    validationStatus: entries.every(entry => entry.validationStatus === 'valid') ? 'valid' : 'pending',
    isAutomatic: false,
    isProtected: false,
    entries: entries.sort((a, b) => b.createdAt - a.createdAt),
    maxAutomaticSnapshots: typeof raw?.maxAutomaticSnapshots === 'number' ? raw.maxAutomaticSnapshots : MAX_AUTOMATIC_SNAPSHOTS,
  };
};

const retainSnapshots = async (repository: SnapshotRepository, index: SnapshotIndex): Promise<SnapshotIndex> => {
  const automatic = index.entries
    .filter(entry => entry.isAutomatic && !entry.isProtected)
    .sort((a, b) => b.createdAt - a.createdAt);
  const keepIds = new Set(automatic.slice(0, MAX_AUTOMATIC_SNAPSHOTS).map(entry => entry.snapshotId));
  const removed = automatic.slice(MAX_AUTOMATIC_SNAPSHOTS);
  for (const entry of removed) {
    // Named/protected snapshots are never in this list and are therefore never
    // silently removed by retention.
    await repository.deleteSnapshot(entry.snapshotId);
  }
  const entries = index.entries.filter(entry => !entry.isAutomatic || entry.isProtected || keepIds.has(entry.snapshotId));
  return { ...index, entries, updatedAt: Date.now() };
};

export const createBookmarkSnapshot = async (options: CreateBookmarkSnapshotOptions): Promise<BookmarkSnapshot> => {
  const repository = options.repository || getSnapshotRepository();
  const now = options.now ?? Date.now();
  const isAutomatic = options.isAutomatic ?? (options.source !== SNAPSHOT_SOURCES.MANUAL && options.source !== SNAPSHOT_SOURCES.IMPORTED);
  const isProtected = options.isProtected ?? !isAutomatic;
  const nodes = snapshotContent(options.nodes ?? await captureBookmarkTree());
  const metrics = await computeSnapshotMetrics(nodes);
  const metadata = createMetadata({
    snapshotId: createId('snapshot'),
    name: options.name?.trim() || `${options.source === SNAPSHOT_SOURCES.RESTORE_BEFORE
      ? '恢复前'
      : options.source === SNAPSHOT_SOURCES.AI_CLASSIFICATION_BEFORE
        ? 'AI 分类前'
        : options.source === SNAPSHOT_SOURCES.IMPORTED
          ? '导入快照'
          : '命名快照'} - ${formatSnapshotDate(now)}`,
    userName: options.userName?.trim() || '本地用户',
    createdAt: now,
    source: options.source,
    isAutomatic,
    isProtected,
    metrics,
  });
  const snapshot: BookmarkSnapshot = {
    ...metadata,
    planId: options.planId,
    affectedBookmarkIds: [...(options.affectedBookmarkIds || [])],
    delta: [...(options.delta || [])],
    rootIds: nodes.filter(node => !node.parentId).map(node => node.id),
    nodes,
  };
  const validation = await validateSnapshot(snapshot);
  if (!validation.valid) throw new SnapshotValidationError(validation.errors.join('; '));
  try {
    await repository.putSnapshot(snapshot);
    let index = await loadSnapshotIndex();
    const entry: SnapshotIndexEntry = {
      ...metadata,
      planId: snapshot.planId,
    };
    index = { ...index, userName: metadata.userName, entries: [entry, ...index.entries.filter(item => item.snapshotId !== snapshot.snapshotId)] };
    index = await retainSnapshots(repository, index);
    await saveIndex(index);
    await browser.storage.local.set({ [SNAPSHOT_RECENT_STATE_KEY]: { snapshotId: snapshot.snapshotId, createdAt: now, status: 'valid' } });
    return snapshot;
  } catch (error) {
    if (error instanceof SnapshotCapacityError || isQuotaError(error)) throw new SnapshotCapacityError();
    throw error;
  }
};

export const getBookmarkSnapshot = async (snapshotId: string, repository?: SnapshotRepository): Promise<BookmarkSnapshot | null> =>
  (repository || getSnapshotRepository()).getSnapshot(snapshotId);

export const listBookmarkSnapshots = async (options?: {
  repository?: SnapshotRepository;
  query?: string;
  source?: SnapshotSource;
  isAutomatic?: boolean;
}): Promise<SnapshotIndexEntry[]> => {
  const index = await loadSnapshotIndex();
  const query = options?.query?.trim().toLocaleLowerCase();
  return index.entries.filter(entry => {
    if (options?.source && entry.source !== options.source) return false;
    if (typeof options?.isAutomatic === 'boolean' && entry.isAutomatic !== options.isAutomatic) return false;
    if (!query) return true;
    const dateText = `${new Date(entry.createdAt).toLocaleString()} ${new Date(entry.createdAt).toISOString()}`;
    return [entry.name, entry.userName, entry.source, dateText].some(value => value.toLocaleLowerCase().includes(query));
  });
};

export const deleteBookmarkSnapshot = async (snapshotId: string, repository?: SnapshotRepository): Promise<void> => {
  const repo = repository || getSnapshotRepository();
  const index = await loadSnapshotIndex();
  const entry = index.entries.find(item => item.snapshotId === snapshotId);
  if (entry?.isProtected) throw new Error('受保护的命名快照不能被自动删除，请先明确确认删除');
  await repo.deleteSnapshot(snapshotId);
  await saveIndex({ ...index, entries: index.entries.filter(item => item.snapshotId !== snapshotId), updatedAt: Date.now() });
};

export const exportBookmarkSnapshot = async (snapshotId: string, repository?: SnapshotRepository): Promise<string> => {
  const snapshot = await getBookmarkSnapshot(snapshotId, repository);
  if (!snapshot) throw new Error('找不到要导出的快照');
  const validation = await validateSnapshot(snapshot);
  if (!validation.valid) throw new SnapshotValidationError('快照校验失败，不能导出');
  return JSON.stringify(snapshot, null, 2);
};

export const importBookmarkSnapshot = async (json: string, options?: {
  repository?: SnapshotRepository;
  name?: string;
  userName?: string;
}): Promise<BookmarkSnapshot> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SnapshotValidationError('快照 JSON 格式无效');
  }
  const validation = await validateSnapshot(parsed);
  if (!validation.valid) throw new SnapshotValidationError(validation.errors.join('; '));
  const source = parsed as BookmarkSnapshot;
  const repository = options?.repository || getSnapshotRepository();
  const existing = await repository.getSnapshot(source.snapshotId);
  const now = Date.now();
  const imported: BookmarkSnapshot = {
    ...clone(source),
    snapshotId: existing ? createId('snapshot') : source.snapshotId,
    name: options?.name?.trim() || source.name,
    userName: options?.userName?.trim() || source.userName,
    createdAt: source.createdAt || now,
    updatedAt: now,
    source: SNAPSHOT_SOURCES.IMPORTED,
    isAutomatic: false,
    isProtected: true,
    validationStatus: 'valid',
  };
  const importedValidation = await validateSnapshot(imported);
  if (!importedValidation.valid) throw new SnapshotValidationError(importedValidation.errors.join('; '));
  await repository.putSnapshot(imported);
  const index = await loadSnapshotIndex();
  const entry: SnapshotIndexEntry = {
    schemaVersion: imported.schemaVersion,
    snapshotId: imported.snapshotId,
    name: imported.name,
    userName: imported.userName,
    createdAt: imported.createdAt,
    source: imported.source,
    nodeCount: imported.nodeCount,
    maxDepth: imported.maxDepth,
    byteSize: imported.byteSize,
    contentHash: imported.contentHash,
    validationStatus: imported.validationStatus,
    isAutomatic: imported.isAutomatic,
    isProtected: imported.isProtected,
    planId: imported.planId,
  };
  await saveIndex({ ...index, entries: [entry, ...index.entries], updatedAt: now });
  return imported;
};

export const getSnapshotRetentionPolicy = (overrides?: Partial<SnapshotRetentionPolicy>): SnapshotRetentionPolicy => ({
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  createdAt: Date.now(),
  userName: '本地用户',
  source: SNAPSHOT_SOURCES.MANUAL,
  nodeCount: 0,
  byteSize: 0,
  contentHash: '',
  validationStatus: 'valid',
  isAutomatic: false,
  isProtected: true,
  maxAutomaticSnapshots: MAX_AUTOMATIC_SNAPSHOTS,
  protectNamedSnapshots: true,
  warnAtBytes: 50 * 1024 * 1024,
  rejectAtBytes: 100 * 1024 * 1024,
  ...overrides,
});

/** Compatibility read for v2.0.1's AI plan snapshot. */
export const readLegacyAiClassificationPlan = async (): Promise<Record<string, unknown> | null> => {
  const result = await browser.storage.local.get('ai_last_classification_plan') as Record<string, unknown>;
  const plan = result.ai_last_classification_plan;
  return plan && typeof plan === 'object' ? plan as Record<string, unknown> : null;
};

export const readLegacyAiLastClassificationPlan = readLegacyAiClassificationPlan;
