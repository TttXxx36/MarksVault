import React, { Fragment, useState, useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import InputBase from '@mui/material/InputBase';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import ClearIcon from '@mui/icons-material/Clear';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import SortIcon from '@mui/icons-material/Sort';
import CheckIcon from '@mui/icons-material/Check';
import ViewToggleButton from './ViewToggleButton';
import { BookmarkItem as BookmarkItemType } from '../../../utils/bookmark-service';
import type { BookmarkSortOrder } from '../../../utils/bookmark-search-utils';

interface BookmarksHeaderProps {
    // Navigation props
    folderStack: BookmarkItemType[];
    isSearching: boolean;
    searchResultCount?: number;
    onNavigateBack: () => void;
    onNavigateToCrumb: (folderId: string | null) => void;

    // Search props
    searchText: string;
    onSearch: (query: string) => void;
    onClearSearch: () => void;
    searchInputRef?: React.Ref<HTMLInputElement>;

    // View props
    viewType: 'list' | 'grid';
    onViewTypeChange: (viewType: 'list' | 'grid') => void;

    // Sort props
    sortOrder: BookmarkSortOrder;
    onSortOrderChange: (order: BookmarkSortOrder) => void;
}

export const BookmarksHeaderTitle: React.FC<{
    folderStack: BookmarkItemType[];
    isSearching: boolean;
    searchResultCount?: number;
    onNavigateBack: () => void;
    onNavigateToCrumb: (folderId: string | null) => void;
}> = ({
    folderStack,
    isSearching,
    searchResultCount,
    onNavigateBack,
    onNavigateToCrumb
}) => {
    if (isSearching) {
        return (
            <Box sx={{ display: 'flex', alignItems: 'center', width: '100%', overflow: 'hidden' }}>
                <Typography
                    variant="subtitle2"
                    noWrap
                    sx={{
                        fontWeight: 600,
                        flex: 1,
                        fontSize: '0.95rem',
                        color: 'text.primary',
                        letterSpacing: '0.02em',
                    }}
                >
                    {typeof searchResultCount === 'number' && searchResultCount > 0
                        ? `搜索结果（${searchResultCount}）`
                        : '搜索结果'}
                </Typography>
            </Box>
        );
    }

    // 面包屑链：书签栏（根）+ 已进入的各级文件夹
    const crumbs: Array<{ id: string | null; title: string }> = [
        { id: null, title: '书签栏' },
        ...folderStack.map(folder => ({ id: folder.id, title: folder.title })),
    ];

    return (
        <Box sx={{ display: 'flex', alignItems: 'center', width: '100%', overflow: 'hidden' }}>
            <IconButton onClick={onNavigateBack} size="small" sx={{ p: 0.5, mr: 0.5, ml: -0.5 }}>
                <ArrowBackIcon fontSize="small" />
            </IconButton>
            <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0, overflow: 'hidden', flex: 1 }}>
                {crumbs.map((crumb, index) => {
                    const isLast = index === crumbs.length - 1;
                    return (
                        <Fragment key={crumb.id ?? 'root'}>
                            {index > 0 && (
                                <ChevronRightIcon
                                    sx={{
                                        flexShrink: 0,
                                        mx: 0.25,
                                        fontSize: '0.9rem',
                                        color: 'text.disabled',
                                    }}
                                />
                            )}
                            <Typography
                                component="button"
                                type="button"
                                noWrap
                                onClick={() => onNavigateToCrumb(crumb.id)}
                                sx={{
                                    flexShrink: isLast ? 0 : 1,
                                    minWidth: 0,
                                    maxWidth: '100%',
                                    fontSize: '0.8rem',
                                    fontWeight: isLast ? 600 : 400,
                                    color: isLast ? 'text.primary' : 'text.secondary',
                                    cursor: isLast ? 'default' : 'pointer',
                                    background: 'none',
                                    border: 'none',
                                    padding: '2px 2px',
                                    borderRadius: '4px',
                                    lineHeight: 1.4,
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    '&:hover': isLast ? {} : { color: 'primary.main', textDecoration: 'underline' },
                                    '&:focus-visible': { outline: '1px solid', outlineColor: 'primary.main' },
                                }}
                            >
                                {crumb.title}
                            </Typography>
                        </Fragment>
                    );
                })}
            </Box>
        </Box>
    );
};

// 排序方式选项（与 BookmarkSortOrder 一一对应）
const SORT_OPTIONS: Array<{ value: BookmarkSortOrder; label: string }> = [
    { value: 'default', label: '默认顺序' },
    { value: 'title', label: '按标题' },
    { value: 'dateAdded', label: '按添加时间' },
];

export const BookmarksHeaderActions: React.FC<{
    searchText: string;
    onSearch: (query: string) => void;
    onClearSearch: () => void;
    searchInputRef?: React.Ref<HTMLInputElement>;
    viewType: 'list' | 'grid';
    onViewTypeChange: (viewType: 'list' | 'grid') => void;
    sortOrder: BookmarkSortOrder;
    onSortOrderChange: (order: BookmarkSortOrder) => void;
    isSearching: boolean;
}> = ({
    searchText,
    onSearch,
    onClearSearch,
    searchInputRef,
    viewType,
    onViewTypeChange,
    sortOrder,
    onSortOrderChange,
    isSearching
}) => {
    const [inputValue, setInputValue] = useState(searchText);
    const isComposingRef = useRef(false);
    const [sortMenuAnchor, setSortMenuAnchor] = useState<HTMLElement | null>(null);

    useEffect(() => {
        if (!isComposingRef.current) {
            setInputValue(searchText);
        }
    }, [searchText]);

    const handleCompositionStart = () => {
        isComposingRef.current = true;
    };

    const handleCompositionEnd = (e: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        isComposingRef.current = false;
        const value = e.currentTarget.value;
        setInputValue(value);
        onSearch(value);
    };

    const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const value = e.target.value;
        const nativeIsComposing = (e.nativeEvent as any)?.isComposing;

        setInputValue(value);
        if (isComposingRef.current || nativeIsComposing) return;
        onSearch(value);
    };

    const handleSearchBlur = () => {
        isComposingRef.current = false;
    };

    const clearSearch = () => {
        setInputValue('');
        onClearSearch();
    };

    return (
        <Box sx={{ display: 'flex', alignItems: 'center', width: '100%' }}>
            <InputBase
                inputRef={searchInputRef}
                sx={{
                    pl: 0.5,
                    flex: 1,
                    fontSize: '0.9rem',
                    fontWeight: 400,
                    fontFamily: 'inherit',
                    color: 'text.primary'
                }}
                placeholder="搜索..."
                value={inputValue}
                onChange={handleSearchChange}
                onBlur={handleSearchBlur}
                inputProps={{
                    // 组合输入事件绑定到真实 input，避免 e.target 非输入节点导致取值异常
                    onCompositionStart: handleCompositionStart,
                    onCompositionEnd: handleCompositionEnd
                }}
            />
            {inputValue && (
                <IconButton sx={{ p: 0.5 }} aria-label="清除" onClick={clearSearch}>
                    <ClearIcon fontSize="small" />
                </IconButton>
            )}
            <Box sx={{ display: 'flex', alignItems: 'center', ml: 0.5, borderLeft: '1px solid rgba(255,255,255,0.1)', pl: 0.5 }}>
                {!isSearching && (
                    <>
                        <IconButton size="small" onClick={(e) => setSortMenuAnchor(e.currentTarget)} aria-label="排序" sx={{ p: 0.5 }}>
                            <SortIcon fontSize="small" />
                        </IconButton>
                        <Menu
                            open={Boolean(sortMenuAnchor)}
                            anchorEl={sortMenuAnchor}
                            onClose={() => setSortMenuAnchor(null)}
                        >
                            {SORT_OPTIONS.map((option) => (
                                <MenuItem
                                    key={option.value}
                                    onClick={() => {
                                        onSortOrderChange(option.value);
                                        setSortMenuAnchor(null);
                                    }}
                                    sx={{ minHeight: 32, py: 0.5, px: 1.5, fontSize: '0.85rem' }}
                                >
                                    <ListItemIcon sx={{ minWidth: 24 }}>
                                        {sortOrder === option.value
                                            ? <CheckIcon fontSize="small" sx={{ color: 'primary.main' }} />
                                            : null}
                                    </ListItemIcon>
                                    <ListItemText primary={option.label} />
                                </MenuItem>
                            ))}
                        </Menu>
                    </>
                )}
                <ViewToggleButton
                    viewType={viewType}
                    onChange={onViewTypeChange}
                />
            </Box>
        </Box>
    );
};

/**
 * 书签页顶部栏：将“标题区”和“操作区”合并到同一个容器中，并把分隔线放到中间。
 */
export const BookmarksHeader: React.FC<BookmarksHeaderProps> = (props) => {
    const {
        folderStack,
        isSearching,
        searchResultCount,
        onNavigateBack,
        onNavigateToCrumb,
        searchText,
        onSearch,
        onClearSearch,
        searchInputRef,
        viewType,
        onViewTypeChange,
        sortOrder,
        onSortOrderChange,
    } = props;

    return (
        <Box sx={{ display: 'flex', alignItems: 'center', width: '100%', minWidth: 0 }}>
            <Box sx={{ flex: 1, minWidth: 0, pr: 1 }}>
                <BookmarksHeaderTitle
                    folderStack={folderStack}
                    isSearching={isSearching}
                    searchResultCount={searchResultCount}
                    onNavigateBack={onNavigateBack}
                    onNavigateToCrumb={onNavigateToCrumb}
                />
            </Box>

            <Box
                sx={{
                    width: '1px',
                    height: 22,
                    bgcolor: 'rgba(255,255,255,0.1)',
                    flex: '0 0 auto',
                }}
            />

            <Box sx={{ flex: 1, minWidth: 0, pl: 1 }}>
                <BookmarksHeaderActions
                    searchText={searchText}
                    onSearch={onSearch}
                    onClearSearch={onClearSearch}
                    searchInputRef={searchInputRef}
                    viewType={viewType}
                    onViewTypeChange={onViewTypeChange}
                    sortOrder={sortOrder}
                    onSortOrderChange={onSortOrderChange}
                    isSearching={isSearching}
                />
            </Box>
        </Box>
    );
};
