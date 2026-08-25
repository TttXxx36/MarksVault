import { browser } from 'wxt/browser';
import {
  classifyBookmarks,
  createDefaultAiProviderConfig,
  getAiProviderConfig,
  saveAiProviderConfig,
} from './ai-service';

describe('ai-service user-configured provider', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await browser.storage.local.clear();
    (globalThis as any).fetch = jest.fn();
  });

  test('keeps API key separate from public provider configuration', async () => {
    const config = await saveAiProviderConfig({
      ...createDefaultAiProviderConfig(),
      enabled: true,
      endpoint: 'https://example.com',
      model: 'demo-model',
      apiKey: 'secret-value',
    });
    const stored = await browser.storage.local.get(null) as any;
    expect(stored.ai_provider_config.apiKey).toBeUndefined();
    expect(stored.ai_provider_secret).toBe('secret-value');
    expect(config.apiKey).toBe('secret-value');
    const loaded = await getAiProviderConfig();
    expect(loaded.apiKey).toBe('secret-value');
    expect(loaded.endpoint).toBe('https://example.com');
  });

  test('parses Responses API JSON output without sending secrets in the prompt', async () => {
    const config = {
      ...createDefaultAiProviderConfig(),
      enabled: true,
      endpoint: 'https://example.com',
      model: 'demo-model',
      apiKey: 'secret-value',
      batchSize: 10,
    };
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        output_text: JSON.stringify({
          categories: [{ name: '开发', description: '开发资源' }],
          assignments: [{ bookmarkId: 'b1', categoryName: '开发', confidence: 0.9 }],
        }),
      }),
    });
    const result = await classifyBookmarks(config, [{
      id: 'b1',
      title: 'TypeScript',
      url: 'https://www.typescriptlang.org',
      path: '书签栏 / 开发',
    }]);
    expect(result.assignments).toEqual([
      expect.objectContaining({ bookmarkId: 'b1', categoryName: '开发' }),
    ]);
    const [, request] = (globalThis as any).fetch.mock.calls[0];
    expect(request.method).toBe('POST');
    expect(request.headers.get('Authorization')).toBe('Bearer secret-value');
    expect(String(request.body)).toContain('TypeScript');
    expect(String(request.body)).not.toContain('secret-value');
  });

  test('rejects non-local HTTP endpoints', async () => {
    await expect(saveAiProviderConfig({
      ...createDefaultAiProviderConfig(),
      endpoint: 'http://remote.example.com',
    })).rejects.toThrow('HTTPS');
  });

  test('constrains assignments when the model exceeds the category limit', async () => {
    const config = {
      ...createDefaultAiProviderConfig(),
      enabled: true,
      endpoint: 'https://example.com',
      model: 'demo-model',
      maxCategories: 3,
    };
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        output_text: JSON.stringify({
          categories: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }],
          assignments: [{ bookmarkId: 'b1', categoryName: 'D', confidence: 0.9 }],
        }),
      }),
    });

    const result = await classifyBookmarks(config, [{
      id: 'b1',
      title: 'Example',
      url: 'https://example.com',
      path: '',
    }]);

    expect(result.categories).toHaveLength(3);
    expect(result.assignments[0]).toEqual(expect.objectContaining({
      bookmarkId: 'b1',
      categoryName: '其他',
    }));
  });

  test('persists batch progress and skips a completed batch when resumed', async () => {
    const config = {
      ...createDefaultAiProviderConfig(),
      enabled: true,
      endpoint: 'https://example.com',
      model: 'demo-model',
      batchSize: 10,
    };
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        output_text: JSON.stringify({
          categories: [{ name: '开发' }],
          assignments: [{ bookmarkId: 'b1', categoryName: '开发', confidence: 0.8 }],
        }),
      }),
    });
    const progress: any[] = [];
    const input = [{ id: 'b1', title: 'TypeScript', url: 'https://typescriptlang.org', path: '' }];
    const first = await classifyBookmarks(config, input, {
      onBatchProgress: item => { progress.push(item); },
    });
    expect(progress.map(item => item.state)).toEqual(['running', 'completed']);
    const callsAfterFirstRun = (globalThis as any).fetch.mock.calls.length;

    const resumed = await classifyBookmarks(config, input, {
      resume: {
        completedBatchIds: [progress[1].batchId],
        categories: first.categories,
        assignments: first.assignments,
      },
    });
    expect(resumed).toEqual(first);
    expect((globalThis as any).fetch.mock.calls).toHaveLength(callsAfterFirstRun);
  });

});
