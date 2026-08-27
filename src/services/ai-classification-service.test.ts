import { browser } from 'wxt/browser';
import { AiClassificationPlan } from '../types/ai';
import { applyAiClassificationPlan, clearAiClassificationAlarm, ensureAiClassificationAlarm, recoverAiClassificationOnWorkerStart, rollbackAiClassificationPlan, runAiClassificationJob, startAiClassificationJob, getAiClassificationJob, markAiClassificationRecoverable, saveAiClassificationJob } from './ai-classification-service';
import { createDefaultAiProviderConfig, saveAiProviderConfig } from './ai-service';
import { MemorySnapshotRepository, setSnapshotRepositoryForTesting } from './bookmark-snapshot-service';

describe('ai-classification rollback safety', () => {
  const bookmarks = browser.bookmarks as any;
  const alarms = browser.alarms as any;

  beforeEach(async () => {
    jest.clearAllMocks();
    await browser.storage.local.clear();
    // The shared browser fixture uses lightweight async functions; replace only the
    // methods this test needs so assertions and per-node behavior remain isolated.
    bookmarks.get = jest.fn();
    bookmarks.move = jest.fn();
    bookmarks.create = jest.fn().mockResolvedValue({ id: 'ai-folder', title: '其他' });
    bookmarks.update = jest.fn();
    alarms.get = jest.fn().mockResolvedValue(undefined);
    alarms.create = jest.fn().mockResolvedValue(undefined);
    alarms.clear = jest.fn().mockResolvedValue(true);
    setSnapshotRepositoryForTesting(null);
  });

  test('starts a job with a one-shot watchdog alarm', async () => {
    const job = {
      id: 'alarm-job',
      state: 'queued' as const,
    };

    await expect(ensureAiClassificationAlarm(job)).resolves.toBe(true);
    expect(alarms.create).toHaveBeenCalledWith(
      'marksvault-ai-alarm-job',
      expect.objectContaining({ when: expect.any(Number) }),
    );

    alarms.get.mockResolvedValueOnce({ name: 'marksvault-ai-alarm-job' });
    await expect(ensureAiClassificationAlarm(job)).resolves.toBe(true);
    expect(alarms.create).toHaveBeenCalledTimes(1);

    await expect(clearAiClassificationAlarm(job.id)).resolves.toBe(true);
    expect(alarms.clear).toHaveBeenCalledWith('marksvault-ai-alarm-job');
  });

  test('recreates a missing alarm for a queued job after worker restart', async () => {
    const job: any = {
      schemaVersion: 1,
      promptContractVersion: 1,
      id: 'job-alarm-lost',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      endpoint: 'https://example.com',
      model: 'demo-model',
      bookmarkIds: [],
      bookmarks: [],
      batches: [],
      categories: [],
      assignments: [],
      state: 'queued',
    };
    await saveAiClassificationJob(job);

    const recovered = await recoverAiClassificationOnWorkerStart();

    expect(recovered?.state).toBe('queued');
    expect(alarms.create).toHaveBeenCalledWith(
      'marksvault-ai-job-alarm-lost',
      expect.objectContaining({ when: expect.any(Number) }),
    );
  });

  test('marks an interrupted classifying job resumable when its alarm is missing', async () => {
    const job: any = {
      schemaVersion: 1,
      promptContractVersion: 1,
      id: 'job-worker-restart',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      endpoint: 'https://example.com',
      model: 'demo-model',
      bookmarkIds: [],
      bookmarks: [],
      batches: [],
      categories: [],
      assignments: [],
      state: 'classifying',
    };
    await saveAiClassificationJob(job);

    const recovered = await recoverAiClassificationOnWorkerStart();

    expect(recovered?.state).toBe('paused');
    expect(recovered?.resumeAvailable).toBe(true);
    expect(alarms.clear).toHaveBeenCalledWith('marksvault-ai-job-worker-restart');
  });

  test('browser restart also pauses a queued job instead of auto-sending it', async () => {
    const job: any = {
      schemaVersion: 1,
      promptContractVersion: 1,
      id: 'job-browser-restart-queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      endpoint: 'https://example.com',
      model: 'demo-model',
      bookmarkIds: [],
      bookmarks: [],
      batches: [],
      categories: [],
      assignments: [],
      state: 'queued',
    };
    await saveAiClassificationJob(job);

    const recovered = await markAiClassificationRecoverable();

    expect(recovered?.state).toBe('paused');
    expect(recovered?.resumeAvailable).toBe(true);
    expect(alarms.clear).toHaveBeenCalledWith('marksvault-ai-job-browser-restart-queued');
  });

  test('keeps a classifying job active when the worker was woken by its alarm', async () => {
    const job: any = {
      schemaVersion: 1,
      promptContractVersion: 1,
      id: 'job-alarm-wake',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      endpoint: 'https://example.com',
      model: 'demo-model',
      bookmarkIds: [],
      bookmarks: [],
      batches: [],
      categories: [],
      assignments: [],
      state: 'classifying',
    };
    await saveAiClassificationJob(job);
    alarms.get.mockResolvedValue({ name: 'marksvault-ai-job-alarm-wake' });

    const recovered = await recoverAiClassificationOnWorkerStart();

    expect(recovered?.state).toBe('classifying');
    expect(alarms.clear).not.toHaveBeenCalled();
  });

  test('refuses every bookmark write when the mandatory AI-before snapshot cannot be stored', async () => {
    bookmarks.getTree = jest.fn().mockResolvedValue([{
      id: 'root', title: '', children: [{ id: 'toolbar', title: 'Bookmarks Toolbar', children: [] }],
    }]);
    bookmarks.get = jest.fn().mockResolvedValue([{ id: 'b1', parentId: 'toolbar', title: 'Example', url: 'https://example.com', index: 0 }]);
    const failingRepository = new MemorySnapshotRepository();
    failingRepository.putSnapshot = jest.fn().mockRejectedValue(new Error('quota exceeded'));
    setSnapshotRepositoryForTesting(failingRepository);
    const plan: AiClassificationPlan = {
      id: 'snapshot-gate-plan',
      createdAt: Date.now(),
      categories: [{ name: '其他' }],
      assignments: [{ bookmarkId: 'b1', categoryName: '其他', confidence: 1 }],
      snapshot: [{ id: 'b1', parentId: 'toolbar', index: 0 }],
      skippedBookmarkIds: [],
      unassignedBookmarkIds: [],
      appliedBookmarkIds: [],
      appliedDestinationByBookmarkId: {},
      createdFolderIds: [],
      state: 'preview',
    };
    await expect(applyAiClassificationPlan(plan)).rejects.toThrow();
    expect(bookmarks.create).not.toHaveBeenCalled();
    expect(bookmarks.move).not.toHaveBeenCalled();
  });

  test('does not move a node that was changed by the user after the operation', async () => {
    bookmarks.get.mockImplementation(async (id: string) => {
      if (id === 'unprocessed') return [{ id, parentId: 'user-folder', url: 'https://user.example' }];
      return [{ id, parentId: 'ai-folder', url: 'https://processed.example' }];
    });

    const plan: AiClassificationPlan = {
      id: 'plan-1',
      createdAt: Date.now(),
      categories: [],
      assignments: [],
      snapshot: [
        { id: 'unprocessed', parentId: 'original-folder', index: 0 },
        { id: 'processed', parentId: 'original-folder', index: 1 },
      ],
      skippedBookmarkIds: [],
      unassignedBookmarkIds: [],
      appliedBookmarkIds: ['processed'],
      appliedDestinationByBookmarkId: { processed: 'ai-folder' },
      createdFolderIds: [],
      state: 'applied',
    };

    await rollbackAiClassificationPlan(plan);

    expect(bookmarks.move).toHaveBeenCalledTimes(1);
    expect(bookmarks.move).toHaveBeenCalledWith('processed', {
      parentId: 'original-folder',
      index: 1,
    });
  });

  test('starts a persisted background classification job without requiring the Popup to stay mounted', async () => {
    bookmarks.getTree = jest.fn().mockResolvedValue([{
      id: 'root',
      title: '',
      children: [{
        id: 'toolbar',
        title: 'Bookmarks Toolbar',
        children: [{ id: 'b1', title: 'Example', url: 'https://example.com', parentId: 'toolbar', index: 0 }],
      }],
    }]);
    await saveAiProviderConfig({
      ...createDefaultAiProviderConfig(),
      enabled: true,
      endpoint: 'https://example.com',
      model: 'demo-model',
      apiKey: 'fake-secret',
    });
    (globalThis as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        output_text: JSON.stringify({
          categories: [{ name: '其他' }],
          assignments: [{ bookmarkId: 'b1', categoryName: '其他', confidence: 0.4 }],
        }),
      }),
    });

    const queued = await startAiClassificationJob();
    expect(queued.state).toBe('queued');
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    const completed = await getAiClassificationJob();
    expect(completed?.state).toBe('awaiting_review');
  });

  test('moves the persisted AI task out of preview-waiting after confirmation', async () => {
    const repository = new MemorySnapshotRepository();
    bookmarks.getTree = jest.fn().mockResolvedValue([{
      id: 'root',
      title: '',
      children: [{
        id: 'toolbar',
        title: 'Bookmarks Toolbar',
        children: [{ id: 'b1', parentId: 'toolbar', title: 'Example', url: 'https://example.test', index: 0 }],
      }],
    }]);
    bookmarks.getChildren = jest.fn().mockResolvedValue([]);
    bookmarks.get = jest.fn().mockResolvedValue([
      { id: 'b1', parentId: 'toolbar', title: 'Example', url: 'https://example.test', index: 0 },
    ]);
    bookmarks.create = jest.fn().mockResolvedValue({ id: 'ai-folder', parentId: 'toolbar', title: '开发', children: [] });
    bookmarks.move = jest.fn().mockResolvedValue({ id: 'b1', parentId: 'ai-folder', title: 'Example', url: 'https://example.test', index: 0 });

    await saveAiClassificationJob({
      schemaVersion: 1,
      promptContractVersion: 1,
      id: 'job-applied-state',
      planId: 'plan-applied-state',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      endpoint: 'https://example.test',
      model: 'fixture-model',
      bookmarkIds: ['b1'],
      bookmarks: [{ id: 'b1', title: 'Example', url: 'https://example.test', path: 'Bookmarks Toolbar' }],
      batches: [{ batchId: 'batch-1', bookmarkIds: ['b1'], state: 'completed', attempts: 1 }],
      categories: [{ name: '开发' }],
      assignments: [{ bookmarkId: 'b1', categoryName: '开发', confidence: 1 }],
      state: 'awaiting_review',
    } as any);

    const plan: AiClassificationPlan = {
      id: 'plan-applied-state',
      createdAt: Date.now(),
      categories: [{ name: '开发' }],
      assignments: [{ bookmarkId: 'b1', categoryName: '开发', confidence: 1 }],
      snapshot: [{ id: 'b1', parentId: 'toolbar', index: 0 }],
      skippedBookmarkIds: [],
      unassignedBookmarkIds: [],
      appliedBookmarkIds: [],
      appliedDestinationByBookmarkId: {},
      createdFolderIds: [],
      state: 'preview',
    };

    setSnapshotRepositoryForTesting(repository);
    await applyAiClassificationPlan(plan);

    await expect(getAiClassificationJob()).resolves.toEqual(expect.objectContaining({
      state: 'applied',
      planId: 'plan-applied-state',
    }));
  });

  test('marks an interrupted classifying job as resumable instead of restarting it silently', async () => {
    const job: any = {
      schemaVersion: 1,
      id: 'job-interrupted',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      endpoint: 'https://example.com',
      model: 'demo-model',
      bookmarkIds: [],
      bookmarks: [],
      batches: [],
      categories: [],
      assignments: [],
      state: 'classifying',
    };
    await saveAiClassificationJob(job);
    const recovered = await markAiClassificationRecoverable();
    expect(recovered?.state).toBe('paused');
    expect(recovered?.resumeAvailable).toBe(true);
  });

  test('persists one background batch at a time and resumes from the checkpoint', async () => {
    bookmarks.getTree = jest.fn().mockResolvedValue([{
      id: 'root',
      title: '',
      children: [{
        id: 'toolbar',
        title: 'Bookmarks Toolbar',
        children: Array.from({ length: 21 }, (_, index) => ({
          id: `b${index}`,
          title: `Example ${index}`,
          url: `https://example.com/${index}`,
          parentId: 'toolbar',
          index,
        })),
      }],
    }]);
    const config = await saveAiProviderConfig({
      ...createDefaultAiProviderConfig(),
      enabled: true,
      endpoint: 'https://example.com',
      model: 'demo-model',
      apiKey: 'fake-secret',
      batchSize: 20,
    });
    const responseFor = (ids: string[]) => JSON.stringify({ output_text: JSON.stringify({
      categories: [{ name: '其他' }],
      assignments: ids.map(bookmarkId => ({ bookmarkId, categoryName: '其他', confidence: 0.4 })),
    }) });
    (globalThis as any).fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => responseFor(Array.from({ length: 20 }, (_, index) => `b${index}`)) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => responseFor(['b20']) });

    const queued = await startAiClassificationJob(config);
    expect(queued.batches.every(batch => batch.state === 'pending')).toBe(true);
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    const checkpoint = await getAiClassificationJob();
    expect(checkpoint?.state).toBe('queued');
    expect(checkpoint?.batches.filter(batch => batch.state === 'completed')).toHaveLength(1);
    // Simulate the worker being reclaimed after the first checkpoint and the
    // one-shot alarm being lost. A new worker repairs the alarm before resume.
    alarms.get.mockResolvedValue(undefined);
    const recovered = await recoverAiClassificationOnWorkerStart();
    expect(recovered?.state).toBe('queued');
    expect(alarms.create).toHaveBeenCalledWith(
      expect.stringMatching(/^marksvault-ai-/),
      expect.objectContaining({ when: expect.any(Number) }),
    );
    await runAiClassificationJob(recovered || undefined);
    const completed = await getAiClassificationJob();
    expect(completed?.state).toBe('awaiting_review');
    expect((globalThis as any).fetch).toHaveBeenCalledTimes(2);
  });

  test('does not leave a stale active-run lock after an early startup failure', async () => {
    await expect(runAiClassificationJob()).rejects.toThrow('没有可执行的 AI 分类任务');
    await expect(runAiClassificationJob()).rejects.toThrow('没有可执行的 AI 分类任务');
  });
});

