import { z } from 'zod';
import { memoryLayerSchema, type MemoryLayer } from './memory.types';

/**
 * Block types that can appear inside a generated context pack.
 */
export const contextPackBlockTypeSchema = z.enum([
  'memory',
  'summary',
  'system_instruction',
  'tool_result',
] as const);

export const CONTEXT_PACK_BLOCK_TYPES = contextPackBlockTypeSchema.options;

export type ContextPackBlockType = z.infer<typeof contextPackBlockTypeSchema>;

export const contextPackDropReasonSchema = z.enum([
  'layer_item_limit',
  'layer_token_limit',
  'pack_token_limit',
] as const);

export const CONTEXT_PACK_DROP_REASONS = contextPackDropReasonSchema.options;

export type ContextPackDropReason = z.infer<typeof contextPackDropReasonSchema>;

export const contextPackMetadataSchema = z.record(z.string(), z.unknown());

/**
 * Snapshot of token usage after budget selection finishes.
 */
export const contextPackUsageSchema = z.object({
  maxTokens: z.number().finite(),
  reservedTokens: z.number().finite(),
  usedTokens: z.number().finite(),
  droppedTokens: z.number().finite(),
});

export type ContextPackUsage = z.infer<typeof contextPackUsageSchema>;

/**
 * A block is the smallest explainable unit shown to users and injected into
 * the final prompt preview.
 */
export const contextPackSummaryBlockSchema = z.object({
  blockId: z.string(),
  type: contextPackBlockTypeSchema,
  layer: memoryLayerSchema,
  position: z.number().finite(),
  title: z.string(),
  content: z.string(),
  memoryIds: z.array(z.string()),
  tokenEstimate: z.number().finite(),
  truncated: z.boolean(),
  metadata: contextPackMetadataSchema.optional(),
});

export type ContextPackSummaryBlock = z.infer<
  typeof contextPackSummaryBlockSchema
>;

/**
 * Explainable record describing why a memory was excluded from a pack.
 */
export const contextPackDroppedMemorySchema = z.object({
  memoryId: z.string(),
  layer: memoryLayerSchema,
  reason: contextPackDropReasonSchema,
  tokenEstimate: z.number().finite(),
  priority: z.number().finite(),
  pinned: z.boolean(),
  summary: z.string().nullable(),
});

export type ContextPackDroppedMemory = z.infer<
  typeof contextPackDroppedMemorySchema
>;

/**
 * Snapshot persisted for one context-building decision.
 */
export interface ContextPack {
  packId: string;
  conversationId: string;
  runId: string | null;
  intent: string | null;
  maxTokens: number;
  layerOrder: MemoryLayer[];
  selectedMemoryIds: string[];
  droppedMemoryIds: string[];
  droppedMemories: ContextPackDroppedMemory[];
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
  layerOrder: MemoryLayer[];
  selectedMemoryIds: string[];
  droppedMemoryIds?: string[];
  droppedMemories?: ContextPackDroppedMemory[];
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
  packIds?: string[];
  conversationId?: string;
  runId?: string;
  intent?: string;
  generatedAfter?: Date;
  generatedBefore?: Date;
  orderBy?: {
    field: 'generatedAt';
    direction: 'asc' | 'desc';
  };
  limit?: number;
}

/**
 * Query used when requesting the latest pack for a conversation scope.
 */
export interface ContextPackLatestQuery {
  conversationId: string;
  runId?: string | null;
  intent?: string | null;
}

/**
 * Deletion filter for pack cleanup and rotation.
 */
export interface ContextPackDeleteQuery {
  packIds?: string[];
  conversationId?: string;
  runId?: string;
  intent?: string;
  generatedBefore?: Date;
}
