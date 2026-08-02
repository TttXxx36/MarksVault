/**
 * 任务执行引擎
 * 负责执行触发的任务并记录结果
 */

import {
  Task,
  TaskStatus,
  ActionType,
  BackupAction,
  OrganizeAction,
  PushAction,
  SelectivePushAction,
  TaskExecutionResult,
  TaskSnapshot,
  ExecutionSource,
  ExecutionOutcome,
  TriggerType,
} from '../types/task';
import taskService from './task-service';
import backupService from './backup-service';
import organizeService from './organize-service';
import storageService from '../utils/storage-service';
import bookmarkService from '../utils/bookmark-service';
import githubService, { isRetryableGitHubError } from './github-service';
import { browser } from 'wxt/browser';

// 任务执行配置
interface TaskExecutionConfig {
  maxRetries: number;         // 最大重试次数
  retryDelay: number;         // 重试延迟(毫秒)
  timeout: number;            // 执行超时时间(毫秒)
  maxHistoryLength: number;   // 执行历史记录最大长度
}

// 默认配置
const DEFAULT_CONFIG: TaskExecutionConfig = {
  maxRetries: 3,              // 默认最多重试3次
  retryDelay: 2000,           // 默认重试延迟2秒
  timeout: 60000,             // 默认超时1分钟
  maxHistoryLength: 50        // 默认保留50条执行记录
};

/**
 * 执行租约
 * 一项任务在限定时间内已有任务执行负责运行的声明，用于阻止同一任务被重复执行。
 * 租约到期表示原任务执行已失去运行所有权。
 */
export interface ExecutionLease {
  taskId: string;        // 任务ID
  executionId: string;   // 执行ID（本次任务执行的唯一标识）
  acquiredAt: number;    // 获取时间（毫秒时间戳）
  expiresAt: number;     // 到期时间（毫秒时间戳）
}

// 执行租约在 storage.local 中的存储键前缀（每个任务一个独立键，避免跨任务写入互相覆盖）
export const EXECUTION_LEASE_KEY_PREFIX = 'execution_lease:';

// 执行租约时长：2倍执行超时（120秒），为原执行留足余量；到期后原执行失去运行所有权
const EXECUTION_LEASE_DURATION = DEFAULT_CONFIG.timeout * 2;

/**
 * 执行超时错误
 * 用于结构化识别超时结束的执行：超时后底层操作可能仍在进行（外部副作用不确定），
 * 结果应为"结果不确定"，不得进入按错误消息匹配的重试判定
 */
export class ExecutionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionTimeoutError';
  }
}

/**
 * 书签写入租约
 * 一次任务执行在限定时间内独占修改本地书签树的声明。它允许只读或上传操作并行，
 * 但阻止多个任务同时修改书签树。租约到期表示原任务执行已失去书签树写入权。
 */
export interface BookmarkWriteLease {
  taskId: string;        // 持有写入租约的任务ID
  executionId: string;   // 持有写入租约的任务执行ID
  acquiredAt: number;    // 获取时间（毫秒时间戳）
  expiresAt: number;     // 到期时间（毫秒时间戳）
}

// 书签写入租约在 storage.local 中的存储键（全局唯一：所有写入任务共用同一互斥声明）
export const BOOKMARK_WRITE_LEASE_KEY = 'bookmark_write_lease';

// 书签写入租约时长：与执行租约一致为 2倍执行超时（120秒），为原执行留足余量；
// SW 中断时此方法不会执行释放，租约在到期后自然失效，不会永久阻塞写入任务
const BOOKMARK_WRITE_LEASE_DURATION = DEFAULT_CONFIG.timeout * 2;

/**
 * 任务执行引擎
 * 负责执行触发的任务并记录执行结果
 */
export class TaskExecutor {
  private static instance: TaskExecutor | undefined;
  private config: TaskExecutionConfig;
  private executingTasks: Set<string> = new Set(); // 记录正在执行的任务ID

  // 互斥队列：串行化租约"检查-获取"与快照读写等临界区。
  // MV3 扩展单线程，但 await 会使多个执行流程交错，必须互斥才能保证原子性
  private leaseMutex: Promise<void> = Promise.resolve();

  // 任务快照的 storage.local 存储键
  private readonly SNAPSHOTS_KEY = 'execution_snapshots';

  /**
   * 私有构造函数，防止直接实例化
   */
  private constructor() {
    this.config = { ...DEFAULT_CONFIG };
    console.log('任务执行引擎已初始化');
  }

  /**
   * 在互斥队列中串行执行临界区
   * 链式队列保证同一时刻只有一个临界区在运行；fn 抛出异常时同样释放互斥，
   * 避免后续临界区永久等待
   * @param fn 需要互斥执行的异步操作
   * @returns fn 的执行结果
   */
  private async withLeaseMutex<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.leaseMutex;
    let release!: () => void;
    this.leaseMutex = new Promise(r => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * 读取全部任务快照
   * @returns 任务ID到任务快照的映射，读取失败时返回空对象
   */
  private async getSnapshots(): Promise<Record<string, TaskSnapshot>> {
    try {
      const result = await storageService.getStorageData(this.SNAPSHOTS_KEY);
      if (!result.success || !result.data) {
        return {};
      }

      const raw = result.data as Record<string, TaskSnapshot>;
      const snapshots: Record<string, TaskSnapshot> = {};
      for (const [taskId, snapshot] of Object.entries(raw)) {
        if (snapshot && snapshot.taskId && snapshot.task) {
          snapshots[taskId] = snapshot;
        }
      }
      return snapshots;
    } catch (error) {
      console.error('读取任务快照失败:', error);
      return {};
    }
  }

  /**
   * 持久化任务快照（含执行输入）
   * 同一任务不可并发执行，因此直接以 taskId 为键保存，覆盖旧快照
   * @param snapshot 任务快照
   */
  private async saveSnapshot(snapshot: TaskSnapshot): Promise<void> {
    try {
      // 快照读-改-写纳入互斥：避免并发执行流程的快照读写相互覆盖
      await this.withLeaseMutex(async () => {
        const result = await storageService.getStorageData(this.SNAPSHOTS_KEY);
        const snapshots = result.success && result.data
          ? { ...(result.data as Record<string, TaskSnapshot>) }
          : {};
        snapshots[snapshot.taskId] = snapshot;
        await storageService.setStorageData(this.SNAPSHOTS_KEY, snapshots);
      });
    } catch (error) {
      console.error(`保存任务快照 ${snapshot.taskId} 失败:`, error);
    }
  }

  /**
   * 删除任务快照
   * 任务执行正常结束时调用，使执行输入失效；
   * SW 中断时此方法不会执行，快照保留以便恢复判定
   * 删除失败时自动重试一次（共 2 次尝试），避免瞬时读写冲突导致快照残留
   * @param taskId 任务ID
   */
  private async deleteSnapshot(taskId: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // 快照读-改-写纳入互斥：避免并发执行流程的快照读写相互覆盖
        await this.withLeaseMutex(async () => {
          const result = await storageService.getStorageData(this.SNAPSHOTS_KEY);
          if (!result.success || !result.data) {
            return;
          }
          const snapshots = result.data as Record<string, TaskSnapshot>;
          if (!(taskId in snapshots)) {
            return;
          }
          delete snapshots[taskId];
          await storageService.setStorageData(this.SNAPSHOTS_KEY, snapshots);
        });
        return;
      } catch (error) {
        // 第一次失败后重试一次；重试仍失败才记录错误
        if (attempt === 1) {
          console.error(`删除任务快照 ${taskId} 失败:`, error);
        }
      }
    }
  }

  /**
   * 获取指定任务未完成的执行快照
   * 用于 SW 中断后的可恢复判定：快照存在说明该任务有一次已开始但未正常结束的执行，
   * 其执行输入（如选中的书签）仍可从快照读取
   * @param taskId 任务ID
   * @returns 任务快照或 null（无未完成执行）
   */
  public async getPendingSnapshot(taskId: string): Promise<TaskSnapshot | null> {
    const snapshots = await this.getSnapshots();
    return snapshots[taskId] ?? null;
  }

  /**
   * 重置单例（测试辅助）
   * 用于模拟 Service Worker 重启时重建执行引擎实例；生产代码不应调用
   */
  public static resetForTesting(): void {
    TaskExecutor.instance = undefined;
  }

  /**
   * 获取TaskExecutor实例
   * @returns TaskExecutor单例
   */
  public static getInstance(): TaskExecutor {
    if (!TaskExecutor.instance) {
      TaskExecutor.instance = new TaskExecutor();
    }
    return TaskExecutor.instance;
  }

  /**
   * 检查执行租约是否可用（不存在或已到期）
   * 防重复判定以持久化执行租约为准
   * @param taskId 任务ID
   * @returns true 表示无未到期租约，可接受新的执行请求
   */
  private async isExecutionLeaseAvailable(taskId: string): Promise<boolean> {
    const result = await storageService.getStorageData(this.getExecutionLeaseKey(taskId));
    if (!result.success) {
      // 无法确认租约状态时拒绝执行请求（安全优先）
      return false;
    }
    const lease = result.data as ExecutionLease | null;
    if (!lease) {
      return true;
    }
    // 租约到期表示原任务执行已失去运行所有权
    return lease.expiresAt <= Date.now();
  }

  /**
   * 获取执行租约
   * 租约可靠保存后执行请求才被接受并形成任务执行
   * @param taskId 任务ID
   * @returns 获取结果与执行ID
   */
  private async acquireExecutionLease(taskId: string): Promise<{ success: boolean; executionId: string }> {
    const now = Date.now();
    const executionId = this.generateExecutionId();
    const lease: ExecutionLease = {
      taskId,
      executionId,
      acquiredAt: now,
      expiresAt: now + EXECUTION_LEASE_DURATION,
    };
    const saveResult = await storageService.setStorageData(this.getExecutionLeaseKey(taskId), lease);
    if (!saveResult.success) {
      return { success: false, executionId: '' };
    }
    return { success: true, executionId };
  }

  /**
   * 释放执行租约
   * 仅释放本执行持有的租约（校验执行ID），避免误删租约到期后新获取的租约
   * @param taskId 任务ID
   * @param executionId 本执行的执行ID
   */
  private async releaseExecutionLease(taskId: string, executionId: string): Promise<void> {
    try {
      const result = await storageService.getStorageData(this.getExecutionLeaseKey(taskId));
      if (!result.success) {
        return;
      }
      const lease = result.data as ExecutionLease | null;
      if (lease && lease.executionId === executionId) {
        await browser.storage.local.remove(this.getExecutionLeaseKey(taskId));
      }
    } catch (error) {
      // 释放失败时租约将在到期后自然失效，不会永久阻塞任务
      console.warn(`任务 ${taskId} 释放执行租约失败:`, error);
    }
  }

  /**
   * 检查执行租约是否仍由本执行持有且未到期
   * 重试属于同一任务执行的执行尝试：仅在租约有效期内重试，
   * 租约到期或失效表示原执行已失去运行所有权，不得继续重试
   * @param taskId 任务ID
   * @param executionId 本执行的执行ID
   * @returns true 表示本执行仍持有有效租约，可继续重试
   */
  private async isExecutionLeaseActive(taskId: string, executionId: string): Promise<boolean> {
    const result = await storageService.getStorageData(this.getExecutionLeaseKey(taskId));
    if (!result.success) {
      return false;
    }
    const lease = result.data as ExecutionLease | null;
    return !!lease && lease.executionId === executionId && lease.expiresAt > Date.now();
  }

  /**
   * 判断任务操作是否修改书签树
   * 修改书签树的操作 = ORGANIZE 与 BACKUP/restore；
   * 只读/上传操作（BACKUP/backup、PUSH、SELECTIVE_PUSH）不修改书签树，无需获取写入租约
   * @param task 任务对象
   * @returns 是否需要获取书签写入租约
   */
  private isBookmarkWriteAction(task: Task): boolean {
    if (task.action.type === ActionType.ORGANIZE) {
      return true;
    }
    if (task.action.type === ActionType.BACKUP) {
      return (task.action as BackupAction).operation === 'restore';
    }
    return false;
  }

  /**
   * 检查书签写入租约是否可用（不存在或已到期）
   * @returns true 表示无未到期写入租约，可接受新的写入执行请求
   */
  private async isBookmarkWriteLeaseAvailable(): Promise<boolean> {
    const result = await storageService.getStorageData(BOOKMARK_WRITE_LEASE_KEY);
    if (!result.success) {
      // 无法确认租约状态时拒绝执行请求（安全优先）
      return false;
    }
    const lease = result.data as BookmarkWriteLease | null;
    if (!lease) {
      return true;
    }
    // 租约到期表示原任务执行已失去书签树写入权
    return lease.expiresAt <= Date.now();
  }

  /**
   * 获取书签写入租约
   * 租约可靠保存后本次执行才拥有书签树独占写入权；
   * 重试属于同一任务执行的执行尝试，重新获取并覆盖原租约
   * @param taskId 持有写入租约的任务ID
   * @param executionId 本次任务执行的执行ID
   * @returns 获取结果
   */
  private async acquireBookmarkWriteLease(taskId: string, executionId: string): Promise<{ success: boolean }> {
    const now = Date.now();
    const lease: BookmarkWriteLease = {
      taskId,
      executionId,
      acquiredAt: now,
      expiresAt: now + BOOKMARK_WRITE_LEASE_DURATION,
    };
    const saveResult = await storageService.setStorageData(BOOKMARK_WRITE_LEASE_KEY, lease);
    if (!saveResult.success) {
      return { success: false };
    }
    return { success: true };
  }

  /**
   * 释放书签写入租约
   * 仅释放本执行持有的写入租约（校验执行ID），避免误删租约到期后新获取的租约
   * @param executionId 本执行的执行ID
   */
  private async releaseBookmarkWriteLease(executionId: string): Promise<void> {
    try {
      const result = await storageService.getStorageData(BOOKMARK_WRITE_LEASE_KEY);
      if (!result.success) {
        return;
      }
      const lease = result.data as BookmarkWriteLease | null;
      if (lease && lease.executionId === executionId) {
        await browser.storage.local.remove(BOOKMARK_WRITE_LEASE_KEY);
      }
    } catch (error) {
      // 释放失败时租约将在到期后自然失效，不会永久阻塞写入任务
      console.warn('释放书签写入租约失败:', error);
    }
  }

  /**
   * 生成执行ID
   * 用于区分同一任务的不同任务执行
   */
  private generateExecutionId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private getExecutionLeaseKey(taskId: string): string {
    return `${EXECUTION_LEASE_KEY_PREFIX}${taskId}`;
  }

  /**
   * 更新执行配置
   * @param config 部分或完整的配置对象
   */
  public updateConfig(config: Partial<TaskExecutionConfig>): void {
    this.config = { ...this.config, ...config };
    console.log('任务执行引擎配置已更新:', this.config);
  }

  /**
   * 初始化任务执行引擎
   * 对遗留 RUNNING 任务按执行租约状态恢复，取代一律 FAILED 的恢复逻辑：
   * - 存在未到期执行租约 → 恢复为"结果不确定"（原执行可能仍有外部副作用）
   * - 执行租约已到期或不存在 → 恢复为"执行中断"（原执行已失去运行所有权）
   * - 无遗留快照 → 无未正常结束的执行，仅清理 RUNNING 状态残留
   */
  public async init(): Promise<void> {
    try {
      const runningTasksResult = await taskService.getTasksByStatus(TaskStatus.RUNNING);
      if (runningTasksResult.success && runningTasksResult.data.length > 0) {
        const runningTasks = runningTasksResult.data as Task[];
        console.log(`发现 ${runningTasks.length} 个处于RUNNING状态的任务，正在按执行租约状态恢复...`);

        for (const task of runningTasks) {
          await this.recoverInterruptedExecution(task.id);
        }
      }

      console.log('任务执行引擎初始化完成');
    } catch (error) {
      console.error('任务执行引擎初始化失败:', error);
    }
  }

  /**
   * 按当前状态更新任务状态（恢复与收尾兜底专用）
   * 启用状态是稳定配置，执行结果不覆盖：当前状态为 DISABLED（用户主动禁用）时
   * 保持禁用，仅由调用方负责写入执行历史；仅 RUNNING/ENABLED 等可流转状态
   * 才按预期状态更新，避免执行收尾静默改变用户的启用/禁用意图
   * @param taskId 任务ID
   * @param status 预期状态（仅当前状态非 DISABLED 时生效）
   */
  private async setTaskStatusPreservingDisabled(taskId: string, status: TaskStatus): Promise<void> {
    try {
      const taskResult = await taskService.getTaskById(taskId);
      if (!taskResult.success) {
        console.error(`任务 ${taskId} 更新状态失败: 无法读取任务当前状态`);
        return;
      }
      const currentStatus = (taskResult.data as Task).status;
      if (currentStatus === TaskStatus.DISABLED) {
        console.warn(`任务 ${taskId} 已被用户禁用，保持 DISABLED，不覆盖为 ${status}`);
        return;
      }
      await taskService.setTaskStatus(taskId, status);
    } catch (error) {
      console.error(`任务 ${taskId} 更新状态为 ${status} 失败:`, error);
    }
  }

  /**
   * 恢复遗留执行（SW 中断/重启后）
   * 按执行租约状态判定遗留执行的结果并写入执行历史：
   * - 未到期租约 → "结果不确定"：原执行可能仍有外部副作用，系统无法确认操作是否完成；
   *   任务恢复为 ENABLED（不等于失败），未到期租约保留以继续阻止重复执行
   * - 已到期/不存在租约 → "执行中断"：原执行已失去运行所有权；任务恢复为 FAILED，
   *   已到期租约一并清理
   * - 无快照 → 无遗留执行（如超时已收尾但状态残留）：不写入历史，仅恢复状态为 ENABLED
   * 恢复完成后清理快照（执行输入已失效）
   * 状态恢复均遵守"启用状态是稳定配置"规则：执行期间被用户禁用的任务（DISABLED）
   * 保持禁用，仅写入历史
   * @param taskId 任务ID
   */
  private async recoverInterruptedExecution(taskId: string): Promise<void> {
    const snapshot = await this.getPendingSnapshot(taskId);
    if (!snapshot) {
      // 无遗留执行：说明原执行已正常收尾（快照在收尾时被清理），仅存在 RUNNING 状态残留。
      // 读取执行租约：若存在且已到期，原执行已失去运行所有权，清理该租约；
      // 未到期或不存在则不管（未到期保留以阻止并发，与 UNCERTAIN 分支一致）
      const leaseResult = await storageService.getStorageData(this.getExecutionLeaseKey(taskId));
      const lease = leaseResult.success ? (leaseResult.data as ExecutionLease | null) : null;
      if (lease && lease.expiresAt <= Date.now()) {
        await this.releaseExecutionLease(taskId, lease.executionId);
      }
      await this.setTaskStatusPreservingDisabled(taskId, TaskStatus.ENABLED);
      return;
    }

    const leaseResult = await storageService.getStorageData(this.getExecutionLeaseKey(taskId));
    const lease = leaseResult.success ? (leaseResult.data as ExecutionLease | null) : null;
    const leaseActive = !!lease && lease.expiresAt > Date.now();

    if (leaseActive) {
      // 租约未到期：原执行可能仍在进行或刚被中断，存在外部副作用，结果不确定
      const executionResult: TaskExecutionResult = {
        success: false,
        outcome: ExecutionOutcome.UNCERTAIN,
        timestamp: Date.now(),
        source: snapshot.source,
        error: '任务执行结果不确定（扩展后台重启，无法确认操作是否完成）',
        details: '系统无法确认任务操作是否完成，已恢复为"结果不确定"；该结果不会自动重试',
      };
      console.warn(`任务 ${taskId} 存在未到期执行租约，恢复为结果不确定...`);
      await taskService.updateTaskExecutionHistory(taskId, executionResult);
      // 结果不确定不等于失败：任务恢复为 ENABLED（可再次执行）；
      // 未到期租约保留，在到期前继续阻止同一任务被重复执行
      await this.setTaskStatusPreservingDisabled(taskId, TaskStatus.ENABLED);
    } else {
      // 租约已到期或不存在：原执行已失去运行所有权，执行中断
      const executionResult: TaskExecutionResult = {
        success: false,
        outcome: ExecutionOutcome.INTERRUPTED,
        timestamp: Date.now(),
        source: snapshot.source,
        error: '任务执行中断（扩展后台终止）',
        details: '任务执行因扩展后台终止而停止，无法继续原执行尝试；执行中断不会自动续跑',
      };
      console.warn(`任务 ${taskId} 执行租约已到期，恢复为执行中断...`);
      await taskService.updateTaskExecutionHistory(taskId, executionResult);
      await this.setTaskStatusPreservingDisabled(taskId, TaskStatus.FAILED);
      // 原执行已失去运行所有权，清理已到期租约
      if (lease) {
        await this.releaseExecutionLease(taskId, lease.executionId);
      }
    }

    // 遗留执行已判定终结，执行输入失效，清理快照
    await this.deleteSnapshot(taskId);
  }

  /**
   * 执行任务
   * 执行开始时固化任务快照（含执行输入），执行全程使用快照，不实时读取任务定义，
   * 因此执行期间任务被编辑或删除不影响本次执行
   * @param taskId 要执行的任务ID
   * @param retryCount 当前重试次数，默认为0
   * @param source 执行来源，默认为 manual（用户明确发起）
   * @returns 执行结果
   */
  public async executeTask(
    taskId: string,
    retryCount: number = 0,
    source: ExecutionSource = 'manual'
  ): Promise<TaskExecutionResult> {
    return this.executeTaskInternal(taskId, retryCount, source);
  }

  /**
   * 执行任务（内部实现）
   * 重试属于同一任务执行的执行尝试：重试时延续执行租约（不覆盖获取新租约），
   * 仅在租约仍有效（本执行仍持有运行所有权）时继续重试，租约到期或失效后停止重试
   * @param taskId 要执行的任务ID
   * @param retryCount 当前重试次数
   * @param source 执行来源
   * @param leaseExecutionId 重试时继承的本执行执行租约ID（首次执行为空，由本方法获取）
   * @returns 执行结果
   */
  private async executeTaskInternal(
    taskId: string,
    retryCount: number,
    source: ExecutionSource,
    leaseExecutionId?: string
  ): Promise<TaskExecutionResult> {
    // 创建初始执行结果对象
    let executionResult: TaskExecutionResult = {
      success: false,
      timestamp: Date.now(),
      details: '',
      source,
    };

    // 执行租约阶段：
    // - 首次执行请求（无继承租约）：检查可用性后获取新租约，租约可靠保存后执行请求才被接受
    // - 重试（继承租约）：延续原执行租约，不覆盖获取；租约到期或失效表示本执行已失去
    //   运行所有权，停止重试并按失败收尾
    // 检查-获取在互斥中完成：避免并发请求在"检查可用"与"获取租约"之间交错
    // 导致同一任务被重复执行
    let activeLeaseExecutionId: string;
    if (leaseExecutionId === undefined) {
      const leaseAcquired = await this.withLeaseMutex(async (): Promise<
        { success: true; executionId: string } | { success: false; error: string }
      > => {
        if (retryCount === 0) {
          // 检查任务是否已在执行中（内存快速检查）
          if (this.executingTasks.has(taskId)) {
            return { success: false, error: '任务正在执行中' };
          }
          // 存在未到期执行租约时拒绝执行请求，被拒绝的请求不产生执行历史
          if (!(await this.isExecutionLeaseAvailable(taskId))) {
            return { success: false, error: '任务正在执行中' };
          }
        }

        // 获取执行租约：租约可靠保存后执行请求才被接受
        const lease = await this.acquireExecutionLease(taskId);
        if (!lease.success) {
          return { success: false, error: '获取执行租约失败' };
        }
        return { success: true, executionId: lease.executionId };
      });

      // 获取失败：保持既有拒绝路径（不入历史、不改状态）
      if (!leaseAcquired.success) {
        console.warn(`任务 ${taskId} 拒绝执行请求: ${leaseAcquired.error}`);
        executionResult.error = leaseAcquired.error;
        return executionResult;
      }
      activeLeaseExecutionId = leaseAcquired.executionId;
    } else if (!(await this.isExecutionLeaseActive(taskId, leaseExecutionId))) {
      // 防御分支：重试路径（retryTask）在延迟后已校验租约，此处兜底确保
      // 租约失效时不再发起任何执行尝试
      console.warn(`任务 ${taskId} 执行租约已失效，停止重试...`);
      executionResult.success = false;
      executionResult.outcome = ExecutionOutcome.FAILURE;
      executionResult.error = '执行租约已失效，停止重试';
      executionResult.details = '执行租约已到期或失效，原执行已失去运行所有权，停止重试';
      executionResult.source = source;
      await taskService.updateTaskExecutionHistory(taskId, executionResult);
      await taskService.setTaskStatus(taskId, TaskStatus.FAILED);
      return executionResult;
    } else {
      activeLeaseExecutionId = leaseExecutionId;
    }

    // 将任务添加到执行中集合
    this.executingTasks.add(taskId);

    const executionStartTime = new Date();
    console.log(`[${executionStartTime.toLocaleString()}] 开始执行任务: ${taskId}${retryCount > 0 ? ` (重试 ${retryCount}/${this.config.maxRetries})` : ''}`);

    // 超时定时器句柄（用于清理，避免悬挂定时器导致资源泄漏）
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    // 是否发生执行超时：超时后底层操作可能仍在运行，finally 中保留租约直至自然到期
    let timeoutOccurred = false;

    // 是否持有书签写入租约（finally 中按持有状态释放，避免误删其他任务新获取的租约）
    let writeLeaseHeld = false;

    // 是否进入重试：重试延续执行租约（不重新获取），本层 finally 须跳过执行租约释放，
    // 由重试链最内层在执行收尾时释放，避免 finally 在本层返回值求值后立即释放租约
    let retrying = false;

    try {
      // 获取任务详情
      const taskResult = await taskService.getTaskById(taskId);

      // 如果找不到任务，返回失败
      if (!taskResult.success) {
        executionResult.error = `获取任务失败: ${taskResult.error}`;
        executionResult.timestamp = Date.now();
        return executionResult;
      }

      const task = taskResult.data as Task;

      // 书签写入租约：修改书签树的任务（整理、恢复）在每次执行尝试开始时检查并获取，
      // 阻止多个任务同时修改书签树；只读/上传类任务不获取写入租约，可与写入任务并行。
      // 获取顺序：先执行租约（任务执行所有权），后写入租约（书签树独占权）；
      // 被写入租约阻止时拒绝执行请求（不产生执行历史），并立即释放刚获取的执行租约，避免残留
      // 检查-获取在互斥中完成：避免并发写入请求在"检查可用"与"获取租约"之间交错导致双重获取
      if (this.isBookmarkWriteAction(task)) {
        const writeLeaseResult = await this.withLeaseMutex(async () => {
          if (!(await this.isBookmarkWriteLeaseAvailable())) {
            return { success: false, denied: true };
          }
          const acquired = await this.acquireBookmarkWriteLease(taskId, activeLeaseExecutionId);
          return { success: acquired.success, denied: false };
        });

        if (!writeLeaseResult.success) {
          // 事件触发跳过本次执行请求；手动触发返回失败并带清晰提示
          const error = writeLeaseResult.denied
            ? (source === 'event'
              ? '另一个任务正在修改书签树，本次执行被跳过'
              : '另一个任务正在修改书签树，请稍后重试')
            : '获取书签写入租约失败';
          console.warn(`任务 ${taskId} 获取书签写入租约失败，拒绝执行请求...`);
          executionResult.error = error;
          // 立即释放刚获取的执行租约，避免残留
          await this.releaseExecutionLease(taskId, activeLeaseExecutionId);
          // 重试层被拒时任务之前已被置 RUNNING，必须恢复 ENABLED 否则永久卡死
          if (retryCount > 0) {
            await taskService.setTaskStatus(taskId, TaskStatus.ENABLED);
          }
          return executionResult;
        }
        writeLeaseHeld = true;
      }

      // 固化任务快照：执行开始时的任务定义（含执行输入），执行全程使用快照，
      // 任务后续被编辑或删除不会影响本次执行
      await this.saveSnapshot({
        taskId,
        task,
        source,
        createdAt: Date.now(),
      });

      // 任务执行前更新任务状态为RUNNING
      await taskService.setTaskStatus(taskId, TaskStatus.RUNNING);

      // 开始计时
      const startTime = Date.now();

      // 设置初始执行结果
      executionResult = {
        success: false,
        timestamp: startTime,
        details: '',
        source,
      };

      // 创建超时Promise
      const timeoutPromise = new Promise<TaskExecutionResult>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new ExecutionTimeoutError(`任务执行超时(${this.config.timeout / 1000}秒)`));
        }, this.config.timeout);
      });

      // 创建执行Promise
      const executePromise = (async () => {
        // 根据任务类型执行不同的操作
        switch (task.action.type) {
          case ActionType.BACKUP:
            return await this.executeBackupAction(task);
          case ActionType.ORGANIZE:
            return await this.executeOrganizeAction(task);
          case ActionType.PUSH:
            return await this.executePushAction(task);
          case ActionType.SELECTIVE_PUSH:
            return await this.executeSelectivePush(task);
          default:
            throw new Error(`不支持的任务类型: ${(task.action as any).type}`);
        }
      })();

      // 竞争模式，哪个先完成就用哪个结果
      executionResult = await Promise.race([executePromise, timeoutPromise]);

      // 清理超时定时器（避免后台悬挂定时器导致资源泄漏）
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      // 添加执行持续时间
      executionResult.duration = Date.now() - startTime;

      // 记录执行来源（动作执行器返回的结果不包含来源，此处统一补充）
      executionResult.source = source;

      // 结果类型：未显式声明时按 success 推断（兼容动作执行器返回的旧格式结果）
      executionResult.outcome ??= executionResult.success ? ExecutionOutcome.SUCCESS : ExecutionOutcome.FAILURE;

      // 执行成功：更新任务执行历史记录并返回；
      // 执行失败（含可重试的临时性失败）统一走重试判定与失败收尾
      if (executionResult.success) {
        console.log(`更新任务 ${taskId} 执行历史记录...`);
        // 历史+状态为同一次写入：写入失败时任务可能残留 RUNNING，
        // 单独兜底恢复 ENABLED（读取当前状态，DISABLED 保持禁用意图）
        const historyResult = await taskService.updateTaskExecutionHistory(taskId, executionResult);
        if (!historyResult.success) {
          console.error(`任务 ${taskId} 更新执行历史失败:`, historyResult.error);
          await this.setTaskStatusPreservingDisabled(taskId, TaskStatus.ENABLED);
        }

        const executionEndTime = new Date();
        const executionTimeMessage = `开始: ${executionStartTime.toLocaleString()}, 结束: ${executionEndTime.toLocaleString()}, 耗时: ${Math.round((executionEndTime.getTime() - executionStartTime.getTime()) / 1000)}秒`;
        console.log(`任务 ${taskId} 执行完成, 结果: 成功, ${executionTimeMessage}`);
        return executionResult;
      }

      // 失败结果：补充失败详情（异常路径在 catch 中补充），
      // 结果不确定（UNCERTAIN）保持执行器提供的语义，不在此覆盖
      if (executionResult.outcome !== ExecutionOutcome.UNCERTAIN) {
        executionResult.details = executionResult.details || `执行失败${retryCount > 0 ? `，已重试 ${retryCount} 次` : ''}`;
      }

      // 统一重试判定与失败收尾（结果路径）
      if (this.shouldRetryExecution(executionResult, retryCount)) {
        retrying = true;
        return this.retryTask(taskId, retryCount, source, activeLeaseExecutionId);
      }
      return this.finalizeFailureResult(executionResult, taskId, executionStartTime);
    } catch (error) {
      // 超时结束的执行：底层操作可能仍在进行（外部副作用不确定），
      // 本次执行结果应为"结果不确定"：不进入重试、不把任务标记为 FAILED，
      // 保持 RUNNING 由租约驱动的恢复逻辑处理
      if (error instanceof ExecutionTimeoutError) {
        // 标记超时：finally 中保留租约直至自然到期，阻止底层仍在运行的操作被并发重入
        timeoutOccurred = true;
        const errorMessage = error.message;
        const startTime = executionResult.timestamp || Date.now();
        executionResult.success = false;
        executionResult.outcome = ExecutionOutcome.UNCERTAIN;
        executionResult.error = errorMessage;
        executionResult.details = `执行超时，结果不确定${retryCount > 0 ? `，已重试 ${retryCount} 次` : ''}`;
        executionResult.duration = Date.now() - startTime;
        executionResult.source = source;
        console.warn(`任务 ${taskId} 执行超时，结果不确定（底层操作可能仍在进行）`);

        // 更新任务历史记录
        await taskService.updateTaskExecutionHistory(taskId, executionResult);
        return executionResult;
      }

      // 处理错误：构造结构化失败结果。
      // 可重试性依据错误类型与状态码判定（isRetryableError），不匹配错误消息字符串
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`任务 ${taskId} 执行出错:`, errorMessage);

      // 确保startTime变量存在（在try块中可能未定义）
      const startTime = executionResult.timestamp || Date.now();
      executionResult.success = false;
      executionResult.outcome = ExecutionOutcome.FAILURE;
      executionResult.error = errorMessage;
      executionResult.details = `执行失败${retryCount > 0 ? `，已重试 ${retryCount} 次` : ''}`;
      executionResult.duration = Date.now() - startTime;
      executionResult.source = source;
      // 结构化可重试性标记：仅临时性失败（网络、限流、服务端错误等）可重试
      executionResult.retryable = this.isRetryableError(error);

      // 失败收尾与重试判定（异常路径）
      if (this.shouldRetryExecution(executionResult, retryCount)) {
        retrying = true;
        return this.retryTask(taskId, retryCount, source, activeLeaseExecutionId);
      }
      return this.finalizeFailureResult(executionResult, taskId, executionStartTime);
    } finally {
      if (timeoutOccurred) {
        // 底层操作可能仍在运行：保留执行租约与写入租约直至自然到期（120s），
        // 阻止并发重入/双写；快照照常清理（执行输入失效）
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        this.executingTasks.delete(taskId);
        await this.deleteSnapshot(taskId);
        console.warn(`[TaskExecutor] 执行超时（任务 ${taskId}），保留执行租约与书签写入租约直至到期`);
      } else {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        // 无论结果如何，从执行中任务集合中移除
        this.executingTasks.delete(taskId);

        // 清理任务快照：执行正常结束时执行输入失效；
        // retrying 时跳过：快照由重试层重新固化、最内层 finally 删除；
        // 若此处因 SW 中断未执行，快照保留在 storage 中供恢复判定
        if (!retrying) {
          await this.deleteSnapshot(taskId);
        }

        // 释放书签写入租约：与获取顺序相反，先释放写入租约，再释放执行租约。
        // 写入租约由重试层重新检查并获取（重试属于同一任务执行的执行尝试），本层总是释放
        if (writeLeaseHeld) {
          await this.releaseBookmarkWriteLease(activeLeaseExecutionId);
        }

        // 释放执行租约：执行结束后租约被释放，后续执行请求可通过。
        // 重试时跳过：重试延续执行租约（不重新获取），由重试链最内层收尾时释放，
        // 避免本层 finally 在返回值求值后立即释放租约导致重试层无租约可用
        if (!retrying) {
          await this.releaseExecutionLease(taskId, activeLeaseExecutionId);
        }
      }
      console.log(`任务 ${taskId} 已从执行队列移除`);
    }
  }

  /**
   * 失败结果收尾（结果路径与异常路径共用）
   * 结果不确定（UNCERTAIN）只记录历史，不标记 FAILED；
   * 其余失败记录执行历史并将任务状态设置为失败
   * @param executionResult 失败的执行结果
   * @param taskId 任务ID
   * @param executionStartTime 本次执行尝试的开始时间
   * @returns 执行结果
   */
  private async finalizeFailureResult(
    executionResult: TaskExecutionResult,
    taskId: string,
    executionStartTime: Date
  ): Promise<TaskExecutionResult> {
    // 结果不确定：系统无法确认任务操作是否完成，不得自动重试；
    // 不标记 FAILED，保持当前状态由租约驱动的恢复逻辑处理
    if (executionResult.outcome === ExecutionOutcome.UNCERTAIN) {
      console.warn(`任务 ${taskId} 执行结果不确定，记录历史但不标记为 FAILED`);
      await taskService.updateTaskExecutionHistory(taskId, executionResult);
      return executionResult;
    }

    // 失败收尾：记录执行历史并将任务状态设置为失败
    console.log(`更新任务 ${taskId} 执行历史(失败)...`);
    // 历史+状态为同一次写入：写入失败时任务可能残留 RUNNING，
    // 单独兜底标记 FAILED（读取当前状态，DISABLED 保持禁用意图）
    const historyResult = await taskService.updateTaskExecutionHistory(taskId, executionResult);
    if (!historyResult.success) {
      console.error(`任务 ${taskId} 更新执行历史(失败)失败:`, historyResult.error);
      await this.setTaskStatusPreservingDisabled(taskId, TaskStatus.FAILED);
    }

    console.log(`更新任务 ${taskId} 状态为 FAILED`);
    await this.setTaskStatusPreservingDisabled(taskId, TaskStatus.FAILED);

    const executionEndTime = new Date();
    const executionTimeMessage = `开始: ${executionStartTime.toLocaleString()}, 结束: ${executionEndTime.toLocaleString()}, 耗时: ${Math.round((executionEndTime.getTime() - executionStartTime.getTime()) / 1000)}秒`;
    console.error(`任务 ${taskId} 执行失败: ${executionResult.error}, ${executionTimeMessage}`);
    return executionResult;
  }

  /**
   * 判断执行结果是否应进入重试
   * 重试判定仅依据结构化信息，不匹配错误消息字符串：
   * - 未达到重试上限（retryCount < maxRetries）
   * - 执行失败（success=false）
   * - 结果不确定（UNCERTAIN：系统无法确认任务操作是否完成）不得自动重试
   * - 结果携带可重试性标记（retryable=true：网络、限流等临时性失败）
   * @param result 执行结果
   * @param retryCount 当前重试次数
   * @returns 是否进入重试
   */
  private shouldRetryExecution(result: TaskExecutionResult, retryCount: number): boolean {
    if (retryCount >= this.config.maxRetries) {
      return false;
    }
    if (result.success) {
      return false;
    }
    // 结果不确定：不得自动重试
    if (result.outcome === ExecutionOutcome.UNCERTAIN) {
      return false;
    }
    // 结构化可重试性标记：仅临时性失败可重试
    return result.retryable === true;
  }

  /**
   * 发起重试（重试路径）
   * 重试属于同一任务执行的执行尝试：等待重试延迟后递归执行；
   * 递归层入口校验执行租约仍由本执行持有，租约到期或失效表示原执行已失去
   * 运行所有权，停止重试并按失败收尾
   * @param taskId 任务ID
   * @param retryCount 当前重试次数
   * @param source 执行来源
   * @param leaseExecutionId 本执行的执行租约ID（重试时延续）
   * @returns 执行结果
   */
  private async retryTask(
    taskId: string,
    retryCount: number,
    source: ExecutionSource,
    leaseExecutionId: string
  ): Promise<TaskExecutionResult> {
    console.log(`将在 ${this.config.retryDelay / 1000} 秒后重试任务 ${taskId}`);

    // 从执行中任务集合中移除（重试层执行时重新加入）
    this.executingTasks.delete(taskId);

    // 等待重试延迟
    await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));

    // 递归执行下一次执行尝试（保持执行来源不变，延续执行租约）
    return this.executeTaskInternal(taskId, retryCount + 1, source, leaseExecutionId);
  }

  /**
   * 使用提供的任务数据直接执行任务（不从存储重新加载）
   * 主要用于选择性推送等需要运行时数据的任务
   * 传入的任务定义（含执行输入如 selections）随任务快照持久化到 storage.local，
   * SW 中断后仍可读取；执行输入不会写回任务的持久化配置
   * @param task 完整的任务对象（包含运行时数据如 selections）
   * @param retryCount 当前重试次数，默认为0
   * @param source 执行来源，默认为 manual（用户明确发起）
   * @returns 执行结果
   */
  public async executeTaskWithData(
    task: Task,
    retryCount: number = 0,
    source: ExecutionSource = 'manual'
  ): Promise<TaskExecutionResult> {
    return this.executeTaskWithDataInternal(task, retryCount, source);
  }

  /**
   * 使用提供的任务数据直接执行任务（内部实现，不从存储重新加载）
   * 重试属于同一任务执行的执行尝试：重试时延续执行租约（不覆盖获取新租约），
   * 仅在租约仍有效（本执行仍持有运行所有权）时继续重试，租约到期或失效后停止重试
   * @param task 完整的任务对象（包含运行时数据如 selections）
   * @param retryCount 当前重试次数
   * @param source 执行来源
   * @param leaseExecutionId 重试时继承的本执行执行租约ID（首次执行为空，由本方法获取）
   * @returns 执行结果
   */
  private async executeTaskWithDataInternal(
    task: Task,
    retryCount: number,
    source: ExecutionSource,
    leaseExecutionId?: string
  ): Promise<TaskExecutionResult> {
    const taskId = task.id;

    // 创建初始执行结果对象
    let executionResult: TaskExecutionResult = {
      success: false,
      timestamp: Date.now(),
      details: '',
      source,
    };

    // 执行租约阶段：
    // - 首次执行请求（无继承租约）：检查可用性后获取新租约，租约可靠保存后执行请求才被接受
    // - 重试（继承租约）：延续原执行租约，不覆盖获取；租约到期或失效表示本执行已失去
    //   运行所有权，停止重试并按失败收尾
    // 检查-获取在互斥中完成：避免并发请求在"检查可用"与"获取租约"之间交错
    // 导致同一任务被重复执行
    let activeLeaseExecutionId: string;
    if (leaseExecutionId === undefined) {
      const leaseAcquired = await this.withLeaseMutex(async (): Promise<
        { success: true; executionId: string } | { success: false; error: string }
      > => {
        if (retryCount === 0) {
          // 检查任务是否已在执行中（内存快速检查）
          if (this.executingTasks.has(taskId)) {
            return { success: false, error: '任务正在执行中' };
          }
          // 存在未到期执行租约时拒绝执行请求，被拒绝的请求不产生执行历史
          if (!(await this.isExecutionLeaseAvailable(taskId))) {
            return { success: false, error: '任务正在执行中' };
          }
        }

        // 获取执行租约：租约可靠保存后执行请求才被接受
        const lease = await this.acquireExecutionLease(taskId);
        if (!lease.success) {
          return { success: false, error: '获取执行租约失败' };
        }
        return { success: true, executionId: lease.executionId };
      });

      // 获取失败：保持既有拒绝路径（不入历史、不改状态）
      if (!leaseAcquired.success) {
        console.warn(`任务 ${taskId} 拒绝执行请求: ${leaseAcquired.error}`);
        executionResult.error = leaseAcquired.error;
        return executionResult;
      }
      activeLeaseExecutionId = leaseAcquired.executionId;
    } else if (!(await this.isExecutionLeaseActive(taskId, leaseExecutionId))) {
      // 防御分支：重试路径（retryTask）在延迟后已校验租约，此处兜底确保
      // 租约失效时不再发起任何执行尝试
      console.warn(`任务 ${taskId} 执行租约已失效，停止重试...`);
      executionResult.success = false;
      executionResult.outcome = ExecutionOutcome.FAILURE;
      executionResult.error = '执行租约已失效，停止重试';
      executionResult.details = '执行租约已到期或失效，原执行已失去运行所有权，停止重试';
      executionResult.source = source;
      await taskService.updateTaskExecutionHistory(taskId, executionResult);
      await taskService.setTaskStatus(taskId, TaskStatus.FAILED);
      return executionResult;
    } else {
      activeLeaseExecutionId = leaseExecutionId;
    }

    // 将任务添加到执行中集合
    this.executingTasks.add(taskId);

    const executionStartTime = new Date();
    console.log(`[${executionStartTime.toLocaleString()}] 开始执行任务(带数据): ${taskId}${retryCount > 0 ? ` (重试 ${retryCount}/${this.config.maxRetries})` : ''}`);

    // 超时定时器句柄（用于清理，避免悬挂定时器导致资源泄漏）
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    // 是否发生执行超时：超时后底层操作可能仍在运行，finally 中保留租约直至自然到期
    let timeoutOccurred = false;

    // 是否持有书签写入租约（finally 中按持有状态释放，避免误删其他任务新获取的租约）
    let writeLeaseHeld = false;

    // 是否进入重试：重试延续执行租约（不重新获取），本层 finally 须跳过执行租约释放，
    // 由重试链最内层在执行收尾时释放，避免 finally 在本层返回值求值后立即释放租约
    let retrying = false;

    try {
      // 书签写入租约：修改书签树的任务（整理、恢复）在每次执行尝试开始时检查并获取，
      // 阻止多个任务同时修改书签树；只读/上传类任务不获取写入租约，可与写入任务并行。
      // 获取顺序：先执行租约（任务执行所有权），后写入租约（书签树独占权）；
      // 被写入租约阻止时拒绝执行请求（不产生执行历史），并立即释放刚获取的执行租约，避免残留
      // 检查-获取在互斥中完成：避免并发写入请求在"检查可用"与"获取租约"之间交错导致双重获取
      if (this.isBookmarkWriteAction(task)) {
        const writeLeaseResult = await this.withLeaseMutex(async () => {
          if (!(await this.isBookmarkWriteLeaseAvailable())) {
            return { success: false, denied: true };
          }
          const acquired = await this.acquireBookmarkWriteLease(taskId, activeLeaseExecutionId);
          return { success: acquired.success, denied: false };
        });

        if (!writeLeaseResult.success) {
          // 事件触发跳过本次执行请求；手动触发返回失败并带清晰提示
          const error = writeLeaseResult.denied
            ? (source === 'event'
              ? '另一个任务正在修改书签树，本次执行被跳过'
              : '另一个任务正在修改书签树，请稍后重试')
            : '获取书签写入租约失败';
          console.warn(`任务 ${taskId} 获取书签写入租约失败，拒绝执行请求...`);
          executionResult.error = error;
          // 立即释放刚获取的执行租约，避免残留
          await this.releaseExecutionLease(taskId, activeLeaseExecutionId);
          // 重试层被拒时任务之前已被置 RUNNING，必须恢复 ENABLED 否则永久卡死
          if (retryCount > 0) {
            await taskService.setTaskStatus(taskId, TaskStatus.ENABLED);
          }
          return executionResult;
        }
        writeLeaseHeld = true;
      }

      // 固化任务快照：传入的任务定义（含执行输入如 selections）随快照持久化到 storage.local，
      // SW 中断后仍可读取；执行输入不会写回任务的持久化配置
      await this.saveSnapshot({
        taskId,
        task,
        source,
        createdAt: Date.now(),
      });

      // 任务执行前更新任务状态为RUNNING
      await taskService.setTaskStatus(taskId, TaskStatus.RUNNING);

      // 开始计时
      const startTime = Date.now();

      // 设置初始执行结果
      executionResult = {
        success: false,
        timestamp: startTime,
        details: '',
        source,
      };

      // 创建超时Promise
      const timeoutPromise = new Promise<TaskExecutionResult>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new ExecutionTimeoutError(`任务执行超时(${this.config.timeout / 1000}秒)`));
        }, this.config.timeout);
      });

      // 创建执行Promise - 直接使用传入的 task 对象（快照中的任务定义）
      const executePromise = (async () => {
        switch (task.action.type) {
          case ActionType.BACKUP:
            return await this.executeBackupAction(task);
          case ActionType.ORGANIZE:
            return await this.executeOrganizeAction(task);
          case ActionType.PUSH:
            return await this.executePushAction(task);
          case ActionType.SELECTIVE_PUSH:
            return await this.executeSelectivePush(task);
          default:
            throw new Error(`不支持的任务类型: ${(task.action as any).type}`);
        }
      })();

      // 竞争模式
      executionResult = await Promise.race([executePromise, timeoutPromise]);

      // 清理超时定时器（避免后台悬挂定时器导致资源泄漏）
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      // 添加执行持续时间
      executionResult.duration = Date.now() - startTime;

      // 记录执行来源（动作执行器返回的结果不包含来源，此处统一补充）
      executionResult.source = source;

      // 结果类型：未显式声明时按 success 推断（兼容动作执行器返回的旧格式结果）
      executionResult.outcome ??= executionResult.success ? ExecutionOutcome.SUCCESS : ExecutionOutcome.FAILURE;

      // 执行成功：更新任务执行历史记录并返回；
      // 执行失败（含可重试的临时性失败）统一走重试判定与失败收尾
      if (executionResult.success) {
        console.log(`更新任务 ${taskId} 执行历史记录...`);
        // 历史+状态为同一次写入：写入失败时任务可能残留 RUNNING，
        // 单独兜底恢复 ENABLED（读取当前状态，DISABLED 保持禁用意图）
        const historyResult = await taskService.updateTaskExecutionHistory(taskId, executionResult);
        if (!historyResult.success) {
          console.error(`任务 ${taskId} 更新执行历史失败:`, historyResult.error);
          await this.setTaskStatusPreservingDisabled(taskId, TaskStatus.ENABLED);
        }

        const executionEndTime = new Date();
        const executionTimeMessage = `开始: ${executionStartTime.toLocaleString()}, 结束: ${executionEndTime.toLocaleString()}, 耗时: ${Math.round((executionEndTime.getTime() - executionStartTime.getTime()) / 1000)}秒`;
        console.log(`任务 ${taskId} 执行完成, 结果: 成功, ${executionTimeMessage}`);
        return executionResult;
      }

      // 失败结果：补充失败详情（异常路径在 catch 中补充），
      // 结果不确定（UNCERTAIN）保持执行器提供的语义，不在此覆盖
      if (executionResult.outcome !== ExecutionOutcome.UNCERTAIN) {
        executionResult.details = executionResult.details || `执行失败${retryCount > 0 ? `，已重试 ${retryCount} 次` : ''}`;
      }

      // 统一重试判定与失败收尾（结果路径）
      if (this.shouldRetryExecution(executionResult, retryCount)) {
        retrying = true;
        return this.retryTask(taskId, retryCount, source, activeLeaseExecutionId);
      }
      return this.finalizeFailureResult(executionResult, taskId, executionStartTime);
    } catch (error) {
      // 超时结束的执行：底层操作可能仍在进行（外部副作用不确定），
      // 本次执行结果应为"结果不确定"：不进入重试、不把任务标记为 FAILED，
      // 保持 RUNNING 由租约驱动的恢复逻辑处理
      if (error instanceof ExecutionTimeoutError) {
        // 标记超时：finally 中保留租约直至自然到期，阻止底层仍在运行的操作被并发重入
        timeoutOccurred = true;
        const errorMessage = error.message;
        const startTime = executionResult.timestamp || Date.now();
        executionResult.success = false;
        executionResult.outcome = ExecutionOutcome.UNCERTAIN;
        executionResult.error = errorMessage;
        executionResult.details = `执行超时，结果不确定${retryCount > 0 ? `，已重试 ${retryCount} 次` : ''}`;
        executionResult.duration = Date.now() - startTime;
        executionResult.source = source;
        console.warn(`任务 ${taskId} 执行超时，结果不确定（底层操作可能仍在进行）`);

        // 更新任务历史记录
        await taskService.updateTaskExecutionHistory(taskId, executionResult);
        return executionResult;
      }

      // 处理错误：构造结构化失败结果。
      // 可重试性依据错误类型与状态码判定（isRetryableError），不匹配错误消息字符串
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`任务 ${taskId} 执行出错:`, errorMessage);

      // 确保startTime变量存在（在try块中可能未定义）
      const startTime = executionResult.timestamp || Date.now();
      executionResult.success = false;
      executionResult.outcome = ExecutionOutcome.FAILURE;
      executionResult.error = errorMessage;
      executionResult.details = `执行失败${retryCount > 0 ? `，已重试 ${retryCount} 次` : ''}`;
      executionResult.duration = Date.now() - startTime;
      executionResult.source = source;
      // 结构化可重试性标记：仅临时性失败（网络、限流、服务端错误等）可重试
      executionResult.retryable = this.isRetryableError(error);

      // 失败收尾与重试判定（异常路径）
      if (this.shouldRetryExecution(executionResult, retryCount)) {
        retrying = true;
        return this.retryTask(taskId, retryCount, source, activeLeaseExecutionId);
      }
      return this.finalizeFailureResult(executionResult, taskId, executionStartTime);
    } finally {
      if (timeoutOccurred) {
        // 底层操作可能仍在运行：保留执行租约与写入租约直至自然到期（120s），
        // 阻止并发重入/双写；快照照常清理（执行输入失效）
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        this.executingTasks.delete(taskId);
        await this.deleteSnapshot(taskId);
        console.warn(`[TaskExecutor] 执行超时（任务 ${taskId}），保留执行租约与书签写入租约直至到期`);
      } else {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        this.executingTasks.delete(taskId);

        // 清理任务快照：执行正常结束时执行输入失效；
        // retrying 时跳过：快照由重试层重新固化、最内层 finally 删除；
        // 若此处因 SW 中断未执行，快照保留在 storage 中供恢复判定
        if (!retrying) {
          await this.deleteSnapshot(taskId);
        }

        // 释放书签写入租约：与获取顺序相反，先释放写入租约，再释放执行租约。
        // 写入租约由重试层重新检查并获取（重试属于同一任务执行的执行尝试），本层总是释放
        if (writeLeaseHeld) {
          await this.releaseBookmarkWriteLease(activeLeaseExecutionId);
        }

        // 释放执行租约：执行结束后租约被释放，后续执行请求可通过。
        // 重试时跳过：重试延续执行租约（不重新获取），由重试链最内层收尾时释放，
        // 避免本层 finally 在返回值求值后立即释放租约导致重试层无租约可用
        if (!retrying) {
          await this.releaseExecutionLease(taskId, activeLeaseExecutionId);
        }
      }
      console.log(`任务 ${taskId} 已从执行队列移除`);
    }
  }

  /**
   * 结构化判定错误是否可重试（不匹配错误消息字符串）
   * - RetryableError：明确标记为临时性失败（网络、限流、服务端错误）→ 可重试
   * - GitHubApiError：按状态码判定（429 限流、5xx 服务端错误）→ 可重试；
   *   其余状态码（如 401 凭据错误）→ 不可重试
   * - ExecutionTimeoutError：超时属于"结果不确定"，由超时分支拦截处理，永不进入重试
   * - 其余错误默认不可重试（凭据缺失、配置错误、未启用等）
   * @param error 错误对象
   * @returns 是否可重试
   */
  private isRetryableError(error: unknown): boolean {
    if (error instanceof ExecutionTimeoutError) {
      return false;
    }
    return isRetryableGitHubError(error);
  }

  /**
   * 执行备份操作
   * @param task 任务对象
   * @returns 执行结果
   */
  private async executeBackupAction(task: Task): Promise<TaskExecutionResult> {
    console.log(`执行备份任务: ${task.id}, 操作类型: ${(task.action as BackupAction).operation || 'backup'}`);
    const backupAction = task.action as BackupAction;

    try {
      // 安全策略：恢复属于高风险操作，必须是手动触发任务
      if (backupAction.operation === 'restore' && task.trigger.type !== TriggerType.MANUAL) {
        return {
          success: false,
          timestamp: Date.now(),
          error: '恢复书签属于高风险操作，必须使用手动触发任务',
          details: '请将任务触发器设置为“手动触发”，并在执行前确认备份文件来源与内容',
        };
      }

      // 获取GitHub凭据
      const credentialsResult = await storageService.getGitHubCredentials();

      if (!credentialsResult.success || !credentialsResult.data) {
        console.error(`任务${task.id}执行失败: 未找到GitHub凭据`);
        return {
          success: false,
          timestamp: Date.now(),
          error: '未找到GitHub凭据，请先在“概览”页配置GitHub账号',
          details: '请打开扩展的“概览”页面，完成GitHub账号授权后再执行此任务'
        };
      }

      const credentials = credentialsResult.data;

      // 获取GitHub用户名并验证凭据有效性
      let username = 'user'; // 默认占位符
      try {
        console.log(`验证GitHub凭据...`);
        const userResult = await githubService.validateCredentials(credentials);
        username = userResult.login;
        console.log(`GitHub凭据验证成功，用户: ${username}`);
      } catch (error) {
        console.error(`GitHub凭据验证失败:`, error);
        // 网络/服务端错误导致验证失败属临时性失败，可重试，并给出明确的网络错误提示；
        // 凭据错误（401 等）不可重试，保持原有凭据错误消息
        if (isRetryableGitHubError(error)) {
          return {
            success: false,
            timestamp: Date.now(),
            retryable: true,
            error: `GitHub凭据验证失败（网络或服务端错误）: ${error instanceof Error ? error.message : String(error)}`,
            details: '网络异常导致GitHub凭据验证失败，请检查网络连接后重试',
          };
        }
        return {
          success: false,
          timestamp: Date.now(),
          retryable: false,
          error: `GitHub凭据无效或已过期: ${error instanceof Error ? error.message : String(error)}`,
          details: '请重新登录GitHub账号，更新授权信息后再执行此任务',
        };
      }

      // 根据操作类型执行不同的操作
      if (backupAction.operation === 'backup' || !backupAction.operation) {
        // 执行备份操作 (上传)
        console.log(`开始执行备份操作，上传书签到GitHub...`);
        const backupResult = await backupService.backupToGitHub(
          credentials,
          username
        );

        if (!backupResult.success) {
          console.error(`GitHub备份失败:`, backupResult.error);
          return {
            success: false,
            timestamp: Date.now(),
            // 结构化可重试性标记：网络/限流等临时性失败可重试，凭据/配置等错误不可重试
            retryable: backupResult.retryable,
            error: `GitHub备份失败: ${backupResult.error}`,
            details: '备份过程中发生错误，请检查网络连接和GitHub仓库权限'
          };
        }

        console.log(`备份成功完成，书签数:`, backupResult.data?.bookmarksCount);
        return {
          success: true,
          timestamp: Date.now(),
          details: `成功备份书签到GitHub: ${backupResult.data?.fileUrl || '无文件URL'}${backupResult.data?.bookmarksCount ? `，包含 ${backupResult.data.bookmarksCount} 个书签` : ''
            }`
        };
      } else if (backupAction.operation === 'restore') {
        // 执行恢复操作 (下载)
        const useTimestampedFile = !!backupAction.options?.backupFilePath;
        const timestampedFilePath = backupAction.options?.backupFilePath;

        console.log(`开始执行恢复操作，从GitHub下载书签`,
          useTimestampedFile ? `，使用指定文件: ${timestampedFilePath}` : '，使用最新文件');

        const restoreResult = await backupService.restoreFromGitHub(
          credentials,
          username,
          useTimestampedFile,
          timestampedFilePath
        );

        if (!restoreResult.success) {
          console.error(`从GitHub恢复失败:`, restoreResult.error);
          return {
            success: false,
            timestamp: Date.now(),
            // 结构化可重试性标记：网络/限流等临时性失败可重试
            retryable: restoreResult.retryable,
            error: `从GitHub恢复失败: ${restoreResult.error}`,
            details: '恢复过程中发生错误，请检查备份文件是否存在和有效'
          };
        }

        console.log(`恢复成功完成，书签数:`, restoreResult.data?.bookmarksCount);
        return {
          success: true,
          timestamp: Date.now(),
          details: `成功从GitHub恢复书签${restoreResult.data?.bookmarksCount ? `，恢复了 ${restoreResult.data.bookmarksCount} 个书签` : ''
            }`
        };
      } else {
        console.error(`不支持的备份操作: ${backupAction.operation}`);
        return {
          success: false,
          timestamp: Date.now(),
          error: `不支持的备份操作: ${backupAction.operation}`,
          details: '任务配置错误，请修改任务设置中的操作类型'
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`备份/恢复任务执行异常:`, errorMessage);

      return {
        success: false,
        timestamp: Date.now(),
        // 结构化可重试性标记：网络/限流等临时性失败可重试
        retryable: isRetryableGitHubError(error),
        error: `备份/恢复失败: ${errorMessage}`,
        details: '执行过程中发生未预期的错误，请检查控制台日志获取更多信息'
      };
    }
  }

  /**
   * 执行整理操作
   * @param task 任务对象
   * @returns 执行结果
   */
  private async executeOrganizeAction(task: Task): Promise<TaskExecutionResult> {
    console.log(`执行整理任务: ${task.id}`);
    const organizeAction = task.action as OrganizeAction;

    try {
      // 验证操作数组是否有效
      if (!organizeAction.operations || !Array.isArray(organizeAction.operations) || organizeAction.operations.length === 0) {
        throw new Error('整理操作数组为空或无效');
      }

      // 使用organizeService执行书签整理操作
      const results = await organizeService.organizeBookmarks(organizeAction.operations);

      // 汇总处理结果
      let successCount = 0;
      let failureCount = 0;
      let processedBookmarksCount = 0;
      let details: string[] = [];

      results.forEach(result => {
        if (result.success) {
          successCount++;
        } else {
          failureCount++;
        }
        processedBookmarksCount += result.processedCount;
        details.push(result.details);
      });

      // 生成总结果
      const allOperationsSucceeded = failureCount === 0;
      return {
        success: allOperationsSucceeded,
        timestamp: Date.now(),
        details: `执行了 ${organizeAction.operations.length} 个整理操作，成功 ${successCount} 个，失败 ${failureCount} 个，处理了 ${processedBookmarksCount} 个书签。详情: ${details.join(' | ')}`,
        error: allOperationsSucceeded ? undefined : `${failureCount} 个操作失败，请检查详情`
      };
    } catch (error) {
      return {
        success: false,
        timestamp: Date.now(),
        error: `整理失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * 执行推送书签操作
   * @param task 任务对象
   * @returns 执行结果
   */
  private async executePushAction(task: Task): Promise<TaskExecutionResult> {
    console.log(`执行推送书签任务: ${task.id}`);
    const pushAction = task.action as PushAction;

    try {
      // 获取GitHub凭据
      const credentialsResult = await storageService.getGitHubCredentials();

      if (!credentialsResult.success || !credentialsResult.data) {
        console.error(`任务${task.id}执行失败: 未找到GitHub凭据`);
        return {
          success: false,
          timestamp: Date.now(),
          error: '未找到GitHub凭据，请先在“概览”页配置GitHub账号',
          details: '请打开扩展的“概览”页面，完成GitHub账号授权后再执行此任务'
        };
      }

      const credentials = credentialsResult.data;

      // 获取GitHub用户名并验证凭据有效性
      let username = 'user'; // 默认占位符
      try {
        console.log(`验证GitHub凭据...`);
        const userResult = await githubService.validateCredentials(credentials);
        username = userResult.login;
        console.log(`GitHub凭据验证成功，用户: ${username}`);
      } catch (error) {
        console.error(`GitHub凭据验证失败:`, error);
        // 网络/服务端错误导致验证失败属临时性失败，可重试，并给出明确的网络错误提示；
        // 凭据错误（401 等）不可重试，保持原有凭据错误消息
        if (isRetryableGitHubError(error)) {
          return {
            success: false,
            timestamp: Date.now(),
            retryable: true,
            error: `GitHub凭据验证失败（网络或服务端错误）: ${error instanceof Error ? error.message : String(error)}`,
            details: '网络异常导致GitHub凭据验证失败，请检查网络连接后重试',
          };
        }
        return {
          success: false,
          timestamp: Date.now(),
          retryable: false,
          error: `GitHub凭据无效或已过期: ${error instanceof Error ? error.message : String(error)}`,
          details: '请重新登录GitHub账号，更新授权信息后再执行此任务',
        };
      }

      // 执行推送书签操作
      console.log(`开始执行推送书签操作，目标仓库: ${pushAction.options.repoName}/${pushAction.options.folderPath}...`);
      const pushResult = await backupService.pushBookmarksToGitHub(
        credentials,
        username,
        pushAction.options.repoName,
        pushAction.options.folderPath,
        pushAction.options.commitMessage
      );

      if (!pushResult.success) {
        console.error(`推送书签失败:`, pushResult.error);
        return {
          success: false,
          timestamp: Date.now(),
          // 结构化可重试性标记：网络/限流等临时性失败可重试
          retryable: pushResult.retryable,
          error: `推送书签失败: ${pushResult.error}`,
          details: '推送过程中发生错误，请检查网络连接和GitHub仓库权限'
        };
      }

      console.log(`推送书签成功完成，文件URL:`, pushResult.data?.fileUrl);
      return {
        success: true,
        timestamp: Date.now(),
        details: `成功推送书签到GitHub: ${pushResult.data?.fileUrl || '无文件URL'}`
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`推送书签任务执行异常:`, errorMessage);

      return {
        success: false,
        timestamp: Date.now(),
        // 结构化可重试性标记：网络/限流等临时性失败可重试
        retryable: isRetryableGitHubError(error),
        error: `推送书签失败: ${errorMessage}`,
        details: '执行过程中发生未预期的错误，请检查控制台日志获取更多信息'
      };
    }
  }

  /**
   * 执行选择性推送
   * @param task 任务对象
   * @returns 执行结果
   */
  private async executeSelectivePush(task: Task): Promise<TaskExecutionResult> {
    console.log(`执行选择性推送任务: ${task.id}`);
    const selectivePushAction = task.action as SelectivePushAction;

    try {
      // 1. 验证selections不为空
      if (!selectivePushAction.options.selections || selectivePushAction.options.selections.length === 0) {
        return {
          success: false,
          timestamp: Date.now(),
          error: '未选择任何书签',
          details: '请在任务配置中选择至少一个书签或文件夹'
        };
      }

      // 2. 获取GitHub凭据
      const credentialsResult = await storageService.getGitHubCredentials();

      if (!credentialsResult.success || !credentialsResult.data) {
        console.error(`任务${task.id}执行失败: 未找到GitHub凭据`);
        return {
          success: false,
          timestamp: Date.now(),
          error: '未找到GitHub凭据，请先在“概览”页配置GitHub账号',
          details: '请打开扩展的“概览”页面，完成GitHub账号授权后再执行此任务'
        };
      }

      const credentials = credentialsResult.data;

      // 3. 验证GitHub凭据
      let username = 'user'; // 默认占位符
      try {
        console.log(`验证GitHub凭据...`);
        const userResult = await githubService.validateCredentials(credentials);
        username = userResult.login;
        console.log(`GitHub凭据验证成功，用户: ${username}`);
      } catch (error) {
        console.error(`GitHub凭据验证失败:`, error);
        // 网络/服务端错误导致验证失败属临时性失败，可重试，并给出明确的网络错误提示；
        // 凭据错误（401 等）不可重试，保持原有凭据错误消息
        if (isRetryableGitHubError(error)) {
          return {
            success: false,
            timestamp: Date.now(),
            retryable: true,
            error: `GitHub凭据验证失败（网络或服务端错误）: ${error instanceof Error ? error.message : String(error)}`,
            details: '网络异常导致GitHub凭据验证失败，请检查网络连接后重试',
          };
        }
        return {
          success: false,
          timestamp: Date.now(),
          retryable: false,
          error: `GitHub凭据无效或已过期: ${error instanceof Error ? error.message : String(error)}`,
          details: '请重新登录GitHub账号，更新授权信息后再执行此任务',
        };
      }

      // 4. 使用BackupService生成HTML
      console.log(`生成选择性书签HTML，选中数量: ${selectivePushAction.options.selections.length}...`);
      const html = await backupService.generateSelectiveHtml(selectivePushAction.options.selections);

      // 5. 生成文件名(使用时间戳)
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const filename = `selective-bookmarks-${timestamp}.html`;

      // 6. 使用GitHubService上传
      const folderPath = selectivePushAction.options.folderPath || '';
      const filePath = folderPath ? `${folderPath}/${filename}` : filename;
      const commitMessage = selectivePushAction.options.commitMessage || '选择性推送书签';

      console.log(`开始上传到GitHub，目标路径: ${filePath}...`);
      const uploadResult = await githubService.createOrUpdateFile(
        credentials,
        username,
        selectivePushAction.options.repoName,
        filePath,
        html,
        commitMessage
      );

      console.log(`选择性推送完成:`, filePath);
      return {
        success: true,
        timestamp: Date.now(),
        details: `成功推送 ${selectivePushAction.options.selections.length} 个选中书签到 ${selectivePushAction.options.repoName}/${filePath}`
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`选择性推送任务执行异常:`, errorMessage);

      return {
        success: false,
        timestamp: Date.now(),
        // 结构化可重试性标记：网络/限流等临时性失败可重试
        retryable: isRetryableGitHubError(error),
        error: `选择性推送失败: ${errorMessage}`,
        details: '执行过程中发生未预期的错误，请检查控制台日志获取更多信息'
      };
    }
  }

  /**
   * 执行任务的操作部分
   * @param task 任务对象
   * @returns 执行结果
   */
  private async executeTaskAction(task: Task): Promise<TaskExecutionResult> {
    console.log(`执行任务操作: ${task.id}, 类型: ${task.action.type}`);

    try {
      switch (task.action.type) {
        case ActionType.BACKUP:
          return await this.executeBackupAction(task);
        case ActionType.ORGANIZE:
          return await this.executeOrganizeAction(task);
        case ActionType.PUSH:
          return await this.executePushAction(task);
        default:
          return {
            success: false,
            timestamp: Date.now(),
            error: `不支持的操作类型: ${(task.action as any).type}`
          };
      }
    } catch (error) {
      console.error(`执行任务操作异常:`, error);
      return {
        success: false,
        timestamp: Date.now(),
        error: `执行失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
}

// 导出单例实例
const taskExecutor = TaskExecutor.getInstance();
export default taskExecutor; 
