import { browser } from 'wxt/browser';
import {
  BookmarkSnapshot,
  BookmarkSnapshotNode,
  RestoreJournal,
  RestoreJournalItem,
  RestorePlan,
  SnapshotConflict,
  SnapshotDiff,
  SnapshotDiffItem,
  SNAPSHOT_SCHEMA_VERSION,
} from '../types/snapshot';
import {
  captureBookmarkTree,
  createBookmarkSnapshot,
  getBookmarkSnapshot,
  getSnapshotRepository,
  SnapshotRepository,
  SNAPSHOT_CURRENT_TASK_KEY,
} from './bookmark-snapshot-service';

export const BOOKMARK_WRITE_LEASE_KEY = 'bookmark_write_lease';
const LEASE_DURATION_MS = 120_000;

type RestoreBookmarkNode = BookmarkSnapshotNode;

export interface SnapshotDiffOptions {
  safeChangeIds?: string[];
  userName?: string;
}

export interface CreateRestorePlanOptions extends SnapshotDiffOptions {
  repository?: SnapshotRepository;
  currentNodes?: BookmarkSnapshotNode[];
  selectedItemIds?: string[];
}

export interface ApplyRestorePlanOptions {
  repository?: SnapshotRepository;
  userName?: string;
  signal?: AbortSignal;
  cancelRequested?: () => boolean | Promise<boolean>;
  continueAfterUncertain?: boolean;
  /** Explicit user selection from the preview UI; conflicts are always rejected. */
  selectedItemIds?: string[];
  faultInjector?: (item: SnapshotDiffItem, phase: 'before-write' | 'after-write') => void | Promise<void>;
}

export class RestoreUncertainError extends Error {
  readonly code = 'RESTORE_UNCERTAIN';

  constructor(message: string) {
    super(message);
    this.name = 'RestoreUncertainError';
  }
}

export class RestoreLeaseError extends Error {
  readonly code = 'RESTORE_LEASE';

  constructor(message: string) {
    super(message);
    this.name = 'RestoreLeaseError';
  }
}

let leaseMutex: Promise<void> = Promise.resolve();

const withLeaseMutex = async <T>(fn: () => Promise<T>): Promise<T> => {
  const previous = leaseMutex;
  let release!: () => void;
  leaseMutex = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
};

const createId = (prefix: string): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const fingerprint = (node: Pick<BookmarkSnapshotNode, 'title' | 'url' | 'path'>): string =>
  `${node.title.trim()}\u0000${node.url || ''}\u0000${node.path.trim()}`;

const getNodeById = async (id: string): Promise<RestoreBookmarkNode | null> => {
  const nodes = await browser.bookmarks.get(id) as unknown as Array<{
    id: string;
    parentId?: string;
    title?: string;
    url?: string;
    index?: number;
    children?: unknown[];
  }>;
  const node = nodes?.[0];
  if (!node) return null;
  return {
    id: node.id,
    parentId: node.parentId,
    index: node.index,
    title: node.title || '',
    ...(node.url ? { url: node.url } : {}),
    type: (node as unknown as { type?: 'bookmark' | 'folder' | 'separator' }).type || (node.url ? 'bookmark' : Array.isArray(node.children) ? 'folder' : 'separator'),
    ...((node as unknown as { unmodifiable?: string }).unmodifiable ? { unmodifiable: (node as unknown as { unmodifiable?: string }).unmodifiable } : {}),
    path: '',
  };
};

const isSameUrl = (a?: string, b?: string): boolean => (a || '') === (b || '');

const resolveSemanticParentId = (
  snapshot: BookmarkSnapshot,
  targetParentId: string | undefined,
  currentNodes: RestoreBookmarkNode[],
  matchedIds: Map<string, string>,
  semanticRootMap: Record<string, string>,
): string | undefined => {
  if (!targetParentId) return targetParentId;
  // Imported backups carry foreign IDs. Prefer the ID of the uniquely matched
  // current node before falling back to a semantic root mapping.
  if (matchedIds.has(targetParentId)) return matchedIds.get(targetParentId);
  if (semanticRootMap[targetParentId]) return semanticRootMap[targetParentId];
  const root = snapshot.roots?.find(item => item.nativeId === targetParentId);
  if (!root) return targetParentId;
  const currentRoot = currentNodes.find(node => node.rootRole === root.role && node.path === '' && node.type === 'folder');
  return currentRoot?.id || targetParentId;
};

const importedRootTitle = (plan: RestorePlan): string => {
  const date = new Date(plan.createdAt);
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `MarksVault Imported - ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
};

const findOrCreateSemanticRootMap = async (
  snapshot: BookmarkSnapshot,
  plan: RestorePlan,
  journal: RestoreJournal,
  currentNodes: RestoreBookmarkNode[],
  repository: SnapshotRepository,
  requiredRootIds?: Set<string>,
): Promise<{ journal: RestoreJournal; map: Record<string, string> }> => {
  const map = { ...(journal.semanticRootMap || {}) };
  const createdRootFolderIds = [...(journal.createdRootFolderIds || [])];
  const writableRoot = currentNodes.find(node =>
    node.type === 'folder' && !node.unmodifiable && (node.rootRole === 'toolbar' || node.rootRole === 'menu' || node.rootRole === 'other')
  );
  const fallbackTitle = importedRootTitle(plan);
  for (const root of snapshot.roots || []) {
    if (requiredRootIds && !requiredRootIds.has(root.nativeId)) continue;
    if (map[root.nativeId]) continue;
    const currentRoot = root.role !== 'unknown' && root.role !== 'managed'
      ? currentNodes.find(node => node.type === 'folder' && !node.unmodifiable && node.path === '' && node.rootRole === root.role)
      : undefined;
    if (currentRoot) {
      map[root.nativeId] = currentRoot.id;
      continue;
    }
    if (!writableRoot) throw new RestoreUncertainError('找不到可写入的浏览器书签根目录，已阻止未知根目录导入');
    const children = await browser.bookmarks.getChildren(writableRoot.id) as unknown as Array<{ id: string; title?: string; type?: string; children?: unknown[] }>;
    const existing = children.find(child => child.title === fallbackTitle && (child.type === 'folder' || Array.isArray(child.children)));
    if (existing) {
      map[root.nativeId] = existing.id;
      continue;
    }
    const created = await browser.bookmarks.create({ parentId: writableRoot.id, title: fallbackTitle });
    map[root.nativeId] = created.id;
    createdRootFolderIds.push(created.id);
    const updatedJournal: RestoreJournal = {
      ...journal,
      semanticRootMap: { ...map },
      createdRootFolderIds,
      updatedAt: Date.now(),
    };
    await repository.putJournal(updatedJournal);
    journal = updatedJournal;
  }
  return { journal: { ...journal, semanticRootMap: map, createdRootFolderIds }, map };
};

const makeConflict = (
  snapshot: BookmarkSnapshot,
  node: BookmarkSnapshotNode,
  candidateNodeIds: string[],
  reason: SnapshotConflict['reason'],
  message: string,
): SnapshotConflict => ({
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  createdAt: snapshot.createdAt,
  userName: snapshot.userName,
  source: snapshot.source,
  nodeCount: snapshot.nodeCount,
  byteSize: snapshot.byteSize,
  contentHash: snapshot.contentHash,
  validationStatus: snapshot.validationStatus,
  isAutomatic: snapshot.isAutomatic,
  isProtected: snapshot.isProtected,
  snapshotNodeId: node.id,
  candidateNodeIds,
  reason,
  message,
});

export const calculateSnapshotDiff = (
  snapshot: BookmarkSnapshot,
  currentNodes: BookmarkSnapshotNode[],
  options?: SnapshotDiffOptions,
): SnapshotDiff => {
  const currentById = new Map(currentNodes.map(node => [node.id, node]));
  const currentByFingerprint = new Map<string, BookmarkSnapshotNode[]>();
  for (const node of currentNodes) {
    const key = fingerprint(node);
    const candidates = currentByFingerprint.get(key) || [];
    candidates.push(node);
    currentByFingerprint.set(key, candidates);
  }
  const matchedCurrentIds = new Set<string>();
  const safeChangeIds = new Set(options?.safeChangeIds || []);
  const items: SnapshotDiffItem[] = [];

  for (const snapshotNode of snapshot.nodes) {
    let currentNode = currentById.get(snapshotNode.id);
    let matchedBy: SnapshotDiffItem['matchedBy'] = currentNode ? 'stable-id' : undefined;
    let conflict: SnapshotConflict | undefined;
    if (!currentNode) {
      const candidates = currentByFingerprint.get(fingerprint(snapshotNode)) || [];
      if (candidates.length === 1) {
        currentNode = candidates[0];
        matchedBy = 'fingerprint';
      } else if (candidates.length > 1) {
        conflict = makeConflict(snapshot, snapshotNode, candidates.map(node => node.id), 'duplicate-fingerprint', '标题、URL 和文件夹路径指纹不唯一');
      }
    }

    if (conflict) {
      items.push({
        id: snapshotNode.id,
        snapshotNode,
        kind: 'conflict',
        changes: ['conflict'],
        action: 'skip',
        reason: conflict.message,
        conflict,
      });
      continue;
    }
    if (!currentNode) {
      const canImport = snapshot.source === 'imported'
        && snapshotNode.type !== 'separator'
        && !snapshotNode.unmodifiable;
      items.push({
        id: snapshotNode.id,
        snapshotNode,
        kind: 'deleted',
        changes: ['deleted'],
        action: canImport ? 'restore' : 'skip',
        reason: canImport ? '当前不存在，将在确认后导入为新节点' : '快照之后节点已删除或无法安全匹配',
      });
      continue;
    }

    matchedCurrentIds.add(currentNode.id);
    if (snapshotNode.type !== currentNode.type) {
      const typeConflict = makeConflict(snapshot, snapshotNode, [currentNode.id], 'type-changed', '节点类型发生变化');
      items.push({ id: snapshotNode.id, snapshotNode, currentNode, matchedBy, kind: 'conflict', changes: ['conflict'], action: 'skip', reason: typeConflict.message, conflict: typeConflict });
      continue;
    }
    if (snapshotNode.type === 'separator' || currentNode.unmodifiable || snapshotNode.unmodifiable) {
      const unsupportedConflict = makeConflict(
        snapshot,
        snapshotNode,
        [currentNode.id],
        currentNode.unmodifiable ? 'unmodifiable' : 'unsupported-type',
        currentNode.unmodifiable ? '当前节点受浏览器策略保护，恢复会跳过' : '分隔线节点不支持跨浏览器恢复写入',
      );
      items.push({ id: snapshotNode.id, snapshotNode, currentNode, matchedBy, kind: 'conflict', changes: ['conflict'], action: 'skip', reason: unsupportedConflict.message, conflict: unsupportedConflict });
      continue;
    }
    if (!isSameUrl(snapshotNode.url, currentNode.url)) {
      const urlConflict = makeConflict(snapshot, snapshotNode, [currentNode.id], 'url-changed', '当前 URL 已变化，恢复不会覆盖 URL');
      items.push({ id: snapshotNode.id, snapshotNode, currentNode, matchedBy, kind: 'conflict', changes: ['conflict'], action: 'skip', reason: urlConflict.message, conflict: urlConflict });
      continue;
    }

    const changes: SnapshotDiffItem['changes'] = [];
    if (snapshotNode.parentId !== currentNode.parentId || snapshotNode.path !== currentNode.path) changes.push('moved');
    if (snapshotNode.title !== currentNode.title) changes.push('renamed');
    if (changes.length === 0) {
      items.push({ id: snapshotNode.id, snapshotNode, currentNode, matchedBy, kind: 'unchanged', changes: ['unchanged'], action: 'none' });
      continue;
    }
    const action = safeChangeIds.has(snapshotNode.id) ? 'restore' : 'skip';
    items.push({
      id: snapshotNode.id,
      snapshotNode,
      currentNode,
      matchedBy,
      kind: changes[0],
      changes,
      action,
      reason: action === 'skip' ? '快照之后节点已被修改，默认跳过' : undefined,
    });
  }

  for (const currentNode of currentNodes) {
    if (matchedCurrentIds.has(currentNode.id)) continue;
    items.push({
      id: `current:${currentNode.id}`,
      currentNode,
      kind: 'added',
      changes: ['added'],
      action: 'skip',
      reason: '快照之后新增的节点不会被删除',
    });
  }

  const count = (kind: SnapshotDiffItem['kind']) => items.filter(item => item.changes.includes(kind)).length;
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    createdAt: snapshot.createdAt,
    userName: options?.userName || snapshot.userName,
    source: snapshot.source,
    nodeCount: snapshot.nodeCount,
    byteSize: snapshot.byteSize,
    contentHash: snapshot.contentHash,
    validationStatus: snapshot.validationStatus,
    isAutomatic: snapshot.isAutomatic,
    isProtected: snapshot.isProtected,
    snapshotId: snapshot.snapshotId,
    generatedAt: Date.now(),
    items,
    addedCount: count('added'),
    deletedCount: count('deleted'),
    movedCount: count('moved'),
    renamedCount: count('renamed'),
    conflictCount: count('conflict'),
    skippedCount: items.filter(item => item.action === 'skip').length,
    unchangedCount: count('unchanged'),
  };
};

export const createRestorePlan = async (
  snapshotId: string,
  options?: CreateRestorePlanOptions,
): Promise<RestorePlan> => {
  const repository = options?.repository || getSnapshotRepository();
  const snapshot = await getBookmarkSnapshot(snapshotId, repository);
  if (!snapshot) throw new Error('找不到要恢复的书签快照');
  const currentNodes = options?.currentNodes || await captureBookmarkTree();
  // The AI-before snapshot records the exact IDs it was allowed to move.
  // Those changes are safe to preview for undo, while ordinary historical
  // snapshots keep the conservative default of skipping post-snapshot edits.
  const safeChangeIds = options?.safeChangeIds
    ?? (snapshot.source === 'ai-classification-before' ? snapshot.affectedBookmarkIds : undefined);
  const diff = calculateSnapshotDiff(snapshot, currentNodes, { ...options, safeChangeIds });
  const planId = createId('restore-plan');
  const journalId = createId('restore-journal');
  const selectedItemIds = options?.selectedItemIds
    ? [...options.selectedItemIds]
    : diff.items.filter(item => item.action === 'restore').map(item => item.id);
  const now = Date.now();
  const plan: RestorePlan = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    planId,
    snapshotId,
    createdAt: now,
    updatedAt: now,
    userName: options?.userName || snapshot.userName,
    source: snapshot.source,
    nodeCount: snapshot.nodeCount,
    byteSize: snapshot.byteSize,
    contentHash: snapshot.contentHash,
    validationStatus: snapshot.validationStatus,
    isAutomatic: snapshot.isAutomatic,
    isProtected: snapshot.isProtected,
    diff,
    selectedItemIds,
    journalId,
    state: 'preview',
    safeChangeIds,
  };
  const journal: RestoreJournal = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    journalId,
    planId,
    snapshotId,
    createdAt: now,
    updatedAt: now,
    userName: plan.userName,
    source: plan.source,
    nodeCount: plan.nodeCount,
    byteSize: plan.byteSize,
    contentHash: plan.contentHash,
    validationStatus: plan.validationStatus,
    isAutomatic: plan.isAutomatic,
    isProtected: plan.isProtected,
    state: 'preview',
    items: diff.items.map(item => ({
      itemId: item.id,
      bookmarkId: item.snapshotNode?.id || item.currentNode?.id,
      state: selectedItemIds.includes(item.id) && item.action === 'restore' ? 'pending' : 'skipped',
      error: item.reason,
    })),
  };
  await repository.putPlan(plan);
  await repository.putJournal(journal);
  await browser.storage.local.set({ [SNAPSHOT_CURRENT_TASK_KEY]: { planId, journalId, state: 'preview' } });
  return plan;
};

const loadPlan = async (planOrId: RestorePlan | string, repository: SnapshotRepository): Promise<RestorePlan> => {
  if (typeof planOrId !== 'string') return planOrId;
  const plan = await repository.getPlan(planOrId);
  if (!plan) throw new Error('找不到恢复计划');
  return plan;
};

const acquireLease = async (leaseId: string): Promise<void> => {
  const result = await browser.storage.local.get(BOOKMARK_WRITE_LEASE_KEY) as Record<string, unknown>;
  const existing = result[BOOKMARK_WRITE_LEASE_KEY] as { leaseId?: string; expiresAt?: number } | undefined;
  if (existing && existing.expiresAt && existing.expiresAt > Date.now() && existing.leaseId !== leaseId) {
    throw new RestoreLeaseError('已有其他任务正在写入书签，请稍后重试');
  }
  await browser.storage.local.set({ [BOOKMARK_WRITE_LEASE_KEY]: { leaseId, taskId: `restore:${leaseId}`, executionId: leaseId, acquiredAt: Date.now(), expiresAt: Date.now() + LEASE_DURATION_MS } });
};

const releaseLease = async (leaseId: string): Promise<void> => {
  const result = await browser.storage.local.get(BOOKMARK_WRITE_LEASE_KEY) as Record<string, unknown>;
  const existing = result[BOOKMARK_WRITE_LEASE_KEY] as { leaseId?: string; executionId?: string } | undefined;
  if (!existing || existing.leaseId === leaseId || existing.executionId === leaseId) {
    await browser.storage.local.remove(BOOKMARK_WRITE_LEASE_KEY);
  }
};

const savePlanAndJournal = async (repository: SnapshotRepository, plan: RestorePlan, journal: RestoreJournal): Promise<void> => {
  plan.updatedAt = Date.now();
  journal.updatedAt = plan.updatedAt;
  await repository.putPlan(plan);
  await repository.putJournal(journal);
  await browser.storage.local.set({ [SNAPSHOT_CURRENT_TASK_KEY]: { planId: plan.planId, journalId: journal.journalId, state: plan.state } });
};

const updateJournalItem = async (repository: SnapshotRepository, plan: RestorePlan, journal: RestoreJournal, itemId: string, update: Partial<RestoreJournalItem>): Promise<void> => {
  const index = journal.items.findIndex(item => item.itemId === itemId);
  if (index < 0) return;
  journal.items[index] = { ...journal.items[index], ...update };
  await savePlanAndJournal(repository, plan, journal);
};

const shouldCancel = async (options: ApplyRestorePlanOptions): Promise<boolean> => {
  if (options.signal?.aborted) return true;
  return options.cancelRequested ? Boolean(await options.cancelRequested()) : false;
};

export const applyRestorePlan = async (
  planInput: RestorePlan | string,
  options?: ApplyRestorePlanOptions,
): Promise<RestorePlan> => {
  const repository = options?.repository || getSnapshotRepository();
  let plan = await loadPlan(planInput, repository);
  if (plan.state === 'applied' || plan.state === 'rolled_back' || plan.state === 'cancelled') return plan;
  if (plan.state === 'applying') throw new RestoreUncertainError('恢复计划正在执行或上次执行结果不确定，请先检查恢复日志');
  if (plan.state === 'uncertain' && !options?.continueAfterUncertain) throw new RestoreUncertainError('恢复结果不确定，请明确选择继续或回滚');

  const loadedJournal = plan.journalId ? await repository.getJournal(plan.journalId) : null;
  if (!loadedJournal) throw new Error('找不到恢复日志，已阻止写入');
  let journal: RestoreJournal = loadedJournal;
  if (options?.selectedItemIds) {
    const requested = new Set(options.selectedItemIds);
    const allowed = new Set(
      plan.diff.items
        .filter(item => requested.has(item.id) && item.action === 'restore' && !item.conflict)
        .map(item => item.id),
    );
    // Conflicts and non-restorable items never become selectable, even if a
    // caller sends a forged runtime message instead of using the UI.
    plan = { ...plan, selectedItemIds: [...allowed], updatedAt: Date.now() };
    journal = {
      ...journal,
      items: journal.items.map(item => {
        if (item.state === 'completed' || item.state === 'uncertain' || item.state === 'rolled_back') return item;
        const diffItem = plan.diff.items.find(candidate => candidate.id === item.itemId);
        const selected = Boolean(diffItem && allowed.has(item.itemId) && diffItem.action === 'restore' && !diffItem.conflict);
        return { ...item, state: selected ? 'pending' : 'skipped', error: selected ? undefined : item.error };
      }),
    };
    await savePlanAndJournal(repository, plan, journal);
  }
  const sourceSnapshot = await getBookmarkSnapshot(plan.snapshotId, repository);
  if (!sourceSnapshot) throw new Error('找不到恢复源快照，已阻止写入');

  if (!plan.beforeSnapshotId) {
    // This must complete and validate before acquiring a write path. If it
    // fails, no browser.bookmarks.write method is called.
    const before = await createBookmarkSnapshot({
      repository,
      source: 'restore-before',
      planId: plan.planId,
      userName: options?.userName || plan.userName,
      isAutomatic: true,
      isProtected: false,
    });
    plan = { ...plan, beforeSnapshotId: before.snapshotId };
  }

  const leaseId = createId('restore-lease');
  return withLeaseMutex(async () => {
    await acquireLease(leaseId);
    try {
      plan = { ...plan, state: 'applying', updatedAt: Date.now() };
      journal = { ...journal, state: 'applying', leaseId, updatedAt: Date.now() };
      await savePlanAndJournal(repository, plan, journal);
      const currentTreeForRoots = await captureBookmarkTree();
      const matchedIds = new Map<string, string>();
      for (const diffItem of plan.diff.items) {
        if (diffItem.snapshotNode?.id && diffItem.currentNode?.id) matchedIds.set(diffItem.snapshotNode.id, diffItem.currentNode.id);
      }
      const selected = new Set(plan.selectedItemIds);
      const items = plan.diff.items.filter(item => selected.has(item.id) && item.action === 'restore');
      const requiredRootIds = sourceSnapshot.roots
        ? new Set(sourceSnapshot.roots
          .filter(root => plan.diff.items.some(item => selected.has(item.id) && item.action === 'restore'
            && item.snapshotNode && root.nodeIds.includes(item.snapshotNode.id)))
          .map(root => root.nativeId))
        : undefined;
      const semanticRoots = await findOrCreateSemanticRootMap(sourceSnapshot, plan, journal, currentTreeForRoots, repository, requiredRootIds);
      journal = semanticRoots.journal;
      for (const item of items) {
        if (await shouldCancel(options || {})) {
          plan = { ...plan, state: 'cancelled' };
          journal = { ...journal, state: 'cancelled' };
          await savePlanAndJournal(repository, plan, journal);
          return plan;
        }
        const journalItem = journal.items.find(entry => entry.itemId === item.id);
        if (journalItem?.state === 'completed' || journalItem?.state === 'rolled_back') continue;
        await updateJournalItem(repository, plan, journal, item.id, { state: 'running', startedAt: Date.now() });
        try {
          await options?.faultInjector?.(item, 'before-write');
          const target = item.snapshotNode;
          if (!target) {
            await updateJournalItem(repository, plan, journal, item.id, { state: 'skipped', completedAt: Date.now(), error: '没有可安全匹配的节点' });
            continue;
          }
          if (!item.currentNode) {
            // Imported GitHub backups may contain nodes that do not exist in
            // the current browser. Create only those nodes, under the
            // already-resolved semantic root, after explicit confirmation.
            if (sourceSnapshot.source !== 'imported' || target.type === 'separator' || target.unmodifiable) {
              await updateJournalItem(repository, plan, journal, item.id, { state: 'skipped', completedAt: Date.now(), error: '没有可安全匹配的节点' });
              continue;
            }
            if (!target.parentId && semanticRoots.map[target.id]) {
              matchedIds.set(target.id, semanticRoots.map[target.id]);
              await updateJournalItem(repository, plan, journal, item.id, {
                state: 'skipped', completedAt: Date.now(), bookmarkId: semanticRoots.map[target.id],
                error: '语义根目录已映射到当前浏览器，未重复创建根节点',
              });
              continue;
            }
            const targetParentId = resolveSemanticParentId(sourceSnapshot, target.parentId, currentTreeForRoots, matchedIds, semanticRoots.map);
            if (!targetParentId) {
              await updateJournalItem(repository, plan, journal, item.id, { state: 'skipped', completedAt: Date.now(), error: '父目录无法安全映射' });
              continue;
            }
            const children = await browser.bookmarks.getChildren(targetParentId) as unknown as Array<{ id: string; title?: string; url?: string; type?: string; children?: unknown[] }>;
            const matches = children.filter(child => {
              const childTypeMatches = target.type === 'folder'
                ? child.type === 'folder' || Array.isArray(child.children)
                : child.type === 'bookmark' || Boolean(child.url);
              return childTypeMatches && child.title === target.title && (target.type !== 'bookmark' || child.url === target.url);
            });
            if (matches.length > 1) {
              await updateJournalItem(repository, plan, journal, item.id, {
                state: 'skipped', completedAt: Date.now(),
                error: '导入目标存在多个同名或同 URL 节点，已阻止猜测匹配',
              });
              continue;
            }
            const existing = matches[0];
            const created = existing || await browser.bookmarks.create({
              parentId: targetParentId,
              index: target.index,
              title: target.title,
              ...(target.type === 'bookmark' && target.url ? { url: target.url } : {}),
            });
            matchedIds.set(target.id, created.id);
            await options?.faultInjector?.(item, 'after-write');
            await updateJournalItem(repository, plan, journal, item.id, {
              state: 'completed', completedAt: Date.now(), bookmarkId: created.id,
              afterParentId: targetParentId, afterIndex: target.index, afterTitle: target.title,
              ...(target.url ? { afterUrl: target.url } : {}),
              operation: target.type === 'folder' ? 'create-folder' : 'create-bookmark',
            });
            continue;
          }
          const current = await getNodeById(item.currentNode.id);
          if (!current) {
            await updateJournalItem(repository, plan, journal, item.id, { state: 'skipped', completedAt: Date.now(), error: '当前节点已删除' });
            continue;
          }
          if (!isSameUrl(target.url, current.url)) {
            await updateJournalItem(repository, plan, journal, item.id, { state: 'skipped', completedAt: Date.now(), error: 'URL 已变化，恢复不会覆盖 URL' });
            continue;
          }
          if (target.type === 'separator' || current.type === 'separator' || current.unmodifiable || target.unmodifiable) {
            await updateJournalItem(repository, plan, journal, item.id, { state: 'skipped', completedAt: Date.now(), error: '分隔线或受保护节点不可写入' });
            continue;
          }
          const targetParentId = resolveSemanticParentId(sourceSnapshot, target.parentId, currentTreeForRoots, matchedIds, semanticRoots.map);
          const journalUpdate: Partial<RestoreJournalItem> = {
            bookmarkId: current.id,
            beforeParentId: current.parentId,
            beforeIndex: current.index,
            beforeTitle: current.title,
            afterParentId: targetParentId,
            afterIndex: target.index,
            afterTitle: target.title,
            ...(target.url ? { afterUrl: target.url } : {}),
          };
          if (current.parentId !== targetParentId && targetParentId) {
            await browser.bookmarks.move(current.id, { parentId: targetParentId, index: target.index });
            journalUpdate.operation = 'move';
          }
          if (current.title !== target.title) {
            await browser.bookmarks.update(current.id, { title: target.title });
            journalUpdate.operation = journalUpdate.operation || 'rename';
          }
          await options?.faultInjector?.(item, 'after-write');
          await updateJournalItem(repository, plan, journal, item.id, { ...journalUpdate, state: 'completed', completedAt: Date.now() });
        } catch (error) {
          await updateJournalItem(repository, plan, journal, item.id, { state: 'uncertain', completedAt: Date.now(), error: error instanceof Error ? error.message : String(error) });
          throw new RestoreUncertainError(`恢复节点 ${item.id} 时写入结果不确定`);
        }
      }
      plan = { ...plan, state: 'applied' };
      journal = { ...journal, state: 'applied' };
      await savePlanAndJournal(repository, plan, journal);
      return plan;
    } catch (error) {
      if (plan.state !== 'cancelled') {
        plan = { ...plan, state: 'uncertain' };
        journal = { ...journal, state: 'uncertain', error: error instanceof Error ? error.message : String(error) };
        await savePlanAndJournal(repository, plan, journal);
      }
      throw error;
    } finally {
      await releaseLease(leaseId);
    }
  });
};

export const rollbackRestorePlan = async (planInput: RestorePlan | string, options?: { repository?: SnapshotRepository }): Promise<RestorePlan> => {
  const repository = options?.repository || getSnapshotRepository();
  const plan = await loadPlan(planInput, repository);
  const journal = plan.journalId ? await repository.getJournal(plan.journalId) : null;
  if (!journal) throw new Error('找不到恢复日志，无法回滚');
  const leaseId = createId('restore-rollback-lease');
  return withLeaseMutex(async () => {
    await acquireLease(leaseId);
    try {
      let resultPlan: RestorePlan = { ...plan, state: 'applying' };
      const resultJournal: RestoreJournal = { ...journal, state: 'applying' };
      await savePlanAndJournal(repository, resultPlan, resultJournal);
      for (const item of [...resultJournal.items].filter(entry => entry.state === 'completed').reverse()) {
        if (!item.bookmarkId) continue;
        const current = await getNodeById(item.bookmarkId);
        if (!current) continue;
        // Only reverse changes whose current state still equals our recorded
        // post-restore state. A later user edit is left untouched.
        if (item.afterParentId && current.parentId !== item.afterParentId) continue;
        if (item.afterTitle && current.title !== item.afterTitle) continue;
        if (item.operation === 'create-folder' || item.operation === 'create-bookmark') {
          const raw = await browser.bookmarks.get(current.id) as unknown as Array<{ id: string; url?: string; children?: unknown[] }>;
          const createdNode = raw?.[0];
          if (item.afterUrl && createdNode?.url !== item.afterUrl) continue;
          // Never remove an imported folder after the user has added content.
          if (item.operation === 'create-folder' && (createdNode?.children?.length || 0) > 0) continue;
          await browser.bookmarks.removeTree(current.id);
          const createdIndex = resultJournal.items.findIndex(entry => entry.itemId === item.itemId);
          if (createdIndex >= 0) resultJournal.items[createdIndex] = { ...resultJournal.items[createdIndex], state: 'rolled_back', completedAt: Date.now() };
          await savePlanAndJournal(repository, resultPlan, resultJournal);
          continue;
        }
        if (!item.beforeParentId) continue;
        if (current.parentId !== item.beforeParentId) {
          await browser.bookmarks.move(current.id, { parentId: item.beforeParentId, index: item.beforeIndex });
        }
        if (item.beforeTitle !== undefined && current.title !== item.beforeTitle) {
          await browser.bookmarks.update(current.id, { title: item.beforeTitle });
        }
        const index = resultJournal.items.findIndex(entry => entry.itemId === item.itemId);
        if (index >= 0) resultJournal.items[index] = { ...resultJournal.items[index], state: 'rolled_back', completedAt: Date.now() };
        await savePlanAndJournal(repository, resultPlan, resultJournal);
      }
      // Unknown-root fallback folders are created outside the diff item list.
      // Remove them only when they are still empty; user-added content keeps
      // the folder and therefore remains recoverable and untouched.
      for (const folderId of resultJournal.createdRootFolderIds || []) {
        const raw = await browser.bookmarks.get(folderId) as unknown as Array<{ id: string; title?: string; children?: unknown[] }>;
        const folder = raw?.[0];
        if (!folder || (folder.children?.length || 0) > 0) continue;
        await browser.bookmarks.removeTree(folderId);
      }
      resultPlan = { ...resultPlan, state: 'rolled_back' };
      resultJournal.state = 'rolled_back';
      await savePlanAndJournal(repository, resultPlan, resultJournal);
      return resultPlan;
    } finally {
      await releaseLease(leaseId);
    }
  });
};

export const cancelRestorePlan = async (planInput: RestorePlan | string, options?: { repository?: SnapshotRepository }): Promise<RestorePlan> => {
  const repository = options?.repository || getSnapshotRepository();
  const plan = await loadPlan(planInput, repository);
  const journal = plan.journalId ? await repository.getJournal(plan.journalId) : null;
  if (!journal) throw new Error('找不到恢复日志');
  const cancelled = { ...plan, state: 'cancelled' as const };
  await savePlanAndJournal(repository, cancelled, { ...journal, state: 'cancelled' });
  return cancelled;
};

export const resumeRestoreJournal = async (journalId: string, options?: { repository?: SnapshotRepository }): Promise<RestorePlan> => {
  const repository = options?.repository || getSnapshotRepository();
  const journal = await repository.getJournal(journalId);
  if (!journal) throw new Error('找不到恢复日志');
  const plan = await repository.getPlan(journal.planId);
  if (!plan) throw new Error('找不到恢复计划');
  return applyRestorePlan({ ...plan, state: 'uncertain' }, { repository, continueAfterUncertain: true });
};

/** Called during startup only to make uncertain state visible; it never writes bookmarks. */
export const markRestoreJournalsRecoverable = async (repository?: SnapshotRepository): Promise<RestoreJournal[]> => {
  const repo = repository || getSnapshotRepository();
  const journals = await repo.listJournals();
  const recoverable: RestoreJournal[] = [];
  for (const journal of journals) {
    if (journal.state !== 'applying') continue;
    const updated = { ...journal, state: 'uncertain' as const, browserRestartRecovered: true, updatedAt: Date.now() };
    await repo.putJournal(updated);
    const plan = await repo.getPlan(journal.planId);
    if (plan && plan.state === 'applying') await repo.putPlan({ ...plan, state: 'uncertain', updatedAt: Date.now() });
    recoverable.push(updated);
  }
  return recoverable;
};

export const getRestorePlan = async (planId: string, repository?: SnapshotRepository): Promise<RestorePlan | null> =>
  (repository || getSnapshotRepository()).getPlan(planId);
