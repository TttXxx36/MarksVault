/**
 * AI provider and classification contracts.
 *
 * API keys are deliberately kept out of public configuration snapshots.
 */

export type AiProtocol = 'responses' | 'chat-completions' | 'custom';
export type AiAuthType = 'bearer' | 'api-key-header' | 'none';

export interface AiProviderConfig {
  enabled: boolean;
  endpoint: string;
  apiKey: string;
  protocol: AiProtocol;
  authType: AiAuthType;
  apiKeyHeader: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  timeoutMs: number;
  batchSize: number;
  maxCategories: number;
}

export interface AiBookmarkInput {
  id: string;
  title: string;
  url: string;
  path: string;
  parentId?: string;
  index?: number;
}

export interface AiCategory {
  name: string;
  description?: string;
}

export interface AiAssignment {
  bookmarkId: string;
  categoryName: string;
  confidence: number;
  reason?: string;
}

export interface AiClassificationResponse {
  categories: AiCategory[];
  assignments: AiAssignment[];
}

export type AiBatchState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type AiClassificationJobState =
  | 'queued'
  | 'classifying'
  | 'paused'
  | 'awaiting_review'
  | 'failed'
  | 'cancelled';

export interface AiBatchProgress {
  batchId: string;
  bookmarkIds: string[];
  inputHash?: string;
  state: AiBatchState;
  attempts: number;
  errorCode?: string;
  splitDepth?: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface AiClassificationJob {
  schemaVersion: 1;
  promptContractVersion: 1;
  id: string;
  createdAt: number;
  updatedAt: number;
  endpoint: string;
  model: string;
  bookmarkIds: string[];
  bookmarks: AiBookmarkInput[];
  batches: AiBatchProgress[];
  categories: AiCategory[];
  assignments: AiAssignment[];
  state: AiClassificationJobState;
  activeBatchId?: string;
  cancelRequested?: boolean;
  resumeAvailable?: boolean;
  errorCode?: string;
  error?: string;
}

export interface AiSnapshotItem {
  id: string;
  parentId?: string;
  index?: number;
}

export interface AiClassificationPlan {
  id: string;
  createdAt: number;
  categories: AiCategory[];
  assignments: AiAssignment[];
  snapshot: AiSnapshotItem[];
  skippedBookmarkIds: string[];
  unassignedBookmarkIds: string[];
  appliedBookmarkIds: string[];
  appliedDestinationByBookmarkId: Record<string, string>;
  createdFolderIds: string[];
  state: 'preview' | 'applying' | 'applied' | 'rolled_back';
}
