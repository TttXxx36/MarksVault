/**
 * Structured diagnostics intentionally omit secrets and user content. This is
 * a small boundary until the full runtime logging schema is introduced.
 */
const SENSITIVE_KEY = /(token|secret|key|authorization|password|prompt|title|url|content|body|path)/i;

const redact = (value: unknown, key = '', depth = 0): unknown => {
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (depth > 2) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map(item => redact(item, key, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 30).map(([childKey, childValue]) => [childKey, redact(childValue, childKey, depth + 1)]));
  }
  if (typeof value === 'string' && value.length > 120) return `${value.slice(0, 117)}...`;
  return value;
};

export const redactLogDetails = (details?: Record<string, unknown>): Record<string, unknown> =>
  (redact(details || {}) as Record<string, unknown>);

export const logStructuredEvent = (event: string, details?: Record<string, unknown>): void => {
  console.info(`[MarksVault] ${event}`, redactLogDetails(details));
};
