/** Minimal runtime message boundary shared by popup, task pages and the worker. */
export interface RuntimeMessage {
  type: string;
  payload?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const isRuntimeMessage = (value: unknown): value is RuntimeMessage => {
  if (!isRecord(value) || typeof value.type !== 'string' || value.type.length === 0 || value.type.length > 100) return false;
  return value.payload === undefined || isRecord(value.payload);
};

export const parseRuntimeMessage = (value: unknown): RuntimeMessage | null =>
  isRuntimeMessage(value) ? value : null;
