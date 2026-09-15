import { Injectable } from '@nestjs/common';
import { Prisma, type UserMemory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LongTermMemoryStore, type LongTermMemoryQuery } from './memory.store';
import type { MemoryEntry, MemorySourceRef } from './memory.types';

/**
 * L3 long-term memory 的 Prisma 实现，读写 user_memories 表。
 *
 * 与 PrismaPersistentMemoryStore（会话级 L2）隔离：本实现以 userId 为归属，
 * 跨会话共享，不参与会话级 hydrate / LRU 缓存。
 */
@Injectable()
export class PrismaLongTermMemoryStore extends LongTermMemoryStore {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async get(memoryId: string): Promise<MemoryEntry | null> {
    const memory = await this.prisma.userMemory.findUnique({
      where: { id: memoryId },
    });

    return memory ? this.toMemoryEntry(memory) : null;
  }

  async list(query: LongTermMemoryQuery): Promise<MemoryEntry[]> {
    const memories = await this.prisma.userMemory.findMany({
      where: this.buildWhere(query),
      orderBy: this.buildOrderBy(query),
      ...(query.limit ? { take: query.limit } : {}),
    });

    return memories.map((memory) => this.toMemoryEntry(memory));
  }

  async save(userId: string, memory: MemoryEntry): Promise<MemoryEntry> {
    const saved = await this.prisma.userMemory.upsert({
      where: { id: memory.memoryId },
      create: this.toCreateData(userId, memory),
      update: this.toUpdateData(userId, memory),
    });

    return this.toMemoryEntry(saved);
  }

  async delete(memoryId: string): Promise<boolean> {
    try {
      await this.prisma.userMemory.delete({ where: { id: memoryId } });
      return true;
    } catch {
      return false;
    }
  }

  private buildWhere(query: LongTermMemoryQuery): Prisma.UserMemoryWhereInput {
    const clauses: Prisma.UserMemoryWhereInput[] = [{ userId: query.userId }];

    if (query.memoryIds?.length) {
      clauses.push({ id: { in: query.memoryIds } });
    }

    if (query.layer) {
      clauses.push({ layer: query.layer });
    }

    if (query.layers?.length) {
      clauses.push({ layer: { in: query.layers } });
    }

    if (query.mergeGroup) {
      clauses.push({ mergeGroup: query.mergeGroup });
    }

    if (!query.includeExpired) {
      clauses.push({
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      });
    }

    return { AND: clauses };
  }

  private buildOrderBy(
    query: LongTermMemoryQuery,
  ): Prisma.UserMemoryOrderByWithRelationInput[] {
    if (query.orderBy) {
      return [
        { [query.orderBy.field]: query.orderBy.direction },
        { id: 'asc' },
      ];
    }

    return [{ updatedAt: 'desc' }, { id: 'asc' }];
  }

  private toCreateData(
    userId: string,
    memory: MemoryEntry,
  ): Prisma.UserMemoryUncheckedCreateInput {
    return {
      id: memory.memoryId,
      userId,
      originConversationId: memory.conversationId || null,
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
    userId: string,
    memory: MemoryEntry,
  ): Prisma.UserMemoryUncheckedUpdateInput {
    return {
      userId,
      originConversationId: memory.conversationId || null,
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

  private toMemoryEntry(memory: UserMemory): MemoryEntry {
    return {
      memoryId: memory.id,
      conversationId: memory.originConversationId ?? '',
      runId: null,
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
