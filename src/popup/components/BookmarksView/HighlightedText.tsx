import React, { useMemo } from 'react';
import Box from '@mui/material/Box';
import { getSearchHighlightRanges } from '../../../utils/bookmark-search-utils';

interface HighlightedTextProps {
  text: string;
  query: string;
}

/**
 * 高亮显示文本中命中搜索关键词的部分。
 * 命中段以半透明主题蓝背景的 mark 包裹，未命中段为普通文本。
 */
const HighlightedText: React.FC<HighlightedTextProps> = ({ text, query }) => {
  // 计算高亮区间（基于原文本字符索引，区间已合并、不重叠）
  const ranges = useMemo(() => getSearchHighlightRanges(text, query), [text, query]);

  // 无区间或无 query 时直接返回原文本
  if (ranges.length === 0 || !query) {
    return <>{text}</>;
  }

  // 按区间切分文本：cursor 记录已处理位置，跳过空段
  const segments: React.ReactNode[] = [];
  let cursor = 0;

  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];

    if (cursor < range.start) {
      segments.push(text.slice(cursor, range.start));
    }

    segments.push(
      <Box
        key={i}
        component="mark"
        sx={{
          backgroundColor: 'rgba(66, 165, 245, 0.25)',
          color: 'inherit',
          borderRadius: '2px',
          padding: '0 1px',
        }}
      >
        {text.slice(range.start, range.end)}
      </Box>,
    );

    cursor = range.end;
  }

  if (cursor < text.length) {
    segments.push(text.slice(cursor));
  }

  // 过滤掉任何空字符串段
  return <>{segments.filter(segment => segment !== '')}</>;
};

export default HighlightedText;
