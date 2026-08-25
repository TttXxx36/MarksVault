import { browser } from 'wxt/browser';
import {
  MemorySnapshotRepository,
  createBookmarkSnapshot,
  computeSnapshotMetrics,
  exportBookmarkSnapshot,
  importBookmarkSnapshot,
  loadSnapshotIndex,
  validateSnapshot,
} from './bookmark-snapshot-service';

const bookmarkTree = [
  {
    id: '0',
    title: '',
    children: [
      {
        id: '1',
        title: '书签栏',
        children: [
          { id: '10', parentId: '1', title: 'Docs', url: 'https://example.test/docs', index: 0 },
        ],
      },
    ],
  },
];

describe('bookmark snapshot domain', () => {
  beforeEach(async () => {
    await browser.storage.local.clear();
    browser.bookmarks.getTree = async () => bookmarkTree as never;
  });

  it('creates a validated local snapshot with deterministic metadata and no secrets', async () => {
    const repository = new MemorySnapshotRepository();
    const snapshot = await createBookmarkSnapshot({
      repository,
      source: 'manual',
      name: 'before-test',
      userName: 'tester',
      now: 1700000000000,
    });

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.validationStatus).toBe('valid');
    expect(snapshot.nodeCount).toBe(3);
    expect(snapshot.maxDepth).toBe(2);
    expect(snapshot.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(snapshot)).not.toMatch(/api.?key|token|secret/i);
    expect((await loadSnapshotIndex()).entries).toHaveLength(1);
  });

  it('retains the newest 20 automatic snapshots while preserving named snapshots', async () => {
    const repository = new MemorySnapshotRepository();
    await createBookmarkSnapshot({ repository, source: 'manual', name: 'protected', now: 1 });
    for (let i = 0; i < 21; i += 1) {
      await createBookmarkSnapshot({ repository, source: 'ai-classification-before', isAutomatic: true, now: i + 2 });
    }
    const index = await loadSnapshotIndex();
    expect(index.entries.filter(entry => entry.isAutomatic)).toHaveLength(20);
    expect(index.entries.some(entry => entry.name === 'protected')).toBe(true);
  });

  it('rejects tampered hashes and unsafe URL protocols during import', async () => {
    const repository = new MemorySnapshotRepository();
    const snapshot = await createBookmarkSnapshot({ repository, source: 'manual', name: 'export-me' });
    const exported = await exportBookmarkSnapshot(snapshot.snapshotId, repository);
    const parsed = JSON.parse(exported) as { nodes: Array<{ url?: string }>; contentHash: string };
    parsed.nodes[2].url = 'javascript:alert(1)';
    expect((await validateSnapshot(parsed as never)).valid).toBe(false);
    await expect(importBookmarkSnapshot(JSON.stringify(parsed), { repository })).rejects.toThrow();
  });

  it('keeps a 20,000-node synthetic snapshot within a measurable local baseline', async () => {
    const nodes = Array.from({ length: 20000 }, (_, index) => ({
      id: `b-${index}`,
      parentId: 'toolbar',
      index,
      title: `Synthetic ${index}`,
      url: `https://example.test/${index}`,
      type: 'bookmark' as const,
      path: '书签栏',
    }));
    const started = Date.now();
    const metrics = await computeSnapshotMetrics(nodes);
    const elapsed = Date.now() - started;
    expect(metrics.nodeCount).toBe(20000);
    expect(metrics.byteSize).toBeGreaterThan(100000);
    expect(metrics.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // This is a regression baseline, not a machine-specific hard SLA.
    expect(elapsed).toBeLessThan(10000);
  });
});
