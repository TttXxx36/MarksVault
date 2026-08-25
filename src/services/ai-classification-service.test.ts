import { browser } from 'wxt/browser';
import { AiClassificationPlan } from '../types/ai';
import { rollbackAiClassificationPlan } from './ai-classification-service';

describe('ai-classification rollback safety', () => {
  const bookmarks = browser.bookmarks as any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('does not move a node that was changed by the user after the operation', async () => {
    bookmarks.get.mockImplementation(async (id: string) => {
      if (id === 'unprocessed') return [{ id, parentId: 'user-folder', url: 'https://user.example' }];
      return [{ id, parentId: 'ai-folder', url: 'https://processed.example' }];
    });

    const plan: AiClassificationPlan = {
      id: 'plan-1',
      createdAt: Date.now(),
      categories: [],
      assignments: [],
      snapshot: [
        { id: 'unprocessed', parentId: 'original-folder', index: 0 },
        { id: 'processed', parentId: 'original-folder', index: 1 },
      ],
      skippedBookmarkIds: [],
      unassignedBookmarkIds: [],
      appliedBookmarkIds: ['processed'],
      appliedDestinationByBookmarkId: { processed: 'ai-folder' },
      createdFolderIds: [],
      state: 'applied',
    };

    await rollbackAiClassificationPlan(plan);

    expect(bookmarks.move).toHaveBeenCalledTimes(1);
    expect(bookmarks.move).toHaveBeenCalledWith('processed', {
      parentId: 'original-folder',
      index: 1,
    });
  });
});
