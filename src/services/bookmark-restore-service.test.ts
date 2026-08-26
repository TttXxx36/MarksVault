import { browser } from 'wxt/browser';
import { MemorySnapshotRepository, createBookmarkSnapshot } from './bookmark-snapshot-service';
import { calculateSnapshotDiff, createRestorePlan, applyRestorePlan, markRestoreJournalsRecoverable } from './bookmark-restore-service';

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
});
