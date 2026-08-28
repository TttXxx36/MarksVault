import { AiClassificationJob } from '../types/ai';

/**
 * Build a deliberately small diagnostic payload. It contains only bounded
 * protocol/response metadata and never includes an endpoint, API key, prompt,
 * bookmark title, bookmark URL, or raw provider response.
 */
export const buildAiDiagnosticsText = (job: Pick<AiClassificationJob, 'errorCode' | 'errorDiagnostics'>): string => {
  const diagnostics = job.errorDiagnostics;
  return JSON.stringify({
    errorCode: job.errorCode || 'UNKNOWN',
    protocol: diagnostics?.protocol,
    status: diagnostics?.status,
    contentType: diagnostics?.contentType,
    responseChars: diagnostics?.responseChars,
    responseShape: diagnostics?.responseShape,
    finishReason: diagnostics?.finishReason,
    incompleteReason: diagnostics?.incompleteReason,
  }, null, 2);
};

export const getAiErrorHint = (errorCode?: string): string => {
  switch (errorCode) {
    case 'TRUNCATED_OUTPUT':
      return '可尝试减小批次大小或减少输出字段。';
    case 'STREAMING_UNSUPPORTED':
      return '请在服务端关闭流式输出。';
    case 'MULTIPLE_JSON':
    case 'EXTRA_TEXT':
    case 'INVALID_JSON':
    case 'MISSING_FIELDS':
    case 'UPSTREAM_FORMAT':
      return '请确认接口返回单个完整 JSON 对象，并检查协议与模型是否匹配。';
    default:
      return '';
  }
};
