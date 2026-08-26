import { BookmarkItem } from '../utils/bookmark-service';
import type { BookmarkRootRole } from './snapshot';

/**
 * 书签备份数据结构
 */
export interface BookmarkBackupV1 {
  /** 备份版本号 */
  version: string;
  /** 备份创建时间戳 */
  timestamp: number;
  /** 备份设备/来源信息 */
  source: string;
  /** 书签树 */
  bookmarks: BookmarkItem[];
  /** 备份元数据 */
  metadata?: {
    /** 总书签数量 */
    totalBookmarks: number;
    /** 总文件夹数量 */
    totalFolders: number;
    /** 其他可能的元数据 */
    [key: string]: any;
  };
}

export interface BookmarkNodeV2 {
  id: string;
  parentId?: string;
  title: string;
  type: 'bookmark' | 'folder' | 'separator';
  url?: string;
  children?: BookmarkNodeV2[];
  dateAdded?: number;
  index?: number;
  path: string;
  unmodifiable?: string;
}

export interface BookmarkBackupV2 {
  schemaVersion: 2;
  app: 'MarksVault';
  createdAt: string;
  source: {
    extensionVersion: string;
    browser: string;
    manifestVersion: 2 | 3;
    platform?: string;
  };
  roots: Array<{
    role: BookmarkRootRole;
    originalTitle: string;
    nativeId?: string;
    children: BookmarkNodeV2[];
  }>;
  stats: {
    bookmarks: number;
    folders: number;
    separators: number;
    maxDepth: number;
    nodeCount?: number;
    byteSize?: number;
    contentHash?: string;
  };
  /** Transitional metadata used by old status/reporting callers. */
  timestamp?: number;
}

export type BookmarkBackup = BookmarkBackupV1 | BookmarkBackupV2;

/**
 * 备份操作结果
 */
export interface BackupResult {
  /** 操作是否成功 */
  success: boolean;
  /** 返回的数据(如果有) */
  data?: any;
  /** 错误信息(如果有) */
  error?: string;
  /** 时间戳 */
  timestamp?: number;
  /** 结构化可重试性标记：失败是否属于临时性失败（网络、限流等），重试判定仅依据此字段 */
  retryable?: boolean;
}

/**
 * 备份状态信息
 */
export interface BackupStatus {
  /** 最后备份时间 */
  lastBackupTime?: number;
  /** 最后恢复时间 */
  lastRestoreTime?: number;
  /** 备份文件URL */
  backupFileUrl?: string;
  /** 最后备份的文件路径 */
  lastBackupFilePath?: string;
  /** 最后操作状态 */
  lastOperationStatus?: 'success' | 'failed';
  /** 错误信息 */
  errorMessage?: string;
  /** 备份统计信息 */
  stats?: {
    /** 总备份数量 */
    totalBackups?: number;
    /** 最早备份时间 */
    firstBackupTime?: number;
    /** 最新备份中的书签数量 */
    totalBookmarks?: number;
    /** 最新备份中的文件夹数量 */
    totalFolders?: number;
    /** 最新备份文件大小(字节) */
    fileSize?: number;
    /** 是否来自缓存数据 */
    isFromCache?: boolean;
  };
}
