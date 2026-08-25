import React, { useEffect, useState } from 'react';
import { browser, type Browser } from 'wxt/browser';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import LinearProgress from '@mui/material/LinearProgress';
import Chip from '@mui/material/Chip';
import { AiClassificationJob } from '../../../types/ai';
import { getAiClassificationJob } from '../../../services/ai-classification-service';

const AiClassificationTaskCard: React.FC = () => {
  const [job, setJob] = useState<AiClassificationJob | null>(null);

  useEffect(() => {
    void browser.runtime.sendMessage({ type: 'GET_AI_CLASSIFICATION_JOB' })
      .then((response: { success?: boolean; job?: AiClassificationJob | null }) => {
        if (response?.success) setJob(response.job || null);
        else return getAiClassificationJob().then(setJob);
      })
      .catch(() => getAiClassificationJob().then(setJob).catch(() => setJob(null)));
    const handleStorageChange = (
      changes: { [key: string]: Browser.storage.StorageChange },
      areaName: Browser.storage.AreaName,
    ) => {
      if (areaName !== 'local') return;
      const next = changes.ai_classification_job?.newValue as AiClassificationJob | undefined;
      if (next) setJob(next);
    };
    browser.storage.onChanged.addListener(handleStorageChange);
    return () => browser.storage.onChanged.removeListener(handleStorageChange);
  }, []);

  if (!job) return null;

  const completed = job.batches.filter(batch => batch.state === 'completed')
    .reduce((total, batch) => total + batch.bookmarkIds.length, 0);
  const failed = job.batches.filter(batch => batch.state === 'failed')
    .reduce((total, batch) => total + batch.bookmarkIds.length, 0);
  const total = job.bookmarks.length || job.bookmarkIds.length;
  const progress = total ? Math.min(100, (completed / total) * 100) : 0;
  const running = job.state === 'queued' || job.state === 'classifying';
  const currentBatch = job.batches.find(batch => batch.state === 'running') || job.batches.find(batch => batch.state === 'failed');
  let providerDomain = job.endpoint;
  try {
    providerDomain = new URL(job.endpoint).host || job.endpoint;
  } catch {
    // Keep the stored endpoint as a safe fallback for legacy jobs.
  }
  const send = async (type: string) => {
    await browser.runtime.sendMessage({ type });
  };

  return (
    <Card sx={{ mb: 2 }} variant="outlined">
      <CardContent>
        <Stack spacing={1}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
            <Typography variant="subtitle1">AI 分类任务</Typography>
            <Chip size="small" label={job.state === 'awaiting_review' ? '等待预览确认' : job.state === 'classifying' || job.state === 'queued' ? '后台处理中' : job.state === 'paused' ? '可恢复' : job.state === 'failed' ? '有失败批次' : '已取消'} />
          </Box>
          <LinearProgress variant="determinate" value={progress} />
          <Typography variant="caption" color="text.secondary">
            已完成 {completed} / {total} 个书签；失败 {failed} 个。关闭 Popup 不会中断后台任务。
          </Typography>
          <Typography variant="caption" color="text.secondary">
            服务：{providerDomain}；{currentBatch ? `当前批次 ${currentBatch.bookmarkIds.length} 条，已尝试 ${currentBatch.attempts} 次` : '当前没有正在处理的批次'}
          </Typography>
          {job.error && <Alert severity="warning">{job.error}</Alert>}
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {(job.state === 'paused' || job.state === 'cancelled') && <Button size="small" variant="contained" onClick={() => void send('RESUME_AI_CLASSIFICATION')}>继续分类</Button>}
            {job.state === 'failed' && <Button size="small" variant="contained" onClick={() => void send('RETRY_AI_CLASSIFICATION')}>重试失败批次</Button>}
            {running && <Button size="small" color="warning" variant="outlined" onClick={() => void send('CANCEL_AI_CLASSIFICATION')}>取消任务</Button>}
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
};

export default AiClassificationTaskCard;
