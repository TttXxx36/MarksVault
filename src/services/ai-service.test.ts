import { browser } from 'wxt/browser';
import {
  AiResponseFormatError,
  classifyBookmarks,
  createDefaultAiProviderConfig,
  getAiProviderDraft,
  getAiProviderConfig,
  saveAiProviderDraft,
  saveAiProviderConfig,
} from './ai-service';

describe('ai-service user-configured provider', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await browser.storage.local.clear();
    (globalThis as any).fetch = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
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

  test('persists configuration drafts locally without exposing the key in the public draft', async () => {
    await saveAiProviderDraft({
      ...createDefaultAiProviderConfig(),
      endpoint: 'https://example.com',
      model: 'draft-model',
      apiKey: 'draft-secret',
    });
    const stored = await browser.storage.local.get(null) as any;
    expect(stored.ai_provider_config_draft.apiKey).toBeUndefined();
    expect(stored.ai_provider_secret_draft).toBe('draft-secret');
    const loaded = await getAiProviderDraft();
    expect(loaded?.model).toBe('draft-model');
    expect(loaded?.apiKey).toBe('draft-secret');
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

  test('reports concatenated JSON as a response-format error', async () => {
    const config = {
      ...createDefaultAiProviderConfig(),
      enabled: true,
      endpoint: 'https://example.com',
      model: 'demo-model',
      apiKey: 'secret-value',
    };
    const first = JSON.stringify({
      categories: [{ name: '开发' }],
      assignments: [{ bookmarkId: 'b1', categoryName: '开发', confidence: 0.9 }],
    });
    const second = JSON.stringify({
      categories: [{ name: '其他' }],
      assignments: [{ bookmarkId: 'b1', categoryName: '其他', confidence: 0.1 }],
    });
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output_text: first + second }),
    });

    await expect(classifyBookmarks(config, [{
      id: 'b1',
      title: 'Example',
      url: 'https://example.com',
      path: '',
    }])).rejects.toThrow('AI 返回内容包含多个 JSON');
  });

  test('keeps the mandatory JSON contract when a supplemental prompt is provided', async () => {
    const config = {
      ...createDefaultAiProviderConfig(),
      enabled: true,
      endpoint: 'https://example.com',
      model: 'demo-model',
      systemPrompt: '请优先把开发资源放进开发分类。',
    };
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        output_text: JSON.stringify({
          categories: [{ name: '开发' }],
          assignments: [{ bookmarkId: 'b1', categoryName: '开发', confidence: 0.9 }],
        }),
      }),
    });

    await classifyBookmarks(config, [{
      id: 'b1',
      title: 'TypeScript',
      url: 'https://typescriptlang.org',
      path: '',
    }]);

    const [, request] = (globalThis as any).fetch.mock.calls[0];
    const body = JSON.parse(String(request.body));
    expect(body.input[0].content).toContain('JSON 必须包含 categories 数组和 assignments 数组');
    expect(body.input[0].content).toContain('用户补充要求');
    expect(body.text.format).toEqual({ type: 'json_object' });
  });

  test('guides diverse bookmarks into meaningful domain categories before using other', async () => {
    const config = {
      ...createDefaultAiProviderConfig(),
      enabled: true,
      endpoint: 'https://example.com',
      model: 'demo-model',
      maxCategories: 12,
    };
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        output_text: JSON.stringify({
          categories: [{ name: '开发' }, { name: '学习' }],
          assignments: [
            { bookmarkId: 'b1', categoryName: '开发', confidence: 0.9 },
            { bookmarkId: 'b2', categoryName: '学习', confidence: 0.9 },
          ],
        }),
      }),
    });

    await classifyBookmarks(config, [
      { id: 'b1', title: 'TypeScript 文档', url: 'https://www.typescriptlang.org/docs', path: '书签栏 / 开发' },
      { id: 'b2', title: '在线课程', url: 'https://learn.example.test/course', path: '书签栏 / 学习' },
    ]);

    const [, request] = (globalThis as any).fetch.mock.calls[0];
    const body = JSON.parse(String(request.body));
    const systemPrompt = body.input[0].content as string;
    const userPrompt = body.input[1].content as string;
    expect(systemPrompt).toContain('优先依据域名、URL 路径、标题和文件夹路径');
    expect(systemPrompt).toContain('“其他”仅用于确实无法判断');
    expect(userPrompt).toContain('不要把所有书签默认归入“其他”');
    expect(userPrompt).toContain('域名');
  });

  test('repairs one invalid response without restarting the batch', async () => {
    const config = {
      ...createDefaultAiProviderConfig(),
      enabled: true,
      endpoint: 'https://example.com',
      model: 'demo-model',
    };
    (globalThis as any).fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ output_text: '{"categories":[]}{}' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          output_text: JSON.stringify({
            categories: [{ name: '其他' }],
            assignments: [{ bookmarkId: 'b1', categoryName: '其他', confidence: 0.2 }],
          }),
        }),
      });

    const result = await classifyBookmarks(config, [{
      id: 'b1',
      title: 'Example',
      url: 'https://example.com',
      path: '',
    }]);

    expect(result.assignments[0]).toEqual(expect.objectContaining({ categoryName: '其他' }));
    expect((globalThis as any).fetch).toHaveBeenCalledTimes(2);
  });

  test('records both parsing attempts when the repair response is also invalid', async () => {
    const config = {
      ...createDefaultAiProviderConfig(),
      enabled: true,
      endpoint: 'https://example.com',
      model: 'demo-model',
      maxAttempts: 2,
    };
    (globalThis as any).fetch
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ output_text: '{"categories":[]}{"assignments":[]}' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ output_text: 'still not JSON' }) });
    const progress: any[] = [];
    await expect(classifyBookmarks(config, [{
      id: 'b1', title: 'Example', url: 'https://example.com', path: '',
    }], { onBatchProgress: item => { progress.push(item); } })).rejects.toMatchObject({
      code: 'INVALID_JSON',
      attempts: 2,
    });
    expect(progress.at(-1)).toEqual(expect.objectContaining({ state: 'failed', attempts: 2, errorCode: 'INVALID_JSON' }));
  });

  test('uses only the final Responses assistant message', async () => {
    const config = {
      ...createDefaultAiProviderConfig(),
      enabled: true,
      endpoint: 'https://example.com',
      model: 'demo-model',
    };
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        output: [
          { type: 'reasoning', content: [{ type: 'output_text', text: '{"not":"a classification"}' }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({
            categories: [{ name: '开发' }],
            assignments: [{ bookmarkId: 'b1', categoryName: '开发', confidence: 0.9 }],
          }) }] },
        ],
      }),
    });

    const result = await classifyBookmarks(config, [{
      id: 'b1',
      title: 'TypeScript',
      url: 'https://typescriptlang.org',
      path: '',
    }]);

    expect(result.assignments[0]).toEqual(expect.objectContaining({ categoryName: '开发' }));
  });

  test('accepts fenced JSON, nested braces in strings, and compatible text response shapes', async () => {
    const config = {
      ...createDefaultAiProviderConfig(),
      enabled: true,
      endpoint: 'https://example.com',
      model: 'demo-model',
    };
    const response = JSON.stringify({
      categories: [{ name: '开发', description: '包含 {大括号} 的说明' }],
      assignments: [{ bookmarkId: 'b1', categoryName: '开发', confidence: 0.8 }],
    });
    for (const shape of [
      { choices: [{ text: `\`\`\`json\n${response}\n\`\`\`` }] },
      { choices: [{ message: { content: [{ type: 'text', text: response }] } }] },
    ]) {
      (globalThis as any).fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(shape),
      });
    }

    const input = [{ id: 'b1', title: 'Example', url: 'https://example.com', path: '' }];
    const first = await classifyBookmarks(config, input);
    const second = await classifyBookmarks(config, input);
    expect(first.assignments[0].categoryName).toBe('开发');
    expect(second.assignments[0].categoryName).toBe('开发');
  });

  test('uses structured output when supported and falls back once after HTTP 400', async () => {
    const config = {
      ...createDefaultAiProviderConfig(),
      enabled: true,
      endpoint: 'https://example.com',
      model: 'demo-model',
    };
    const valid = JSON.stringify({
      categories: [{ name: '其他' }],
      assignments: [{ bookmarkId: 'b1', categoryName: '其他', confidence: 0.4 }],
    });
    (globalThis as any).fetch
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => '{"error":"unsupported"}' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ output_text: valid }) });

    await classifyBookmarks(config, [{ id: 'b1', title: 'Example', url: 'https://example.com', path: '' }]);
    expect((globalThis as any).fetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String((globalThis as any).fetch.mock.calls[0][1].body));
    const fallbackBody = JSON.parse(String((globalThis as any).fetch.mock.calls[1][1].body));
    expect(firstBody.text.format).toEqual({ type: 'json_object' });
    expect(fallbackBody.text).toBeUndefined();
  });

  test('returns a structured format error for truncated JSON after one repair attempt', async () => {
    const config = {
      ...createDefaultAiProviderConfig(),
      enabled: true,
      endpoint: 'https://example.com',
      model: 'demo-model',
    };
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output_text: '{"categories":[{"name":"开发"}],"assignments":[' }),
    });

    await expect(classifyBookmarks(config, [{ id: 'b1', title: 'Example', url: 'https://example.com', path: '' }]))
      .rejects.toMatchObject({ code: 'INVALID_JSON' });
    expect((globalThis as any).fetch).toHaveBeenCalledTimes(2);
    await expect(classifyBookmarks(config, [])).resolves.toEqual({ categories: [], assignments: [] });
    expect(AiResponseFormatError).toBeDefined();
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

  test('limits a background slice to one batch and persists an input ID fingerprint', async () => {
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
      text: async () => JSON.stringify({ output_text: JSON.stringify({
        categories: [{ name: '其他' }],
        assignments: Array.from({ length: 10 }, (_, index) => ({
          bookmarkId: `b${index}`,
          categoryName: '其他',
          confidence: 0.4,
        })),
      }) }),
    });
    const input = Array.from({ length: 21 }, (_, index) => ({
      id: `b${index}`,
      title: `Bookmark ${index}`,
      url: `https://example.com/${index}`,
      path: '',
    }));
    const progress: any[] = [];
    const result = await classifyBookmarks(config, input, {
      maxBatches: 1,
      onBatchProgress: item => { progress.push(item); },
    });
    expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);
    expect(result.assignments).toHaveLength(10);
    expect(progress[0]).toEqual(expect.objectContaining({ state: 'running', inputHash: expect.stringMatching(/^[0-9a-f]{8}$/) }));
  });

  test('resumes only the failed child after an adaptive split', async () => {
    const config = {
      ...createDefaultAiProviderConfig(),
      enabled: true,
      endpoint: 'https://example.com',
      model: 'demo-model',
      batchSize: 20,
    };
    const input = Array.from({ length: 20 }, (_, index) => ({
      id: `b${index}`,
      title: `Bookmark ${index}`,
      url: `https://example.com/${index}`,
      path: '',
    }));
    const valid = (ids: string[]) => JSON.stringify({ output_text: JSON.stringify({
      categories: [{ name: '其他' }],
      assignments: ids.map(bookmarkId => ({ bookmarkId, categoryName: '其他', confidence: 0.4 })),
    }) });
    (globalThis as any).fetch
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ output_text: 'not-json' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ output_text: 'still-not-json' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => valid(input.slice(0, 10).map(item => item.id)) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ output_text: 'not-json' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ output_text: 'still-not-json' }) });
    const progress: any[] = [];
    await expect(classifyBookmarks(config, input, { onBatchProgress: item => { progress.push(item); } })).rejects.toThrow();
    const completedChild = progress.find(item => item.state === 'completed' && item.bookmarkIds.length === 10);
    expect(completedChild).toBeTruthy();
    const callsBeforeResume = (globalThis as any).fetch.mock.calls.length;
    (globalThis as any).fetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => valid(input.slice(10).map(item => item.id)) });
    const resumed = await classifyBookmarks(config, input, {
      resume: {
        completedBatchIds: [completedChild.batchId],
        completedBookmarkIds: completedChild.bookmarkIds,
        categories: [{ name: '其他' }],
        assignments: completedChild.bookmarkIds.map((bookmarkId: string) => ({ bookmarkId, categoryName: '其他', confidence: 0.4 })),
      },
    });
    expect((globalThis as any).fetch.mock.calls.length - callsBeforeResume).toBe(1);
    expect(resumed.assignments).toHaveLength(20);
  });

  test('uses bounded v2.1.2 defaults and migrates the legacy 60-second/20-item defaults', async () => {
    const defaults = createDefaultAiProviderConfig();
    expect(defaults.timeoutMs).toBe(30_000);
    expect(defaults.batchTimeoutMs).toBe(90_000);
    expect(defaults.maxAttempts).toBe(2);
    expect(defaults.batchSize).toBe(10);

    await browser.storage.local.set({
      ai_provider_config: {
        enabled: true,
        endpoint: 'https://example.com',
        protocol: 'responses',
        authType: 'bearer',
        apiKeyHeader: 'X-API-Key',
        model: 'legacy-model',
        systemPrompt: '',
        temperature: 0.1,
        timeoutMs: 60_000,
        batchSize: 20,
        maxCategories: 12,
      },
      ai_provider_secret: 'fake-secret',
    });
    const migrated = await getAiProviderConfig();
    expect(migrated.timeoutMs).toBe(30_000);
    expect(migrated.batchTimeoutMs).toBe(90_000);
    expect(migrated.maxAttempts).toBe(2);
    expect(migrated.batchSize).toBe(10);
  });

  test('stops a stalled 10-item batch after two attempts and records the real count', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn((_url: string, init: RequestInit) => new Promise<never>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    (globalThis as any).fetch = fetchMock;
    const progress: any[] = [];
    const config = {
      ...createDefaultAiProviderConfig(),
      enabled: true,
      endpoint: 'https://example.com',
      model: 'slow-model',
      timeoutMs: 5_000,
      batchTimeoutMs: 12_000,
      maxAttempts: 2,
      batchSize: 10,
    };
    const pending = classifyBookmarks(config, Array.from({ length: 10 }, (_, index) => ({
      id: `b${index}`, title: `Bookmark ${index}`, url: `https://example.com/${index}`, path: '',
    })), { onBatchProgress: item => { progress.push(item); } }).catch(error => error);
    await jest.advanceTimersByTimeAsync(12_000);
    const error = await pending;
    expect(error).toMatchObject({ code: 'TIMEOUT', attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(progress.at(-1)).toEqual(expect.objectContaining({ state: 'failed', attempts: 2, errorCode: 'TIMEOUT' }));
    jest.useRealTimers();
  });

  test('splits a timed-out 20-item batch within the same deadline', async () => {
    jest.useFakeTimers();
    const validResponse = JSON.stringify({ output_text: JSON.stringify({
      categories: [{ name: '其他' }],
      assignments: [],
    }) });
    const fetchMock = jest.fn()
      .mockImplementationOnce((_url: string, init: RequestInit) => new Promise<never>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }))
      .mockResolvedValue({ ok: true, status: 200, text: async () => validResponse });
    (globalThis as any).fetch = fetchMock;
    const input = Array.from({ length: 20 }, (_, index) => ({
      id: `b${index}`, title: `Bookmark ${index}`, url: `https://example.com/${index}`, path: '',
    }));
    const pending = classifyBookmarks({
      ...createDefaultAiProviderConfig(),
      enabled: true,
      endpoint: 'https://example.com',
      model: 'adaptive-model',
      timeoutMs: 5_000,
      batchTimeoutMs: 12_000,
      maxAttempts: 1,
      batchSize: 20,
    }, input);
    await jest.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.assignments).toHaveLength(20);
    jest.useRealTimers();
  });

  test('processes 100 synthetic bookmarks as ten bounded batches', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output_text: JSON.stringify({ categories: [{ name: '其他' }], assignments: [] }) }),
    });
    (globalThis as any).fetch = fetchMock;
    const input = Array.from({ length: 100 }, (_, index) => ({
      id: `b${index}`, title: `Bookmark ${index}`, url: `https://example.com/${index}`, path: 'Bookmarks Bar',
    }));
    const startedAt = Date.now();
    const result = await classifyBookmarks({
      ...createDefaultAiProviderConfig(),
      enabled: true,
      endpoint: 'https://example.com',
      model: 'fast-fixture-model',
      maxAttempts: 1,
      batchSize: 10,
    }, input);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(result.assignments).toHaveLength(100);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

});

