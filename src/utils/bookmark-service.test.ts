import { browser } from 'wxt/browser';
import bookmarkService, { isBookmarkNode } from './bookmark-service';

describe('bookmark-service Firefox node compatibility', () => {
  test('preserves separator and unmodifiable nodes instead of guessing from URL', async () => {
    browser.bookmarks.getTree = async () => ([{
      id: 'root________',
      title: '',
      children: [{
        id: 'toolbar_____',
        title: 'Bookmarks Toolbar',
        children: [
          { id: 'separator-1', title: '', type: 'separator' },
          { id: 'managed-1', title: 'Managed', type: 'folder', unmodifiable: 'managed', children: [] },
          { id: 'bookmark-1', title: 'A', url: 'https://example.test', type: 'bookmark' },
        ],
      }],
    }] as never);

    const result = await bookmarkService.getAllBookmarks();
    expect(result.success).toBe(true);
    const items = result.data[0].children[0].children;
    expect(items[0]).toMatchObject({ type: 'separator', isFolder: false });
    expect(items[1]).toMatchObject({ type: 'folder', isFolder: true, unmodifiable: 'managed' });
    expect(items[2]).toMatchObject({ type: 'bookmark', isFolder: false });
    expect(isBookmarkNode(items[0])).toBe(false);
    expect(isBookmarkNode(items[2])).toBe(true);
  });
});
