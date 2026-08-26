import { browser } from 'wxt/browser';
import { MemorySnapshotRepository, createBookmarkSnapshot } from './bookmark-snapshot-service';
import { calculateSnapshotDiff, createRestorePlan, applyRestorePlan, markRestoreJournalsRecoverable, rollbackRestorePlan } from './bookmark-restore-service';

describe('bookmark restore safety', () => {
  beforeEach(async () => {
    await browser.storage.local.clear();
  });

  it('uses stable IDs first and reports duplicate fingerprint matches as conflicts', async () => {
    const snapshot = {
      schemaVersion: 1 as const,
      snapshotId: 's1',
      name: 'test',
      userName: 'tester',
      createdAt: 1,
      source: 'manual' as const,
      isAutomatic: false,
      isProtected: true,
      nodes: [{ id: 'old', title: 'same', url: 'https://example.test', type: 'bookmark' as const, path: 'A' }],
      nodeCount: 1,
      maxDepth: 1,
      byteSize: 1,
      contentHash: '0'.repeat(64),
      validationStatus: 'valid' as const,
      affectedBookmarkIds: [],
      delta: [],
      rootIds: [],
    };
    const diff = calculateSnapshotDiff(snapshot, [
      { id: 'new-1', title: 'same', url: 'https://example.test', type: 'bookmark', path: 'A' },
      { id: 'new-2', title: 'same', url: 'https://example.test', type: 'bookmark', path: 'A' },
    ]);
    expect(diff.conflictCount).toBe(1);
    expect(diff.items[0].action).toBe('skip');
  });

  it('counts safe moves and renames while preserving current-only nodes', () => {
    const snapshot = {
      schemaVersion: 1 as const,
      snapshotId: 's2', name: 'test', userName: 'tester', createdAt: 1,
      source: 'manual' as const, isAutomatic: false, isProtected: true,
      nodes: [{ id: 'b1', parentId: 'old', title: 'Old', url: 'https://example.test', type: 'bookmark' as const, path: 'Old' }],
      nodeCount: 1, maxDepth: 2, byteSize: 1, contentHash: '0'.repeat(64), validationStatus: 'valid' as const,
      affectedBookmarkIds: [], delta: [], rootIds: [],
    };
    const diff = calculateSnapshotDiff(snapshot, [
      { id: 'b1', parentId: 'new', title: 'New', url: 'https://example.test', type: 'bookmark', path: 'New' },
      { id: 'b2', parentId: 'new', title: 'Added', url: 'https://added.test', type: 'bookmark', path: 'New' },
    ], { safeChangeIds: ['b1'] });
    expect(diff.movedCount).toBe(1);
    expect(diff.renamedCount).toBe(1);
    expect(diff.addedCount).toBe(1);
    expect(diff.items.find(item => item.id === 'b1')?.action).toBe('restore');
    expect(diff.items.find(item => item.id === 'current:b2')?.action).toBe('skip');
  });

  it('skips separators and managed nodes in restore diff', () => {
    const snapshot = {
      schemaVersion: 1 as const,
      snapshotId: 's-separator', name: 'test', userName: 'tester', createdAt: 1,
      source: 'manual' as const, isAutomatic: false, isProtected: true,
      nodes: [
        { id: 'sep', parentId: 'toolbar', title: '', type: 'separator' as const, path: 'Bar' },
        { id: 'managed', parentId: 'toolbar', title: 'Managed', type: 'folder' as const, unmodifiable: 'managed', path: 'Bar' },
      ],
      nodeCount: 2, maxDepth: 2, byteSize: 1, contentHash: '0'.repeat(64), validationStatus: 'valid' as const,
      affectedBookmarkIds: [], delta: [], rootIds: [],
    };
    const diff = calculateSnapshotDiff(snapshot, [
      { id: 'sep', parentId: 'toolbar', title: '', type: 'separator', path: 'Bar' },
      { id: 'managed', parentId: 'toolbar', title: 'Managed', type: 'folder', unmodifiable: 'managed', path: 'Bar' },
    ]);
    expect(diff.conflictCount).toBe(2);
    expect(diff.items.every(item => item.action === 'skip')).toBe(true);
  });

  it('creates a restore-before snapshot before writes and records uncertain partial failure', async () => {
    const repository = new MemorySnapshotRepository();
    const tree = [{ id: '0', title: '', children: [{ id: '1', title: 'Bar', children: [] }, { id: '2', title: 'Other', children: [] }] }];
    browser.bookmarks.getTree = async () => tree as never;
    browser.bookmarks.get = async () => [{ id: '10', parentId: '2', title: 'A', url: 'https://a.test', index: 0 }] as never;
    const snapshot = await createBookmarkSnapshot({
      repository,
      source: 'manual',
      name: 'restore-source',
      nodes: [
        { id: '0', title: '', type: 'folder', path: '' },
        { id: '1', parentId: '0', title: 'Bar', type: 'folder', path: '' },
        { id: '10', parentId: '1', title: 'A', url: 'https://a.test', type: 'bookmark', path: 'Bar', index: 0 },
      ],
    });
    const plan = await createRestorePlan(snapshot.snapshotId, {
      repository,
      currentNodes: [
        { id: '0', title: '', type: 'folder', path: '' },
        { id: '1', parentId: '0', title: 'Bar', type: 'folder', path: '' },
        { id: '2', parentId: '0', title: 'Other', type: 'folder', path: '' },
        { id: '10', parentId: '2', title: 'A', url: 'https://a.test', type: 'bookmark', path: 'Other', index: 0 },
      ],
      safeChangeIds: ['10'],
    });
    browser.bookmarks.move = async () => { throw new Error('injected write failure'); };
    await expect(applyRestorePlan(plan, { repository })).rejects.toThrow();
    expect((await repository.listJournals()).some(journal => journal.state === 'uncertain')).toBe(true);
  });

  it('marks an interrupted journal uncertain after restart without moving bookmarks', async () => {
    const repository = new MemorySnapshotRepository();
    let moveCalled = false;
    browser.bookmarks.move = async () => { moveCalled = true; return {} as never; };
    const journal = {
      schemaVersion: 1 as const, journalId: 'j-restart', planId: 'p-restart', snapshotId: 's-restart',
      createdAt: 1, updatedAt: 1, userName: 'tester', source: 'manual' as const,
      nodeCount: 1, byteSize: 1, contentHash: '0'.repeat(64), validationStatus: 'valid' as const,
      isAutomatic: false, isProtected: true, state: 'applying' as const, items: [],
    };
    await repository.putJournal(journal);
    const recovered = await markRestoreJournalsRecoverable(repository);
    expect(recovered[0].state).toBe('uncertain');
    expect(moveCalled).toBe(false);
  });

  it('imports an unknown semantic root into one idempotent fallback folder', async () => {
    const repository = new MemorySnapshotRepository();
    const tree: any[] = [{
      id: '0', title: '', children: [{ id: 'toolbar', title: 'Bookmarks Bar', type: 'folder', children: [] }],
    }];
    const created: any[] = [];
    browser.bookmarks.getTree = async () => tree as never;
    browser.bookmarks.getChildren = async (parentId: string) => {
      const find = (items: any[]): any => items.find(item => item.id === parentId) || items.flatMap(item => find(item.children || []) || []).find(Boolean);
      return (find(tree)?.children || []) as never;
    };
    (browser.bookmarks.get as any) = async (id: string) => {
      const find = (items: any[]): any => {
        for (const item of items) {
          if (item.id === id) return item;
          const nested = find(item.children || []);
          if (nested) return nested;
        }
        return undefined;
      };
      const node = find(tree);
      return node ? [node] as never : [] as never;
    };
    browser.bookmarks.create = async (input: any) => {
      const id = `created-${created.length + 1}`;
      const node = { id, parentId: input.parentId, title: input.title, url: input.url, type: input.url ? 'bookmark' : 'folder', children: [] };
      const find = (items: any[]): any => {
        for (const item of items) {
          if (item.id === input.parentId) return item;
          const nested = find(item.children || []);
          if (nested) return nested;
        }
        return undefined;
      };
      find(tree)?.children.push(node);
      created.push(node);
      return node as never;
    };
    (browser.bookmarks.removeTree as any) = async (id: string) => {
      const remove = (items: any[]): boolean => {
        for (const item of items) {
          const index = (item.children || []).findIndex((child: any) => child.id === id);
          if (index >= 0) {
            item.children.splice(index, 1);
            return true;
          }
          if (remove(item.children || [])) return true;
        }
        return false;
      };
      remove(tree);
    };
    const snapshot = await createBookmarkSnapshot({
      repository,
      source: 'imported',
      name: 'GitHub imported',
      roots: [{ role: 'unknown', nativeId: 'foreign-root', title: 'Foreign', nodeIds: ['foreign-root', 'foreign-bookmark'] }],
      nodes: [
        { id: 'foreign-root', title: 'Foreign', type: 'folder', rootRole: 'unknown', path: '' },
        { id: 'foreign-bookmark', parentId: 'foreign-root', title: 'Imported', url: 'https://imported.test', type: 'bookmark', rootRole: 'unknown', path: 'Foreign' },
      ],
    });
    const plan = await createRestorePlan(snapshot.snapshotId, {
      repository,
      currentNodes: [
        { id: '0', title: '', type: 'folder', path: '' },
        { id: 'toolbar', parentId: '0', title: 'Bookmarks Bar', type: 'folder', rootRole: 'toolbar', path: '' },
      ],
    });

    const result = await applyRestorePlan(plan, { repository });

    expect(result.state).toBe('applied');
    expect(created).toHaveLength(2);
    expect(created[0].title).toMatch(/^MarksVault Imported - /);
    expect(created[1]).toMatchObject({ title: 'Imported', url: 'https://imported.test', parentId: created[0].id });
    const journal = (await repository.listJournals()).find(item => item.journalId === result.journalId);
    expect(journal?.semanticRootMap?.['foreign-root']).toBe(created[0].id);

    const rolledBack = await rollbackRestorePlan(result, { repository });
    expect(rolledBack.state).toBe('rolled_back');
    expect(created[0].children).toHaveLength(0);
    expect((tree[0].children[0].children as any[]).some(item => item.title.startsWith('MarksVault Imported - '))).toBe(false);
  });

  it('does not create an unknown-root folder when every restore item is deselected', async () => {
    const repository = new MemorySnapshotRepository();
    browser.bookmarks.getTree = async () => ([{ id: '0', title: '', children: [{ id: 'toolbar', title: 'Bookmarks Bar', children: [] }] }] as never);
    browser.bookmarks.getChildren = async () => [] as never;
    browser.bookmarks.create = jest.fn();
    const snapshot = await createBookmarkSnapshot({
      repository,
      source: 'imported',
      roots: [{ role: 'unknown', nativeId: 'foreign-root', title: 'Foreign', nodeIds: ['foreign-root'] }],
      nodes: [{ id: 'foreign-root', title: 'Foreign', type: 'folder', rootRole: 'unknown', path: '' }],
    });
    const plan = await createRestorePlan(snapshot.snapshotId, {
      repository,
      currentNodes: [{ id: '0', title: '', type: 'folder', path: '' }, { id: 'toolbar', parentId: '0', title: 'Bookmarks Bar', type: 'folder', rootRole: 'toolbar', path: '' }],
      selectedItemIds: [],
    });

    await applyRestorePlan(plan, { repository, selectedItemIds: [] });

    expect(browser.bookmarks.create).not.toHaveBeenCalled();
  });

  it('does not guess when an imported target has duplicate title and URL siblings', async () => {
    const repository = new MemorySnapshotRepository();
    const create = jest.fn();
    browser.bookmarks.getTree = async () => ([{ id: '0', title: '', children: [{ id: 'toolbar', title: 'Bookmarks Bar', children: [
      { id: 'existing-1', parentId: 'toolbar', title: 'Duplicate', url: 'https://duplicate.test', type: 'bookmark', index: 0 },
      { id: 'existing-2', parentId: 'toolbar', title: 'Duplicate', url: 'https://duplicate.test', type: 'bookmark', index: 1 },
    ] }] }] as never);
    browser.bookmarks.getChildren = async (parentId: string) => parentId === 'toolbar' ? ([
      { id: 'existing-1', parentId: 'toolbar', title: 'Duplicate', url: 'https://duplicate.test', type: 'bookmark', index: 0 },
      { id: 'existing-2', parentId: 'toolbar', title: 'Duplicate', url: 'https://duplicate.test', type: 'bookmark', index: 1 },
    ] as never) : [] as never;
    (browser.bookmarks.create as any) = create;
    (browser.bookmarks.get as any) = async (id: string) => id === 'existing-1' || id === 'existing-2'
      ? [{ id, parentId: 'toolbar', title: 'Duplicate', url: 'https://duplicate.test', type: 'bookmark', index: id === 'existing-1' ? 0 : 1 }] as never
      : [] as never;
    const snapshot = await createBookmarkSnapshot({
      repository,
      source: 'imported',
      roots: [{ role: 'toolbar', nativeId: 'foreign-toolbar', title: 'Bookmarks Bar', nodeIds: ['foreign-toolbar', 'foreign-bookmark'] }],
      nodes: [
        { id: 'foreign-toolbar', title: 'Bookmarks Bar', type: 'folder', rootRole: 'toolbar', path: '' },
        { id: 'foreign-bookmark', parentId: 'foreign-toolbar', title: 'Duplicate', url: 'https://duplicate.test', type: 'bookmark', rootRole: 'toolbar', path: 'Bookmarks Bar' },
      ],
    });
    const plan = await createRestorePlan(snapshot.snapshotId, {
      repository,
      currentNodes: [
        { id: '0', title: '', type: 'folder', path: '' },
        { id: 'toolbar', parentId: '0', title: 'Bookmarks Bar', type: 'folder', rootRole: 'toolbar', path: '' },
        { id: 'existing-1', parentId: 'toolbar', title: 'Duplicate', url: 'https://duplicate.test', type: 'bookmark', path: 'Bookmarks Bar' },
        { id: 'existing-2', parentId: 'toolbar', title: 'Duplicate', url: 'https://duplicate.test', type: 'bookmark', path: 'Bookmarks Bar' },
      ],
    });

    const result = await applyRestorePlan(plan, { repository });

    expect(result.state).toBe('applied');
    expect(create).not.toHaveBeenCalled();
    const journal = (await repository.listJournals()).find(item => item.journalId === result.journalId);
    expect(journal?.items.find(item => item.itemId === 'foreign-bookmark')?.state).toBe('skipped');
    expect(journal?.items.find(item => item.itemId === 'foreign-bookmark')?.error).toContain('不唯一');
  });
});
