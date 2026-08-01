import type {
  MemoryDeleteQuery,
  MemoryEntry,
  MemoryHydrationOptions,
  MemoryHydrationResult,
  MemoryPatchInput,
  MemoryQuery,
  MemoryWriteInput,
  MemoryWriteResult,
} from './memory.types';
import type {
  ContextPack,
  ContextPackDeleteQuery,
  ContextPackLatestQuery,
  ContextPackQuery,
  ContextPackWriteInput,
} from './context-pack.types';

/**
 * L1 in-process cache contract.
 * Implementations are expected to optimize hot-path reads and eviction.
 */
export abstract class RuntimeMemoryStore {
  abstract get(memoryId: string): Promise<MemoryEntry | null>;

  abstract list(query: MemoryQuery): Promise<MemoryEntry[]>;

  abstract set(memory: MemoryEntry): Promise<MemoryEntry>;

  abstract patch(
    memoryId: string,
    patch: MemoryPatchInput,
  ): Promise<MemoryEntry | null>;

  abstract delete(memoryId: string): Promise<boolean>;

  abstract deleteMany(query: MemoryDeleteQuery): Promise<string[]>;

  abstract touch(memoryId: string, accessedAt?: Date): Promise<void>;

  abstract evictExpired(now?: Date): Promise<string[]>;

  abstract clearConversation(conversationId: string): Promise<string[]>;

  abstract size(): Promise<number>;
}

/**
 * L2 persistence contract.
 * This stays database-agnostic so Prisma, SQLite, Redis, or another backend
 * can be introduced later without changing service-layer callers.
 */
export abstract class PersistentMemoryStore {
  abstract get(memoryId: string): Promise<MemoryEntry | null>;

  abstract list(query: MemoryQuery): Promise<MemoryEntry[]>;

  abstract save(memory: MemoryEntry): Promise<MemoryEntry>;

  abstract saveMany(memories: MemoryEntry[]): Promise<MemoryEntry[]>;

  abstract patch(
    memoryId: string,
    patch: MemoryPatchInput,
  ): Promise<MemoryEntry | null>;

  abstract delete(memoryId: string): Promise<boolean>;

  abstract deleteMany(query: MemoryDeleteQuery): Promise<string[]>;

  abstract hydrateConversation(
    conversationId: string,
    options?: MemoryHydrationOptions,
  ): Promise<MemoryHydrationResult>;
}

/**
 * Service-facing facade that coordinates write merging, cache refill,
 * and fallback reads across L1 and L2 stores.
 */
export abstract class MemoryStore {
  abstract get(memoryId: string): Promise<MemoryEntry | null>;

  abstract list(query: MemoryQuery): Promise<MemoryEntry[]>;

  abstract write(input: MemoryWriteInput): Promise<MemoryWriteResult>;

  abstract patch(
    memoryId: string,
    patch: MemoryPatchInput,
  ): Promise<MemoryEntry | null>;

  abstract delete(memoryId: string): Promise<boolean>;

  abstract deleteMany(query: MemoryDeleteQuery): Promise<string[]>;

  abstract touch(memoryId: string, accessedAt?: Date): Promise<void>;

  abstract hydrateConversation(
    conversationId: string,
    options?: MemoryHydrationOptions,
  ): Promise<MemoryHydrationResult>;
}

/**
 * Storage contract for explainable context-pack snapshots.
 */
export abstract class ContextPackStore {
  abstract get(packId: string): Promise<ContextPack | null>;

  abstract getLatest(query: ContextPackLatestQuery): Promise<ContextPack | null>;

  abstract list(query: ContextPackQuery): Promise<ContextPack[]>;

  abstract save(input: ContextPackWriteInput): Promise<ContextPack>;

  abstract delete(packId: string): Promise<boolean>;

  abstract deleteMany(query: ContextPackDeleteQuery): Promise<string[]>;
}
