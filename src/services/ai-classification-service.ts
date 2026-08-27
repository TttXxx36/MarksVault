import { browser } from 'wxt/browser';
import {
  AiAssignment,
  AiBookmarkInput,
  AiClassificationJob,
  AiClassificationPlan,
  AiClassificationResponse,
  AiProviderConfig,
} from '../types/ai';
import { AI_PROMPT_CONTRACT_VERSION, classifyBookmarks, getAiProviderConfig, AiClassificationOptions } from './ai-service';
import { createBookmarkSnapshot, getSnapshotRepository } from './bookmark-snapshot-service';

type NativeBookmarkNode = {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  index?: number;
  type?: 'bookmark' | 'folder' | 'separator';
  unmodifiable?: string;
  children?: NativeBookmarkNode[];
};

export const PLAN_KEY = 'ai_last_classification_plan';
export const JOB_KEY = 'ai_classification_job';

let activeAiRun: Promise<AiClassificationJob> | null = null;
let activeAiController: AbortController | null = null;
let activeAiCancelRequested = false;

const createId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'ai-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
};

const getNodeType = (node: NativeBookmarkNode): 'bookmark' | 'folder' | 'separator' => {
  if (node.type === 'bookmark' || node.type === 'folder' || node.type === 'separator') return node.type;
  if (node.url) return 'bookmark';
  return Array.isArray(node.children) ? 'folder' : 'separator';
};

const isFolder = (node: NativeBookmarkNode): boolean => getNodeType(node) === 'folder';

const collectLeaves = (nodes: NativeBookmarkNode[], parentPath = ''): AiBookmarkInput[] => {
  const result: AiBookmarkInput[] = [];
  for (const node of nodes) {
    const currentPath = parentPath ? parentPath + ' / ' + node.title : node.title;
    if (getNodeType(node) === 'bookmark' && node.url) {
      result.push({
        id: node.id,
        title: node.title,
        url: node.url,
        path: parentPath,
        parentId: node.parentId,
        index: node.index,
      });
    }
    if (node.children?.length) result.push(...collectLeaves(node.children, currentPath));
  }
  return result;
};

const getToolbarRoot = (tree: NativeBookmarkNode[]): NativeBookmarkNode => {
  const rootChildren = tree[0]?.children || [];
  return rootChildren.find(node => node.id === '1' || node.id.toLowerCase().startsWith('toolbar') || /书签栏|書籤列|bookmarks? (bar|toolbar)/i.test(node.title))
    || rootChildren.find(node => isFolder(node))
    || rootChildren[0]
    || tree[0];
};

const getCategoryFolder = async (rootId: string, name: string): Promise<{ id: string; created: boolean }> => {
  const children = await browser.bookmarks.getChildren(rootId) as NativeBookmarkNode[];
  const existing = children.find(node => isFolder(node) && node.title.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase());
  if (existing) return { id: existing.id, created: false };
  const created = await browser.bookmarks.create({ parentId: rootId, title: name }) as NativeBookmarkNode;
  return { id: created.id, created: true };
};

export async function collectAiBookmarks(): Promise<AiBookmarkInput[]> {
  const tree = await browser.bookmarks.getTree() as NativeBookmarkNode[];
  return collectLeaves(tree);
}

const getBatchId = (offset: number, batch: AiBookmarkInput[]): string => {
  const first = batch[0]?.id || 'empty';
  const last = batch[batch.length - 1]?.id || 'empty';
  return `${offset}:${batch.length}:${first}:${last}`;
};

const getInputHash = (batch: AiBookmarkInput[]): string => {
  let hash = 2166136261;
  for (const character of batch.map(item => item.id).join('\u0000')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const createPendingBatches = (bookmarks: AiBookmarkInput[], batchSize: number) => {
  const batches = [];
  for (let offset = 0; offset < bookmarks.length; offset += batchSize) {
    const batch = bookmarks.slice(offset, offset + batchSize);
    batches.push({
      batchId: getBatchId(offset, batch),
      bookmarkIds: batch.map(item => item.id),
      inputHash: getInputHash(batch),
      state: 'pending' as const,
      attempts: 0,
      splitDepth: 0,
    });
  }
  return batches;
};

const activeJobStates = new Set(['queued', 'classifying', 'paused', 'failed']);

/**
 * A one-shot alarm keeps a long classification job resumable when an MV3
 * worker is reclaimed while an AI request is in flight. The alarm is renewed
 * at every checkpoint and by the alarm handler itself; it is never used to
 * write bookmarks without an explicit preview confirmation.
 */
export const AI_CLASSIFICATION_ALARM_PREFIX = 'marksvault-ai-';
export const AI_CLASSIFICATION_ALARM_DELAY_MS = 30_000;

type AiAlarmApi = {
  create?: (name: string, details: { when: number }) => Promise<void> | void;
  get?: (name: string) => Promise<unknown>;
  clear?: (name: string) => Promise<boolean> | boolean;
};

const getAiAlarmApi = (): AiAlarmApi | undefined => (
  (browser as unknown as { alarms?: AiAlarmApi }).alarms
);

const getAiAlarmName = (jobId: string): string => `${AI_CLASSIFICATION_ALARM_PREFIX}${jobId}`;

const isAlarmManagedJob = (job: Pick<AiClassificationJob, 'state'>): boolean => (
  job.state === 'queued' || job.state === 'classifying'
);

const getExistingAiAlarm = async (jobId: string): Promise<boolean | null> => {
  const alarmsApi = getAiAlarmApi();
  if (!alarmsApi?.get) return null;
  try {
    return Boolean(await alarmsApi.get(getAiAlarmName(jobId)));
  } catch (error) {
    // A failed read should not prevent a best-effort recreation. Returning
    // null lets the caller call create() without treating the alarm as known
    // to exist.
    console.warn('[AI classification alarm] 读取闹钟状态失败，将尝试恢复:', error);
    return null;
  }
};

/** Ensure an active AI job has a one-shot wake-up alarm. */
export async function ensureAiClassificationAlarm(
  job: Pick<AiClassificationJob, 'id' | 'state'>,
): Promise<boolean> {
  if (!isAlarmManagedJob(job)) return false;
  const alarmsApi = getAiAlarmApi();
  if (!alarmsApi?.create) return false;

  const alarmName = getAiAlarmName(job.id);
  const existing = await getExistingAiAlarm(job.id);
  if (existing === true) return true;

  try {
    await alarmsApi.create(alarmName, { when: Date.now() + AI_CLASSIFICATION_ALARM_DELAY_MS });
    return true;
  } catch (error) {
    console.error('[AI classification alarm] 创建/恢复闹钟失败:', error);
    return false;
  }
}

/** Remove a terminal job's watchdog alarm without failing the job cleanup. */
export async function clearAiClassificationAlarm(jobId: string): Promise<boolean> {
  const alarmsApi = getAiAlarmApi();
  if (!alarmsApi?.clear) return false;
  try {
    return Boolean(await alarmsApi.clear(getAiAlarmName(jobId)));
  } catch (error) {
    console.warn('[AI classification alarm] 清理闹钟失败:', error);
    return false;
  }
}

export async function createAiClassificationJob(configInput?: AiProviderConfig): Promise<AiClassificationJob> {
  const config = configInput || await getAiProviderConfig();
  const bookmarks = await collectAiBookmarks();
  const bookmarkIds = bookmarks.map(item => item.id);
  const storedJob = await getAiClassificationJob();
  const canReuse = Boolean(
    storedJob
    && activeJobStates.has(storedJob.state)
    && storedJob.endpoint === config.endpoint
    && storedJob.model === config.model
    && storedJob.bookmarkIds.length === bookmarkIds.length
    && storedJob.bookmarkIds.every((id, index) => id === bookmarkIds[index]),
  );
  if (canReuse && storedJob) {
    // A worker can be re-created after the previous one had already persisted
    // the job but before its alarm was created. Repair that gap before handing
    // the existing job back to the caller.
    await ensureAiClassificationAlarm(storedJob);
    return storedJob;
  }
  const job: AiClassificationJob = {
    schemaVersion: 1,
    promptContractVersion: AI_PROMPT_CONTRACT_VERSION,
    id: createId(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    endpoint: config.endpoint,
    model: config.model,
    bookmarkIds,
    bookmarks,
    batches: createPendingBatches(bookmarks, config.batchSize),
    categories: [],
    assignments: [],
    state: 'queued',
    resumeAvailable: false,
  };
  await saveAiClassificationJob(job);
  await ensureAiClassificationAlarm(job);
  return job;
}

const buildPlanFromJob = async (job: AiClassificationJob): Promise<AiClassificationPlan> => {
  const assignedIds = new Set(job.assignments.map(item => item.bookmarkId));
  const snapshot = job.bookmarks.map(item => ({ id: item.id, parentId: item.parentId, index: item.index }));
  const plan: AiClassificationPlan = {
    id: createId(),
    createdAt: Date.now(),
    categories: job.categories,
    assignments: job.assignments,
    snapshot,
    skippedBookmarkIds: [],
    unassignedBookmarkIds: job.bookmarks.filter(item => !assignedIds.has(item.id)).map(item => item.id),
    appliedBookmarkIds: [],
    appliedDestinationByBookmarkId: {},
    createdFolderIds: [],
    state: 'preview',
  };
  await browser.storage.local.set({ [PLAN_KEY]: plan });
  return plan;
};

export async function runAiClassificationJob(jobInput?: AiClassificationJob): Promise<AiClassificationJob> {
  if (activeAiRun) return activeAiRun;
  activeAiRun = (async () => {
    try {
      const initialJob = jobInput || await getAiClassificationJob();
      if (!initialJob) throw new Error('没有可执行的 AI 分类任务');
      if (activeAiCancelRequested || initialJob.cancelRequested || initialJob.state === 'cancelled') return initialJob;
      if (!await ensureAiClassificationAlarm(initialJob)) {
        throw new Error('后台闹钟不可用，无法保证 AI 分类任务可恢复');
      }
      let job: AiClassificationJob = initialJob;
      const config = await getAiProviderConfig();
      if (config.endpoint !== job.endpoint || config.model !== job.model) {
        throw new Error('AI 配置已变化，请重新生成分类任务');
      }
      activeAiController = new AbortController();
      job = { ...job, state: 'classifying', cancelRequested: false, resumeAvailable: false, error: undefined, errorCode: undefined, updatedAt: Date.now() };
      await saveAiClassificationJob(job);
      if (activeAiCancelRequested) throw new Error('AI 分类已取消');
      const options: AiClassificationOptions = {
      signal: activeAiController.signal,
      resume: {
        completedBatchIds: job.batches.filter(batch => batch.state === 'completed').map(batch => batch.batchId),
        completedBookmarkIds: job.batches
          .filter(batch => batch.state === 'completed')
          .flatMap(batch => batch.bookmarkIds),
        categories: job.categories,
        assignments: job.assignments,
      },
      maxBatches: 1,
      onBatchProgress: async (progress, response) => {
        const existingIndex = job.batches.findIndex(batch => batch.batchId === progress.batchId);
        const batches = [...job.batches];
        if (existingIndex >= 0) batches[existingIndex] = progress;
        else batches.push(progress);
        job = {
          ...job,
          batches,
          activeBatchId: progress.state === 'running' ? progress.batchId : job.activeBatchId,
          categories: response ? mergeCategories(job.categories, response) : job.categories,
          assignments: response ? mergeAssignments(job.assignments, response.assignments) : job.assignments,
          cancelRequested: activeAiCancelRequested || job.cancelRequested,
          updatedAt: Date.now(),
        };
        await saveAiClassificationJob(job);
        // Renew the one-shot watchdog at every persisted checkpoint. If the
        // worker is reclaimed before the next network response, the alarm can
        // wake a fresh worker and continue from the completed-batch set.
        if (progress.state === 'running' || progress.state === 'completed') {
          if (!await ensureAiClassificationAlarm(job)) {
            throw new Error('后台闹钟不可用，无法继续 AI 分类任务');
          }
        }
      },
      };
      try {
      const result = await classifyBookmarks(config, job.bookmarks, options);
      if (activeAiCancelRequested || job.cancelRequested) throw new Error('AI 分类已取消');
      const completedIds = new Set(job.batches
        .filter(batch => batch.state === 'completed')
        .flatMap(batch => batch.bookmarkIds));
      const allBatchesCompleted = job.bookmarkIds.every(id => completedIds.has(id));
      if (!allBatchesCompleted) {
        job = {
          ...job,
          state: 'queued',
          categories: result.categories,
          assignments: result.assignments,
          resumeAvailable: true,
          updatedAt: Date.now(),
        };
        await saveAiClassificationJob(job);
        if (!await ensureAiClassificationAlarm(job)) {
          throw new Error('后台闹钟不可用，无法继续 AI 分类任务');
        }
        return job;
      }
      job = {
        ...job,
        state: 'awaiting_review',
        activeBatchId: undefined,
        categories: result.categories,
        assignments: result.assignments,
        updatedAt: Date.now(),
        resumeAvailable: false,
        error: undefined,
        errorCode: undefined,
      };
      await saveAiClassificationJob(job);
      await clearAiClassificationAlarm(job.id);
      await buildPlanFromJob(job);
      return job;
      } catch (error) {
      const cancelled = activeAiController?.signal.aborted || (error instanceof Error && error.message.includes('取消'));
      job = {
        ...job,
        state: cancelled ? 'cancelled' : 'failed',
        resumeAvailable: !cancelled,
        updatedAt: Date.now(),
        error: error instanceof Error ? error.message : 'AI 分类任务失败',
        errorCode: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : undefined,
      };
      await saveAiClassificationJob(job);
      await clearAiClassificationAlarm(job.id);
        throw error;
      }
    } finally {
      activeAiController = null;
      activeAiRun = null;
      activeAiCancelRequested = false;
    }
  })();
  return activeAiRun;
}

export async function startAiClassificationJob(configInput?: AiProviderConfig): Promise<AiClassificationJob> {
  const existingJob = await createAiClassificationJob(configInput);
  // START is an explicit user action. Preserve completed checkpoints when a
  // previous attempt failed, but put that job back into the queued state before
  // arming the watchdog. Paused jobs remain user-controlled and must use the
  // dedicated RESUME command instead.
  const job = existingJob.state === 'failed'
    ? {
        ...existingJob,
        state: 'queued' as const,
        resumeAvailable: true,
        cancelRequested: false,
        error: undefined,
        errorCode: undefined,
        updatedAt: Date.now(),
      }
    : existingJob;
  if (job !== existingJob) await saveAiClassificationJob(job);
  if (!await ensureAiClassificationAlarm(job)) {
    const paused: AiClassificationJob = {
      ...job,
      state: 'paused',
      resumeAvailable: true,
      updatedAt: Date.now(),
      error: '后台闹钟不可用，任务已暂停，请检查扩展权限后重试',
      errorCode: 'ALARM_UNAVAILABLE',
    };
    await saveAiClassificationJob(paused);
    throw new Error(paused.error);
  }
  void runAiClassificationJob(job).catch(() => undefined);
  return job;
}

export async function resumeAiClassificationJob(): Promise<AiClassificationJob> {
  const job = await getAiClassificationJob();
  if (!job) throw new Error('没有可恢复的 AI 分类任务');
  if (!activeJobStates.has(job.state) && job.state !== 'cancelled') throw new Error('当前 AI 分类任务不可恢复');
  const queued = { ...job, state: 'queued' as const, resumeAvailable: true, cancelRequested: false, updatedAt: Date.now() };
  await saveAiClassificationJob(queued);
  if (!await ensureAiClassificationAlarm(queued)) {
    throw new Error('后台闹钟不可用，无法恢复 AI 分类任务');
  }
  void runAiClassificationJob(queued).catch(() => undefined);
  return queued;
}

export async function cancelAiClassificationJob(): Promise<AiClassificationJob | null> {
  const job = await getAiClassificationJob();
  if (!job) return null;
  if (activeAiRun) {
    activeAiCancelRequested = true;
    if (activeAiController) activeAiController.abort();
    const requested = { ...job, cancelRequested: true, updatedAt: Date.now() };
    await saveAiClassificationJob(requested);
    return requested;
  }
  const cancelled = { ...job, state: 'cancelled' as const, cancelRequested: true, resumeAvailable: true, updatedAt: Date.now() };
  await saveAiClassificationJob(cancelled);
  await clearAiClassificationAlarm(cancelled.id);
  return cancelled;
}

export async function markAiClassificationRecoverable(): Promise<AiClassificationJob | null> {
  const job = await getAiClassificationJob();
  // Both an in-flight request and a queued-but-not-started request must stop
  // after a browser restart. The former may have an unknown network outcome;
  // the latter must not silently start sending data in the background.
  if (!job || (job.state !== 'classifying' && job.state !== 'queued')) return job;
  const paused: AiClassificationJob = {
    ...job,
    state: 'paused',
    resumeAvailable: true,
    updatedAt: Date.now(),
    error: '后台服务已重新初始化，任务可以继续',
  };
  await saveAiClassificationJob(paused);
  await clearAiClassificationAlarm(paused.id);
  return paused;
}

/**
 * Reconcile a persisted job when a new Service Worker instance starts.
 *
 * A queued job always gets its alarm repaired. A classifying job is kept
 * running only when its watchdog alarm still exists (typically an alarm wake
 * event); if the alarm is missing, the in-flight request cannot be trusted
 * after worker reclamation, so the job becomes explicitly resumable instead
 * of being retried silently.
 */
export async function recoverAiClassificationOnWorkerStart(): Promise<AiClassificationJob | null> {
  const job = await getAiClassificationJob();
  if (!job) return null;

  if (job.state === 'queued') {
    await ensureAiClassificationAlarm(job);
    return job;
  }

  if (job.state !== 'classifying') return job;

  const alarmPresence = await getExistingAiAlarm(job.id);
  if (alarmPresence === true) return job;

  return markAiClassificationRecoverable();
}

export async function createAiClassificationPlan(configInput?: AiProviderConfig): Promise<AiClassificationPlan> {
  const job = await createAiClassificationJob(configInput);
  await runAiClassificationJob(job);
  const plan = await getLastAiClassificationPlan();
  if (!plan) throw new Error('AI 分类预览未生成');
  return plan;
}

export async function applyAiClassificationPlan(plan: AiClassificationPlan, options?: { snapshotName?: string; userName?: string }): Promise<AiClassificationPlan> {
  if (plan.state !== 'preview') throw new Error('该分类计划已经执行或撤销');
  const tree = await browser.bookmarks.getTree() as NativeBookmarkNode[];
  const root = getToolbarRoot(tree);
  if (!root?.id) throw new Error('找不到可写入的书签栏');

  // 写入前重新检查节点位置和可修改性，防止预览期间的人工改动被覆盖。
  const snapshotById = new Map(plan.snapshot.map(item => [item.id, item]));
  for (const assignment of plan.assignments) {
    const current = await browser.bookmarks.get(assignment.bookmarkId) as NativeBookmarkNode[];
    const node = current[0];
    const original = snapshotById.get(assignment.bookmarkId);
    if (!node?.url) continue;
    if (node.unmodifiable) throw new Error('书签包含不可修改节点，请重新生成预览');
    if (original && (node.parentId !== original.parentId || node.index !== original.index)) {
      throw new Error('预览期间书签位置已变化，请重新生成分类预览');
    }
  }

  // SNAP-002 safety gate: capture and validate the complete bookmark tree
  // before changing state to applying or calling any write API. A snapshot
  // failure aborts this function and therefore makes zero bookmark writes.
  const beforeSnapshot = await createBookmarkSnapshot({
    source: 'ai-classification-before',
    name: options?.snapshotName,
    planId: plan.id,
    userName: options?.userName,
    affectedBookmarkIds: plan.assignments.map(assignment => assignment.bookmarkId),
    isAutomatic: true,
    isProtected: false,
  });

  let applied: AiClassificationPlan = {
    ...plan,
    preSnapshotId: beforeSnapshot.snapshotId,
    state: 'applying',
    appliedBookmarkIds: [],
    appliedDestinationByBookmarkId: {},
    createdFolderIds: [],
  };
  // 先落盘状态，再执行任何创建/移动；Service Worker 中断后仍可继续撤销。
  await browser.storage.local.set({ [PLAN_KEY]: applied });

  const folderMap = new Map<string, string>();
  try {
    for (const category of plan.categories) {
      const folder = await getCategoryFolder(root.id, category.name);
      folderMap.set(category.name.toLocaleLowerCase(), folder.id);
      if (folder.created) {
        applied = { ...applied, createdFolderIds: [...applied.createdFolderIds, folder.id] };
        await browser.storage.local.set({ [PLAN_KEY]: applied });
      }
    }

    for (const assignment of plan.assignments) {
      const targetId = folderMap.get(assignment.categoryName.toLocaleLowerCase());
      if (!targetId) continue;
      const current = await browser.bookmarks.get(assignment.bookmarkId) as NativeBookmarkNode[];
      const node = current[0];
      if (!node?.url) continue;
      const nextDestinations = {
        ...applied.appliedDestinationByBookmarkId,
        [node.id]: targetId,
      };
      if (node.parentId === targetId) {
        applied = { ...applied, appliedDestinationByBookmarkId: nextDestinations };
        await browser.storage.local.set({ [PLAN_KEY]: applied });
        continue;
      }
      await browser.bookmarks.move(node.id, { parentId: targetId });
      applied = {
        ...applied,
        appliedBookmarkIds: [...applied.appliedBookmarkIds, node.id],
        appliedDestinationByBookmarkId: nextDestinations,
      };
      await browser.storage.local.set({ [PLAN_KEY]: applied });
    }
  } catch (error) {
    try {
      await rollbackAiClassificationPlan(applied);
    } catch {
      // 保留原始错误；最近计划仍会留在 local storage 中供手动恢复。
    }
    throw new Error('AI 分类执行失败，已尝试自动回滚');
  }
  applied = { ...applied, state: 'applied' };
  await browser.storage.local.set({ [PLAN_KEY]: applied });
  return applied;
}

export async function rollbackAiClassificationPlan(planInput?: AiClassificationPlan): Promise<AiClassificationPlan> {
  const plan = planInput || await getLastAiClassificationPlan();
  if (!plan) throw new Error('没有可撤销的 AI 分类操作');
  const snapshot = [...plan.snapshot].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  for (const item of snapshot) {
    if (!item.parentId) continue;
    try {
      const current = await browser.bookmarks.get(item.id) as NativeBookmarkNode[];
      if (!current[0] || current[0].parentId === item.parentId) continue;
      const expectedParent = plan.appliedDestinationByBookmarkId?.[item.id];
      // 只有本次操作记录过目标位置的节点才允许回滚；尚未处理的节点可能已被用户手动移动。
      if (!expectedParent) continue;
      // 用户在分类完成后手动移动过的书签不强行覆盖，避免撤销操作吞掉后续修改。
      if (current[0].parentId !== expectedParent) continue;
      await browser.bookmarks.move(item.id, { parentId: item.parentId, index: item.index });
    } catch {
      // 继续处理其他节点，最终状态仍保存在计划中。
    }
  }
  for (const folderId of plan.createdFolderIds || []) {
    try {
      const children = await browser.bookmarks.getChildren(folderId) as NativeBookmarkNode[];
      if (children.length === 0) await browser.bookmarks.remove(folderId);
    } catch {
      // 用户可能已经手动删除或修改该文件夹。
    }
  }
  const rolledBack: AiClassificationPlan = { ...plan, state: 'rolled_back' };
  await browser.storage.local.set({ [PLAN_KEY]: rolledBack });
  return rolledBack;
}

export async function getLastAiClassificationPlan(): Promise<AiClassificationPlan | null> {
  const data = await browser.storage.local.get(PLAN_KEY) as Record<string, unknown>;
  const plan = data[PLAN_KEY];
  return plan && typeof plan === 'object' ? plan as AiClassificationPlan : null;
}

const mergeCategories = (
  existing: AiClassificationJob['categories'],
  response: AiClassificationResponse,
): AiClassificationJob['categories'] => {
  const byName = new Map(existing.map(category => [category.name.toLocaleLowerCase(), category]));
  for (const category of response.categories) {
    if (!byName.has(category.name.toLocaleLowerCase())) byName.set(category.name.toLocaleLowerCase(), category);
  }
  return Array.from(byName.values());
};

const mergeAssignments = (existing: AiAssignment[], next: AiAssignment[]): AiAssignment[] => {
  const byId = new Map(existing.map(assignment => [assignment.bookmarkId, assignment]));
  for (const assignment of next) {
    if (!byId.has(assignment.bookmarkId)) byId.set(assignment.bookmarkId, assignment);
  }
  return Array.from(byId.values());
};

export async function getAiClassificationJob(): Promise<AiClassificationJob | null> {
  const repository = getSnapshotRepository();
  let job: unknown = null;
  // In production, large task checkpoints live in IndexedDB. Jest and older
  // migration contexts without IndexedDB keep the v2.0.1 local fallback.
  if (globalThis.indexedDB && repository.getAiClassificationJob) {
    job = await repository.getAiClassificationJob();
  }
  if (!job) {
    const data = await browser.storage.local.get(JOB_KEY) as Record<string, unknown>;
    job = data[JOB_KEY];
    if (job && globalThis.indexedDB && repository.putAiClassificationJob) {
      await repository.putAiClassificationJob(job as AiClassificationJob);
      await browser.storage.local.remove(JOB_KEY);
    }
  }
  if (!job || typeof job !== 'object') return null;
  const raw = job as Partial<AiClassificationJob>;
  return {
    ...(raw as AiClassificationJob),
    schemaVersion: 1,
    promptContractVersion: AI_PROMPT_CONTRACT_VERSION,
    bookmarks: Array.isArray(raw.bookmarks) ? raw.bookmarks : [],
    bookmarkIds: Array.isArray(raw.bookmarkIds) ? raw.bookmarkIds : [],
    batches: Array.isArray(raw.batches) ? raw.batches : [],
    categories: Array.isArray(raw.categories) ? raw.categories : [],
    assignments: Array.isArray(raw.assignments) ? raw.assignments : [],
    state: raw.state || 'paused',
    resumeAvailable: raw.resumeAvailable ?? false,
  };
}

export async function saveAiClassificationJob(job: AiClassificationJob): Promise<void> {
  const repository = getSnapshotRepository();
  if (globalThis.indexedDB && repository.putAiClassificationJob) {
    await repository.putAiClassificationJob(job);
    await browser.storage.local.remove(JOB_KEY);
    return;
  }
  await browser.storage.local.set({ [JOB_KEY]: job });
}
