import { browser } from 'wxt/browser';
import triggerService from './trigger-service';
import taskService from './task-service';
import {
  Task,
  TaskStatus,
  TaskExecutionResult,
  ExecutionOutcome,
  createBackupAction,
  createManualTrigger,
} from '../types/task';

describe('trigger-service 失败任务恢复', () => {
  beforeEach(async () => {
    await browser.storage.local.clear();
    await browser.storage.sync.clear();
  });

  // 构造一个 FAILED 状态且历史最后一条为指定执行结果的任务
  const createFailedTask = async (id: string, lastExecution: TaskExecutionResult): Promise<void> => {
    await taskService.createTask({
      id,
      name: `失败任务 ${id}`,
      status: TaskStatus.FAILED,
      trigger: createManualTrigger('手动'),
      action: createBackupAction('backup'),
    });
    await taskService.updateTask(id, {
      history: {
        executions: [lastExecution],
        lastExecution,
      },
    });
  };

  test('上次执行 outcome=INTERRUPTED 的任务不被自动恢复（保持 FAILED）', async () => {
    const taskId = 'recover_interrupted_not_enabled';
    await createFailedTask(taskId, {
      success: false,
      timestamp: Date.now(),
      outcome: ExecutionOutcome.INTERRUPTED,
      error: '任务执行中断（扩展后台终止）',
    });

    await triggerService.tryRecoverFailedTasks();

    // 执行中断不会自动续跑：任务保持 FAILED
    const task = (await taskService.getTaskById(taskId)).data as Task;
    expect(task.status).toBe(TaskStatus.FAILED);
  });

  test('普通失败（outcome 缺省或 failure，非凭据错误）恢复为 ENABLED', async () => {
    // 旧数据：outcome 缺省（仅 success=false），非凭据错误
    const legacyId = 'recover_failure_legacy';
    await createFailedTask(legacyId, {
      success: false,
      timestamp: Date.now(),
      error: 'GitHub备份失败: 网络错误: Failed to fetch',
    });

    // 新数据：显式 outcome=failure，非凭据错误
    const explicitId = 'recover_failure_explicit';
    await createFailedTask(explicitId, {
      success: false,
      timestamp: Date.now(),
      outcome: ExecutionOutcome.FAILURE,
      error: '整理书签失败',
    });

    await triggerService.tryRecoverFailedTasks();

    const legacy = (await taskService.getTaskById(legacyId)).data as Task;
    expect(legacy.status).toBe(TaskStatus.ENABLED);
    const explicit = (await taskService.getTaskById(explicitId)).data as Task;
    expect(explicit.status).toBe(TaskStatus.ENABLED);
  });

  test('凭据错误（未找到GitHub凭据）的任务不被自动恢复', async () => {
    const taskId = 'recover_credential_error';
    await createFailedTask(taskId, {
      success: false,
      timestamp: Date.now(),
      outcome: ExecutionOutcome.FAILURE,
      error: '未找到GitHub凭据，请在设置中配置',
    });

    await triggerService.tryRecoverFailedTasks();

    // 凭据问题需要用户重新授权后手动恢复
    const task = (await taskService.getTaskById(taskId)).data as Task;
    expect(task.status).toBe(TaskStatus.FAILED);
  });
});
