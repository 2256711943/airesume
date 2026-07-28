/**
 * Block types that can appear inside a generated context pack.
 */
export const CONTEXT_PACK_BLOCK_TYPES = [
  'memory',
  'summary',
  'system_instruction',
  'tool_result',
] as const;

export type ContextPackBlockType = (typeof CONTEXT_PACK_BLOCK_TYPES)[number];

/**
 * Snapshot of token usage after budget selection finishes.
 */
export interface ContextPackUsage {
  maxTokens: number;
  reservedTokens: number;
  usedTokens: number;
  droppedTokens: number;
}

/**
 * A block is the smallest explainable unit shown to users and injected into
 * the final prompt preview.
 */
export interface ContextPackSummaryBlock {
  blockId: string;
  type: ContextPackBlockType;
  title: string;
  content: string;
  memoryIds: string[];
  tokenEstimate: number;
  truncated: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Snapshot persisted for one context-building decision.
 */
export interface ContextPack {
  packId: string;
  conversationId: string;
  runId: string | null;
  intent: string | null;
  maxTokens: number;
  selectedMemoryIds: string[];
  droppedMemoryIds: string[];
  summaryBlocks: ContextPackSummaryBlock[];
  finalPromptPreview: string;
  usage: ContextPackUsage;
  metadata: Record<string, unknown> | null;
  generatedAt: Date;
}

/**
 * Write payload used when a context budget manager emits a new pack snapshot.
 */
export interface ContextPackWriteInput {
  packId?: string;
  conversationId: string;
  runId?: string | null;
  intent?: string | null;
  maxTokens: number;
  selectedMemoryIds: string[];
  droppedMemoryIds?: string[];
  summaryBlocks: ContextPackSummaryBlock[];
  finalPromptPreview: string;
  usage: ContextPackUsage;
  metadata?: Record<string, unknown> | null;
  generatedAt?: Date;
}

/**
 * Query filters for pack history and inspection use cases.
 */
export interface ContextPackQuery {
  packId?: string;
  conversationId?: string;
  runId?: string;
  intent?: string;
  limit?: number;
}
