/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type ConversationContextPack as PrismaConversationContextPack,
} from '@prisma/client';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import type {
  ContextPack,
  ContextPackDeleteQuery,
  ContextPackDroppedMemory,
  ContextPackLatestQuery,
  ContextPackQuery,
  ContextPackSummaryBlock,
  ContextPackUsage,
  ContextPackWriteInput,
} from './context-pack.types';
import {
  contextPackDroppedMemorySchema,
  contextPackMetadataSchema,
  contextPackSummaryBlockSchema,
  contextPackUsageSchema,
} from './context-pack.types';
import { ContextPackStore } from './memory.store';
import { memoryLayerSchema } from './memory.types';

const contextPackLayerOrderSchema = z.array(memoryLayerSchema);
const contextPackStringArraySchema = z.array(z.string());
const contextPackDroppedMemoriesSchema = z.array(
  contextPackDroppedMemorySchema,
);
const contextPackSummaryBlocksSchema = z.array(contextPackSummaryBlockSchema);

@Injectable()
export class PrismaContextPackStore extends ContextPackStore {
  private readonly logger = new Logger(PrismaContextPackStore.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async get(packId: string): Promise<ContextPack | null> {
    const pack = await this.prisma.conversationContextPack.findUnique({
      where: { id: packId },
    });

    return pack ? this.toContextPack(pack) : null;
  }

  async getLatest(query: ContextPackLatestQuery): Promise<ContextPack | null> {
    const pack = await this.prisma.conversationContextPack.findFirst({
      where: this.buildLatestWhere(query),
      orderBy: [{ generatedAt: 'desc' }, { id: 'asc' }],
    });

    return pack ? this.toContextPack(pack) : null;
  }

  async list(query: ContextPackQuery): Promise<ContextPack[]> {
    const packs = await this.prisma.conversationContextPack.findMany({
      where: this.buildWhere(query),
      orderBy: this.buildOrderBy(query.orderBy),
      ...(query.limit ? { take: query.limit } : {}),
    });

    return packs.map((pack) => this.toContextPack(pack));
  }

  async save(input: ContextPackWriteInput): Promise<ContextPack> {
    const pack = this.normalizePack(input);
    const saved = await this.prisma.conversationContextPack.upsert({
      where: { id: pack.packId },
      create: this.toCreateData(pack),
      update: this.toUpdateData(pack),
    });

    return this.toContextPack(saved);
  }

  async delete(packId: string): Promise<boolean> {
    try {
      await this.prisma.conversationContextPack.delete({
        where: { id: packId },
      });
      return true;
    } catch {
      return false;
    }
  }

  async deleteMany(query: ContextPackDeleteQuery): Promise<string[]> {
    const deleted = await this.prisma.conversationContextPack.findMany({
      where: this.buildDeleteWhere(query),
      select: { id: true },
    });

    if (deleted.length === 0) {
      return [];
    }

    await this.prisma.conversationContextPack.deleteMany({
      where: {
        id: {
          in: deleted.map((item) => item.id),
        },
      },
    });

    return deleted.map((item) => item.id);
  }

  private normalizePack(input: ContextPackWriteInput): ContextPack {
    const generatedAt = input.generatedAt
      ? new Date(input.generatedAt)
      : new Date();

    return {
      packId: input.packId?.trim() || this.createPackId(),
      conversationId: input.conversationId,
      runId: input.runId ?? null,
      intent: input.intent ?? null,
      maxTokens: input.maxTokens,
      layerOrder: [...input.layerOrder],
      selectedMemoryIds: [...input.selectedMemoryIds],
      droppedMemoryIds: [...(input.droppedMemoryIds ?? [])],
      droppedMemories: (input.droppedMemories ?? []).map((item) => ({
        ...item,
      })),
      summaryBlocks: input.summaryBlocks.map((block) =>
        this.cloneSummaryBlock(block),
      ),
      finalPromptPreview: input.finalPromptPreview,
      usage: {
        ...input.usage,
      },
      metadata: input.metadata ? { ...input.metadata } : null,
      generatedAt,
    };
  }

  private buildLatestWhere(
    query: ContextPackLatestQuery,
  ): Prisma.ConversationContextPackWhereInput {
    const where: Prisma.ConversationContextPackWhereInput = {
      conversationId: query.conversationId,
    };

    if (query.runId) {
      where.runId = query.runId;
    }

    if (query.intent) {
      where.intent = query.intent;
    }

    return where;
  }

  private buildWhere(
    query: ContextPackQuery,
  ): Prisma.ConversationContextPackWhereInput {
    const clauses: Prisma.ConversationContextPackWhereInput[] = [];

    if (query.packId) {
      clauses.push({ id: query.packId });
    }

    if (query.packIds?.length) {
      clauses.push({
        id: {
          in: query.packIds,
        },
      });
    }

    if (query.conversationId) {
      clauses.push({ conversationId: query.conversationId });
    }

    if (query.runId) {
      clauses.push({ runId: query.runId });
    }

    if (query.intent) {
      clauses.push({ intent: query.intent });
    }

    if (query.generatedAfter) {
      clauses.push({
        generatedAt: {
          gt: query.generatedAfter,
        },
      });
    }

    if (query.generatedBefore) {
      clauses.push({
        generatedAt: {
          lt: query.generatedBefore,
        },
      });
    }

    return clauses.length > 0 ? { AND: clauses } : {};
  }

  private buildDeleteWhere(
    query: ContextPackDeleteQuery,
  ): Prisma.ConversationContextPackWhereInput {
    const clauses: Prisma.ConversationContextPackWhereInput[] = [];

    if (query.packIds?.length) {
      clauses.push({
        id: {
          in: query.packIds,
        },
      });
    }

    if (query.conversationId) {
      clauses.push({ conversationId: query.conversationId });
    }

    if (query.runId) {
      clauses.push({ runId: query.runId });
    }

    if (query.intent) {
      clauses.push({ intent: query.intent });
    }

    if (query.generatedBefore) {
      clauses.push({
        generatedAt: {
          lt: query.generatedBefore,
        },
      });
    }

    return clauses.length > 0 ? { AND: clauses } : {};
  }

  private buildOrderBy(
    orderBy?: ContextPackQuery['orderBy'],
  ): Prisma.ConversationContextPackOrderByWithRelationInput[] {
    return [
      {
        generatedAt: orderBy?.direction === 'asc' ? 'asc' : 'desc',
      },
      {
        id: 'asc',
      },
    ];
  }

  private toCreateData(
    pack: ContextPack,
  ): Prisma.ConversationContextPackUncheckedCreateInput {
    return {
      id: pack.packId,
      conversationId: pack.conversationId,
      runId: pack.runId,
      intent: pack.intent,
      maxTokens: pack.maxTokens,
      layerOrder: this.toJsonValue(pack.layerOrder),
      selectedMemoryIds: this.toJsonValue(pack.selectedMemoryIds),
      droppedMemoryIds: this.toJsonValue(pack.droppedMemoryIds),
      droppedMemories: this.toJsonValue(pack.droppedMemories),
      summaryBlocks: this.toJsonValue(pack.summaryBlocks),
      finalPromptPreview: pack.finalPromptPreview,
      usage: this.toJsonValue(pack.usage),
      metadata: this.toNullableJsonValue(pack.metadata),
      generatedAt: pack.generatedAt,
    };
  }

  private toUpdateData(
    pack: ContextPack,
  ): Prisma.ConversationContextPackUncheckedUpdateInput {
    return {
      conversationId: pack.conversationId,
      runId: pack.runId,
      intent: pack.intent,
      maxTokens: pack.maxTokens,
      layerOrder: this.toJsonValue(pack.layerOrder),
      selectedMemoryIds: this.toJsonValue(pack.selectedMemoryIds),
      droppedMemoryIds: this.toJsonValue(pack.droppedMemoryIds),
      droppedMemories: this.toJsonValue(pack.droppedMemories),
      summaryBlocks: this.toJsonValue(pack.summaryBlocks),
      finalPromptPreview: pack.finalPromptPreview,
      usage: this.toJsonValue(pack.usage),
      metadata: this.toNullableJsonValue(pack.metadata),
      generatedAt: pack.generatedAt,
    };
  }

  private toContextPack(pack: PrismaConversationContextPack): ContextPack {
    return {
      packId: pack.id,
      conversationId: pack.conversationId,
      runId: pack.runId,
      intent: pack.intent,
      maxTokens: pack.maxTokens,
      layerOrder: this.parseJsonField(
        contextPackLayerOrderSchema,
        pack.layerOrder,
        [],
        'layerOrder',
        pack.id,
      ),
      selectedMemoryIds: this.parseJsonField(
        contextPackStringArraySchema,
        pack.selectedMemoryIds,
        [],
        'selectedMemoryIds',
        pack.id,
      ),
      droppedMemoryIds: this.parseJsonField(
        contextPackStringArraySchema,
        pack.droppedMemoryIds,
        [],
        'droppedMemoryIds',
        pack.id,
      ),
      droppedMemories: this.toDroppedMemories(pack.droppedMemories, pack.id),
      summaryBlocks: this.toSummaryBlocks(pack.summaryBlocks, pack.id),
      finalPromptPreview: pack.finalPromptPreview,
      usage: this.toUsage(pack.usage, pack.id, pack.maxTokens),
      metadata: this.toMetadata(pack.metadata, 'metadata', pack.id),
      generatedAt: new Date(pack.generatedAt),
    };
  }

  private toDroppedMemories(
    value: Prisma.JsonValue,
    packId: string,
  ): ContextPackDroppedMemory[] {
    return this.parseJsonField(
      contextPackDroppedMemoriesSchema,
      value,
      [],
      'droppedMemories',
      packId,
    );
  }

  private toSummaryBlocks(
    value: Prisma.JsonValue,
    packId: string,
  ): ContextPackSummaryBlock[] {
    return this.parseJsonField(
      contextPackSummaryBlocksSchema,
      value,
      [],
      'summaryBlocks',
      packId,
    );
  }

  private toUsage(
    value: Prisma.JsonValue,
    packId: string,
    maxTokens: number,
  ): ContextPackUsage {
    return this.parseJsonField(
      contextPackUsageSchema,
      value,
      {
        maxTokens,
        reservedTokens: 0,
        usedTokens: 0,
        droppedTokens: 0,
      },
      'usage',
      packId,
    );
  }

  private toMetadata(
    value: Prisma.JsonValue | null,
    fieldName: string,
    packId: string,
  ): Record<string, unknown> | null {
    if (value === null) {
      return null;
    }

    return this.parseJsonField(
      contextPackMetadataSchema,
      value,
      null,
      fieldName,
      packId,
    );
  }

  private cloneSummaryBlock(
    block: ContextPackSummaryBlock,
  ): ContextPackSummaryBlock {
    return {
      ...block,
      memoryIds: [...block.memoryIds],
      metadata: block.metadata ? { ...block.metadata } : undefined,
    };
  }

  // Prisma's JSON inputs are structurally compatible here; the runtime safety
  // boundary is handled on the read side with zod parsing and fallbacks.
  private toJsonValue(value: unknown): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
  }

  private toNullableJsonValue(
    value: Record<string, unknown> | null,
  ): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
    if (value === null) {
      return Prisma.DbNull;
    }

    return value as Prisma.InputJsonValue;
  }

  private parseJsonField<T>(
    schema: z.ZodType<T>,
    value: Prisma.JsonValue | null,
    fallback: T,
    fieldName: string,
    packId: string,
  ): T {
    const result = schema.safeParse(value);
    if (result.success) {
      return result.data;
    }

    this.logger.warn(
      `Invalid ${fieldName} JSON for context pack ${packId}; using fallback.`,
    );
    return fallback;
  }

  private createPackId(): string {
    return `pack_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  }
}
