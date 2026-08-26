import type { GitHubCredentials } from '../utils/storage-service';
import type { BackupResult, BookmarkBackupV1, BookmarkBackupV2 } from '../types/backup';
import type { SnapshotRepository } from './bookmark-snapshot-service';
import {
  backupV2ToSnapshotTree,
  validateBookmarkBackupV2,
} from '../core/backup/schema-v2';
import { isBookmarkBackupV1 } from '../core/backup/schema-v1';
import { migrateBookmarkBackupV1ToV2 } from '../core/backup/migrate-v1-to-v2';
import githubService, { getGitHubErrorMetadata, isRetryableGitHubError } from './github-service';
import {
  createBookmarkSnapshot,
  getSnapshotRepository,
  SnapshotValidationError,
} from './bookmark-snapshot-service';
import { SNAPSHOT_SOURCES } from '../types/snapshot';
import { createRestorePlan } from './bookmark-restore-service';

export const DEFAULT_BACKUP_REPO = 'marksvault-backups';

export interface PrepareGitHubBookmarkRestoreOptions {
  useTimestampedFile?: boolean;
  timestampedFilePath?: string;
  repository?: SnapshotRepository;
  userName?: string;
}

export interface PreparedGitHubBookmarkRestore {
  snapshotId: string;
  planId: string;
  filePath: string;
  schemaVersion: 1 | 2;
  bookmarksCount: number;
  warnings: string[];
}

const isTimestamped = (filename: string): boolean =>
  /bookmarks_backup_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:_[a-z0-9-]+)?\.json/i.test(filename);

const timestampOf = (filename: string): number => {
  const match = filename.match(/bookmarks_backup_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:_([a-z0-9]+)-[a-z0-9]+)?/i);
  if (!match) return 0;
  const [, year, month, day, hour, minute, second, millisBase36] = match;
  const parsedMillis = millisBase36 ? Number.parseInt(millisBase36, 36) : NaN;
  return Number.isFinite(parsedMillis)
    ? parsedMillis
    : new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`).getTime();
};

export const resolveLatestGitHubBookmarkBackupPath = async (
  credentials: GitHubCredentials,
  username: string,
): Promise<string> => {
  const files = await githubService.getRepositoryFiles(credentials, username, DEFAULT_BACKUP_REPO, 'bookmarks');
  const candidates = files
    .filter(file => isTimestamped(file.name) || file.name === 'bookmarks_backup_latest.json')
    .sort((a, b) => timestampOf(b.name) - timestampOf(a.name));
  if (!candidates.length) throw new Error('未找到可恢复的书签备份文件，请先进行备份');
  return candidates[0].path;
};

const parseBackup = (json: string): { backup: BookmarkBackupV2; schemaVersion: 1 | 2; warnings: string[] } => {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new SnapshotValidationError('GitHub 备份不是有效 JSON，已阻止恢复');
  }
  let backup: BookmarkBackupV2;
  let schemaVersion: 1 | 2;
  const warnings: string[] = [];
  if (isBookmarkBackupV1(raw)) {
    backup = migrateBookmarkBackupV1ToV2(raw as BookmarkBackupV1);
    schemaVersion = 1;
    warnings.push('该文件为旧版 v1 备份，已转换为 schema v2 后进入本地历史恢复预览');
  } else {
    backup = raw as BookmarkBackupV2;
    schemaVersion = 2;
  }
  const validation = validateBookmarkBackupV2(backup);
  if (!validation.valid) throw new SnapshotValidationError(`GitHub 备份校验失败: ${validation.errors.join('；')}`);
  return { backup, schemaVersion, warnings };
};

/**
 * Download and validate a GitHub backup, then create only a local imported
 * snapshot and a restore preview. This function deliberately never calls a
 * browser bookmarks write method.
 */
export const prepareGitHubBookmarkRestore = async (
  credentials: GitHubCredentials,
  username: string,
  options: PrepareGitHubBookmarkRestoreOptions = {},
): Promise<BackupResult & { data?: PreparedGitHubBookmarkRestore }> => {
  try {
    if (!(await githubService.repoExists(credentials, username, DEFAULT_BACKUP_REPO))) {
      throw new Error('备份存储库不存在，请先进行备份');
    }
    const filePath = options.useTimestampedFile && options.timestampedFilePath
      ? (options.timestampedFilePath.startsWith('bookmarks/') ? options.timestampedFilePath : `bookmarks/${options.timestampedFilePath}`)
      : await resolveLatestGitHubBookmarkBackupPath(credentials, username);
    const fileData = await githubService.getFileContent(credentials, username, DEFAULT_BACKUP_REPO, filePath);
    const parsed = parseBackup(fileData.content);
    const converted = backupV2ToSnapshotTree(parsed.backup);
    const repository = options.repository || getSnapshotRepository();
    const createdAt = Date.parse(parsed.backup.createdAt);
    const snapshot = await createBookmarkSnapshot({
      repository,
      source: SNAPSHOT_SOURCES.IMPORTED,
      name: `GitHub 导入 - ${new Date(Number.isFinite(createdAt) ? createdAt : Date.now()).toLocaleString()}`,
      userName: options.userName || username,
      isAutomatic: false,
      isProtected: true,
      nodes: converted.nodes,
      roots: converted.roots,
    });
    const plan = await createRestorePlan(snapshot.snapshotId, {
      repository,
      userName: options.userName || username,
    });
    return {
      success: true,
      data: {
        snapshotId: snapshot.snapshotId,
        planId: plan.planId,
        filePath,
        schemaVersion: parsed.schemaVersion,
        bookmarksCount: parsed.backup.stats.bookmarks,
        warnings: parsed.warnings,
      },
      timestamp: snapshot.createdAt,
    };
  } catch (error) {
    const metadata = typeof getGitHubErrorMetadata === 'function' ? getGitHubErrorMetadata(error) : undefined;
    const retryHint = metadata?.retryAfterSeconds !== undefined
      ? `；建议 ${Math.ceil(metadata.retryAfterSeconds)} 秒后重试`
      : metadata?.resetAt
        ? `；配额预计在 ${new Date(metadata.resetAt).toLocaleTimeString()} 重置`
        : '';
    return {
      success: false,
      retryable: isRetryableGitHubError(error),
      error: `准备 GitHub 书签恢复预览失败: ${error instanceof Error ? error.message : String(error)}${retryHint}`,
    };
  }
};
