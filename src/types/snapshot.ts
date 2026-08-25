/**
 * Domain contracts for local, named bookmark snapshots and safe restore.
 *
 * A snapshot contains only bookmark-tree data. Provider credentials, AI
 * configuration, GitHub credentials and runtime secrets are deliberately not
 * part of this domain.
 */

export const SNAPSHOT_SCHEMA_VERSION = 1 as const;
export type SnapshotSchemaVersion = typeof SNAPSHOT_SCHEMA_VERSION;

export const SNAPSHOT_SOURCES = {
  AI_CLASSIFICATION_BEFORE: 'ai-classification-before',
  MANUAL: 'manual',
  RESTORE_BEFORE: 'restore-before',
  IMPORTED: 'imported',
} as const;

export type SnapshotSource = typeof SNAPSHOT_SOURCES[keyof typeof SNAPSHOT_SOURCES];

export type SnapshotValidationStatus = 'pending' | 'valid' | 'invalid';
export type BookmarkSnapshotNodeType = 'bookmark' | 'folder';

export interface BookmarkSnapshotNode {
  id: string;
  parentId?: string;
  index?: number;
  title: string;
  url?: string;
  type: BookmarkSnapshotNodeType;
  /** Folder path of the parent, excluding this node's title. */
  path: string;
  dateAdded?: number;
}

export interface SnapshotDelta {
  bookmarkId: string;
  beforeParentId?: string;
  beforeIndex?: number;
  afterParentId?: string;
  afterIndex?: number;
  afterTitle?: string;
  operation: 'move' | 'rename' | 'create-folder' | 'delete' | 'update';
}

export interface SnapshotMetadata {
  schemaVersion: SnapshotSchemaVersion;
  snapshotId: string;
  name: string;
  userName: string;
  createdAt: number;
  source: SnapshotSource;
  nodeCount: number;
  maxDepth: number;
  byteSize: number;
  contentHash: string;
  validationStatus: SnapshotValidationStatus;
  isAutomatic: boolean;
  isProtected: boolean;
}

export interface BookmarkSnapshot extends SnapshotMetadata {
  updatedAt?: number;
  planId?: string;
  affectedBookmarkIds: string[];
  delta: SnapshotDelta[];
  rootIds: string[];
  nodes: BookmarkSnapshotNode[];
}

export interface SnapshotIndexEntry extends SnapshotMetadata {
  planId?: string;
}

export interface SnapshotIndex {
  schemaVersion: SnapshotSchemaVersion;
  createdAt: number;
  updatedAt: number;
  userName: string;
  /** Index-level source is informational; entries carry their own source. */
  source?: SnapshotSource;
  nodeCount: number;
  byteSize: number;
  contentHash: string;
  validationStatus: SnapshotValidationStatus;
  isAutomatic: boolean;
  isProtected: boolean;
  entries: SnapshotIndexEntry[];
  maxAutomaticSnapshots: number;
}

export interface SnapshotRetentionPolicy {
  schemaVersion: SnapshotSchemaVersion;
  createdAt: number;
  userName: string;
  source: SnapshotSource;
  nodeCount: number;
  byteSize: number;
  contentHash: string;
  validationStatus: SnapshotValidationStatus;
  isAutomatic: boolean;
  isProtected: boolean;
  maxAutomaticSnapshots: number;
  protectNamedSnapshots: boolean;
  warnAtBytes: number;
  rejectAtBytes: number;
}

export type SnapshotDiffKind = 'added' | 'deleted' | 'moved' | 'renamed' | 'conflict' | 'unchanged';
export type SnapshotDiffAction = 'restore' | 'skip' | 'none';

export interface SnapshotConflict {
  schemaVersion: SnapshotSchemaVersion;
  createdAt: number;
  userName: string;
  source: SnapshotSource;
  nodeCount: number;
  byteSize: number;
  contentHash: string;
  validationStatus: SnapshotValidationStatus;
  isAutomatic: boolean;
  isProtected: boolean;
  snapshotNodeId: string;
  candidateNodeIds: string[];
  reason: 'duplicate-fingerprint' | 'url-changed' | 'type-changed' | 'modified-after-snapshot' | 'missing-parent' | 'unsafe-match';
  message: string;
}

export interface SnapshotDiffItem {
  id: string;
  snapshotNode?: BookmarkSnapshotNode;
  currentNode?: BookmarkSnapshotNode;
  matchedBy?: 'stable-id' | 'fingerprint';
  kind: SnapshotDiffKind;
  changes: SnapshotDiffKind[];
  action: SnapshotDiffAction;
  reason?: string;
  conflict?: SnapshotConflict;
}

export interface SnapshotDiff {
  schemaVersion: SnapshotSchemaVersion;
  createdAt: number;
  userName: string;
  source: SnapshotSource;
  nodeCount: number;
  byteSize: number;
  contentHash: string;
  validationStatus: SnapshotValidationStatus;
  isAutomatic: boolean;
  isProtected: boolean;
  snapshotId: string;
  generatedAt: number;
  items: SnapshotDiffItem[];
  addedCount: number;
  deletedCount: number;
  movedCount: number;
  renamedCount: number;
  conflictCount: number;
  skippedCount: number;
  unchangedCount: number;
}

export type RestorePlanState = 'preview' | 'applying' | 'applied' | 'uncertain' | 'rolled_back' | 'cancelled';

export interface RestorePlan {
  schemaVersion: SnapshotSchemaVersion;
  planId: string;
  snapshotId: string;
  createdAt: number;
  updatedAt: number;
  userName: string;
  source: SnapshotSource;
  nodeCount: number;
  byteSize: number;
  contentHash: string;
  validationStatus: SnapshotValidationStatus;
  isAutomatic: boolean;
  isProtected: boolean;
  diff: SnapshotDiff;
  selectedItemIds: string[];
  beforeSnapshotId?: string;
  journalId?: string;
  state: RestorePlanState;
  safeChangeIds?: string[];
}

export type RestoreJournalItemState = 'pending' | 'running' | 'completed' | 'skipped' | 'failed' | 'uncertain' | 'rolled_back';

export interface RestoreJournalItem {
  itemId: string;
  bookmarkId?: string;
  state: RestoreJournalItemState;
  operation?: 'move' | 'rename' | 'create-folder' | 'delete';
  beforeParentId?: string;
  beforeIndex?: number;
  afterParentId?: string;
  afterIndex?: number;
  beforeTitle?: string;
  afterTitle?: string;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface RestoreJournal {
  schemaVersion: SnapshotSchemaVersion;
  journalId: string;
  planId: string;
  snapshotId: string;
  createdAt: number;
  updatedAt: number;
  userName: string;
  source: SnapshotSource;
  nodeCount: number;
  byteSize: number;
  contentHash: string;
  validationStatus: SnapshotValidationStatus;
  isAutomatic: boolean;
  isProtected: boolean;
  state: RestorePlanState;
  leaseId?: string;
  items: RestoreJournalItem[];
  error?: string;
  browserRestartRecovered?: boolean;
}

export interface SnapshotImportValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  schemaVersion?: number;
  nodeCount?: number;
  maxDepth?: number;
  byteSize?: number;
  contentHash?: string;
  computedHash?: string;
}

