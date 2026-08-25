import React, { useEffect, useState } from 'react';
import { browser, type Browser } from 'wxt/browser';
import Tooltip from '@mui/material/Tooltip';
import IconButton from '@mui/material/IconButton';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import Box from '@mui/material/Box';
import { AiClassificationJob, AiClassificationPlan } from '../../../types/ai';
import { applyAiClassificationPlan, getAiClassificationJob, getLastAiClassificationPlan, rollbackAiClassificationPlan } from '../../../services/ai-classification-service';
import { getAiProviderConfig } from '../../../services/ai-service';

const isBackgroundJobState = (state: AiClassificationJob['state']): boolean => {
  return state === 'queued' || state === 'classifying' || state === 'paused' || state === 'failed' || state === 'cancelled';
};

const AiClassifyButton: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<AiClassificationPlan | null>(null);
  const [job, setJob] = useState<AiClassificationJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [providerOrigin, setProviderOrigin] = useState<string | null>(null);

  const loadPlan = async () => {
    const storedPlan = await getLastAiClassificationPlan();
    if (storedPlan && ['preview', 'applied', 'rolled_back'].includes(storedPlan.state)) setPlan(storedPlan);
  };

  useEffect(() => {
    const handleStorageChange = (
      changes: { [key: string]: Browser.storage.StorageChange },
      areaName: Browser.storage.AreaName,
    ) => {
      if (areaName !== 'local') return;
      const nextJob = changes.ai_classification_job?.newValue as AiClassificationJob | undefined;
      if (nextJob) {
        setJob(nextJob);
        if (nextJob.state === 'awaiting_review') void loadPlan();
      }
      const nextPlan = changes.ai_last_classification_plan?.newValue as AiClassificationPlan | undefined;
      if (nextPlan) setPlan(nextPlan);
    };
    browser.storage.onChanged.addListener(handleStorageChange);
    return () => browser.storage.onChanged.removeListener(handleStorageChange);
  }, []);

  const sendJobCommand = async (type: string): Promise<AiClassificationJob | null> => {
    const response = await browser.runtime.sendMessage({ type }) as { success?: boolean; job?: AiClassificationJob; error?: string };
    if (!response?.success) throw new Error(response?.error || 'AI 分类任务操作失败');
    return response.job || null;
  };

  const openPreview = async () => {
    setOpen(true);
    setBusy(true);
    setPlan(null);
    setError(null);
    try {
      const config = await getAiProviderConfig();
      setProviderOrigin(config.endpoint ? new URL(config.endpoint).origin : null);
      const jobResponse = await browser.runtime.sendMessage({ type: 'GET_AI_CLASSIFICATION_JOB' }) as { success?: boolean; job?: AiClassificationJob | null };
      const existingJob = jobResponse?.success ? jobResponse.job || null : await getAiClassificationJob();
      if (existingJob?.state === 'awaiting_review') {
        setJob(existingJob);
        await loadPlan();
      } else if (existingJob && isBackgroundJobState(existingJob.state)) {
        setJob(existingJob);
      } else {
        setJob(await sendJobCommand('START_AI_CLASSIFICATION'));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'AI 分类任务启动失败');
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    setBusy(true);
    setError(null);
    try {
      setJob(await sendJobCommand('RESUME_AI_CLASSIFICATION'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'AI 分类任务恢复失败');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      setJob(await sendJobCommand('CANCEL_AI_CLASSIFICATION'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'AI 分类任务取消失败');
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      setJob(await sendJobCommand('RETRY_AI_CLASSIFICATION'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '失败批次重试失败');
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

  const renameCategory = (index: number, nextName: string) => {
    if (!plan || plan.state !== 'preview') return;
    const previousName = plan.categories[index]?.name;
    const name = nextName.replace(/[\\/]/g, '').trim().slice(0, 80);
    if (!previousName || !name) return;
    setPlan({
      ...plan,
      categories: plan.categories.map((category, categoryIndex) => categoryIndex === index ? { ...category, name } : category),
      assignments: plan.assignments.map(assignment => assignment.categoryName === previousName
        ? { ...assignment, categoryName: name }
        : assignment),
    });
  };

  const close = () => {
    if (!busy) setOpen(false);
  };

  const completedCount = job?.batches.filter(batch => batch.state === 'completed')
    .reduce((total, batch) => total + batch.bookmarkIds.length, 0) || 0;
  const failedCount = job?.batches.filter(batch => batch.state === 'failed')
    .reduce((total, batch) => total + batch.bookmarkIds.length, 0) || 0;
  const currentBatch = job?.batches.find(batch => batch.state === 'running') || job?.batches.find(batch => batch.state === 'failed');
  const totalCount = job?.bookmarks.length || job?.bookmarkIds.length || 0;
  const progressValue = totalCount ? Math.min(100, (completedCount / totalCount) * 100) : 0;
  const running = Boolean(job && (job.state === 'queued' || job.state === 'classifying'));

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
          {busy && <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2 }}><CircularProgress size={20} /><Typography variant="body2">正在处理…</Typography></Box>}
          {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
          {job && !plan && (
            <Stack spacing={1.25}>
              <Typography variant="body2">
                AI 分类任务：{job.state === 'classifying' || job.state === 'queued' ? '后台处理中' : job.state === 'paused' ? '等待继续' : job.state === 'failed' ? '存在失败批次' : '已取消'}
              </Typography>
              <LinearProgress variant="determinate" value={progressValue} />
              <Typography variant="caption" color="text.secondary">
                已完成 {completedCount} / {totalCount} 个书签；失败 {failedCount} 个。关闭此窗口不会停止后台任务。
              </Typography>
              <Typography variant="caption" color="text.secondary">
                目标服务：{providerOrigin || '未配置'}；{currentBatch ? `当前批次 ${currentBatch.bookmarkIds.length} 条，已尝试 ${currentBatch.attempts} 次` : '等待下一批'}。
              </Typography>
              {job.error && <Alert severity="warning">{job.error}</Alert>}
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {(job.state === 'paused' || job.state === 'cancelled') && <Button variant="contained" onClick={resume} disabled={busy}>继续分类</Button>}
                {job.state === 'failed' && <Button variant="contained" onClick={retry} disabled={busy}>重试失败批次</Button>}
                {running && <Button variant="outlined" color="warning" onClick={cancel} disabled={busy}>取消任务</Button>}
              </Box>
            </Stack>
          )}
          {plan && (
            <Stack spacing={1.25}>
              <Typography variant="body2">
                本次将处理 {plan.assignments.length + plan.skippedBookmarkIds.length} 个书签，创建或使用 {plan.categories.length} 个分类文件夹。
              </Typography>
              <Typography variant="caption" color="text.secondary">
                分类名称可在执行前编辑；修改只影响本次计划，不会删除已有文件夹。
              </Typography>
              <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
                {plan.categories.map((category, index) => plan.state === 'preview' ? (
                  <TextField
                    key={`${category.name}-${index}`}
                    size="small"
                    label={`分类 ${index + 1}`}
                    value={category.name}
                    onChange={event => renameCategory(index, event.target.value)}
                    sx={{ minWidth: 150, flex: '1 1 150px' }}
                    inputProps={{ maxLength: 80 }}
                  />
                ) : <Chip key={category.name} label={category.name} size="small" />)}
              </Box>
              {plan.state === 'preview' && (
                <>
                  <Alert severity="info">
                    这是只读预览。确认后才会移动书签；执行前会保存当前位置，失败时自动尝试回滚。
                  </Alert>
                  <Typography variant="caption" color="text.secondary">
                    将发送字段：标题、URL、域名和文件夹路径；目标服务：{providerOrigin || '未配置'}。API Key 只作为认证头发送给该服务，不会放入书签内容、同步存储、配置导出或 GitHub 备份。
                  </Typography>
                </>
              )}
              {plan.state === 'applied' && <Alert severity="success">分类已完成。你可以立即撤销最近一次分类。</Alert>}
              {plan.state === 'rolled_back' && <Alert severity="info">分类已撤销；无法恢复的项目会保留在报告中。</Alert>}
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
