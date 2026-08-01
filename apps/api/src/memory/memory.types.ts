import { z } from 'zod';

/**
 * Supported memory layers that can participate in context selection.
 */
export const memoryLayerSchema = z.enum([
  'session',
  'resume',
  'preference',
  'tool_result',
  'system',
] as const);

export const MEMORY_LAYERS = memoryLayerSchema.options;

export type MemoryLayer = z.infer<typeof memoryLayerSchema>;

/**
 * Scope controls how widely a memory entry can be reused.
 */
export const MEMORY_SCOPES = ['conversation', 'user', 'global'] as const;

export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/**
 * Merge strategies define how a new write should behave when a merge group
 * already has an active memory entry.
 */
export const MEMORY_MERGE_STRATEGIES = [
  'replace',
  'append',
  'summarize',
] as const;

export type MemoryMergeStrategy = (typeof MEMORY_MERGE_STRATEGIES)[number];

/**
 * Ordering options used by runtime and persistent memory queries.
 */
export const MEMORY_ORDER_FIELDS = [
  'createdAt',
  'updatedAt',
  'priority',
  'freshnessScore',
  'relevanceScore',
  'expiresAt',
  'lastAccessedAt',
] as const;

export type MemoryOrderField = (typeof MEMORY_ORDER_FIELDS)[number];

export type SortDirection = 'asc' | 'desc';

/**
 * Describes how much compaction a summarizer performed.
 */
export type MemoryCompactionMode = 'pass-through' | 'fallback' | 'llm';

/**
 * Lightweight pointer back to the original business record that produced
 * a memory entry.
 */
export interface MemorySourceRef {
  kind: string;
  sourceId: string;
  fragment?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Runtime-only access metadata used by L1 cache implementations.
 */
export interface MemoryAccessSnapshot {
  lastAccessedAt: Date | null;
  accessCount: number;
}

/**
 * Canonical in-process representation of a memory entry.
 * Use `Date` internally and serialize to ISO strings only at API boundaries.
 */
export interface MemoryEntry extends MemoryAccessSnapshot {
  memoryId: string;
  conversationId: string;
  runId: string | null;
  layer: MemoryLayer;
  scope: MemoryScope;
  content: string;
  summary: string | null;
  tokenEstimate: number;
  priority: number;
  pinned: boolean;
  freshnessScore: number;
  relevanceScore: number;
  sourceRefs: MemorySourceRef[];
  mergeGroup: string | null;
  mergeStrategy: MemoryMergeStrategy | null;
  version: number;
  metadata: Record<string, unknown> | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input payload used when a caller wants the store facade to create or merge
 * a memory entry.
 */
export interface MemoryWriteInput {
  memoryId?: string;
  conversationId: string;
  runId?: string | null;
  layer: MemoryLayer;
  scope: MemoryScope;
  content: string;
  summary?: string | null;
  tokenEstimate?: number;
  priority?: number;
  pinned?: boolean;
  freshnessScore?: number;
  relevanceScore?: number;
  sourceRefs?: MemorySourceRef[];
  mergeGroup?: string | null;
  mergeStrategy?: MemoryMergeStrategy | null;
  metadata?: Record<string, unknown> | null;
  expiresAt?: Date | null;
}

/**
 * Input payload for summarizing an existing memory entry with a new write.
 */
export interface MemorySummarizeInput {
  previous: MemoryEntry;
  incoming: MemoryWriteInput;
  now: Date;
}

/**
 * Result returned by a summarizer after compaction or pass-through merge.
 */
export interface MemorySummarizeResult {
  content: string;
  summary: string | null;
  tokenEstimate: number;
  sourceRefs: MemorySourceRef[];
  metadata: Record<string, unknown> | null;
  compactionMode: MemoryCompactionMode;
}

/**
 * Pluggable summarizer used by the memory facade when merge strategy is
 * `summarize`.
 */
export interface MemorySummarizer {
  summarize(input: MemorySummarizeInput): Promise<MemorySummarizeResult>;
}

/**
 * Partial update payload for cases where the caller already has a concrete
 * memory identifier and only wants to patch selected fields.
 */
export interface MemoryPatchInput {
  summary?: string | null;
  content?: string;
  tokenEstimate?: number;
  priority?: number;
  pinned?: boolean;
  freshnessScore?: number;
  relevanceScore?: number;
  sourceRefs?: MemorySourceRef[];
  metadata?: Record<string, unknown> | null;
  expiresAt?: Date | null;
}

/**
 * Query filters shared by runtime and persistent memory stores.
 */
export interface MemoryQuery {
  conversationId?: string;
  runId?: string;
  memoryIds?: string[];
  layer?: MemoryLayer;
  layers?: MemoryLayer[];
  scope?: MemoryScope;
  scopes?: MemoryScope[];
  mergeGroup?: string;
  pinned?: boolean;
  includeExpired?: boolean;
  limit?: number;
  cursor?: string;
  orderBy?: {
    field: MemoryOrderField;
    direction: SortDirection;
  };
}

/**
 * Bulk deletion filter.
 */
export interface MemoryDeleteQuery {
  conversationId?: string;
  memoryIds?: string[];
  layer?: MemoryLayer;
  mergeGroup?: string;
  includePinned?: boolean;
}

/**
 * Options used when restoring a conversation's active memory working set.
 */
export interface MemoryHydrationOptions {
  includeExpired?: boolean;
  layers?: MemoryLayer[];
  limit?: number;
  hydratedAt?: Date;
}

/**
 * Result returned after a write so callers know whether a merge occurred.
 */
export interface MemoryWriteResult {
  memory: MemoryEntry;
  merged: boolean;
  replacedMemoryId?: string;
}

/**
 * Result returned after hydration from a persistent layer into a runtime layer.
 */
export interface MemoryHydrationResult {
  conversationId: string;
  memories: MemoryEntry[];
  expiredMemoryIds: string[];
  hydratedAt: Date;
}
