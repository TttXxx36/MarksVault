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

});
