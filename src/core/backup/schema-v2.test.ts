import {
  backupV2ToSnapshotTree,
  createBookmarkBackupV2,
  MAX_BACKUP_DEPTH,
  MAX_BACKUP_NODE_COUNT,
  validateBookmarkBackupV2,
} from './schema-v2';
import { migrateBookmarkBackupV1ToV2 } from './migrate-v1-to-v2';
import type { BookmarkItem } from '../../utils/bookmark-service';

describe('bookmark backup schema v2', () => {
  it.each([
    ['Chrome', '1', 'Bookmarks Bar', 'toolbar'],
    ['Edge', 'toolbar_____', 'Favorites bar', 'toolbar'],
    ['Firefox', 'toolbar_____abc', 'Bookmarks Toolbar', 'toolbar'],
  ])('%s fixture retains semantic roots and node types', (browser, id, title, role) => {
    const backup = createBookmarkBackupV2([{ id, title, isFolder: true, type: 'folder', children: [
      { id: `${browser}-bookmark`, title: 'Example', isFolder: false, type: 'bookmark', url: 'https://example.test' },
      { id: `${browser}-separator`, title: '', isFolder: false, type: 'separator' },
    ] }]);
    expect(backup.schemaVersion).toBe(2);
    expect(backup.roots[0].role).toBe(role);
    expect(backup.stats).toMatchObject({ bookmarks: 1, folders: 1, separators: 1 });
    expect(validateBookmarkBackupV2(backup).valid).toBe(true);
    const snapshot = backupV2ToSnapshotTree(backup);
    expect(snapshot.nodes.find(node => node.id === `${browser}-separator`)?.type).toBe('separator');
    expect(snapshot.roots[0].role).toBe(role);
  });

  it('migrates legacy v1 nested data without secrets or direct writes', () => {
    const migrated = migrateBookmarkBackupV1ToV2({
      version: '1.0', timestamp: 1735600000000, source: 'fixture',
      bookmarks: [{ id: 'toolbar_____', title: 'Bookmarks Toolbar', isFolder: true, children: [
        { id: 'b1', title: 'Legacy', isFolder: false, url: 'https://legacy.test' },
      ] }],
    });
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.createdAt).toBe(new Date(1735600000000).toISOString());
    expect(validateBookmarkBackupV2(migrated).valid).toBe(true);
  });

  it('keeps a legacy shallow folder as a folder when children were not loaded', () => {
    const backup = createBookmarkBackupV2([
      { id: 'toolbar', title: 'Bookmarks Bar', isFolder: true, children: [
        { id: 'shallow-folder', title: '学习', isFolder: true },
      ] },
    ]);
    expect(backup.roots[0].children[0].children?.[0]).toMatchObject({ id: 'shallow-folder', type: 'folder' });
    expect(backup.roots[0].children[0].children?.[0].children).toBeUndefined();
    expect(validateBookmarkBackupV2(backup).valid).toBe(true);
  });

  it('skips Firefox root________ synthetic container and preserves semantic children', () => {
    const backup = createBookmarkBackupV2([{
      id: 'root________', title: '', isFolder: true, type: 'folder', children: [
        { id: 'toolbar_____', title: 'Bookmarks Toolbar', isFolder: true, type: 'folder', children: [] },
      ],
    }]);
    expect(backup.roots.map(root => root.nativeId)).toEqual(['toolbar_____']);
    expect(backup.roots[0].role).toBe('toolbar');
    expect(validateBookmarkBackupV2(backup).valid).toBe(true);
  });

  it('rejects unsafe URLs, duplicate IDs, and inconsistent stats', () => {
    const backup = createBookmarkBackupV2([{ id: 'toolbar', title: 'Bookmarks Bar', isFolder: true, children: [
      { id: 'b1', title: 'Unsafe', isFolder: false, type: 'bookmark', url: 'javascript:alert(1)' },
      { id: 'b1', title: 'Duplicate', isFolder: false, type: 'bookmark', url: 'https://ok.test' },
    ] }]);
    backup.stats.bookmarks = 999;
    const result = validateBookmarkBackupV2(backup);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('URL');
    expect(result.errors.join(' ')).toContain('重复');
    expect(result.errors.join(' ')).toContain('统计');
  });

  it('rejects over-depth and over-capacity backups before restore', () => {
    let deep: BookmarkItem = { id: 'leaf', title: 'Leaf', isFolder: false, type: 'bookmark', url: 'https://deep.test' };
    for (let index = 0; index <= MAX_BACKUP_DEPTH; index += 1) {
      deep = { id: `folder-${index}`, title: `Folder ${index}`, isFolder: true, type: 'folder', children: [deep] };
    }
    const deepBackup = createBookmarkBackupV2([{ id: 'toolbar', title: 'Bookmarks Bar', isFolder: true, type: 'folder', children: [deep] }]);
    expect(validateBookmarkBackupV2(deepBackup).valid).toBe(false);

    const many = Array.from({ length: MAX_BACKUP_NODE_COUNT + 1 }, (_, index) => ({
      id: `b-${index}`, title: `Bookmark ${index}`, isFolder: false, type: 'bookmark' as const, url: `https://example.test/${index}`,
    }));
    const largeBackup = createBookmarkBackupV2([{ id: 'toolbar', title: 'Bookmarks Bar', isFolder: true, type: 'folder', children: many }]);
    const result = validateBookmarkBackupV2(largeBackup);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('节点数量超过上限');
  }, 20_000);
});

