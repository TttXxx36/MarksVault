import { browser } from 'wxt/browser';
import { AiBookmarkInput, AiClassificationPlan, AiProviderConfig } from '../types/ai';
import { classifyBookmarks, getAiProviderConfig } from './ai-service';

type NativeBookmarkNode = {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  index?: number;
  unmodifiable?: string;
  children?: NativeBookmarkNode[];
};

const PLAN_KEY = 'ai_last_classification_plan';

const createId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'ai-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
};

const isFolder = (node: NativeBookmarkNode): boolean => !node.url;

const collectLeaves = (nodes: NativeBookmarkNode[], parentPath = ''): AiBookmarkInput[] => {
  const result: AiBookmarkInput[] = [];
  for (const node of nodes) {
    const currentPath = parentPath ? parentPath + ' / ' + node.title : node.title;
    if (node.url) {
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

export async function createAiClassificationPlan(configInput?: AiProviderConfig): Promise<AiClassificationPlan> {
  const config = configInput || await getAiProviderConfig();
  const bookmarks = await collectAiBookmarks();
  const result = await classifyBookmarks(config, bookmarks);
  const assignedIds = new Set(result.assignments.map(item => item.bookmarkId));
  const snapshot = bookmarks.map(item => ({ id: item.id, parentId: item.parentId, index: item.index }));
  const plan: AiClassificationPlan = {
    id: createId(),
    createdAt: Date.now(),
    categories: result.categories,
    assignments: result.assignments,
    snapshot,
    skippedBookmarkIds: [],
    unassignedBookmarkIds: bookmarks.filter(item => !assignedIds.has(item.id)).map(item => item.id),
    appliedBookmarkIds: [],
    appliedDestinationByBookmarkId: {},
    createdFolderIds: [],
    state: 'preview',
  };
  await browser.storage.local.set({ [PLAN_KEY]: plan });
  return plan;
}

export async function applyAiClassificationPlan(plan: AiClassificationPlan): Promise<AiClassificationPlan> {
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

  let applied: AiClassificationPlan = {
    ...plan,
    state: 'applied',
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
