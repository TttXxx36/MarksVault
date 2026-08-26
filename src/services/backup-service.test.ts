import backupService from './backup-service';
import githubService from './github-service';
import { browser } from 'wxt/browser';
import { createBookmarkBackupV2 } from '../core/backup/schema-v2';
import { MemorySnapshotRepository, setSnapshotRepositoryForTesting } from './bookmark-snapshot-service';

jest.mock('./github-service', () => ({
  __esModule: true,
  default: {
    repoExists: jest.fn(),
    getRepositoryFiles: jest.fn(),
    getFileContent: jest.fn(),
  },
  isRetryableGitHubError: jest.fn(() => false),
}));

const mockedGitHub = githubService as jest.Mocked<typeof githubService>;

describe('GitHub 书签恢复统一预览流程', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await browser.storage.local.clear();
    setSnapshotRepositoryForTesting(new MemorySnapshotRepository());
    mockedGitHub.repoExists.mockResolvedValue(true);
    mockedGitHub.getRepositoryFiles.mockResolvedValue([
      { name: 'bookmarks_backup_20250202020202.json', path: 'bookmarks/bookmarks_backup_20250202020202.json' } as any,
    ]);
    browser.bookmarks.getTree = async () => ([{
      id: '0', title: '', children: [
        { id: 'toolbar_____', title: 'Bookmarks Toolbar', type: 'folder', children: [
          { id: 'current-1', parentId: 'toolbar_____', title: 'Existing', type: 'bookmark', url: 'https://existing.test', index: 0 },
        ] },
        { id: 'menu_____', title: 'Bookmarks Menu', type: 'folder', children: [] },
      ],
    }] as never);
  });

  it('新生成的 GitHub 书签备份只使用 schema v2 且不包含凭据', async () => {
    const data = await (backupService as any).createBackupData();

    expect(data.schemaVersion).toBe(2);
    expect(data.app).toBe('MarksVault');
    expect(JSON.stringify(data)).not.toContain('fake-token');
    expect(JSON.stringify(data)).not.toContain('apiKey');
  });

  it('v2 备份只生成导入快照和恢复计划，不调用书签写入 API', async () => {
    const backup = createBookmarkBackupV2([
      { id: 'toolbar_____', title: 'Bookmarks Toolbar', type: 'folder', isFolder: true, children: [
        { id: 'b1', title: 'Existing', type: 'bookmark', isFolder: false, url: 'https://existing.test', parentId: 'toolbar_____' },
        { id: 'b2', title: 'New', type: 'bookmark', isFolder: false, url: 'https://new.test', parentId: 'toolbar_____' },
      ] },
    ]);
    mockedGitHub.getFileContent.mockResolvedValue({ content: JSON.stringify(backup) } as any);
    const createSpy = jest.spyOn(browser.bookmarks, 'create');
    const moveSpy = jest.spyOn(browser.bookmarks, 'move');
    const result = await backupService.restoreFromGitHub({ token: 'fake-token' }, 'alice');

    expect(result.success).toBe(true);
    expect(result.data?.planId).toEqual(expect.any(String));
    expect(result.data?.snapshotId).toEqual(expect.any(String));
    expect(createSpy).not.toHaveBeenCalled();
    expect(moveSpy).not.toHaveBeenCalled();
  });

  it('旧 v1 备份先迁移为导入快照并给出兼容警告', async () => {
    mockedGitHub.getFileContent.mockResolvedValue({ content: JSON.stringify({
      version: '1.0', timestamp: 1735600000000, source: 'legacy',
      bookmarks: [{ id: 'toolbar_____', title: 'Bookmarks Toolbar', isFolder: true, children: [
        { id: 'legacy-b', title: 'Legacy', url: 'https://legacy.test', isFolder: false },
      ] }],
    }) } as any);
    const result = await backupService.restoreFromGitHub({ token: 'fake-token' }, 'alice');

    expect(result.success).toBe(true);
    expect(result.data?.schemaVersion).toBe(1);
    expect(result.data?.warnings?.[0]).toContain('旧版 v1');
  });

  it('损坏或不安全备份在任何写入前拒绝', async () => {
    mockedGitHub.getFileContent.mockResolvedValue({ content: JSON.stringify({
      schemaVersion: 2, app: 'MarksVault', createdAt: new Date().toISOString(),
      source: { extensionVersion: '2.1.1', browser: 'fixture', manifestVersion: 3 },
      roots: [{ role: 'toolbar', originalTitle: 'Bookmarks Toolbar', children: [{
        id: 'unsafe', title: 'Unsafe', type: 'bookmark', url: 'javascript:alert(1)', path: '',
      }] }],
      stats: { bookmarks: 1, folders: 0, separators: 0, maxDepth: 0 },
    }) } as any);
    const createSpy = jest.spyOn(browser.bookmarks, 'create');
    const result = await backupService.restoreFromGitHub({ token: 'fake-token' }, 'alice');

    expect(result.success).toBe(false);
    expect(result.error).toContain('校验失败');
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('最新文件选择仍优先时间戳文件并兼容 latest 文件', async () => {
    mockedGitHub.getRepositoryFiles.mockResolvedValue([
      { name: 'bookmarks_backup_latest.json', path: 'bookmarks/bookmarks_backup_latest.json' } as any,
      { name: 'bookmarks_backup_20240101010101.json', path: 'bookmarks/bookmarks_backup_20240101010101.json' } as any,
      { name: 'bookmarks_backup_20250202020202.json', path: 'bookmarks/bookmarks_backup_20250202020202.json' } as any,
    ]);
    mockedGitHub.getFileContent.mockRejectedValue(new Error('fixture-stop'));
    const result = await backupService.restoreFromGitHub({ token: 'fake-token' }, 'alice');

    expect(result.success).toBe(false);
    expect(mockedGitHub.getFileContent).toHaveBeenCalledWith(
      { token: 'fake-token' }, 'alice', 'marksvault-backups', 'bookmarks/bookmarks_backup_20250202020202.json'
    );
  });

  it('HTML 图标预加载按域名去重，避免重复抓取', async () => {
    const service = backupService as any;
    const fetchIconSpy = jest.spyOn(service, 'fetchIconAsBase64').mockResolvedValue('data:image/png;base64,AAA');

    const faviconMap = await service.preloadFaviconIcons([
      { id: '1', title: 'A-1', url: 'https://a.example.com/path-1', isFolder: false },
      { id: '2', title: 'A-2', url: 'https://a.example.com/path-2', isFolder: false },
      { id: '3', title: 'B-1', url: 'https://b.example.com/path-1', isFolder: false },
    ]);

    expect(fetchIconSpy).toHaveBeenCalledTimes(2);
    expect(faviconMap.size).toBe(2);
    fetchIconSpy.mockRestore();
  });
});
