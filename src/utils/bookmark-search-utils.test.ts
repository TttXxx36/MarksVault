import {
  getBookmarkFuzzyScore,
  getDuplicateUrlCounts,
  getSearchHighlightRanges,
  normalizeDuplicateUrlKey,
  sortBookmarkItems,
} from './bookmark-search-utils';

describe('bookmark-search-utils 模糊搜索评分', () => {
  test('标题直接包含关键字时应高分命中', () => {
    const score = getBookmarkFuzzyScore('github', 'GitHub - Build software', 'https://github.com');
    expect(score).toBeGreaterThan(200);
  });

  test('支持非连续字符匹配（gthb -> github）', () => {
    const score = getBookmarkFuzzyScore('gthb', 'GitHub', 'https://github.com');
    expect(score).toBeGreaterThan(0);
  });

  test('多关键字采用 AND 语义，缺少任一关键字则不命中', () => {
    const matchedScore = getBookmarkFuzzyScore('react docs', 'React 官方文档', 'https://react.dev/docs');
    const unmatchedScore = getBookmarkFuzzyScore('react docs', 'React 官方站点', 'https://react.dev');

    expect(matchedScore).toBeGreaterThan(0);
    expect(unmatchedScore).toBe(0);
  });

  test('不相关内容应返回 0', () => {
    const score = getBookmarkFuzzyScore('kubernetes', 'GitHub', 'https://github.com');
    expect(score).toBe(0);
  });
});

describe('getSearchHighlightRanges', () => {
  test('中文子串命中', () => {
    // 'GitHub 教程'：GitHub 6 字符 + 空格 1 字符，'教程' 位于索引 7-8
    expect(getSearchHighlightRanges('GitHub 教程', '教程')).toEqual([{ start: 7, end: 9 }]);
  });

  test('大小写不敏感命中', () => {
    expect(getSearchHighlightRanges('GitHub 教程', 'github')).toEqual([{ start: 0, end: 6 }]);
  });

  test('多 term 各自命中', () => {
    // 'React 入门指南'：React 0-4，空格 5，'入门指南' 从 6 开始，'指南' 位于索引 8-9
    expect(getSearchHighlightRanges('React 入门指南', 'react 指南')).toEqual([
      { start: 0, end: 5 },
      { start: 8, end: 10 },
    ]);
  });

  test('同一 term 多次出现时全部记录', () => {
    // 'a-b-a'：a 位于索引 0 和 4
    expect(getSearchHighlightRanges('a-b-a', 'a')).toEqual([
      { start: 0, end: 1 },
      { start: 4, end: 5 },
    ]);
  });

  test('空 query、空白 query、空 text、无匹配均返回空数组', () => {
    expect(getSearchHighlightRanges('GitHub 教程', '')).toEqual([]);
    expect(getSearchHighlightRanges('GitHub 教程', '   ')).toEqual([]);
    expect(getSearchHighlightRanges('', '教程')).toEqual([]);
    expect(getSearchHighlightRanges('GitHub 教程', 'xyz')).toEqual([]);
  });

  test('重叠/相邻区间合并，不产生重复区间', () => {
    // 'abcabc' 中整个 term 命中，只产生一个区间
    expect(getSearchHighlightRanges('abcabc', 'abcabc')).toEqual([{ start: 0, end: 6 }]);
  });
});

describe('sortBookmarkItems', () => {
  test('default 顺序保持原数组引用不变', () => {
    const items = [{ title: 'b' }, { title: 'a' }];
    expect(sortBookmarkItems(items, 'default')).toBe(items);
  });

  test('title 排序结果与 localeCompare 等价', () => {
    const items = [
      { title: '苹果', index: 0 },
      { title: '香蕉', index: 1 },
      { title: '菠萝', index: 2 },
    ];
    const sorted = sortBookmarkItems(items, 'title');

    // 元素集合相同、长度不变
    expect(sorted).toHaveLength(items.length);
    expect(sorted.map(item => item.title).sort()).toEqual(['苹果', '香蕉', '菠萝'].sort());
    // 与直接 localeCompare 排序结果一致（不硬编码具体码位顺序）
    const expected = [...items].sort((a, b) =>
      a.title.localeCompare(b.title, 'zh-Hans-CN', { sensitivity: 'base' }),
    );
    expect(sorted).toEqual(expected);
    // 原数组不被修改
    expect(items).toEqual([
      { title: '苹果', index: 0 },
      { title: '香蕉', index: 1 },
      { title: '菠萝', index: 2 },
    ]);
  });

  test('title 相同时按 index 次键升序', () => {
    const items = [
      { title: 'x', index: 1 },
      { title: 'x', index: 0 },
    ];
    expect(sortBookmarkItems(items, 'title')).toEqual([
      { title: 'x', index: 0 },
      { title: 'x', index: 1 },
    ]);
  });

  test('dateAdded 降序（新添加在前）', () => {
    const items = [
      { title: 'a', dateAdded: 100 },
      { title: 'b', dateAdded: 300 },
      { title: 'c', dateAdded: 200 },
    ];
    expect(sortBookmarkItems(items, 'dateAdded')).toEqual([
      { title: 'b', dateAdded: 300 },
      { title: 'c', dateAdded: 200 },
      { title: 'a', dateAdded: 100 },
    ]);
  });

  test('dateAdded 缺失或相同时按 index 次键升序', () => {
    const items = [
      { title: 'a', dateAdded: undefined, index: 1 },
      { title: 'b', dateAdded: undefined, index: 0 },
    ];
    expect(sortBookmarkItems(items, 'dateAdded')).toEqual([
      { title: 'b', dateAdded: undefined, index: 0 },
      { title: 'a', dateAdded: undefined, index: 1 },
    ]);
  });

  test('空数组和单元素数组原样返回', () => {
    const empty: { title: string }[] = [];
    expect(sortBookmarkItems(empty, 'title')).toBe(empty);
    expect(sortBookmarkItems(empty, 'dateAdded')).toBe(empty);

    const single = [{ title: 'only' }];
    expect(sortBookmarkItems(single, 'title')).toBe(single);
  });
});

describe('重复书签检测', () => {
  describe('normalizeDuplicateUrlKey', () => {
    test('大小写折叠', () => {
      expect(normalizeDuplicateUrlKey('HTTPS://GITHUB.COM/A')).toBe('https://github.com/a');
    });

    test('去除单个尾部斜杠', () => {
      expect(normalizeDuplicateUrlKey('https://a.com/x/')).toBe('https://a.com/x');
    });

    test('去除多个尾部斜杠', () => {
      expect(normalizeDuplicateUrlKey('https://a.com///')).toBe('https://a.com');
    });

    test('纯根 URL 去除尾部斜杠', () => {
      expect(normalizeDuplicateUrlKey('https://a.com/')).toBe('https://a.com');
    });

    test('去除首尾空白', () => {
      expect(normalizeDuplicateUrlKey('  https://a.com/x  ')).toBe('https://a.com/x');
    });

    test('空串与空白输入返回空串', () => {
      expect(normalizeDuplicateUrlKey('')).toBe('');
      expect(normalizeDuplicateUrlKey('   ')).toBe('');
    });
  });

  describe('getDuplicateUrlCounts', () => {
    test('空数组返回空 map', () => {
      expect(getDuplicateUrlCounts([])).toEqual(new Map());
    });

    test('无 url 或空 url 的项被忽略', () => {
      const counts = getDuplicateUrlCounts([{}, { url: '' }, { url: 'https://a.com' }]);
      expect(Array.from(counts.entries())).toEqual([]);
    });

    test('单次出现的 URL 不在结果中', () => {
      const counts = getDuplicateUrlCounts([{ url: 'https://a.com' }]);
      expect(counts.has('https://a.com')).toBe(false);
      expect(Array.from(counts.entries())).toEqual([]);
    });

    test('同一 URL 出现 3 次计数为 3', () => {
      const counts = getDuplicateUrlCounts([
        { url: 'https://a.com/x' },
        { url: 'https://a.com/x' },
        { url: 'https://a.com/x' },
      ]);
      expect(counts.get('https://a.com/x')).toBe(3);
    });

    test('大小写与尾部斜杠不同的 URL 合并判重', () => {
      const counts = getDuplicateUrlCounts([
        { url: 'https://A.com/X' },
        { url: 'https://a.com/x/' },
      ]);
      expect(counts.get('https://a.com/x')).toBe(2);
    });

    test('返回的键是规范化后的形式', () => {
      const counts = getDuplicateUrlCounts([
        { url: 'HTTPS://A.com/X/' },
        { url: 'https://a.com/x' },
        { url: 'https://a.com/y' },
      ]);
      expect(Array.from(counts.entries())).toEqual([['https://a.com/x', 2]]);
    });

    test('纯函数，不修改入参数组', () => {
      const items = [{ url: 'https://A.com/x' }, { url: 'https://a.com/x/' }];
      const snapshot = [...items];
      getDuplicateUrlCounts(items);
      expect(items).toEqual(snapshot);
    });
  });
});
