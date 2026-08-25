jest.mock('wxt/utils/define-background', () => ({
  defineBackground: (config: unknown) => config,
}));

let onMessageListener: ((message: any, sender: any, sendResponse: any) => any) | null = null;

jest.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      onInstalled: { addListener: jest.fn() },
      onStartup: { addListener: jest.fn() },
      onMessage: {
        addListener: jest.fn((listener: any) => {
          onMessageListener = listener;
        }),
      },
      getManifest: jest.fn(() => ({ version: '1.0.0' })),
    },
    bookmarks: {
      onCreated: { addListener: jest.fn() },
      onRemoved: { addListener: jest.fn() },
      onChanged: { addListener: jest.fn() },
      onMoved: { addListener: jest.fn() },
    },
    storage: {
      local: {
        set: jest.fn(),
      },
    },
  },
}));

jest.mock('../services/favicon-warmup-service', () => ({
  __esModule: true,
  warmupBookmarkFavicons: jest.fn(),
}));

jest.mock('../services/task-service', () => ({
  __esModule: true,
  default: {
    init: jest.fn(),
    getTaskById: jest.fn(),
  },
}));

jest.mock('../services/task-executor', () => ({
  __esModule: true,
  default: {
    init: jest.fn(),
    executeTaskWithData: jest.fn(),
  },
}));

jest.mock('../services/trigger-service', () => ({
  __esModule: true,
  default: {
    init: jest.fn(),
  },
}));

jest.mock('../services/ai-classification-service', () => ({
  cancelAiClassificationJob: jest.fn(),
  getAiClassificationJob: jest.fn(),
  getLastAiClassificationPlan: jest.fn(),
  markAiClassificationRecoverable: jest.fn(),
  resumeAiClassificationJob: jest.fn(),
  runAiClassificationJob: jest.fn(),
  startAiClassificationJob: jest.fn(),
}));

import background from '../entrypoints/background';
import { warmupBookmarkFavicons } from '../services/favicon-warmup-service';
import { getAiClassificationJob, markAiClassificationRecoverable, startAiClassificationJob } from '../services/ai-classification-service';

describe('background runtime.onMessage', () => {
  const mockedWarmup = warmupBookmarkFavicons as jest.MockedFunction<typeof warmupBookmarkFavicons>;
  const mockedStartAi = startAiClassificationJob as jest.MockedFunction<typeof startAiClassificationJob>;
  const mockedGetAi = getAiClassificationJob as jest.MockedFunction<typeof getAiClassificationJob>;
  const mockedMarkRecoverable = markAiClassificationRecoverable as jest.MockedFunction<typeof markAiClassificationRecoverable>;

  beforeEach(() => {
    jest.clearAllMocks();
    onMessageListener = null;
  });

  test('WARMUP_BOOKMARK_FAVICONS 会通过 sendResponse 返回结果', async () => {
    mockedWarmup.mockResolvedValue({
      success: true,
      attempted: 2,
      warmed: 2,
      failed: 0,
      skipped: 0,
      durationMs: 123,
    });

    (background as any).main();
    expect(onMessageListener).toBeTruthy();

    const listener = onMessageListener;
    if (!listener) {
      throw new Error('runtime.onMessage listener 未注册');
    }

    const sendResponse = jest.fn();
    const returned = listener(
      { type: 'WARMUP_BOOKMARK_FAVICONS', payload: { scope: 'bookmark_bar' } },
      null,
      sendResponse,
    );

    // Chrome 异步消息响应需要返回 true
    expect(returned).toBe(true);

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      data: {
        success: true,
        attempted: 2,
        warmed: 2,
        failed: 0,
        skipped: 0,
        durationMs: 123,
      },
      error: undefined,
    });
  });

  test('START_AI_CLASSIFICATION 只创建后台任务，不等待 Popup 生命周期', async () => {
    const job = { id: 'job-1', state: 'queued' } as any;
    mockedStartAi.mockResolvedValue(job);

    (background as any).main();
    const listener = onMessageListener;
    if (!listener) throw new Error('runtime.onMessage listener 未注册');
    const sendResponse = jest.fn();
    const returned = listener({ type: 'START_AI_CLASSIFICATION' }, null, sendResponse);

    expect(returned).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockedStartAi).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ success: true, job });
  });

  test('重新打开 Popup 只读取任务，不会把正在运行的任务暂停', async () => {
    const job = { id: 'job-running', state: 'classifying' } as any;
    mockedGetAi.mockResolvedValue(job);
    mockedMarkRecoverable.mockResolvedValue({ ...job, state: 'paused' });

    (background as any).main();
    const listener = onMessageListener;
    if (!listener) throw new Error('runtime.onMessage listener 未注册');
    const sendResponse = jest.fn();
    listener({ type: 'GET_AI_CLASSIFICATION_JOB' }, null, sendResponse);
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(sendResponse).toHaveBeenCalledWith({ success: true, job });
    expect(mockedMarkRecoverable).not.toHaveBeenCalled();
  });
});
