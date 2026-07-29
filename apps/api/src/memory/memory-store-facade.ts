import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  MemoryStore,
  PersistentMemoryStore,
  RuntimeMemoryStore,
} from './memory.store';
import type {
  MemoryDeleteQuery,
  MemoryEntry,
  MemoryHydrationOptions,
  MemoryHydrationResult,
  MemoryPatchInput,
  MemoryQuery,
  MemorySourceRef,
  MemoryWriteInput,
  MemoryWriteResult,
} from './memory.types';

/**
 * Service-facing facade that coordinates hot-cache reads with Prisma-backed
 * persistence and keeps both layers in sync after writes.
 */
@Injectable()
export class MemoryStoreFacade extends MemoryStore {
  constructor(
    private readonly runtimeMemoryStore: RuntimeMemoryStore,
    private readonly persistentMemoryStore: PersistentMemoryStore,
  ) {
    super();
  }

  async get(memoryId: string): Promise<MemoryEntry | null> {
    const runtimeMemory = await this.runtimeMemoryStore.get(memoryId);
    if (runtimeMemory) {
      return runtimeMemory;
    }

    const persistentMemory = await this.persistentMemoryStore.get(memoryId);
    if (!persistentMemory) {
      return null;
    }

    await this.runtimeMemoryStore.set(persistentMemory);
    return persistentMemory;
  }

  async list(query: MemoryQuery): Promise<MemoryEntry[]> {
    const memories = await this.persistentMemoryStore.list(query);
    await Promise.all(
      memories.map((memory) => this.runtimeMemoryStore.set(memory)),
    );
    return memories;
  }

  async write(input: MemoryWriteInput): Promise<MemoryWriteResult> {
    const now = new Date();
    const mergeCandidate = await this.findMergeCandidate(input);

    if (!mergeCandidate) {
      const memory = this.toMemoryEntry(input, now);
      return {
        memory: await this.persistMemory(memory),
        merged: false,
      };
    }

    if (input.mergeStrategy === 'replace') {
      await this.deleteFromStores(mergeCandidate.memoryId);
      const memory = this.toMemoryEntry(input, now);
      return {
        memory: await this.persistMemory(memory),
        merged: true,
        replacedMemoryId: mergeCandidate.memoryId,
      };
    }

    if (input.mergeStrategy === 'summarize') {
      // TODO: hook summarize mode up to an LLM-backed compaction step.
      const memory = this.toMergedMemoryEntry(mergeCandidate, input, now);
      return {
        memory: await this.persistMemory(memory),
        merged: true,
      };
    }

    const memory = this.toMergedMemoryEntry(mergeCandidate, input, now);
    return {
      memory: await this.persistMemory(memory),
      merged: true,
    };
  }

  async patch(
    memoryId: string,
    patch: MemoryPatchInput,
  ): Promise<MemoryEntry | null> {
    const persistentPatched = await this.persistentMemoryStore.patch(
      memoryId,
      patch,
    );
    if (persistentPatched) {
      await this.runtimeMemoryStore.set(persistentPatched);
      return persistentPatched;
    }

    const runtimePatched = await this.runtimeMemoryStore.patch(memoryId, patch);
    if (!runtimePatched) {
      return null;
    }

    return this.persistMemory(runtimePatched);
  }

  async delete(memoryId: string): Promise<boolean> {
    const [persistentDeleted, runtimeDeleted] = await Promise.all([
      this.persistentMemoryStore.delete(memoryId),
      this.runtimeMemoryStore.delete(memoryId),
    ]);

    return persistentDeleted || runtimeDeleted;
  }

  async deleteMany(query: MemoryDeleteQuery): Promise<string[]> {
    const [persistentDeleted, runtimeDeleted] = await Promise.all([
      this.persistentMemoryStore.deleteMany(query),
      this.runtimeMemoryStore.deleteMany(query),
    ]);

    return Array.from(new Set([...persistentDeleted, ...runtimeDeleted]));
  }

  async touch(memoryId: string, accessedAt?: Date): Promise<void> {
    await this.runtimeMemoryStore.touch(memoryId, accessedAt);
  }

  async hydrateConversation(
    conversationId: string,
    options?: MemoryHydrationOptions,
  ): Promise<MemoryHydrationResult> {
    const result = await this.persistentMemoryStore.hydrateConversation(
      conversationId,
      options,
    );

    await this.runtimeMemoryStore.clearConversation(conversationId);
    await Promise.all(
      result.memories.map((memory) => this.runtimeMemoryStore.set(memory)),
    );

    return result;
  }

  private async findMergeCandidate(
    input: MemoryWriteInput,
  ): Promise<MemoryEntry | null> {
    if (!input.mergeGroup || input.mergeStrategy === null) {
      return null;
    }

    const query: MemoryQuery = {
      conversationId: input.conversationId,
      mergeGroup: input.mergeGroup,
      orderBy: {
        field: 'updatedAt',
        direction: 'desc',
      },
      limit: 1,
    };

    const persistentMatches = await this.persistentMemoryStore.list(query);
    if (persistentMatches[0]) {
      return persistentMatches[0];
    }

    const runtimeMatches = await this.runtimeMemoryStore.list(query);
    return runtimeMatches[0] ?? null;
  }

  private toMemoryEntry(input: MemoryWriteInput, now: Date): MemoryEntry {
    return {
      memoryId: input.memoryId?.trim() || cuid(),
      conversationId: input.conversationId,
      runId: input.runId ?? null,
      layer: input.layer,
      scope: input.scope,
      content: input.content,
      summary: input.summary ?? null,
      tokenEstimate: input.tokenEstimate ?? 0,
      priority: input.priority ?? 0,
      pinned: input.pinned ?? false,
      freshnessScore: input.freshnessScore ?? 0,
      relevanceScore: input.relevanceScore ?? 0,
      sourceRefs: this.cloneSourceRefs(input.sourceRefs ?? []),
      mergeGroup: input.mergeGroup ?? null,
      mergeStrategy: input.mergeStrategy ?? null,
      version: 1,
      metadata: this.cloneMetadata(input.metadata),
      expiresAt: this.cloneDate(input.expiresAt),
      createdAt: new Date(now),
      updatedAt: new Date(now),
      lastAccessedAt: null,
      accessCount: 0,
    };
  }

  private toMergedMemoryEntry(
    previous: MemoryEntry,
    input: MemoryWriteInput,
    now: Date,
  ): MemoryEntry {
    return {
      memoryId: previous.memoryId,
      conversationId: previous.conversationId,
      runId: input.runId ?? previous.runId,
      layer: input.layer,
      scope: input.scope,
      content: this.mergeContent(previous.content, input.content),
      summary: input.summary !== undefined ? input.summary : previous.summary,
      tokenEstimate: previous.tokenEstimate + (input.tokenEstimate ?? 0),
      priority: input.priority ?? previous.priority,
      pinned: input.pinned ?? previous.pinned,
      freshnessScore: input.freshnessScore ?? previous.freshnessScore,
      relevanceScore: input.relevanceScore ?? previous.relevanceScore,
      sourceRefs: [
        ...this.cloneSourceRefs(previous.sourceRefs),
        ...this.cloneSourceRefs(input.sourceRefs ?? []),
      ],
      mergeGroup: input.mergeGroup ?? previous.mergeGroup,
      mergeStrategy: input.mergeStrategy ?? previous.mergeStrategy,
      version: previous.version + 1,
      metadata: this.mergeMetadata(previous.metadata, input.metadata),
      expiresAt:
        input.expiresAt !== undefined
          ? this.cloneDate(input.expiresAt)
          : this.cloneDate(previous.expiresAt),
      createdAt: new Date(previous.createdAt),
      updatedAt: new Date(now),
      lastAccessedAt: this.cloneDate(previous.lastAccessedAt),
      accessCount: previous.accessCount,
    };
  }

  private mergeContent(previousContent: string, nextContent: string): string {
    if (!previousContent.trim()) {
      return nextContent;
    }

    if (!nextContent.trim()) {
      return previousContent;
    }

    return `${previousContent}\n${nextContent}`;
  }

  private mergeMetadata(
    previous: Record<string, unknown> | null,
    next: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null {
    if (!previous && !next) {
      return null;
    }

    return {
      ...(previous ?? {}),
      ...(next ?? {}),
    };
  }

  private cloneSourceRefs(sourceRefs: MemorySourceRef[]): MemorySourceRef[] {
    return sourceRefs.map((sourceRef) => ({
      ...sourceRef,
      metadata: this.cloneMetadata(sourceRef.metadata),
    }));
  }

  private cloneMetadata(
    metadata: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null {
    if (!metadata) {
      return null;
    }

    return { ...metadata };
  }

  private cloneDate(value: Date | null | undefined): Date | null {
    if (!value) {
      return null;
    }

    return new Date(value);
  }

  private async persistMemory(memory: MemoryEntry): Promise<MemoryEntry> {
    const persisted = await this.persistentMemoryStore.save(memory);
    await this.runtimeMemoryStore.set(persisted);
    return persisted;
  }

  private async deleteFromStores(memoryId: string): Promise<void> {
    await Promise.all([
      this.persistentMemoryStore.delete(memoryId),
      this.runtimeMemoryStore.delete(memoryId),
    ]);
  }
}

function cuid(): string {
  const timestamp = Date.now().toString(36);
  const random = randomUUID().replace(/-/g, '').slice(0, 16);
  return `c${timestamp}${random}`;
}
