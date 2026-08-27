jest.mock('wxt/utils/define-background', () => ({
  defineBackground: (config: unknown) => config,
}));

const createEvent = () => ({
  addListener: jest.fn(),
  removeListener: jest.fn(),
});

let onAlarmListener: ((alarm: { name: string }) => void) | null = null;

jest.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      onInstalled: createEvent(),
      onStartup: createEvent(),
      onMessage: createEvent(),
      getManifest: jest.fn(() => ({ version: '2.1.3' })),
    },
    alarms: {
      onAlarm: {
        addListener: jest.fn((listener: (alarm: { name: string }) => void) => {
          onAlarmListener = listener;
        }),
      },
    },
    bookmarks: {
      onCreated: createEvent(),
      onRemoved: createEvent(),
      onChanged: createEvent(),
      onMoved: createEvent(),
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
    executeTask: jest.fn(),
  },
}));

jest.mock('../services/trigger-service', () => ({
  __esModule: true,
  default: {
    init: jest.fn(),
    handleEventTrigger: jest.fn(),
  },
}));

jest.mock('../services/ai-classification-service', () => ({
  cancelAiClassificationJob: jest.fn(),
  ensureAiClassificationAlarm: jest.fn().mockResolvedValue(true),
  getAiClassificationJob: jest.fn(),
  getLastAiClassificationPlan: jest.fn(),
  markAiClassificationRecoverable: jest.fn(),
  recoverAiClassificationOnWorkerStart: jest.fn().mockResolvedValue(null),
  resumeAiClassificationJob: jest.fn(),
  runAiClassificationJob: jest.fn(),
  startAiClassificationJob: jest.fn(),
}));

import background from '../entrypoints/background';
import { ensureAiClassificationAlarm, getAiClassificationJob, recoverAiClassificationOnWorkerStart, runAiClassificationJob } from '../services/ai-classification-service';

describe('background AI recovery lifecycle', () => {
  const mockedGetJob = getAiClassificationJob as jest.MockedFunction<typeof getAiClassificationJob>;
  const mockedEnsureAlarm = ensureAiClassificationAlarm as jest.MockedFunction<typeof ensureAiClassificationAlarm>;
  const mockedRecover = recoverAiClassificationOnWorkerStart as jest.MockedFunction<typeof recoverAiClassificationOnWorkerStart>;
  const mockedRun = runAiClassificationJob as jest.MockedFunction<typeof runAiClassificationJob>;

  beforeEach(() => {
    jest.clearAllMocks();
    onAlarmListener = null;
    mockedRecover.mockResolvedValue(null);
    mockedGetJob.mockResolvedValue(null);
    mockedEnsureAlarm.mockResolvedValue(true);
  });

  test('a new worker reconciles persisted AI state without writing bookmarks', async () => {
    (background as any).main();

    await new Promise<void>(resolve => setImmediate(resolve));

    expect(mockedRecover).toHaveBeenCalledTimes(1);
    expect(onAlarmListener).toBeTruthy();
  });

  test('an AI alarm wakes queued/classifying work but never resumes a paused job', async () => {
    (background as any).main();
    if (!onAlarmListener) throw new Error('AI alarm listener 未注册');

    mockedGetJob.mockResolvedValue({ id: 'job-queued', state: 'queued' } as any);
    onAlarmListener({ name: 'marksvault-ai-job-queued' });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(mockedEnsureAlarm).toHaveBeenCalledWith({ id: 'job-queued', state: 'queued' });
    expect(mockedRun).toHaveBeenCalledTimes(1);

    mockedRun.mockClear();
    mockedGetJob.mockResolvedValue({ id: 'job-paused', state: 'paused' } as any);
    onAlarmListener({ name: 'marksvault-ai-job-paused' });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(mockedRun).not.toHaveBeenCalled();
  });

  test('non-AI alarms do not touch the classification runner', async () => {
    (background as any).main();
    if (!onAlarmListener) throw new Error('AI alarm listener 未注册');

    onAlarmListener({ name: 'unrelated-alarm' });
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(mockedGetJob).not.toHaveBeenCalled();
    expect(mockedRun).not.toHaveBeenCalled();
  });
});
