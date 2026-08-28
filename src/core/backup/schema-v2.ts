import type { BookmarkRootRole, BookmarkSnapshotNode, BookmarkSnapshotRoot } from '../../types/snapshot';
import type { BookmarkBackupV2, BookmarkNodeV2 } from '../../types/backup';
import type { BookmarkItem } from '../../utils/bookmark-service';

export const BOOKMARK_BACKUP_SCHEMA_VERSION = 2 as const;
export const MAX_BACKUP_NODE_COUNT = 20_000;
export const MAX_BACKUP_DEPTH = 100;
export const MAX_BACKUP_STRING_LENGTH = 10_000;
export const MAX_BACKUP_URL_LENGTH = 8_192;

export interface BackupValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  nodeCount: number;
  maxDepth: number;
  bookmarks: number;
  folders: number;
  separators: number;
}

const SAFE_PROTOCOLS = new Set([
  'http:', 'https:', 'ftp:', 'file:', 'chrome:', 'chrome-extension:', 'moz-extension:', 'about:',
]);

const nodeType = (item: BookmarkItem): BookmarkNodeV2['type'] => {
  if (item.type === 'bookmark' || item.type === 'folder' || item.type === 'separator') return item.type;
  if (item.url) return 'bookmark';
  // Legacy v1 callers may provide a shallow folder with `isFolder: true` but
  // without a children array. Preserve that explicit semantic flag instead of
  // turning it into a separator merely because the node was not expanded.
  if (item.isFolder) return 'folder';
  return item.children ? 'folder' : 'separator';
};

export const inferBackupRootRole = (item: Pick<BookmarkItem, 'id' | 'title'>): BookmarkRootRole => {
  const id = item.id.toLowerCase();
  const title = item.title.trim().toLocaleLowerCase();
  if (id === '1' || id.startsWith('toolbar') || /bookmark(s)? toolbar|bookmark(s)? bar|书签栏|書籤列/.test(title)) return 'toolbar';
  if (id.startsWith('menu') || /bookmark(s)? menu|书签菜单|書籤選單/.test(title)) return 'menu';
  if (id.startsWith('mobile') || /mobile bookmark|移动书签|行動書籤/.test(title)) return 'mobile';
  if (id.startsWith('unfiled') || /other bookmark|unfiled|其他书签|其他書籤/.test(title)) return 'other';
  if (id.startsWith('managed') || /managed|受管理/.test(title)) return 'managed';
  return 'unknown';
};

const sourceValue = (): BookmarkBackupV2['source'] => ({
  extensionVersion: '2.1.1',
  browser: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
  manifestVersion: 3,
  platform: typeof navigator === 'undefined' ? undefined : navigator.platform,
});

const toV2Node = (item: BookmarkItem, parentPath: string, isRoot = false): BookmarkNodeV2 => {
  const type = nodeType(item);
  const title = typeof item.title === 'string' ? item.title : '';
  const root: BookmarkNodeV2 = {
    id: item.id,
    ...(!isRoot && item.parentId ? { parentId: item.parentId } : {}),
    title,
    type,
    ...(type === 'bookmark' && item.url ? { url: item.url } : {}),
    ...(typeof item.dateAdded === 'number' ? { dateAdded: item.dateAdded } : {}),
    ...(typeof item.index === 'number' ? { index: item.index } : {}),
    path: parentPath,
    ...(item.unmodifiable ? { unmodifiable: item.unmodifiable } : {}),
  };
  if (type !== 'folder' || !Array.isArray(item.children) || item.children.length === 0) return root;
  root.children = [];
  const stack = [{ source: item, target: root, path: parentPath }];
  while (stack.length) {
    const current = stack.pop()!;
    const currentTitle = typeof current.source.title === 'string' ? current.source.title : '';
    const nextPath = current.path ? `${current.path} / ${currentTitle}` : currentTitle;
    const children = current.source.children || [];
    for (const child of children) {
      const childType = nodeType(child);
      const childNode: BookmarkNodeV2 = {
        id: child.id,
        ...(child.parentId ? { parentId: child.parentId } : {}),
        title: typeof child.title === 'string' ? child.title : '',
        type: childType,
        ...(childType === 'bookmark' && child.url ? { url: child.url } : {}),
        ...(typeof child.dateAdded === 'number' ? { dateAdded: child.dateAdded } : {}),
        ...(typeof child.index === 'number' ? { index: child.index } : {}),
        path: nextPath,
        ...(child.unmodifiable ? { unmodifiable: child.unmodifiable } : {}),
      };
      if (childType === 'folder' && Array.isArray(child.children) && child.children.length > 0) {
        childNode.children = [];
      }
      current.target.children!.push(childNode);
      if (childType === 'folder' && childNode.children) stack.push({ source: child, target: childNode, path: nextPath });
    }
  }
  return root;
};

const walk = (roots: BookmarkBackupV2['roots']): { bookmarks: number; folders: number; separators: number; nodeCount: number; maxDepth: number } => {
  const stack = roots.flatMap(root => root.children.map(node => ({ node, depth: 0 })));
  let bookmarks = 0;
  let folders = 0;
  let separators = 0;
  let nodeCount = 0;
  let maxDepth = 0;
  while (stack.length) {
    const current = stack.pop()!;
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, current.depth);
    if (current.node.type === 'bookmark') bookmarks += 1;
    else if (current.node.type === 'folder') {
      folders += 1;
      for (const child of current.node.children || []) stack.push({ node: child, depth: current.depth + 1 });
    } else separators += 1;
  }
  return { bookmarks, folders, separators, nodeCount, maxDepth };
};

export const createBookmarkBackupV2 = (items: BookmarkItem[], createdAt = new Date()): BookmarkBackupV2 => {
  // getTree() exposes a synthetic id=0 container on Chromium and Firefox;
  // semantic backup roots are its children, never the synthetic container.
  const isSyntheticRoot = (item: BookmarkItem): boolean =>
    item.id === '0' || item.id.toLowerCase() === 'root________' || /^root_+$/.test(item.id.toLowerCase());
  const rootItems = items.length === 1 && isSyntheticRoot(items[0]) && Array.isArray(items[0].children)
    ? items[0].children
    : items;
  const roots = rootItems.map(item => ({
    role: inferBackupRootRole(item),
    originalTitle: item.title || '',
    nativeId: item.id,
    children: [toV2Node(item, '', true)],
  }));
  const stats = walk(roots);
  return {
    schemaVersion: BOOKMARK_BACKUP_SCHEMA_VERSION,
    app: 'MarksVault',
    createdAt: createdAt.toISOString(),
    source: sourceValue(),
    roots,
    stats,
    timestamp: createdAt.getTime(),
  };
};

const isSafeUrl = (url: string): boolean => {
  try { return SAFE_PROTOCOLS.has(new URL(url).protocol.toLowerCase()); } catch { return false; }
};

export const validateBookmarkBackupV2 = (candidate: unknown): BackupValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];
  let nodeCount = 0;
  let maxDepth = 0;
  let bookmarks = 0;
  let folders = 0;
  let separators = 0;
  const ids = new Set<string>();
  if (!candidate || typeof candidate !== 'object') return { valid: false, errors: ['备份必须是 JSON 对象'], warnings, nodeCount, maxDepth, bookmarks, folders, separators };
  const backup = candidate as Partial<BookmarkBackupV2>;
  if (backup.schemaVersion !== 2) errors.push('不支持的书签备份 schema 版本');
  if (backup.app !== 'MarksVault') errors.push('备份 app 标识无效');
  if (typeof backup.createdAt !== 'string' || Number.isNaN(Date.parse(backup.createdAt))) errors.push('createdAt 无效');
  if (!backup.source || typeof backup.source !== 'object') errors.push('备份 source 无效');
  if (!Array.isArray(backup.roots)) errors.push('备份 roots 无效');
  const roots = Array.isArray(backup.roots) ? backup.roots : [];
  const stack = roots.flatMap((root, rootIndex) => {
    if (!root || typeof root !== 'object') { errors.push(`根目录 ${rootIndex} 无效`); return []; }
    if (!['toolbar', 'menu', 'other', 'mobile', 'managed', 'unknown'].includes(root.role)) errors.push(`根目录 ${rootIndex} 语义角色无效`);
    if (typeof root.originalTitle !== 'string' || root.originalTitle.length > MAX_BACKUP_STRING_LENGTH) errors.push(`根目录 ${rootIndex} 标题无效`);
    if (typeof root.nativeId !== 'string' || root.nativeId.length === 0 || root.nativeId.length > MAX_BACKUP_STRING_LENGTH) errors.push(`根目录 ${rootIndex} nativeId 无效`);
    if (!Array.isArray(root.children)) { errors.push(`根目录 ${rootIndex} children 无效`); return []; }
    return root.children.map(node => ({ node, depth: 0, path: `root:${rootIndex}` }));
  });
  while (stack.length) {
    const current = stack.pop()!;
    const node = current.node;
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, current.depth);
    if (nodeCount > MAX_BACKUP_NODE_COUNT) { errors.push(`节点数量超过上限 ${MAX_BACKUP_NODE_COUNT}`); break; }
    if (!node || typeof node !== 'object' || typeof node.id !== 'string' || node.id.length === 0 || typeof node.title !== 'string') { errors.push('节点字段无效'); continue; }
    if (ids.has(node.id)) errors.push(`节点 ID 重复: ${node.id}`);
    ids.add(node.id);
    if (node.title.length > MAX_BACKUP_STRING_LENGTH || typeof node.path !== 'string' || node.path.length > MAX_BACKUP_STRING_LENGTH) errors.push(`节点文本或路径无效: ${node.id}`);
    if (!['bookmark', 'folder', 'separator'].includes(node.type)) errors.push(`节点类型无效: ${node.id}`);
    if (node.type === 'bookmark') {
      bookmarks += 1;
      if (typeof node.url !== 'string' || node.url.length > MAX_BACKUP_URL_LENGTH || !isSafeUrl(node.url)) errors.push(`节点 URL 协议或长度不安全: ${node.id}`);
    } else if (node.type === 'folder') {
      folders += 1;
      if (node.url !== undefined) errors.push(`文件夹不应包含 URL: ${node.id}`);
      if (node.children !== undefined && !Array.isArray(node.children)) errors.push(`文件夹 children 无效: ${node.id}`);
      for (const child of node.children || []) stack.push({ node: child, depth: current.depth + 1, path: node.path });
    } else {
      separators += 1;
      if (node.url !== undefined || node.children !== undefined) errors.push(`分隔线字段无效: ${node.id}`);
    }
    if (typeof node.path !== 'string') errors.push(`节点路径无效: ${node.id}`);
    if (current.depth > MAX_BACKUP_DEPTH) errors.push(`最大深度超过上限 ${MAX_BACKUP_DEPTH}`);
  }
  const stats = backup.stats;
  if (!stats || stats.bookmarks !== bookmarks || stats.folders !== folders || stats.separators !== separators || stats.maxDepth !== maxDepth) errors.push('备份统计信息校验失败');
  return { valid: errors.length === 0, errors, warnings, nodeCount, maxDepth, bookmarks, folders, separators };
};

export const flattenV2Nodes = (backup: BookmarkBackupV2): BookmarkNodeV2[] => {
  const result: BookmarkNodeV2[] = [];
  const stack = backup.roots.flatMap(root => [...root.children].reverse());
  while (stack.length) {
    const node = stack.pop()!;
    result.push(node);
    if (node.type === 'folder') for (const child of [...(node.children || [])].reverse()) stack.push(child);
  }
  return result;
};

export interface BackupV2SnapshotTree {
  nodes: BookmarkSnapshotNode[];
  roots: BookmarkSnapshotRoot[];
}

/** Convert a validated v2 tree to the local flat snapshot representation. */
export const backupV2ToSnapshotTree = (backup: BookmarkBackupV2): BackupV2SnapshotTree => {
  const nodes: BookmarkSnapshotNode[] = [];
  const roots: BookmarkSnapshotRoot[] = [];
  for (const root of backup.roots) {
    const rootNodeIds: string[] = [];
    const stack = root.children.map(node => ({ node, parentId: undefined as string | undefined, path: '', depth: 0 }));
    while (stack.length) {
      const current = stack.pop()!;
      const node = current.node;
      rootNodeIds.push(node.id);
      const snapshotNode: BookmarkSnapshotNode = {
        id: node.id,
        ...(node.parentId || current.parentId ? { parentId: node.parentId || current.parentId } : {}),
        index: node.index,
        title: node.title,
        ...(node.url ? { url: node.url } : {}),
        type: node.type,
        ...(node.unmodifiable ? { unmodifiable: node.unmodifiable } : {}),
        rootRole: root.role,
        path: node.path || current.path,
        dateAdded: node.dateAdded,
      };
      nodes.push(snapshotNode);
      if (node.type === 'folder') {
        const nextPath = snapshotNode.path ? `${snapshotNode.path} / ${node.title}` : node.title;
        for (const child of [...(node.children || [])].reverse()) {
          stack.push({ node: child, parentId: node.id, path: nextPath, depth: current.depth + 1 });
        }
      }
    }
    roots.push({
      role: root.role,
      nativeId: root.nativeId || root.children[0]?.id || `imported-${root.role}`,
      title: root.originalTitle,
      nodeIds: rootNodeIds,
    });
  }
  return { nodes, roots };
};
