import { browser } from 'wxt/browser';
import { classifyBookmarks, createDefaultAiProviderConfig } from './ai-service';

/**
 * Opt-in only. The normal Jest suite never calls a network endpoint.
 * Set MARKSVAULT_LIVE_AI=1 and provide the other values in the local process
 * environment after rotating any credential that was previously exposed.
 */
const runtimeEnv = ((globalThis as any).process?.env || {}) as Record<string, string | undefined>;
const liveDescribe = runtimeEnv.MARKSVAULT_LIVE_AI === '1' ? describe : describe.skip;

liveDescribe('opt-in AI provider synthetic latency smoke test', () => {
  jest.setTimeout(15 * 60 * 1000);

  test('classifies 1, 20 and 100 synthetic bookmarks without writing browser bookmarks', async () => {
    const endpoint = runtimeEnv.MARKSVAULT_LIVE_AI_ENDPOINT || '';
    const apiKey = runtimeEnv.MARKSVAULT_LIVE_AI_KEY || '';
    const model = runtimeEnv.MARKSVAULT_LIVE_AI_MODEL || '';
    if (!endpoint || !apiKey || !model) throw new Error('缺少 live AI 测试所需的本机环境配置');

    const protocolValue = runtimeEnv.MARKSVAULT_LIVE_AI_PROTOCOL;
    const authValue = runtimeEnv.MARKSVAULT_LIVE_AI_AUTH;
    const config = {
      ...createDefaultAiProviderConfig(),
      enabled: true,
      endpoint,
      apiKey,
      model,
      protocol: protocolValue === 'chat-completions' || protocolValue === 'custom' ? protocolValue : 'responses',
      authType: authValue === 'api-key-header' || authValue === 'none' ? authValue : 'bearer',
      apiKeyHeader: runtimeEnv.MARKSVAULT_LIVE_AI_HEADER || 'X-API-Key',
      batchSize: 10,
      maxAttempts: 1,
    } as const;
    const originalCreate = browser.bookmarks.create;
    const originalMove = browser.bookmarks.move;
    const counts = [1, 20, 100];
    try {
      for (const count of counts) {
        const input = Array.from({ length: count }, (_, index) => ({
          id: `synthetic-${count}-${index}`,
          title: `Synthetic Bookmark ${index}`,
          url: `https://synthetic.example/${count}/${index}`,
          path: 'Synthetic / Test',
        }));
        const beforeCreate = browser.bookmarks.create;
        const beforeMove = browser.bookmarks.move;
        const startedAt = Date.now();
        const result = await classifyBookmarks(config, input);
        const elapsedMs = Date.now() - startedAt;
        const output = { count, elapsedMs, assignments: result.assignments.length };
        (globalThis as any).process?.stdout?.write(`${JSON.stringify(output)}\n`);
        expect(result.assignments).toHaveLength(count);
        expect(browser.bookmarks.create).toBe(beforeCreate);
        expect(browser.bookmarks.move).toBe(beforeMove);
        expect(browser.bookmarks.create).toBe(originalCreate);
        expect(browser.bookmarks.move).toBe(originalMove);
      }
    } finally {
      browser.bookmarks.create = originalCreate;
      browser.bookmarks.move = originalMove;
    }
  });
});
