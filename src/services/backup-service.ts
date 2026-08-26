import { BookmarkBackupV1, BookmarkBackupV2, BackupResult, BackupStatus } from '../types/backup';
import { GitHubCredentials } from '../utils/storage-service';
import { BookmarkItem, isBookmarkBarNode } from '../utils/bookmark-service';
import bookmarkService from '../utils/bookmark-service';
import githubService, { isRetryableGitHubError, GitHubApiError, RetryableError } from './github-service';
import storageService from '../utils/storage-service';
import { getFaviconUrl } from '../utils/favicon-service';
import { BookmarkSelection } from '../types/task';
import { createBookmarkBackupV2 } from '../core/backup/schema-v2';
import { prepareGitHubBookmarkRestore, DEFAULT_BACKUP_REPO as V2_BACKUP_REPO } from './github-bookmark-restore-service';

// 备份存储库名称
const DEFAULT_BACKUP_REPO = V2_BACKUP_REPO;
// 备份文件路径：最新文件和带时间戳的历史文件
const LATEST_BACKUP_PATH = 'bookmarks_backup_latest.json';
// 设置文件备份文件夹路径
const SETTINGS_FOLDER_PATH = 'settings';

const parseBackupFilenameTimestamp = (filename: string, prefix: 'bookmarks' | 'settings'): number => {
  const escapedPrefix = prefix === 'bookmarks' ? 'bookmarks' : 'settings';
  const match = filename.match(new RegExp(`${escapedPrefix}_backup_(\\d{4})(\\d{2})(\\d{2})(\\d{2})(\\d{2})(\\d{2})(?:_([a-z0-9]+)-[a-z0-9]+)?\\.json`, 'i'));
  if (!match) return 0;
  const [, year, month, day, hour, minute, second, millisBase36] = match;
  const parsedMillis = millisBase36 ? Number.parseInt(millisBase36, 36) : NaN;
  return Number.isFinite(parsedMillis)
    ? parsedMillis
    : new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`).getTime();
};
// 备份类型常量
export enum BackupType {
  BOOKMARKS = 'bookmarks',
  SETTINGS = 'settings'
}

class BackupService {
  private static instance: BackupService;
  private readonly FAVICON_FETCH_TIMEOUT_MS = 5000;
  private readonly FAVICON_PREFETCH_CONCURRENCY = 6;

  private constructor() { }

  static getInstance(): BackupService {
    if (!BackupService.instance) {
      BackupService.instance = new BackupService();
    }
    return BackupService.instance;
  }

  /**
   * 解析书签备份文件名中的时间戳（bookmarks_backup_YYYYMMDDHHMMSS_suffix.json）。
   * suffix 用于避免同一秒内的备份覆盖彼此。
   */
  private parseBookmarksBackupTimestamp(filename: string): number {
    return parseBackupFilenameTimestamp(filename, 'bookmarks');
  }

  /**
   * 是否为“带时间戳”的书签备份文件
   */
  private isTimestampedBookmarksBackupFile(filename: string): boolean {
    return this.parseBookmarksBackupTimestamp(filename) > 0;
  }

  /**
   * 解析“最新书签备份文件路径”
   * 优先选择时间戳备份文件；若不存在，回退到历史的 latest 文件名。
   */
  private async resolveLatestBookmarksBackupFilePath(
    credentials: GitHubCredentials,
    username: string
  ): Promise<string> {
    const files = await githubService.getRepositoryFiles(
      credentials,
      username,
      DEFAULT_BACKUP_REPO,
      'bookmarks'
    );

    const timestampedFiles = files.filter(file => this.isTimestampedBookmarksBackupFile(file.name));
    if (timestampedFiles.length > 0) {
      return timestampedFiles.sort(
        (a, b) => this.parseBookmarksBackupTimestamp(b.name) - this.parseBookmarksBackupTimestamp(a.name)
      )[0].path;
    }

    // 兼容历史逻辑：若仓库中存在 latest 文件，仍支持恢复。
    const latestFile = files.find(file => file.name === LATEST_BACKUP_PATH);
    if (latestFile) {
      return latestFile.path;
    }

    throw new Error('未找到可恢复的书签备份文件，请先进行备份');
  }

  /**
   * 创建书签备份
   * @returns 序列化的书签备份数据
   */
  private async createBackupData(): Promise<BookmarkBackupV2> {
    // 获取所有书签
    const bookmarksResult = await bookmarkService.getAllBookmarks();
    if (!bookmarksResult.success) {
      throw new Error(`获取书签失败: ${bookmarksResult.error}`);
    }

    const bookmarks = bookmarksResult.data as BookmarkItem[];

    // v2 备份保留全部语义根目录和节点类型；旧 v1 文件仅在恢复时兼容读取。
    return createBookmarkBackupV2(bookmarks, new Date());
  }

  /**
   * 创建“配置备份”数据
   * 说明：历史上该类型名为 SETTINGS，但目前用于备份/恢复扩展的完整配置快照（local + sync）。
   */
  private async createSettingsBackupData(): Promise<any> {
    // 复用本地“配置导入导出”的序列化逻辑，确保本地文件与 GitHub 备份格式一致
    const exportResult = await storageService.exportConfig({
      includeGitHubCredentials: false,
      includeLocalStorage: false
    });
    if (!exportResult.success || !exportResult.data) {
      throw new Error(`导出配置失败: ${exportResult.error || '未知错误'}`);
    }

    return exportResult.data;
  }

  /**
   * 备份到GitHub
   * @param credentials GitHub认证凭据
   * @param username GitHub用户名
   * @param type 备份类型 (bookmarks 或 settings)
   * @returns 备份结果
   */
  async backupToGitHub(
    credentials: GitHubCredentials,
    username: string,
    type: BackupType = BackupType.BOOKMARKS
  ): Promise<BackupResult> {
    try {
      // 1. 创建备份数据 (根据类型)
      let backupData: any;
      let backupFolder: string;
      let backupDescription: string;

      if (type === BackupType.SETTINGS) {
        backupData = await this.createSettingsBackupData();
        backupFolder = SETTINGS_FOLDER_PATH;
        backupDescription = '配置';
      } else {
        backupData = await this.createBackupData();
        backupFolder = 'bookmarks';
        backupDescription = '书签';
      }

      // 2. 确保存储库存在
      const repoExists = await githubService.repoExists(credentials, username, DEFAULT_BACKUP_REPO);
      if (!repoExists) {
        // 创建新存储库
        try {
          const createRepoResult = await githubService.createRepo(credentials, DEFAULT_BACKUP_REPO, true);

          // 检查创建结果中是否有_repoExisted标记，表示仓库已存在但成功获取了信息
          if (createRepoResult._repoExisted) {
            console.log('仓库已存在，使用现有仓库');
          } else {
            // 给存储库一些时间初始化
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        } catch (repoError) {
          // 如果创建仓库失败，再次检查仓库是否存在
          console.error('创建仓库失败，再次检查仓库是否存在:', repoError);
          const recheckedExists = await githubService.repoExists(credentials, username, DEFAULT_BACKUP_REPO);

          if (!recheckedExists) {
            // 如果确实不存在，则抛出原始错误
            throw repoError;
          } else {
            console.log('仓库已存在，继续备份流程');
          }
        }
      }

      // 3. 序列化数据
      const backupContent = JSON.stringify(backupData, null, 2);

      // 4. 生成带详细时间戳的文件路径
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const seconds = String(now.getSeconds()).padStart(2, '0');

      const timestamp = `${year}${month}${day}${hours}${minutes}${seconds}`;
      const suffix = `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const fileName = `${type}_backup_${timestamp}_${suffix}.json`;
      // 将文件保存到对应文件夹
      const backupFilePath = `${backupFolder}/${fileName}`;

      // GitHub API对于不存在的目录会自动创建
      // 但我们可以先检查目录是否存在于仓库中
      // 5. 上传新备份文件
      console.log(`开始上传备份文件: ${backupFilePath}`);
      try {
        const uploadResult = await githubService.createOrUpdateFile(
          credentials,
          username,
          DEFAULT_BACKUP_REPO,
          backupFilePath,
          backupContent,
          `添加${backupDescription}备份 - ${now.toLocaleString()}`
        );
        console.log('备份文件上传成功');

        // 6. 保存备份状态
        const backupStatus: BackupStatus = {
          lastBackupTime: now.getTime(),
          backupFileUrl: uploadResult.content.html_url,
          lastBackupFilePath: backupFilePath,
          lastOperationStatus: 'success'
        };

        if (type === BackupType.SETTINGS) {
          // 配置备份状态存储在另一个键中，避免与书签备份状态混淆
          await storageService.setStorageData('settings_backup_status', backupStatus);
        } else {
          await storageService.saveBackupStatus(backupStatus);
        }

        // 清理超出限制的旧备份文件
        try {
          const cleanupResult = await this.cleanupOldBackups(
            credentials,
            username,
            type
          );

          if (cleanupResult.deletedCount > 0) {
            console.log(`已清理 ${cleanupResult.deletedCount} 个旧的 ${type} 备份文件`);
          }
        } catch (cleanupError) {
          // 清理失败不应影响备份结果，只记录日志
          console.error('清理旧备份文件失败:', cleanupError);
        }

        // 7. 返回成功结果
        return {
          success: true,
          data: {
            fileUrl: uploadResult.content.html_url,
            timestamp: backupData.timestamp,
            filePath: backupFilePath
          },
          timestamp: backupData.timestamp
        };
      } catch (uploadError) {
        console.error(`上传备份文件失败:`, uploadError);

        // 保存失败状态
        const backupStatus: BackupStatus = {
          lastOperationStatus: 'failed',
          errorMessage: uploadError instanceof Error ? uploadError.message : String(uploadError)
        };

        if (type === BackupType.SETTINGS) {
          await storageService.setStorageData('settings_backup_status', backupStatus);
        } else {
          await storageService.saveBackupStatus(backupStatus);
        }

        return {
          success: false,
          // 结构化可重试性标记：网络/限流等临时性失败可重试，凭据/配置等错误不可重试
          retryable: isRetryableGitHubError(uploadError),
          error: `备份失败: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`
        };
      }
    } catch (error) {
      console.error(`${type}备份失败:`, error);

      // 保存失败状态
      const backupStatus: BackupStatus = {
        lastOperationStatus: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error)
      };

      if (type === BackupType.SETTINGS) {
        await storageService.setStorageData('settings_backup_status', backupStatus);
      } else {
        await storageService.saveBackupStatus(backupStatus);
      }

      return {
        success: false,
        retryable: isRetryableGitHubError(error),
        error: `备份失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * 从GitHub恢复
   * @param credentials GitHub认证凭据
   * @param username GitHub用户名
   * @param type 恢复类型 (bookmarks 或 settings)
   * @param useTimestampedFile 是否使用带时间戳的文件而不是最新文件
   * @param timestampedFilePath 带时间戳的文件路径(如果useTimestampedFile为true)
   * @returns 恢复结果
   */
  async restoreFromGitHub(
    credentials: GitHubCredentials,
    username: string,
    useTimestampedFile: boolean = false,
    timestampedFilePath?: string,
    type: BackupType = BackupType.BOOKMARKS
  ): Promise<BackupResult> {
    if (type === BackupType.SETTINGS) {
      return this.restoreSettingsFromGitHub(credentials, username, useTimestampedFile, timestampedFilePath);
    } else {
      // 书签恢复统一走“下载校验 → 本地导入快照 → 差异预览”流程。
      // 该调用只准备恢复计划，不调用任何 browser.bookmarks 写入 API。
      return prepareGitHubBookmarkRestore(credentials, username, {
        useTimestampedFile,
        timestampedFilePath,
      });
    }
  }

  /**
   * 从GitHub恢复配置（历史类型名为 SETTINGS）
   * @param credentials GitHub认证凭据
   * @param username GitHub用户名
   * @param useTimestampedFile 是否使用带时间戳的文件
   * @param timestampedFilePath 带时间戳的文件路径
   * @returns 恢复结果
   */
  private async restoreSettingsFromGitHub(
    credentials: GitHubCredentials,
    username: string,
    useTimestampedFile: boolean = false,
    timestampedFilePath?: string
  ): Promise<BackupResult> {
    try {
      // 1. 确保存储库存在
      const repoExists = await githubService.repoExists(credentials, username, DEFAULT_BACKUP_REPO);
      if (!repoExists) {
        throw new Error('备份存储库不存在，请先进行备份');
      }

      let filePath: string;

      if (useTimestampedFile && timestampedFilePath) {
        // 如果指定了时间戳文件，使用指定的文件
        filePath = timestampedFilePath.startsWith(SETTINGS_FOLDER_PATH) ?
          timestampedFilePath : `${SETTINGS_FOLDER_PATH}/${timestampedFilePath}`;
      } else {
        // 否则，获取配置备份文件夹中的所有文件，找到最新的备份文件
        console.log(`尝试获取目录内容: ${SETTINGS_FOLDER_PATH}`);
        try {
          const files = await githubService.getRepositoryFiles(
            credentials,
            username,
            DEFAULT_BACKUP_REPO,
            SETTINGS_FOLDER_PATH
          );

          console.log(`获取到${files.length}个文件:`, files.map(f => f.name).join(', '));

          // 过滤获取所有配置备份文件（历史命名为 settings_backup_）
          const settingsBackupFiles = files.filter(
            file => file.name.startsWith('settings_backup_') && file.name.endsWith('.json')
          );

          console.log(`找到${settingsBackupFiles.length}个配置备份文件`);

          if (settingsBackupFiles.length === 0) {
            throw new Error('未找到配置备份文件，请先进行备份');
          }

          // 解析文件名中的时间戳，以便找到最新文件
          const parseTimestamp = (filename: string): number => {
            return parseBackupFilenameTimestamp(filename, 'settings');
          };

          // 按时间戳降序排序文件，取第一个（最新的）
          const latestFile = settingsBackupFiles
            .sort((a, b) => parseTimestamp(b.name) - parseTimestamp(a.name))[0];

          filePath = latestFile.path;
          console.log(`选择最新的配置备份文件: ${filePath}`);
        } catch (error) {
          console.error('获取仓库文件列表失败:', error);
          // 网络/限流等临时性失败保留结构化分类，供上层判定可重试性
          if (error instanceof RetryableError || error instanceof GitHubApiError) {
            throw error;
          }
          throw new Error(`获取仓库文件列表失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // 2. 获取备份文件内容
      console.log('尝试获取配置备份文件:', filePath);
      const fileData = await githubService.getFileContent(
        credentials,
        username,
        DEFAULT_BACKUP_REPO,
        filePath
      );

      // 3. 解析备份数据
      const backupData = JSON.parse(fileData.content);

      // 4. 兼容两种格式：
      // - 新版：配置快照（schemaVersion/app/local...），复用 storageService.importConfig
      // - 旧版：仅 settings（backupData.settings），保持兼容
      const looksLikeConfig = backupData
        && typeof backupData === 'object'
        && backupData.schemaVersion === 1
        && backupData.app === 'MarksVault'
        && backupData.local
        && typeof backupData.local === 'object';

      if (looksLikeConfig) {
        const result = await storageService.importConfig(backupData, { importLocalStorage: false });
        if (!result.success) {
          throw new Error(`导入配置失败: ${result.error}`);
        }
      } else if (backupData.settings && typeof backupData.settings === 'object') {
        const result = await storageService.saveSettings(backupData.settings);
        if (!result.success) {
          throw new Error(`保存设置失败: ${result.error}`);
        }
      } else {
        throw new Error('备份文件格式不正确');
      }

      // 6. 保存恢复状态
      const now = new Date();
      const restoreStatus: BackupStatus = {
        lastRestoreTime: now.getTime(),
        lastOperationStatus: 'success'
      };

      await storageService.setStorageData('settings_backup_status', restoreStatus);

      // 7. 返回成功结果
      return {
        success: true,
        data: {
          timestamp: typeof backupData?.timestamp === 'number'
            ? backupData.timestamp
            : Date.now(),
          filePath
        },
        timestamp: typeof backupData?.timestamp === 'number'
          ? backupData.timestamp
          : undefined
      };
    } catch (error) {
      console.error('配置恢复失败:', error);

      // 保存失败状态
      const restoreStatus: BackupStatus = {
        lastOperationStatus: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error)
      };

      await storageService.setStorageData('settings_backup_status', restoreStatus);

      return {
        success: false,
          retryable: isRetryableGitHubError(error),
          error: `恢复失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  // GitHub bookmark restoration is intentionally implemented only by
  // prepareGitHubBookmarkRestore. Keeping a second direct-write path here
  // would bypass semantic-root mapping, preview, leases and RestoreJournal.

  /**
   * 获取备份统计信息
   * @param credentials GitHub凭据
   * @param username GitHub用户名
   * @param forceRefresh 是否强制刷新（忽略缓存）
   * @returns 备份统计信息
   */
  async getBackupStats(
    credentials: GitHubCredentials,
    username: string,
    forceRefresh: boolean = false
  ): Promise<{
    totalBackups: number;
    firstBackupTime?: number;
    totalBookmarks?: number;
    totalFolders?: number;
    fileSize?: number;
    isFromCache?: boolean;
  }> {
    try {
      // 1. 尝试从缓存获取
      if (!forceRefresh) {
        const cacheResult = await storageService.getBackupStatsCache();
        if (cacheResult.success && cacheResult.data) {
          const cache = cacheResult.data;
          // 检查缓存是否有效
          if (storageService.isBackupStatsCacheValid(cache)) {
            console.log('使用备份统计信息缓存');
            return { ...cache.data, isFromCache: true };
          }
        }
      }

      // 2. 缓存无效或强制刷新，从GitHub获取数据
      console.log('从GitHub获取备份统计信息');

      // 获取所有备份文件 (从bookmarks文件夹)
      const files = await githubService.getRepositoryFiles(
        credentials,
        username,
        DEFAULT_BACKUP_REPO,
        'bookmarks'
      );

      // 过滤并计算备份文件数量
      const backupFiles = files.filter(
        file => file.name.startsWith('bookmarks_backup_') && file.name.endsWith('.json')
      );

      const totalBackups = backupFiles.length;

      if (totalBackups === 0) {
        return { totalBackups: 0 };
      }

      // 解析文件名中的时间戳
      const parseTimestamp = (filename: string): number => {
        return parseBackupFilenameTimestamp(filename, 'bookmarks');
      };

      // 提取时间戳并排序
      const timestamps = backupFiles
        .map(file => parseTimestamp(file.name))
        .filter(ts => ts > 0)
        .sort((a, b) => a - b);

      // 最早备份时间
      const firstBackupTime = timestamps.length > 0 ? timestamps[0] : undefined;

      // 如果有最近的备份文件，获取其内容以提取书签和文件夹数量
      let totalBookmarks: number | undefined;
      let totalFolders: number | undefined;
      let fileSize: number | undefined;

      // 获取最新备份文件(按时间戳排序)
      const latestFile = backupFiles
        .sort((a, b) => parseTimestamp(b.name) - parseTimestamp(a.name))[0];

      if (latestFile) {
        // 设置文件大小
        fileSize = latestFile.size;

        // 获取文件内容以提取详细信息
        try {
          const fileData = await githubService.getFileContent(
            credentials,
            username,
            DEFAULT_BACKUP_REPO,
            latestFile.path // 已经包含了bookmarks/前缀
          );

          const backupData = JSON.parse(fileData.content) as BookmarkBackupV1 | BookmarkBackupV2;

          // 提取元数据
          if ('metadata' in backupData && backupData.metadata) {
            totalBookmarks = backupData.metadata.totalBookmarks;
            totalFolders = backupData.metadata.totalFolders;
          } else if ('stats' in backupData && backupData.stats) {
            totalBookmarks = backupData.stats.bookmarks;
            totalFolders = backupData.stats.folders;
          }
        } catch (error) {
          console.error('获取最新备份内容失败:', error);
          // 如果获取内容失败，只返回基本统计信息
        }
      }

      // 构建结果
      const statsData = {
        totalBackups,
        firstBackupTime,
        totalBookmarks,
        totalFolders,
        fileSize
      };

      // 3. 将获取的数据保存到缓存
      await storageService.saveBackupStatsCache(statsData);

      return statsData;
    } catch (error) {
      console.error('获取备份统计信息失败:', error);
      // 发生错误时返回基本信息
      return { totalBackups: 0 };
    }
  }

  /**
   * 获取备份状态
   * @param forceRefresh 是否强制刷新统计数据
   * @param updateCallback 状态更新回调函数
   * @returns 备份状态信息
   */
  async getBackupStatus(
    forceRefresh: boolean = false,
    updateCallback?: (updatedStatus: BackupStatus) => void
  ): Promise<BackupStatus> {
    try {
      // 获取基本状态信息
      const result = await storageService.getBackupStatus();
      const baseStatus = result.success ? result.data : {};

      // 非强制刷新：优先使用本地缓存的统计信息（避免每次打开都访问 GitHub）
      if (!forceRefresh) {
        const cacheResult = await storageService.getBackupStatsCache();
        if (
          cacheResult.success &&
          cacheResult.data &&
          storageService.isBackupStatsCacheValid(cacheResult.data) &&
          cacheResult.data.data
        ) {
          return {
            ...baseStatus,
            stats: {
              ...(cacheResult.data.data as any),
              isFromCache: true,
            },
          };
        }

        // 兼容：如果历史数据里已经存了 stats，则直接返回
        if (baseStatus.stats) {
          return baseStatus;
        }
      }

      // 无缓存（首次）或用户手动刷新：从 GitHub 拉取
      const fullStatus = await this.getFullBackupStatus(baseStatus, updateCallback, forceRefresh);

      // 将最新统计写回 backup_status，方便下次无缓存时仍可展示
      if (fullStatus.stats) {
        await storageService.saveBackupStatus({ stats: { ...fullStatus.stats, isFromCache: false } });
      }

      return fullStatus;
    } catch (error) {
      console.error('获取备份状态失败:', error);
      return {};
    }
  }

  /**
   * 获取配置备份状态（历史 key 为 settings_backup_status）
   * @param forceRefresh 是否强制刷新统计数据
   * @returns 配置备份状态信息
   */
  async getSettingsBackupStatus(
    forceRefresh: boolean = false
  ): Promise<BackupStatus> {
    try {
      // 获取基本状态信息
      const result = await storageService.getStorageData('settings_backup_status');
      const status = result.success ? result.data : {};

      if (forceRefresh) {
        // 在这里可以添加获取更多配置备份统计信息的逻辑，类似于书签备份的getFullBackupStatus方法
        // 例如获取配置备份的总数量、最新备份的大小等
      }

      return status;
    } catch (error) {
      console.error('获取配置备份状态失败:', error);
      return {};
    }
  }

  /**
   * 获取完整的备份状态（包括从GitHub获取的统计信息）
   * @param baseStatus 基本状态信息
   * @param updateCallback 更新回调
   * @returns 完整的备份状态
   */
  private async getFullBackupStatus(
    baseStatus: BackupStatus,
    updateCallback?: (updatedStatus: BackupStatus) => void,
    forceRefreshStats: boolean = false
  ): Promise<BackupStatus> {
    try {
      // 尝试获取GitHub凭据
      const credentialsResult = await storageService.getGitHubCredentials();
      if (!credentialsResult.success || !credentialsResult.data) {
        return baseStatus; // 无法获取凭据，返回基本状态
      }

      // 获取GitHub用户名
      const userResult = await githubService.validateCredentials(credentialsResult.data);

      // 获取统计信息
      const stats = await this.getBackupStats(credentialsResult.data, userResult.login, forceRefreshStats);

      // 更新状态
      const updatedStatus = { ...baseStatus, stats };

      // 如果提供了回调，执行回调
      if (updateCallback) {
        updateCallback(updatedStatus);
      }

      return updatedStatus;
    } catch (error) {
      console.error('获取完整备份状态失败:', error);
      return baseStatus; // 出错时返回基本状态
    }
  }

  /**
   * 异步刷新备份统计信息
   * @param currentStatus 当前状态
   * @param updateCallback 更新回调
   */
  private async refreshBackupStatsAsync(
    currentStatus: BackupStatus,
    updateCallback?: (updatedStatus: BackupStatus) => void
  ): Promise<void> {
    setTimeout(async () => {
      try {
        const updatedStatus = await this.getFullBackupStatus(currentStatus, updateCallback);

        // 如果提供了回调但在getFullBackupStatus中未调用（例如因为出错），这里调用
        if (updateCallback && JSON.stringify(updatedStatus) !== JSON.stringify(currentStatus)) {
          updateCallback(updatedStatus);
        }
      } catch (error) {
        console.error('异步刷新备份统计信息失败:', error);
      }
    }, 100); // 短暂延迟，确保UI先渲染
  }

  /**
   * 获取图标并转换为 Base64 Data URI (PNG 格式)
   * @param url 网站 URL
   * @returns Base64 编码的 PNG 图标数据或 null
   */
  private async fetchIconAsBase64(url: string): Promise<string | null> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.FAVICON_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });
      const blob = await response.blob();

      // 如果已经是 PNG 格式，直接转换
      if (blob.type === 'image/png') {
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      }

      // 如果不是 PNG，通过 Canvas 转换为 PNG
      return new Promise((resolve) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(blob);

        img.onload = () => {
          try {
            // 创建 canvas 进行格式转换
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;

            const ctx = canvas.getContext('2d');
            if (!ctx) {
              URL.revokeObjectURL(objectUrl);
              resolve(null);
              return;
            }

            ctx.drawImage(img, 0, 0);

            // 转换为 PNG 格式的 Data URI
            const pngDataUrl = canvas.toDataURL('image/png');
            URL.revokeObjectURL(objectUrl);
            resolve(pngDataUrl);
          } catch (error) {
            URL.revokeObjectURL(objectUrl);
            resolve(null);
          }
        };

        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          resolve(null);
        };

        img.src = objectUrl;
      });
    } catch (error) {
      console.warn('获取图标失败:', error);
      return null;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private getFaviconCacheKey(url: string): string {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return url;
    }
  }

  private collectBookmarksWithUrl(items: BookmarkItem[]): BookmarkItem[] {
    const result: BookmarkItem[] = [];

    const walk = (nodes: BookmarkItem[]) => {
      for (const node of nodes) {
        if (!node.isFolder && node.url) {
          result.push(node);
        }

        if (node.children && node.children.length > 0) {
          walk(node.children);
        }
      }
    };

    walk(items);
    return result;
  }

  private async preloadFaviconIcons(bookmarks: BookmarkItem[]): Promise<Map<string, string>> {
    const bookmarksWithUrl = this.collectBookmarksWithUrl(bookmarks);
    if (bookmarksWithUrl.length === 0) {
      return new Map();
    }

    const faviconByKey = new Map<string, string>();
    const faviconUrlByKey = new Map<string, string>();

    for (const bookmark of bookmarksWithUrl) {
      if (!bookmark.url) continue;
      const faviconKey = this.getFaviconCacheKey(bookmark.url);
      if (faviconUrlByKey.has(faviconKey)) continue;

      const faviconUrl = getFaviconUrl(bookmark.url);
      if (!faviconUrl) continue;
      faviconUrlByKey.set(faviconKey, faviconUrl);
    }

    const faviconKeys = Array.from(faviconUrlByKey.keys());
    let cursor = 0;

    const worker = async () => {
      while (cursor < faviconKeys.length) {
        const faviconKey = faviconKeys[cursor++];
        const faviconUrl = faviconUrlByKey.get(faviconKey);
        if (!faviconUrl) continue;

        try {
          const iconData = await this.fetchIconAsBase64(faviconUrl);
          if (iconData && iconData.startsWith('data:image/')) {
            faviconByKey.set(faviconKey, iconData);
          }
        } catch (error) {
          console.warn('预加载 favicon 失败:', faviconUrl, error);
        }
      }
    };

    const workerCount = Math.min(this.FAVICON_PREFETCH_CONCURRENCY, faviconKeys.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return faviconByKey;
  }

  /**
   * 创建HTML格式的书签数据
   * @returns HTML格式的书签数据
   */
  private async createHtmlBookmarkData(): Promise<string> {
    // 获取所有书签
    const bookmarksResult = await bookmarkService.getAllBookmarks();
    if (!bookmarksResult.success) {
      throw new Error(`获取书签失败: ${bookmarksResult.error}`);
    }

    const bookmarks = bookmarksResult.data as BookmarkItem[];
    const faviconByKey = await this.preloadFaviconIcons(bookmarks);

    // 创建标准的HTML书签格式
    let html = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n';
    html += '<!-- This is an automatically generated file.\n';
    html += '     It will be read and overwritten.\n';
    html += '     DO NOT EDIT! -->\n';
    html += '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n';
    html += '<TITLE>Bookmarks</TITLE>\n';
    html += '<H1>Bookmarks</H1>\n';
    html += '<DL><p>\n';

    // 判断是否为书签栏文件夹
    const isBookmarkBar = (item: BookmarkItem): boolean => {
      return isBookmarkBarNode(item);
    };

    // 递归生成书签HTML（异步）
    const generateBookmarkHtml = async (items: BookmarkItem[], indentLevel: number = 1, skipRootWrapper: boolean = true): Promise<string> => {
      const indent = '    '.repeat(indentLevel);
      let result = '';

      for (const item of items) {
        if (item.type === 'separator') continue;
        if (item.isFolder) {
          // 对于根节点的第一层，完全跳过根包装文件夹，直接处理其子节点
          if (skipRootWrapper && indentLevel === 1 && !isBookmarkBar(item)) {
            // 如果不是书签栏，直接递归处理子节点，不输出此节点的HTML
            if (item.children && item.children.length > 0) {
              result += await generateBookmarkHtml(item.children, indentLevel, false);
            }
            continue;
          }

          // 文件夹项 - 只添加 ADD_DATE 和 LAST_MODIFIED 属性
          const addDate = item.dateAdded ? Math.floor(item.dateAdded / 1000) : Math.floor(Date.now() / 1000);
          const lastModified = item.dateGroupModified ? Math.floor(item.dateGroupModified / 1000) : 0;

          // 检查是否为书签栏
          const personalToolbar = isBookmarkBar(item) ? ' PERSONAL_TOOLBAR_FOLDER="true"' : '';

          result += `${indent}<DT><H3 ADD_DATE="${addDate}" LAST_MODIFIED="${lastModified}"${personalToolbar}>${this.escapeHtml(item.title)}</H3>\n`;
          result += `${indent}<DL><p>\n`;

          if (item.children && item.children.length > 0) {
            result += await generateBookmarkHtml(item.children, indentLevel + 1, false);
          }

          result += `${indent}</DL><p>\n`;
        } else if (item.url) {
          // 书签项 - 只添加 ADD_DATE 和 ICON 属性（不添加 LAST_MODIFIED）
          const addDate = item.dateAdded ? Math.floor(item.dateAdded / 1000) : Math.floor(Date.now() / 1000);

          // 从预加载缓存读取 ICON，避免逐条串行网络请求。
          let iconAttr = '';
          try {
            const faviconKey = this.getFaviconCacheKey(item.url);
            const iconData = faviconByKey.get(faviconKey);
            if (iconData) {
              iconAttr = ` ICON="${iconData}"`;
            }
          } catch (error) {
            console.warn('Failed to fetch icon for', item.url, error);
          }

          result += `${indent}<DT><A HREF="${this.escapeHtml(item.url)}" ADD_DATE="${addDate}"${iconAttr}>${this.escapeHtml(item.title)}</A>\n`;
        }
      }

      return result;
    };

    html += await generateBookmarkHtml(bookmarks, 1, true);
    html += '</DL><p>\n';

    return html;
  }

  /**
   * HTML转义特殊字符
   * @param text 需要转义的文本
   * @returns 转义后的文本
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  /**
   * 根据选择的书签生成HTML
   * @param selections 用户选择的书签数组
   * @returns HTML字符串
   */
  async generateSelectiveHtml(selections: BookmarkSelection[]): Promise<string> {
    // 1. 按customOrder排序
    const sortedSelections = this.sortSelections(selections);

    // 2. 生成HTML头部
    let html = this.generateHtmlHeader('选择性书签导出');

    // 3. 生成符合标准浏览器书签格式的结构
    // menav 的 bookmark-processor.js 会查找 PERSONAL_TOOLBAR_FOLDER 标记
    const now = Math.floor(Date.now() / 1000);
    html += '<DL><p>\n';
    html += `    <DT><H3 ADD_DATE="${now}" LAST_MODIFIED="${now}" PERSONAL_TOOLBAR_FOLDER="true">书签栏</H3>\n`;
    html += '    <DL><p>\n';
    html += this.generateSelectiveBookmarkNodes(sortedSelections, 2);
    html += '    </DL><p>\n';
    html += '</DL><p>\n';

    return html;
  }

  /**
   * 排序书签选择
   */
  private sortSelections(selections: BookmarkSelection[]): BookmarkSelection[] {
    return [...selections].sort((a, b) => {
      const orderA = a.customOrder ?? Infinity;
      const orderB = b.customOrder ?? Infinity;
      return orderA - orderB;
    });
  }

  /**
   * 递归生成书签节点HTML
   */
  private generateSelectiveBookmarkNodes(selections: BookmarkSelection[], indent: number = 1): string {
    let html = '';
    const indentStr = '  '.repeat(indent);

    for (const selection of selections) {
      if (selection.type === 'folder') {
        // 文件夹节点
        html += `${indentStr}<DT><H3>${this.escapeHtml(selection.title)}</H3>\n`;
        if (selection.children && selection.children.length > 0) {
          html += `${indentStr}<DL><p>\n`;
          html += this.generateSelectiveBookmarkNodes(selection.children, indent + 1);
          html += `${indentStr}</DL><p>\n`;
        }
      } else {
        // 书签节点
        html += `${indentStr}<DT><A HREF="${this.escapeHtml(selection.url || '')}">${this.escapeHtml(selection.title)}</A>\n`;
      }
    }

    return html;
  }

  /**
   * 生成HTML头部
   */
  private generateHtmlHeader(title: string): string {
    return `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>${this.escapeHtml(title)}</TITLE>
<H1>${this.escapeHtml(title)}</H1>
`;
  }

  /**
   * 推送书签到GitHub
   * @param credentials GitHub认证凭据
   * @param username GitHub用户名
   * @param repoName 目标仓库名称，默认为menav
   * @param folderPath 目标文件夹路径，默认为bookmarks
   * @param commitMessage 提交消息
   * @returns 推送结果
   */
  async pushBookmarksToGitHub(
    credentials: GitHubCredentials,
    username: string,
    repoName: string = 'menav',
    folderPath: string = 'bookmarks',
    commitMessage: string = '自动推送书签'
  ): Promise<BackupResult> {
    try {
      // 1. 创建HTML格式的书签数据
      const htmlBookmarkData = await this.createHtmlBookmarkData();

      // 2. 确保存储库存在
      const repoExists = await githubService.repoExists(credentials, username, repoName);
      if (!repoExists) {
        // 创建新存储库
        try {
          const createRepoResult = await githubService.createRepo(credentials, repoName, true);

          // 检查创建结果中是否有_repoExisted标记，表示仓库已存在但成功获取了信息
          if (createRepoResult._repoExisted) {
            console.log('目标仓库已存在，使用现有仓库');
          } else {
            // 给新创建的仓库一些时间初始化
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        } catch (repoError) {
          // 如果创建仓库失败，再次检查仓库是否存在
          console.error('创建目标仓库失败，再次检查仓库是否存在:', repoError);
          const recheckedExists = await githubService.repoExists(credentials, username, repoName);

          if (!recheckedExists) {
            // 如果确实不存在，则抛出原始错误
            throw repoError;
          } else {
            console.log('目标仓库已存在，继续推送流程');
          }
        }
      }

      // 3. 生成文件名 (格式: bookmarks_YYYYMMDD.html)
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');

      const dateString = `${year}${month}${day}`;
      const fileName = `bookmarks_${dateString}.html`;
      const filePath = folderPath ? `${folderPath}/${fileName}` : fileName;

      // 4. 上传HTML书签文件
      const uploadResult = await githubService.createOrUpdateFile(
        credentials,
        username,
        repoName,
        filePath,
        htmlBookmarkData,
        commitMessage || `推送书签 - ${now.toLocaleString()}`
      );

      // 5. 保存状态 (使用与备份相同的状态结构，但区分开)
      const backupStatus: BackupStatus = {
        lastBackupTime: now.getTime(),
        backupFileUrl: uploadResult.content.html_url,
        lastBackupFilePath: filePath,
        lastOperationStatus: 'success'
      };

      await storageService.saveBackupStatus({
        ...backupStatus,
        stats: {
          ...backupStatus.stats,
          isFromCache: false
        }
      });

      // 6. 返回成功结果
      return {
        success: true,
        data: {
          fileUrl: uploadResult.content.html_url,
          timestamp: now.getTime(),
          filePath: filePath
        },
        timestamp: now.getTime()
      };
    } catch (error) {
      console.error('推送书签失败:', error);

      // 保存失败状态
      const backupStatus: BackupStatus = {
        lastOperationStatus: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error)
      };

      await storageService.saveBackupStatus(backupStatus);

      return {
        success: false,
        retryable: isRetryableGitHubError(error),
        error: `推送失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * 清理超出限制的旧备份文件
   * @param credentials GitHub凭据
   * @param username GitHub用户名
   * @param type 备份类型 (书签或配置)
   * @returns 清理结果
   */
  async cleanupOldBackups(
    credentials: GitHubCredentials,
    username: string,
    type: BackupType = BackupType.BOOKMARKS
  ): Promise<{ success: boolean; deletedCount: number; error?: string }> {
    try {
      // 1. 获取用户设置，检查最大备份数量限制
      const settingsResult = await storageService.getSettings();
      if (!settingsResult.success) {
        return { success: true, deletedCount: 0 }; // 无法获取设置，不执行清理
      }

      const maxBackups = settingsResult.data?.backup?.maxBackupsPerType || 0;
      if (maxBackups <= 0) {
        return { success: true, deletedCount: 0 }; // 没有设置限制或限制为0，不执行清理
      }

      // 2. 确定要检查的文件夹路径
      const folderPath = type === BackupType.SETTINGS ? SETTINGS_FOLDER_PATH : 'bookmarks';

      // 3. 获取该类型的所有备份文件
      const files = await githubService.getRepositoryFiles(
        credentials,
        username,
        DEFAULT_BACKUP_REPO,
        folderPath
      );

      // 4. 根据备份类型过滤文件
      const filePrefix = type === BackupType.SETTINGS ? 'settings_backup_' : 'bookmarks_backup_';
      let backupFiles = files.filter(
        file => file.name.startsWith(filePrefix) && file.name.endsWith('.json')
      );

      // 如果文件数量没有超过限制，不需要清理
      if (backupFiles.length <= maxBackups) {
        console.log(`${type} 备份文件数量 (${backupFiles.length}) 未超过限制 (${maxBackups})`);
        return { success: true, deletedCount: 0 };
      }

      // 5. 解析文件名中的时间戳
      const parseTimestamp = (filename: string): number => {
        return parseBackupFilenameTimestamp(filename, type === BackupType.SETTINGS ? 'settings' : 'bookmarks');
      };

      // 6. 按时间戳排序（从新到旧）
      backupFiles = backupFiles.sort(
        (a, b) => parseTimestamp(b.name) - parseTimestamp(a.name)
      );

      // 7. 保留最新的 maxBackups 个文件，删除其余文件
      const filesToDelete = backupFiles.slice(maxBackups);
      console.log(`需要删除 ${filesToDelete.length} 个旧的 ${type} 备份文件`);

      let deletedCount = 0;
      for (const file of filesToDelete) {
        try {
          await githubService.deleteFile(
            credentials,
            username,
            DEFAULT_BACKUP_REPO,
            file.path,
            `自动清理旧的${type === BackupType.SETTINGS ? '配置' : '书签'}备份文件`,
            file.sha
          );
          deletedCount++;
          console.log(`已删除旧备份文件: ${file.path}`);
        } catch (deleteError) {
          console.error(`删除文件 ${file.path} 失败:`, deleteError);
          // 继续删除其他文件
        }
      }

      // 8. 更新备份统计信息（如果有删除操作）
      if (deletedCount > 0) {
        if (type === BackupType.BOOKMARKS) {
          // 强制刷新书签备份统计信息
          await this.getBackupStats(credentials, username, true);
        }
      }

      return { success: true, deletedCount };
    } catch (error) {
      console.error('清理旧备份文件失败:', error);
      return {
        success: false,
        deletedCount: 0,
        error: `清理失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
}

export default BackupService.getInstance(); 
