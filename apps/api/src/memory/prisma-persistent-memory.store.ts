import { Injectable } from '@nestjs/common';
import { Prisma, type ConversationMemory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  MemoryDeleteQuery,
  MemoryEntry,
  MemoryHydrationOptions,
  MemoryHydrationResult,
  MemoryPatchInput,
  MemoryQuery,
  MemorySourceRef,
} from './memory.types';
import { PersistentMemoryStore } from './memory.store';

@Injectable()
export class PrismaPersistentMemoryStore extends PersistentMemoryStore {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async get(memoryId: string): Promise<MemoryEntry | null> {
    const memory = await this.prisma.conversationMemory.findUnique({
      where: { id: memoryId },
    });

    return memory ? this.toMemoryEntry(memory) : null;
  }

  async list(query: MemoryQuery): Promise<MemoryEntry[]> {
    const where = this.buildWhere(query);
    const memories = await this.prisma.conversationMemory.findMany({
      where,
      orderBy: this.buildOrderBy(query),
      ...(query.limit ? { take: query.limit } : {}),
    });

    return memories.map((memory) => this.toMemoryEntry(memory));
  }

  async save(memory: MemoryEntry): Promise<MemoryEntry> {
    const saved = await this.prisma.conversationMemory.upsert({
      where: { id: memory.memoryId },
      create: this.toCreateData(memory),
      update: this.toUpdateData(memory),
    });

    return this.toMemoryEntry(saved);
  }

  async saveMany(memories: MemoryEntry[]): Promise<MemoryEntry[]> {
    if (memories.length === 0) {
      return [];
    }

    await this.prisma.conversationMemory.createMany({
      data: memories.map((memory) => this.toCreateData(memory)),
    });

    const ids = memories.map((memory) => memory.memoryId);
    const saved = await this.prisma.conversationMemory.findMany({
      where: { id: { in: ids } },
    });
    const savedById = new Map(
      saved.map((memory) => [memory.id, this.toMemoryEntry(memory)]),
    );

    return ids
      .map((id) => savedById.get(id))
      .filter((memory): memory is MemoryEntry => Boolean(memory));
  }

  async patch(
    memoryId: string,
    patch: MemoryPatchInput,
  ): Promise<MemoryEntry | null> {
    const data = this.toPatchData(patch);
    if (Object.keys(data).length === 0) {
      return this.get(memoryId);
    }

    try {
      const patched = await this.prisma.conversationMemory.update({
        where: { id: memoryId },
        data,
      });

      return this.toMemoryEntry(patched);
    } catch {
      return null;
    }
  }

  async delete(memoryId: string): Promise<boolean> {
    try {
      await this.prisma.conversationMemory.delete({
        where: { id: memoryId },
      });
      return true;
    } catch {
      return false;
    }
  }

  async deleteMany(query: MemoryDeleteQuery): Promise<string[]> {
    const deleted = await this.prisma.conversationMemory.findMany({
      where: this.buildDeleteWhere(query),
      select: { id: true },
    });

    if (deleted.length === 0) {
      return [];
    }

    await this.prisma.conversationMemory.deleteMany({
      where: {
        id: {
          in: deleted.map((item) => item.id),
        },
      },
    });

    return deleted.map((item) => item.id);
  }

  async hydrateConversation(
    conversationId: string,
    options?: MemoryHydrationOptions,
  ): Promise<MemoryHydrationResult> {
    const hydratedAt = options?.hydratedAt ?? new Date();
    const baseWhere: Prisma.ConversationMemoryWhereInput = {
      conversationId,
      ...(options?.layers?.length
        ? {
            layer: {
              in: options.layers,
            },
          }
        : {}),
    };
    const expiredWhere: Prisma.ConversationMemoryWhereInput = {
      ...baseWhere,
      expiresAt: {
        lte: hydratedAt,
      },
    };
    const activeWhere: Prisma.ConversationMemoryWhereInput = {
      ...baseWhere,
      OR: [{ expiresAt: null }, { expiresAt: { gt: hydratedAt } }],
    };

    const [expired, memories] = await Promise.all([
      this.prisma.conversationMemory.findMany({
        where: expiredWhere,
        select: { id: true },
      }),
      this.prisma.conversationMemory.findMany({
        where: activeWhere,
        orderBy: [
          { pinned: 'desc' },
          { priority: 'desc' },
          { updatedAt: 'desc' },
          { id: 'asc' },
        ],
        ...(options?.limit ? { take: options.limit } : {}),
      }),
    ]);

    if (expired.length > 0) {
      await this.prisma.conversationMemory.deleteMany({
        where: {
          id: {
            in: expired.map((item) => item.id),
          },
        },
      });
    }

    return {
      conversationId,
      memories: memories.map((memory) => this.toMemoryEntry(memory)),
      expiredMemoryIds: expired.map((item) => item.id),
      hydratedAt,
    };
  }

  private buildWhere(query: MemoryQuery): Prisma.ConversationMemoryWhereInput {
    const clauses: Prisma.ConversationMemoryWhereInput[] = [];

    if (query.conversationId) {
      clauses.push({ conversationId: query.conversationId });
    }

    if (query.runId) {
      clauses.push({ runId: query.runId });
    }

    if (query.memoryIds?.length) {
      clauses.push({
        id: {
          in: query.memoryIds,
        },
      });
    }

    if (query.layer) {
      clauses.push({ layer: query.layer });
    }

    if (query.layers?.length) {
      clauses.push({
        layer: {
          in: query.layers,
        },
      });
    }

    if (query.scope) {
      clauses.push({ scope: query.scope });
    }

    if (query.scopes?.length) {
      clauses.push({
        scope: {
          in: query.scopes,
        },
      });
    }

    if (query.mergeGroup) {
      clauses.push({ mergeGroup: query.mergeGroup });
    }

    if (query.pinned !== undefined) {
      clauses.push({ pinned: query.pinned });
    }

    if (!query.includeExpired) {
      clauses.push({
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      });
    }

    if (query.cursor) {
      clauses.push({
        id: {
          gt: query.cursor,
        },
      });
    }

    return clauses.length > 0 ? { AND: clauses } : {};
  }

  private buildDeleteWhere(
    query: MemoryDeleteQuery,
  ): Prisma.ConversationMemoryWhereInput {
    const clauses: Prisma.ConversationMemoryWhereInput[] = [];

    if (query.conversationId) {
      clauses.push({ conversationId: query.conversationId });
    }

    if (query.memoryIds?.length) {
      clauses.push({
        id: {
          in: query.memoryIds,
        },
      });
    }

    if (query.layer) {
      clauses.push({ layer: query.layer });
    }

    if (query.mergeGroup) {
      clauses.push({ mergeGroup: query.mergeGroup });
    }

    if (!query.includePinned) {
      clauses.push({ pinned: false });
    }

    return clauses.length > 0 ? { AND: clauses } : {};
  }

  private buildOrderBy(
    query: MemoryQuery,
  ): Prisma.ConversationMemoryOrderByWithRelationInput[] {
    if (query.orderBy) {
      return [
        {
          [query.orderBy.field]: query.orderBy.direction,
        },
        { id: 'asc' },
      ];
    }

    return [{ id: 'asc' }];
  }

  private toCreateData(
    memory: MemoryEntry,
  ): Prisma.ConversationMemoryCreateManyInput {
    return {
      id: memory.memoryId,
      conversationId: memory.conversationId,
      runId: memory.runId,
      layer: memory.layer,
      scope: memory.scope,
      content: memory.content,
      summary: memory.summary,
      tokenEstimate: memory.tokenEstimate,
      priority: memory.priority,
      pinned: memory.pinned,
      freshnessScore: memory.freshnessScore,
      relevanceScore: memory.relevanceScore,
      sourceRefs: this.toJsonValue(this.cloneSourceRefs(memory.sourceRefs)),
      mergeGroup: memory.mergeGroup,
      mergeStrategy: memory.mergeStrategy,
      version: memory.version,
      metadata: this.toNullableJsonValue(memory.metadata),
      expiresAt: memory.expiresAt,
      lastAccessedAt: memory.lastAccessedAt,
      accessCount: memory.accessCount,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    };
  }

  private toUpdateData(
    memory: MemoryEntry,
  ): Prisma.ConversationMemoryUncheckedUpdateInput {
    return {
      conversationId: memory.conversationId,
      runId: memory.runId,
      layer: memory.layer,
      scope: memory.scope,
      content: memory.content,
      summary: memory.summary,
      tokenEstimate: memory.tokenEstimate,
      priority: memory.priority,
      pinned: memory.pinned,
      freshnessScore: memory.freshnessScore,
      relevanceScore: memory.relevanceScore,
      sourceRefs: this.toJsonValue(this.cloneSourceRefs(memory.sourceRefs)),
      mergeGroup: memory.mergeGroup,
      mergeStrategy: memory.mergeStrategy,
      version: memory.version,
      metadata: this.toNullableJsonValue(memory.metadata),
      expiresAt: memory.expiresAt,
      lastAccessedAt: memory.lastAccessedAt,
      accessCount: memory.accessCount,
    };
  }

  private toPatchData(
    patch: MemoryPatchInput,
  ): Prisma.ConversationMemoryUpdateInput {
    const data: Prisma.ConversationMemoryUpdateInput = {};

    if (patch.summary !== undefined) {
      data.summary = patch.summary;
    }

    if (patch.content !== undefined) {
      data.content = patch.content;
    }

    if (patch.tokenEstimate !== undefined) {
      data.tokenEstimate = patch.tokenEstimate;
    }

    if (patch.priority !== undefined) {
      data.priority = patch.priority;
    }

    if (patch.pinned !== undefined) {
      data.pinned = patch.pinned;
    }

    if (patch.freshnessScore !== undefined) {
      data.freshnessScore = patch.freshnessScore;
    }

    if (patch.relevanceScore !== undefined) {
      data.relevanceScore = patch.relevanceScore;
    }

    if (patch.sourceRefs !== undefined) {
      data.sourceRefs = this.toJsonValue(patch.sourceRefs);
    }

    if (patch.metadata !== undefined) {
      data.metadata = this.toNullableJsonValue(patch.metadata);
    }

    if (patch.expiresAt !== undefined) {
      data.expiresAt = patch.expiresAt;
    }

    return data;
  }

  private toMemoryEntry(memory: ConversationMemory): MemoryEntry {
    return {
      memoryId: memory.id,
      conversationId: memory.conversationId,
      runId: memory.runId,
      layer: memory.layer,
      scope: memory.scope,
      content: memory.content,
      summary: memory.summary,
      tokenEstimate: memory.tokenEstimate,
      priority: memory.priority,
      pinned: memory.pinned,
      freshnessScore: memory.freshnessScore,
      relevanceScore: memory.relevanceScore,
      sourceRefs: this.toSourceRefs(memory.sourceRefs),
      mergeGroup: memory.mergeGroup,
      mergeStrategy: memory.mergeStrategy,
      version: memory.version,
      metadata: this.toMetadata(memory.metadata),
      expiresAt: memory.expiresAt,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
      lastAccessedAt: memory.lastAccessedAt,
      accessCount: memory.accessCount,
    };
  }

  private toSourceRefs(value: Prisma.JsonValue): MemorySourceRef[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.map((item) => {
      const record = this.toRecord(item);
      return {
        kind: (record.kind as string) ?? '',
        sourceId: (record.sourceId as string) ?? '',
        fragment:
          record.fragment === undefined || record.fragment === null
            ? null
            : (record.fragment as string),
        title:
          record.title === undefined || record.title === null
            ? null
            : (record.title as string),
        metadata:
          this.toMetadata(record.metadata as Prisma.JsonValue | null) ??
          undefined,
      };
    });
  }

  private toMetadata(
    value: Prisma.JsonValue | null,
  ): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return { ...(value as Record<string, unknown>) };
  }

  private toRecord(value: Prisma.JsonValue): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    return value;
  }

  private cloneSourceRefs(sourceRefs: MemorySourceRef[]): MemorySourceRef[] {
    return sourceRefs.map((sourceRef) => ({
      ...sourceRef,
      metadata: sourceRef.metadata ? { ...sourceRef.metadata } : undefined,
    }));
  }

  private toJsonValue(value: unknown): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
  }

  private toNullableJsonValue(
    value: Record<string, unknown> | null,
  ): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
    if (value === null) {
      return Prisma.DbNull;
    }

    return value as unknown as Prisma.InputJsonValue;
  }
}
