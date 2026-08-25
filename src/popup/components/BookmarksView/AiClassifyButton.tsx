import React, { useState } from 'react';
import Tooltip from '@mui/material/Tooltip';
import IconButton from '@mui/material/IconButton';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
import { AiClassificationPlan } from '../../../types/ai';
import { applyAiClassificationPlan, createAiClassificationPlan, getLastAiClassificationPlan, rollbackAiClassificationPlan } from '../../../services/ai-classification-service';
import { getAiProviderConfig } from '../../../services/ai-service';

const AiClassifyButton: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<AiClassificationPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [providerOrigin, setProviderOrigin] = useState<string | null>(null);

  const openPreview = async () => {
    setOpen(true);
    setBusy(true);
    setPlan(null);
    setError(null);
    try {
      const config = await getAiProviderConfig();
      setProviderOrigin(config.endpoint ? new URL(config.endpoint).origin : null);
      const lastPlan = await getLastAiClassificationPlan();
      if (lastPlan?.state === 'applied') {
        setPlan(lastPlan);
      } else {
        setPlan(await createAiClassificationPlan(config));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'AI 分类预览失败');
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      setPlan(await applyAiClassificationPlan(plan));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'AI 分类执行失败');
    } finally {
      setBusy(false);
    }
  };

  const rollback = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      setPlan(await rollbackAiClassificationPlan(plan));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'AI 分类撤销失败');
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (!busy) setOpen(false);
  };

  return (
    <>
      <Tooltip title="AI 智能分类">
        <IconButton size="small" onClick={openPreview} aria-label="AI 智能分类" sx={{ p: 0.5 }}>
          <AutoAwesomeIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Dialog open={open} onClose={close} maxWidth="sm" fullWidth>
        <DialogTitle>AI 智能分类预览</DialogTitle>
        <DialogContent dividers>
          {busy && <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2 }}><CircularProgress size={20} /><Typography variant="body2">正在生成分类预览…</Typography></Box>}
          {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
          {plan && (
            <Stack spacing={1.25}>
              <Typography variant="body2">
                本次将处理 {plan.assignments.length + plan.skippedBookmarkIds.length} 个书签，创建或使用 {plan.categories.length} 个分类文件夹。
              </Typography>
              <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
                {plan.categories.map(category => <Chip key={category.name} label={category.name} size="small" />)}
              </Box>
              {plan.state === 'preview' && (
                <>
                  <Alert severity="info">
                    这是只读预览。确认后才会移动书签；执行前会保存当前位置，失败时自动尝试回滚。
                  </Alert>
                  <Typography variant="caption" color="text.secondary">
                    将发送字段：标题、URL、域名和文件夹路径；目标服务：{providerOrigin || '未配置'}。API Key 只作为认证头发送给该服务，不会放入书签内容、同步存储或配置导出。
                  </Typography>
                </>
              )}
              {plan.state === 'applied' && (
                <Alert severity="success">分类已完成。你可以立即撤销最近一次分类。</Alert>
              )}
              {plan.state === 'rolled_back' && (
                <Alert severity="info">分类已撤销；无法恢复的项目会保留在报告中。</Alert>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={close} disabled={busy}>关闭</Button>
          {plan?.state === 'preview' && <Button onClick={apply} variant="contained" disabled={busy || !plan.assignments.length}>确认并执行</Button>}
          {plan?.state === 'applied' && <Button onClick={rollback} color="warning" variant="outlined" disabled={busy}>撤销本次分类</Button>}
        </DialogActions>
      </Dialog>
    </>
  );
};

export default AiClassifyButton;
