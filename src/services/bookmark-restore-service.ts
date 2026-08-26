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

const resolveSemanticParentId = (snapshot: BookmarkSnapshot, targetParentId: string | undefined, currentNodes: RestoreBookmarkNode[]): string | undefined => {
  if (!targetParentId) return targetParentId;
  const root = snapshot.roots?.find(item => item.nativeId === targetParentId);
  if (!root) return targetParentId;
  const currentRoot = currentNodes.find(node => node.rootRole === root.role || (node.path === '' && node.title === root.title));
  return currentRoot?.id || targetParentId;
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
      items.push({
        id: snapshotNode.id,
        snapshotNode,
        kind: 'deleted',
        changes: ['deleted'],
        action: 'skip',
        reason: '快照之后节点已删除或无法安全匹配',
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
      const selected = new Set(plan.selectedItemIds);
      const items = plan.diff.items.filter(item => selected.has(item.id) && item.action === 'restore');
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
          if (!target || !item.currentNode) {
            await updateJournalItem(repository, plan, journal, item.id, { state: 'skipped', completedAt: Date.now(), error: '没有可安全匹配的节点' });
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
          const targetParentId = resolveSemanticParentId(sourceSnapshot, target.parentId, currentTreeForRoots);
          const journalUpdate: Partial<RestoreJournalItem> = {
            bookmarkId: current.id,
            beforeParentId: current.parentId,
            beforeIndex: current.index,
            beforeTitle: current.title,
            afterParentId: targetParentId,
            afterIndex: target.index,
            afterTitle: target.title,
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
      for (const item of resultJournal.items.filter(entry => entry.state === 'completed')) {
        if (!item.bookmarkId || !item.beforeParentId) continue;
        const current = await getNodeById(item.bookmarkId);
        if (!current) continue;
        // Only reverse changes whose current state still equals our recorded
        // post-restore state. A later user edit is left untouched.
        if (item.afterParentId && current.parentId !== item.afterParentId) continue;
        if (item.afterTitle && current.title !== item.afterTitle) continue;
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
