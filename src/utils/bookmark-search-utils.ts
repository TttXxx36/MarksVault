const QUERY_SPACE_REGEX = /\s+/g;

/**
 * 统一搜索文本：去首尾空白、合并多空格、转小写、兼容全角字符。
 */
export const normalizeSearchText = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  let normalized = trimmed;
  try {
    normalized = normalized.normalize('NFKC');
  } catch {
    // 兼容极少数不支持 Unicode normalize 的运行环境
  }

  return normalized.toLowerCase().replace(QUERY_SPACE_REGEX, ' ');
};

const splitQueryTerms = (normalizedQuery: string): string[] => {
  return normalizedQuery.split(' ').map(term => term.trim()).filter(Boolean);
};

/**
 * 非连续匹配评分（按字符顺序匹配）。
 */
const getSubsequenceScore = (query: string, target: string): number => {
  if (!query || !target) {
    return 0;
  }

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let lastMatchIndex = -1;
  let continuousMatches = 0;

  for (let i = 0; i < target.length && queryIndex < query.length; i++) {
    if (target[i] !== query[queryIndex]) {
      continue;
    }

    if (firstMatchIndex === -1) {
      firstMatchIndex = i;
    }

    if (lastMatchIndex === i - 1) {
      continuousMatches += 1;
    }

    lastMatchIndex = i;
    queryIndex += 1;
  }

  if (queryIndex !== query.length || firstMatchIndex === -1 || lastMatchIndex === -1) {
    return 0;
  }

  const spanLength = Math.max(lastMatchIndex - firstMatchIndex + 1, 1);
  const compactness = query.length / spanLength;
  const coverage = query.length / target.length;
  const continuity = continuousMatches / query.length;

  return Math.round(compactness * 35 + coverage * 25 + continuity * 30);
};

const getFieldScore = (queryTerm: string, normalizedField: string, isTitle: boolean): number => {
  if (!queryTerm || !normalizedField) {
    return 0;
  }

  if (normalizedField === queryTerm) {
    return isTitle ? 260 : 220;
  }

  if (normalizedField.startsWith(queryTerm)) {
    return (isTitle ? 220 : 180) - Math.min(normalizedField.length - queryTerm.length, 40) * 0.2;
  }

  const containsIndex = normalizedField.indexOf(queryTerm);
  if (containsIndex >= 0) {
    return (isTitle ? 180 : 150) - Math.min(containsIndex, 50) * 0.8;
  }

  // 单字符查询不做模糊匹配，避免噪音结果过多。
  if (queryTerm.length < 2) {
    return 0;
  }

  const subsequenceScore = getSubsequenceScore(queryTerm, normalizedField);
  if (subsequenceScore <= 0) {
    return 0;
  }

  return (isTitle ? 95 : 70) + subsequenceScore;
};

/**
 * 计算书签项的模糊匹配分数（越大越相关，0 表示不匹配）。
 */
export const getBookmarkFuzzyScoreByNormalizedQuery = (normalizedQuery: string, title: string, url?: string): number => {
  if (!normalizedQuery) {
    return 0;
  }

  const normalizedTitle = normalizeSearchText(title || '');
  const normalizedUrl = normalizeSearchText(url || '');

  if (!normalizedTitle && !normalizedUrl) {
    return 0;
  }

  const terms = splitQueryTerms(normalizedQuery);
  if (terms.length === 0) {
    return 0;
  }

  let totalScore = 0;

  // 多关键字策略：每个 term 都必须命中（AND 语义）。
  for (const term of terms) {
    const titleScore = getFieldScore(term, normalizedTitle, true);
    const urlScore = getFieldScore(term, normalizedUrl, false);
    const termBestScore = Math.max(titleScore, urlScore);

    if (termBestScore <= 0) {
      return 0;
    }

    totalScore += termBestScore;
  }

  // 全 query 直接命中加权，帮助“完整词组”优先。
  if (normalizedTitle.includes(normalizedQuery)) {
    totalScore += 40;
  } else if (normalizedUrl.includes(normalizedQuery)) {
    totalScore += 20;
  }

  return Math.round(totalScore);
};

/**
 * 计算书签项的模糊匹配分数（对外入口，内部会先归一化 query）。
 */
export const getBookmarkFuzzyScore = (query: string, title: string, url?: string): number => {
  const normalizedQuery = normalizeSearchText(query);
  return getBookmarkFuzzyScoreByNormalizedQuery(normalizedQuery, title, url);
};

// 书签目录排序方式：default=浏览器原始顺序，title=按标题，dateAdded=按添加时间（新→旧）
export type BookmarkSortOrder = 'default' | 'title' | 'dateAdded';

// 文本高亮区间：[start, end) 字符索引（基于原文本，非归一化文本）
export interface HighlightRange {
  start: number;
  end: number;
}

/**
 * 计算搜索命中关键词的高亮区间（纯函数）。
 * 基于原文本小写化后的字符索引，保证与原始 text 一一对应。
 */
export const getSearchHighlightRanges = (text: string, query: string): HighlightRange[] => {
  const normalizedQuery = normalizeSearchText(query);

  // 空文本或空 query 直接返回空数组
  if (!text || !normalizedQuery) {
    return [];
  }

  const terms = splitQueryTerms(normalizedQuery);
  const lowerText = text.toLowerCase();
  const ranges: HighlightRange[] = [];

  // 逐 term 查找所有出现位置（不做 NFKC 归一化，只 toLowerCase）
  for (const term of terms) {
    if (!term) {
      continue;
    }

    let fromIndex = 0;
    let matchIndex = lowerText.indexOf(term, fromIndex);
    while (matchIndex >= 0) {
      ranges.push({ start: matchIndex, end: matchIndex + term.length });
      fromIndex = matchIndex + term.length;
      matchIndex = lowerText.indexOf(term, fromIndex);
    }
  }

  if (ranges.length === 0) {
    return [];
  }

  // 按 start 升序排序
  ranges.sort((a, b) => a.start - b.start);

  // 合并相邻或重叠区间（next.start <= prev.end 时合并）
  const merged: HighlightRange[] = [{ ...ranges[0] }];
  for (let i = 1; i < ranges.length; i++) {
    const prev = merged[merged.length - 1];
    const next = ranges[i];
    if (next.start <= prev.end) {
      prev.end = Math.max(prev.end, next.end);
    } else {
      merged.push({ ...next });
    }
  }

  return merged;
};

/**
 * 书签目录排序（纯函数）。
 * default 保持原始顺序；title 按标题升序；dateAdded 按添加时间降序（新在前）。
 */
export const sortBookmarkItems = <T extends { title: string; dateAdded?: number; index?: number }>(
  items: T[],
  order: BookmarkSortOrder,
): T[] => {
  // default 顺序或无需排序时原样返回（不拷贝）
  if (order === 'default' || items.length <= 1) {
    return items;
  }

  const sorted = [...items];

  if (order === 'title') {
    sorted.sort((a, b) => {
      const titleCompare = a.title.localeCompare(b.title, 'zh-Hans-CN', { sensitivity: 'base' });
      if (titleCompare !== 0) {
        return titleCompare;
      }
      // 标题相同时按 index 稳定次键
      return (a.index ?? 0) - (b.index ?? 0);
    });
  } else if (order === 'dateAdded') {
    sorted.sort((a, b) => {
      const dateCompare = (b.dateAdded ?? 0) - (a.dateAdded ?? 0);
      if (dateCompare !== 0) {
        return dateCompare;
      }
      // 时间相同或缺失时按 index 次键
      return (a.index ?? 0) - (b.index ?? 0);
    });
  }

  return sorted;
};

/**
 * 规范化书签 URL 为判重键：去首尾空白、转小写、去掉尾部斜杠（可一次去多个）。
 * 空串或空白输入返回空串。
 */
export const normalizeDuplicateUrlKey = (url: string): string => {
  const trimmed = url.trim().toLowerCase();
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(/\/+$/, '');
};

/**
 * 统计书签列表中各 URL 的出现次数（纯函数，不修改入参）。
 * 键为 normalizeDuplicateUrlKey 规范化后的 URL；无 url 或空 url 的项被忽略；
 * 返回值只包含出现次数 >= 2 的键。
 */
export const getDuplicateUrlCounts = (items: ReadonlyArray<{ url?: string }>): Map<string, number> => {
  const counts = new Map<string, number>();

  for (const item of items) {
    const url = item.url;
    if (!url) {
      continue;
    }

    const key = normalizeDuplicateUrlKey(url);
    if (!key) {
      continue;
    }

    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const duplicates = new Map<string, number>();
  for (const [key, count] of counts) {
    if (count >= 2) {
      duplicates.set(key, count);
    }
  }

  return duplicates;
};
