import type { BookmarkBackupV1 } from '../../types/backup';

export const isBookmarkBackupV1 = (value: unknown): value is BookmarkBackupV1 => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BookmarkBackupV1>;
  return candidate.version === '1.0' && Array.isArray(candidate.bookmarks);
};
