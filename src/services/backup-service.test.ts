import backupService from './backup-service';
import githubService from './github-service';
import storageService from '../utils/storage-service';
import bookmarkService from '../utils/bookmark-service';
import { browser } from 'wxt/browser';

jest.mock('./github-service', () => ({
  __esModule: true,
  default: {
    repoExists: jest.fn(),
    getRepositoryFiles: jest.fn(),
    getFileContent: jest.fn(),
  },
  // 测试中的错误均为普通错误（配置/文件错误），结构化判定返回不可重试
  isRetryableGitHubError: jest.fn(() => false),
  GitHubApiError: class extends Error {},
  RetryableError: class extends Error {},
}));

jest.mock('../utils/storage-service', () => ({
  __esModule: true,
  default: {
    saveBackupStatus: jest.fn(),
    setStorageData: jest.fn(),
  },
}));

jest.mock('../utils/bookmark-service', () => ({
  __esModule: true,
  isBookmarkBarNode: jest.fn((item: { id: string; title: string }) => {
    const normalizedId = item.id.toLowerCase();
    if (normalizedId === '1' || normalizedId.startsWith('toolbar')) {
      return true;
    }
    const normalizedTitle = item.title.trim().toLowerCase();
    return ['书签栏', '書籤列', 'bookmarks bar', 'bookmark bar', 'bookmarks toolbar', 'bookmark toolbar']
      .includes(normalizedTitle);
  }),
  findBookmarkBar: jest.fn((roots: Array<{ id: string; title: string; isFolder?: boolean }>) => {
    if (!Array.isArray(roots) || roots.length === 0) {
      return undefined;
    }
    return roots.find(root => {
      const normalizedId = root.id.toLowerCase();
      const normalizedTitle = root.title.trim().toLowerCase();
      return normalizedId === '1'
        || normalizedId.startsWith('toolbar')
        || ['书签栏', '書籤列', 'bookmarks bar', 'bookmark bar', 'bookmarks toolbar', 'bookmark toolbar']
          .includes(normalizedTitle);
    }) ?? roots.find(root => root.isFolder) ?? roots[0];
  }),
  default: {
    getBookmarkRoots: jest.fn(),
    removeBookmarkTree: jest.fn(),
    createFolder: jest.fn(),
    createBookmark: jest.fn(),
  },
}));

describe('backup-service 恢复路径选择', () => {
  const mockedGitHub = githubService as jest.Mocked<typeof githubService>;
  const mockedStorage = storageService as jest.Mocked<typeof storageService>;
  const mockedBookmark = bookmarkService as jest.Mocked<typeof bookmarkService>;
  const credentials = { token: 'test-token' };
  const username = 'alice';

  const backupFileContent = JSON.stringify({
    timestamp: 1735600000000,
    metadata: {
      totalBookmarks: 1,
    },
    bookmarks: [
      {
        id: '0',
        title: 'root',
        isFolder: true,
        children: [
          {
            id: '1',
            title: 'Bookmarks Bar',
            isFolder: true,
            children: [
              {
                id: '2',
                title: 'Example',
                url: 'https://example.com',
                isFolder: false,
              },
            ],
          },
        ],
      },
    ],
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedGitHub.repoExists.mockResolvedValue(true);
    mockedStorage.saveBackupStatus.mockResolvedValue({ success: true });
    mockedStorage.setStorageData.mockResolvedValue({ success: true } as any);
    mockedBookmark.getBookmarkRoots.mockResolvedValue({
      success: true,
      data: [
        {
          id: '1',
          title: 'Bookmarks Bar',
          isFolder: true,
          children: [
            {
              id: 'old-1',
              title: 'Old Bookmark',
              url: 'https://old.example.com',
              isFolder: false,
            },
          ],
        },
      ],
    } as any);
    mockedBookmark.removeBookmarkTree.mockResolvedValue({ success: true } as any);
    mockedBookmark.createFolder.mockResolvedValue({
      success: true,
      data: { id: 'folder-created' },
    } as any);
    mockedBookmark.createBookmark.mockResolvedValue({
      success: true,
      data: { id: 'bookmark-created' },
    } as any);
  });

  test('默认恢复会优先选择最新时间戳备份文件', async () => {
    mockedGitHub.getRepositoryFiles.mockResolvedValue([
      {
        name: 'bookmarks_backup_20240101010101.json',
        path: 'bookmarks/bookmarks_backup_20240101010101.json',
      } as any,
      {
        name: 'bookmarks_backup_20250202020202.json',
        path: 'bookmarks/bookmarks_backup_20250202020202.json',
      } as any,
    ]);
    mockedGitHub.getFileContent.mockRejectedValue(new Error('stop-here'));

    const result = await backupService.restoreFromGitHub(credentials, username);

    expect(result.success).toBe(false);
    expect(mockedGitHub.getFileContent).toHaveBeenCalledWith(
      credentials,
      username,
      'marksvault-backups',
      'bookmarks/bookmarks_backup_20250202020202.json'
    );
  });

  test('当没有时间戳备份时，兼容回退到 latest 文件', async () => {
    mockedGitHub.getRepositoryFiles.mockResolvedValue([
      {
        name: 'bookmarks_backup_latest.json',
        path: 'bookmarks/bookmarks_backup_latest.json',
      } as any,
    ]);
    mockedGitHub.getFileContent.mockRejectedValue(new Error('stop-here'));

    const result = await backupService.restoreFromGitHub(credentials, username);

    expect(result.success).toBe(false);
    expect(mockedGitHub.getFileContent).toHaveBeenCalledWith(
      credentials,
      username,
      'marksvault-backups',
      'bookmarks/bookmarks_backup_latest.json'
    );
  });

  test('当不存在可恢复文件时，返回明确错误', async () => {
    mockedGitHub.getRepositoryFiles.mockResolvedValue([]);

    const result = await backupService.restoreFromGitHub(credentials, username);

    expect(result.success).toBe(false);
    expect(result.error).toContain('未找到可恢复的书签备份文件');
    expect(mockedGitHub.getFileContent).not.toHaveBeenCalled();
  });

  test('删除旧书签失败时应中断恢复并返回失败', async () => {
    mockedGitHub.getRepositoryFiles.mockResolvedValue([
      {
        name: 'bookmarks_backup_20250202020202.json',
        path: 'bookmarks/bookmarks_backup_20250202020202.json',
      } as any,
    ]);
    mockedGitHub.getFileContent.mockResolvedValue({ content: backupFileContent } as any);
    mockedBookmark.removeBookmarkTree.mockResolvedValue({
      success: false,
      error: 'permission denied',
    } as any);

    const result = await backupService.restoreFromGitHub(credentials, username);

    expect(result.success).toBe(false);
    expect(result.error).toContain('删除现有书签失败');
    expect(mockedBookmark.createBookmark).not.toHaveBeenCalled();
  });

  test('创建新书签失败时应中断恢复并返回失败', async () => {
    mockedGitHub.getRepositoryFiles.mockResolvedValue([
      {
        name: 'bookmarks_backup_20250202020202.json',
        path: 'bookmarks/bookmarks_backup_20250202020202.json',
      } as any,
    ]);
    mockedGitHub.getFileContent.mockResolvedValue({ content: backupFileContent } as any);
    mockedBookmark.createBookmark.mockResolvedValue({
      success: false,
      error: 'invalid url',
    } as any);

    const result = await backupService.restoreFromGitHub(credentials, username);

    expect(result.success).toBe(false);
    expect(result.error).toContain('创建书签失败');
  });

  test('Firefox 书签栏ID（toolbar前缀）应能被正确识别', async () => {
    const firefoxBackupContent = JSON.stringify({
      timestamp: 1735600000000,
      metadata: {
        totalBookmarks: 1,
      },
      bookmarks: [
        {
          id: 'root________',
          title: '',
          isFolder: true,
          children: [
            {
              id: 'toolbar_____',
              title: 'Bookmarks Toolbar',
              isFolder: true,
              children: [
                {
                  id: '2',
                  title: 'Example',
                  url: 'https://example.com',
                  isFolder: false,
                },
              ],
            },
          ],
        },
      ],
    });

    mockedGitHub.getRepositoryFiles.mockResolvedValue([
      {
        name: 'bookmarks_backup_20250202020202.json',
        path: 'bookmarks/bookmarks_backup_20250202020202.json',
      } as any,
    ]);
    mockedGitHub.getFileContent.mockResolvedValue({ content: firefoxBackupContent } as any);
    mockedBookmark.getBookmarkRoots.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'toolbar_____',
          title: 'Bookmarks Toolbar',
          isFolder: true,
          children: [],
        },
      ],
    } as any);

    const result = await backupService.restoreFromGitHub(credentials, username);

    expect(result.success).toBe(true);
    expect(mockedBookmark.createBookmark).toHaveBeenCalledWith({
      parentId: 'toolbar_____',
      title: 'Example',
      url: 'https://example.com',
    });
  });

  test('HTML 图标预加载应按域名去重，避免重复抓取', async () => {
    const service = backupService as any;
    const fetchIconSpy = jest
      .spyOn(service, 'fetchIconAsBase64')
      .mockResolvedValue('data:image/png;base64,AAA');

    const faviconMap = await service.preloadFaviconIcons([
      {
        id: '1',
        title: 'A-1',
        url: 'https://a.example.com/path-1',
        isFolder: false,
      },
      {
        id: '2',
        title: 'A-2',
        url: 'https://a.example.com/path-2',
        isFolder: false,
      },
      {
        id: '3',
        title: 'B-1',
        url: 'https://b.example.com/path-1',
        isFolder: false,
      },
    ]);

    expect(fetchIconSpy).toHaveBeenCalledTimes(2);
    expect(faviconMap.size).toBe(2);

    fetchIconSpy.mockRestore();
  });
});

describe('backup-service restore 前置校验与暂存保护', () => {
  const mockedGitHub = githubService as jest.Mocked<typeof githubService>;
  const mockedStorage = storageService as jest.Mocked<typeof storageService>;
  const mockedBookmark = bookmarkService as jest.Mocked<typeof bookmarkService>;
  const credentials = { token: 'test-token' };
  const username = 'alice';

  // 构造备份内容：bookmarks[0].children[0] 为书签栏，其 children 为待恢复数据
  const buildBackupContent = (barChildren: any[]): string => JSON.stringify({
    timestamp: 1735600000000,
    metadata: { totalBookmarks: 1 },
    bookmarks: [
      {
        id: '0',
        title: 'root',
        isFolder: true,
        children: [
          { id: '1', title: 'Bookmarks Bar', isFolder: true, children: barChildren },
        ],
      },
    ],
  });

  // 构造嵌套链：leaf 被 depth 层文件夹包裹
  const buildDeepNestedNode = (depth: number): any => {
    let node: any = { id: 'leaf', title: 'Leaf', url: 'https://example.com', isFolder: false };
    for (let i = 0; i < depth; i++) {
      node = { id: `folder-${i}`, title: `Folder ${i}`, isFolder: true, children: [node] };
    }
    return node;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedGitHub.repoExists.mockResolvedValue(true);
    mockedStorage.saveBackupStatus.mockResolvedValue({ success: true });
    mockedStorage.setStorageData.mockResolvedValue({ success: true } as any);
    mockedBookmark.getBookmarkRoots.mockResolvedValue({
      success: true,
      data: [
        {
          id: '1',
          title: 'Bookmarks Bar',
          isFolder: true,
          children: [
            {
              id: 'old-1',
              title: 'Old Bookmark',
              url: 'https://old.example.com',
              isFolder: false,
            },
          ],
        },
      ],
    } as any);
    mockedBookmark.removeBookmarkTree.mockResolvedValue({ success: true } as any);
    mockedBookmark.createFolder.mockResolvedValue({
      success: true,
      data: { id: 'folder-created' },
    } as any);
    mockedBookmark.createBookmark.mockResolvedValue({
      success: true,
      data: { id: 'bookmark-created' },
    } as any);
    mockedGitHub.getRepositoryFiles.mockResolvedValue([
      {
        name: 'bookmarks_backup_20250202020202.json',
        path: 'bookmarks/bookmarks_backup_20250202020202.json',
      } as any,
    ]);
  });

  test('嵌套层级过深的备份应在任何删除/暂存前被拒绝', async () => {
    mockedGitHub.getFileContent.mockResolvedValue({
      content: buildBackupContent([buildDeepNestedNode(101)]),
    } as any);

    const result = await backupService.restoreFromGitHub(credentials, username);

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('嵌套层级过深');
    expect(mockedBookmark.removeBookmarkTree).not.toHaveBeenCalled();
    expect(mockedStorage.setStorageData).not.toHaveBeenCalled();
  });

  test('节点数超过上限的备份应在任何删除/暂存前被拒绝', async () => {
    const manyItems = Array.from({ length: 5001 }, (_, i) => ({
      id: `b-${i}`,
      title: `B ${i}`,
      url: 'https://example.com',
      isFolder: false,
    }));
    mockedGitHub.getFileContent.mockResolvedValue({
      content: buildBackupContent(manyItems),
    } as any);

    const result = await backupService.restoreFromGitHub(credentials, username);

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('备份文件过大');
    expect(mockedBookmark.removeBookmarkTree).not.toHaveBeenCalled();
    expect(mockedStorage.setStorageData).not.toHaveBeenCalled();
  });

  test('暂存现有书签失败时应拒绝恢复，不进入删除阶段', async () => {
    mockedGitHub.getFileContent.mockResolvedValue({
      content: buildBackupContent([
        { id: '2', title: 'Example', url: 'https://example.com', isFolder: false },
      ]),
    } as any);
    mockedStorage.setStorageData.mockResolvedValue({
      success: false,
      error: 'quota exceeded',
    } as any);

    const result = await backupService.restoreFromGitHub(credentials, username);

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('暂存现有书签失败');
    expect(mockedBookmark.removeBookmarkTree).not.toHaveBeenCalled();
  });

  test('恢复成功前应暂存现有书签树，成功后清理暂存键', async () => {
    mockedGitHub.getFileContent.mockResolvedValue({
      content: buildBackupContent([
        { id: '2', title: 'Example', url: 'https://example.com', isFolder: false },
      ]),
    } as any);
    const removeSpy = jest.spyOn(browser.storage.local, 'remove');

    const result = await backupService.restoreFromGitHub(credentials, username);

    expect(result.success).toBe(true);
    // 暂存：写入序列化后的书签栏树（含现有旧书签）
    expect(mockedStorage.setStorageData).toHaveBeenCalledWith(
      'pending_restore_backup',
      expect.stringContaining('old-1')
    );
    expect(mockedStorage.setStorageData).toHaveBeenCalledWith(
      'pending_restore_backup',
      expect.stringContaining('Old Bookmark')
    );
    // 成功后清理暂存键
    expect(removeSpy).toHaveBeenCalledWith('pending_restore_backup');
    removeSpy.mockRestore();
  });

  test('恢复中途失败时应保留暂存数据（不清理）', async () => {
    mockedGitHub.getFileContent.mockResolvedValue({
      content: buildBackupContent([
        { id: '2', title: 'Example', url: 'https://example.com', isFolder: false },
      ]),
    } as any);
    mockedBookmark.createBookmark.mockResolvedValue({
      success: false,
      error: 'invalid url',
    } as any);
    const removeSpy = jest.spyOn(browser.storage.local, 'remove');

    const result = await backupService.restoreFromGitHub(credentials, username);

    expect(result.success).toBe(false);
    expect(mockedStorage.setStorageData).toHaveBeenCalledWith(
      'pending_restore_backup',
      expect.any(String)
    );
    // 失败路径不清理暂存数据，供未来回滚
    expect(removeSpy).not.toHaveBeenCalled();
    removeSpy.mockRestore();
  });
});
