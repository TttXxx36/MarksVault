import React, { useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import CircularProgress from '@mui/material/CircularProgress';
import Checkbox from '@mui/material/Checkbox';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import FileUploadIcon from '@mui/icons-material/FileUpload';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import CameraAltIcon from '@mui/icons-material/CameraAlt';
import RestoreIcon from '@mui/icons-material/Restore';
import type { RestorePlan, SnapshotIndexEntry, SnapshotSource } from '../../../types/snapshot';
import type { SnapshotStorageSummary } from '../../../services/bookmark-snapshot-service';

interface SnapshotHistoryCardProps {
  compact?: boolean;
  onMessage?: (message: string, severity?: 'success' | 'error' | 'warning' | 'info') => void;
}

type RuntimeResponse<T> = { success?: boolean; error?: string } & T;

const send = async <T,>(type: string, payload?: Record<string, unknown>): Promise<RuntimeResponse<T>> =>
  browser.runtime.sendMessage({ type, payload }) as Promise<RuntimeResponse<T>>;

const downloadJson = (name: string, json: string): void => {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const sourceLabel = (source: SnapshotSource): string => ({
  'ai-classification-before': 'AI 分类前',
  manual: '手动',
  'restore-before': '恢复前',
  imported: 'GitHub/文件导入',
}[source] || source);

const SnapshotHistoryCard: React.FC<SnapshotHistoryCardProps> = ({ compact = false, onMessage }) => {
  const [entries, setEntries] = useState<SnapshotIndexEntry[]>([]);
  const [storageSummary, setStorageSummary] = useState<SnapshotStorageSummary | null>(null);
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SnapshotSource | 'all'>('all');
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<SnapshotIndexEntry | null>(null);
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [showPlan, setShowPlan] = useState(false);
  const [applying, setApplying] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const notify = (message: string, severity: 'success' | 'error' | 'warning' | 'info' = 'info') => onMessage?.(message, severity);

  const load = async () => {
    setLoading(true);
    try {
      const response = await send<{ entries?: SnapshotIndexEntry[] }>('GET_SNAPSHOT_INDEX', { query, source: sourceFilter === 'all' ? undefined : sourceFilter });
      if (!response.success) throw new Error(response.error || '获取快照列表失败');
      setEntries(response.entries || []);
      const capacity = await send<{ summary?: SnapshotStorageSummary }>('GET_SNAPSHOT_STORAGE');
      if (capacity.success && capacity.summary) setStorageSummary(capacity.summary);
    } catch (error) {
      notify(error instanceof Error ? error.message : '获取快照列表失败', 'error');
    } finally {
      setLoading(false);
    }
  };

  const deleteSnapshot = async (entry: SnapshotIndexEntry) => {
    const confirmed = typeof window !== 'undefined' && window.confirm(
      entry.isProtected
        ? `快照“${entry.name}”受保护。确定要永久删除它吗？建议先导出。`
        : `确定要删除快照“${entry.name}”吗？`,
    );
    if (!confirmed) return;
    try {
      const response = await send('DELETE_SNAPSHOT', { snapshotId: entry.snapshotId, confirmProtected: entry.isProtected });
      if (!response.success) throw new Error(response.error || '删除快照失败');
      notify('快照已删除', 'success');
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : '删除快照失败', 'error');
    }
  };

  useEffect(() => { void load(); }, [query, sourceFilter]);

  const visibleEntries = useMemo(() => entries.slice(0, compact ? 5 : 50), [entries, compact]);

  const createManual = async () => {
    try {
      const response = await send<{ snapshot?: SnapshotIndexEntry }>('CREATE_MANUAL_SNAPSHOT', { name: name.trim() || undefined });
      if (!response.success) throw new Error(response.error || '创建快照失败');
      setShowCreate(false);
      setName('');
      notify('命名快照已创建', 'success');
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : '创建快照失败', 'error');
    }
  };

  const exportSnapshot = async (entry: SnapshotIndexEntry) => {
    try {
      const response = await send<{ json?: string }>('EXPORT_SNAPSHOT', { snapshotId: entry.snapshotId });
      if (!response.success || !response.json) throw new Error(response.error || '导出快照失败');
      downloadJson(`marksvault-snapshot-${entry.snapshotId}.json`, response.json);
      notify('快照已导出', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : '导出快照失败', 'error');
    }
  };

  const importSnapshot = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const response = await send<{ snapshot?: SnapshotIndexEntry }>('IMPORT_SNAPSHOT', { json: await file.text() });
      if (!response.success) throw new Error(response.error || '导入快照失败');
      notify('快照已导入并完成校验', 'success');
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : '导入快照失败', 'error');
    }
  };

  const previewRestore = async (entry: SnapshotIndexEntry) => {
    try {
      setLoading(true);
      const response = await send<{ plan?: RestorePlan }>('CREATE_RESTORE_PLAN', { snapshotId: entry.snapshotId });
      if (!response.success || !response.plan) throw new Error(response.error || '生成恢复预览失败');
      setSelected(entry);
      setPlan(response.plan);
      setShowPlan(true);
    } catch (error) {
      notify(error instanceof Error ? error.message : '生成恢复预览失败', 'error');
    } finally {
      setLoading(false);
    }
  };

  const applyRestore = async () => {
    if (!plan) return;
    setApplying(true);
    try {
      const response = await send<{ plan?: RestorePlan }>('APPLY_RESTORE_PLAN', {
        planId: plan.planId,
        selectedItemIds: plan.selectedItemIds,
      });
      if (!response.success) throw new Error(response.error || '恢复失败');
      setPlan(response.plan || plan);
      notify('恢复已完成；新增节点和冲突节点已保留', 'success');
      setShowPlan(false);
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : '恢复结果不确定，请检查恢复日志', 'error');
    } finally {
      setApplying(false);
    }
  };

  return (
    <Card sx={{ mb: 2 }} variant="outlined">
      <CardContent>
        <Stack spacing={1}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
            <Typography variant="subtitle1"><CameraAltIcon sx={{ verticalAlign: 'middle', mr: 0.5 }} fontSize="small" />书签快照</Typography>
            <Box sx={{ display: 'flex', gap: 0.5 }}>
              <Button size="small" onClick={() => setShowCreate(true)}>新建命名快照</Button>
              {!compact && <Button size="small" startIcon={<FileUploadIcon />} onClick={() => importRef.current?.click()}>导入</Button>}
              <input ref={importRef} hidden type="file" accept="application/json,.json" onChange={importSnapshot} />
            </Box>
          </Box>
          {!compact && <Box sx={{ display: 'flex', gap: 0.75 }}>
            <TextField size="small" fullWidth value={query} onChange={event => setQuery(event.target.value)} placeholder="按名称、时间或来源搜索" />
            <FormControl size="small" sx={{ minWidth: 110 }}>
              <Select value={sourceFilter} onChange={event => setSourceFilter(event.target.value as SnapshotSource | 'all')} displayEmpty aria-label="按来源筛选">
                <MenuItem value="all">全部来源</MenuItem>
                <MenuItem value="ai-classification-before">AI 分类前</MenuItem>
                <MenuItem value="manual">手动</MenuItem>
                <MenuItem value="restore-before">恢复前</MenuItem>
                <MenuItem value="imported">导入</MenuItem>
              </Select>
            </FormControl>
          </Box>}
          {loading && <CircularProgress size={18} />}
          {storageSummary?.warning && <Alert severity={storageSummary.rejected ? 'error' : 'warning'}>
            快照占用约 {(storageSummary.byteSize / 1024 / 1024).toFixed(1)} MB；{storageSummary.rejected ? '已达到安全上限，请先导出或删除快照。' : '接近容量提示线，建议导出不常用的快照。'} 受保护快照不会被自动清理。
          </Alert>}
          {!loading && visibleEntries.length === 0 && <Typography variant="caption" color="text.secondary">还没有本地快照。AI 分类确认前会自动创建可验证快照。</Typography>}
          {visibleEntries.map(entry => (
            <Box key={entry.snapshotId} sx={{ p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" noWrap>{entry.name}</Typography>
                  <Typography variant="caption" color="text.secondary">{new Date(entry.createdAt).toLocaleString()} · {entry.nodeCount} 节点 · {sourceLabel(entry.source)}</Typography>
                </Box>
                <Chip size="small" color={entry.validationStatus === 'valid' ? 'success' : 'warning'} label={entry.isProtected ? '受保护' : '自动'} />
              </Box>
              <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5 }}>
                <Button size="small" startIcon={<RestoreIcon />} onClick={() => void previewRestore(entry)}>预览恢复</Button>
                <Button size="small" startIcon={<FileDownloadIcon />} onClick={() => void exportSnapshot(entry)}>导出</Button>
                <Button size="small" color="error" onClick={() => void deleteSnapshot(entry)}>删除</Button>
              </Box>
            </Box>
          ))}
        </Stack>
      </CardContent>

      <Dialog open={showCreate} onClose={() => setShowCreate(false)}>
        <DialogTitle>创建命名快照</DialogTitle>
        <DialogContent><TextField autoFocus fullWidth label="快照名称" value={name} onChange={event => setName(event.target.value)} helperText="命名快照默认受保护，不会被自动清理" /></DialogContent>
        <DialogActions><Button onClick={() => setShowCreate(false)}>取消</Button><Button variant="contained" onClick={() => void createManual()}>创建并校验</Button></DialogActions>
      </Dialog>

      <Dialog open={showPlan} onClose={() => !applying && setShowPlan(false)} fullWidth maxWidth="sm">
        <DialogTitle>恢复预览{selected ? `：${selected.name}` : ''}</DialogTitle>
        <DialogContent>
          {plan && <>
            <Alert severity={plan.diff.conflictCount ? 'warning' : 'info'} sx={{ mb: 1 }}>
              新增 {plan.diff.addedCount} · 删除 {plan.diff.deletedCount} · 移动 {plan.diff.movedCount} · 重命名 {plan.diff.renamedCount} · 冲突 {plan.diff.conflictCount} · 跳过 {plan.diff.skippedCount}
            </Alert>
            {plan.cleanupFolderIds?.length ? <Alert severity="info" sx={{ mb: 1 }}>
              本次恢复还会尝试清理 {plan.cleanupFolderIds.length} 个本次 AI 创建的空文件夹；仅当文件夹仍为空且未被移动或重命名时才会删除。其他新增内容不会被删除。
            </Alert> : null}
            <DialogContentText>默认跳过快照之后被修改、已删除或无法安全匹配的节点，不删除快照之后新增书签，不修改 URL。确认后会先创建“恢复前”快照。</DialogContentText>
            {plan.state === 'uncertain' && <Alert severity="error" sx={{ mt: 1 }}>上次恢复结果不确定，请先检查恢复日志，再明确选择继续或回滚。</Alert>}
            <Divider sx={{ my: 1 }} />
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>本次恢复项目</Typography>
            <Stack spacing={0.5} sx={{ maxHeight: 260, overflowY: 'auto', mb: 1 }}>
              {plan.diff.items.filter(item => item.action !== 'none').map(item => {
                const selectable = item.action === 'restore' && !item.conflict;
                const checked = plan.selectedItemIds.includes(item.id);
                const label = item.snapshotNode?.title || item.currentNode?.title || item.id;
                const status = item.conflict ? '冲突，已跳过' : item.action === 'restore' ? '可恢复' : item.reason || '跳过';
                return (
                  <Box key={item.id} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 0.5, borderRadius: 0.5, bgcolor: item.conflict ? 'action.hover' : undefined }}>
                    <Checkbox
                      size="small"
                      checked={checked}
                      disabled={!selectable || applying}
                      onChange={event => setPlan(current => current ? {
                        ...current,
                        selectedItemIds: event.target.checked
                          ? [...new Set([...current.selectedItemIds, item.id])]
                          : current.selectedItemIds.filter(id => id !== item.id),
                      } : current)}
                      inputProps={{ 'aria-label': `选择恢复项目 ${label}` }}
                    />
                    <Typography variant="body2" noWrap sx={{ minWidth: 0, flex: 1 }}>{label}</Typography>
                    <Typography variant="caption" color={item.conflict ? 'warning.main' : 'text.secondary'} noWrap>{status}</Typography>
                  </Box>
                );
              })}
            </Stack>
            <Typography variant="caption" color="text.secondary">恢复计划只会执行标记为“恢复”的项目；预览本身不会写入书签。</Typography>
          </>}
        </DialogContent>
        <DialogActions><Button onClick={() => setShowPlan(false)} disabled={applying}>关闭</Button><Button variant="contained" onClick={() => void applyRestore()} disabled={applying || !plan || plan.selectedItemIds.length === 0}>{applying ? '恢复中…' : '确认恢复'}</Button></DialogActions>
      </Dialog>
    </Card>
  );
};

export default SnapshotHistoryCard;
