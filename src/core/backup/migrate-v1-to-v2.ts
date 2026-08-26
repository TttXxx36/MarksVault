import type { BookmarkBackupV1, BookmarkBackupV2 } from '../../types/backup';
import type { BookmarkItem } from '../../utils/bookmark-service';
import { createBookmarkBackupV2 } from './schema-v2';

/** Convert legacy nested BookmarkItem data without writing to the browser. */
export const migrateBookmarkBackupV1ToV2 = (legacy: BookmarkBackupV1): BookmarkBackupV2 => {
  const createdAt = new Date(Number.isFinite(legacy.timestamp) ? legacy.timestamp : Date.now());
  const sourceItems = Array.isArray(legacy.bookmarks) ? legacy.bookmarks : [];
  return createBookmarkBackupV2(sourceItems as BookmarkItem[], createdAt);
};
