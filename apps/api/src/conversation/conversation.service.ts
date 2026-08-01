import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ContextPackReadService } from '../memory/context-pack-read.service';
import type { ContextPack } from '../memory/context-pack.types';
import {
  type DisplayPreferenceCandidate,
  getDisplayPreferenceMergeGroup,
  type DisplayPreferenceMemoryMetadata,
} from '../memory/display-preference.types';
import { MemoryStore } from '../memory/memory.store';
import { PrismaService } from '../prisma/prisma.service';
import { ResumeContextService } from '../resume/resume-context.service';
import { extractDisplayPreferenceCandidates } from './display-preference-extractor';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { AppendConversationMessageDto } from './dto/append-conversation-message.dto';
import { SetConversationResumeContextDto } from './dto/set-conversation-resume-context.dto';
import type {
  ConversationContextPackDetailDto,
  ConversationContextPackHistoryDto,
  ConversationContextPackSummaryDto,
  ConversationLatestContextPackDto,
} from './dto/conversation-context-pack.dto';
import type { ConversationResumeContextDetailDto } from './dto/conversation-resume-context-detail.dto';
import type {
  ConversationDto,
  ConversationListResponseDto,
  ConversationMessageDto,
  ConversationMessageListResponseDto,
} from './dto/conversation-response.dto';
import type { ConversationResumeContextDto } from './dto/conversation-resume-context-response.dto';

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resumeContextService: ResumeContextService,
    private readonly memoryStore: MemoryStore,
    private readonly contextPackReadService: ContextPackReadService,
  ) {}

  // 创建会话基础记录，供后续多轮对话继续追加消息。
  async createConversation(
    userId: string,
    dto: CreateConversationDto,
  ): Promise<ConversationDto> {
    const conversation = await this.prisma.conversation.create({
      data: {
        userId,
        title: dto.title?.trim() || 'New Conversation',
        status: 'active',
      },
    });

    return this.toConversationDto(conversation);
  }

  // 查询当前用户最近使用的会话列表。
  async listConversations(
    userId: string,
  ): Promise<ConversationListResponseDto> {
    const conversations = await this.prisma.conversation.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });

    return {
      conversations: conversations.map((item) => this.toConversationDto(item)),
    };
  }

  // 向指定会话追加一条消息并刷新会话更新时间。
  async appendMessage(
    userId: string,
    conversationId: string,
    dto: AppendConversationMessageDto,
  ): Promise<ConversationMessageDto> {
    await this.ensureConversationOwner(userId, conversationId);

    const message = await this.prisma.conversationMessage.create({
      data: {
        conversationId,
        role: dto.role,
        content: dto.content.trim(),
        intent: dto.intent?.trim() || null,
        agentName: dto.agentName?.trim() || null,
        toolCallSummary: dto.toolCallSummary
          ? (dto.toolCallSummary as unknown as Prisma.InputJsonValue)
          : Prisma.DbNull,
      },
    });

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        updatedAt: new Date(),
      },
    });

    if (dto.role === 'user') {
      await this.captureDisplayPreferences({
        conversationId,
        messageId: message.id,
        content: message.content,
      });
    }

    return this.toConversationMessageDto(message);
  }

  // 返回最近消息列表，供后续构建短期上下文窗口。
  async listRecentMessages(
    userId: string,
    conversationId: string,
    limit: number,
  ): Promise<ConversationMessageListResponseDto> {
    await this.ensureConversationOwner(userId, conversationId);

    const messages = await this.prisma.conversationMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return {
      conversationId,
      messages: messages
        .reverse()
        .map((item) => this.toConversationMessageDto(item)),
    };
  }

  // 写入当前会话的简历上下文，供后续 chat/agent 读取并做个性化提示词组装。
  async setResumeContext(
    userId: string,
    conversationId: string,
    dto: SetConversationResumeContextDto,
  ): Promise<ConversationResumeContextDto> {
    await this.ensureConversationOwner(userId, conversationId);

    const resumeLibraryItemIds = this.normalizeResumeIds(
      dto.resumeLibraryItemIds,
    );
    await this.resumeContextService.setActiveResumeContext(
      userId,
      conversationId,
      resumeLibraryItemIds,
    );

    return {
      conversationId,
      resumeLibraryItemIds,
      slotKey: 'selected_resume_item_ids',
    };
  }

  // 读取当前会话绑定的简历上下文，供前端展示和 agent 侧透传校验使用。
  async getResumeContext(
    userId: string,
    conversationId: string,
  ): Promise<ConversationResumeContextDetailDto> {
    await this.ensureConversationOwner(userId, conversationId);

    const context = await this.resumeContextService.buildConversationContext(
      userId,
      conversationId,
    );
    const response: ConversationResumeContextDetailDto = {
      conversationId,
      resumeLibraryItemIds: context.activeResumeIds,
      selectedCount: context.selectedCount,
      slotKey: 'selected_resume_item_ids',
      activeResumeSummaries: context.activeResumeSummaries,
    };

    if (context.conversationHistorySummary) {
      response.conversationHistorySummary = context.conversationHistorySummary;
    }

    return response;
  }

  async getLatestContextPack(
    userId: string,
    conversationId: string,
  ): Promise<ConversationLatestContextPackDto> {
    await this.ensureConversationOwner(userId, conversationId);

    const contextPack =
      await this.contextPackReadService.getLatestForConversation(conversationId);

    return {
      conversationId,
      contextPack: contextPack ? this.toContextPackDetailDto(contextPack) : null,
    };
  }

  async listContextPackHistory(
    userId: string,
    conversationId: string,
    limit: number,
  ): Promise<ConversationContextPackHistoryDto> {
    await this.ensureConversationOwner(userId, conversationId);

    const packs = await this.contextPackReadService.listConversationHistory(
      conversationId,
      limit,
    );

    return {
      conversationId,
      packs: packs.map((pack) => this.toContextPackSummaryDto(pack)),
    };
  }

  async getContextPack(
    userId: string,
    conversationId: string,
    packId: string,
  ): Promise<ConversationContextPackDetailDto> {
    await this.ensureConversationOwner(userId, conversationId);

    const contextPack = await this.contextPackReadService.getConversationPack(
      conversationId,
      packId,
    );
    if (!contextPack) {
      throw new NotFoundException('Context pack not found');
    }

    return this.toContextPackDetailDto(contextPack);
  }

  private async ensureConversationOwner(
    userId: string,
    conversationId: string,
  ): Promise<void> {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        userId,
      },
      select: { id: true },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
  }

  private toConversationDto(conversation: {
    id: string;
    title: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  }): ConversationDto {
    return {
      id: conversation.id,
      title: conversation.title,
      status: conversation.status,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
    };
  }

  private toConversationMessageDto(message: {
    id: string;
    role: string;
    content: string;
    intent: string | null;
    agentName: string | null;
    toolCallSummary?: unknown;
    createdAt: Date;
  }): ConversationMessageDto {
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      intent: message.intent,
      agentName: message.agentName,
      toolCallSummary:
        (message.toolCallSummary as ConversationMessageDto['toolCallSummary']) ??
        null,
      createdAt: message.createdAt.toISOString(),
    };
  }

  private toContextPackSummaryDto(
    pack: ContextPack,
  ): ConversationContextPackSummaryDto {
    return {
      packId: pack.packId,
      runId: pack.runId,
      intent: pack.intent,
      maxTokens: pack.maxTokens,
      layerOrder: [...pack.layerOrder],
      usage: {
        ...pack.usage,
      },
      selectedCount: pack.selectedMemoryIds.length,
      droppedCount: pack.droppedMemoryIds.length,
      summaryBlockCount: pack.summaryBlocks.length,
      generatedAt: pack.generatedAt.toISOString(),
    };
  }

  private toContextPackDetailDto(
    pack: ContextPack,
  ): ConversationContextPackDetailDto {
    return {
      packId: pack.packId,
      conversationId: pack.conversationId,
      runId: pack.runId,
      intent: pack.intent,
      maxTokens: pack.maxTokens,
      layerOrder: [...pack.layerOrder],
      selectedMemoryIds: [...pack.selectedMemoryIds],
      droppedMemoryIds: [...pack.droppedMemoryIds],
      droppedMemories: pack.droppedMemories.map((memory) => ({
        ...memory,
      })),
      summaryBlocks: pack.summaryBlocks.map((block) => ({
        ...block,
        memoryIds: [...block.memoryIds],
        metadata: block.metadata ? { ...block.metadata } : undefined,
      })),
      finalPromptPreview: pack.finalPromptPreview,
      usage: {
        ...pack.usage,
      },
      metadata: this.cloneMetadata(pack.metadata),
      selectedCount: pack.selectedMemoryIds.length,
      droppedCount: pack.droppedMemoryIds.length,
      summaryBlockCount: pack.summaryBlocks.length,
      generatedAt: pack.generatedAt.toISOString(),
    };
  }

  private normalizeResumeIds(ids: string[]): string[] {
    return Array.from(
      new Set(ids.map((item) => item.trim()).filter((item) => item.length > 0)),
    );
  }

  private cloneMetadata(
    metadata: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!metadata) {
      return null;
    }

    return { ...metadata };
  }

  /**
   * 从用户消息中捕获显式显示偏好，并以 preference memory 形式写入单会话上下文。
   *
   * @param input 偏好捕获输入
   * @returns 无返回值
   */
  private async captureDisplayPreferences(input: {
    conversationId: string;
    messageId: string;
    content: string;
  }): Promise<void> {
    const candidates = extractDisplayPreferenceCandidates({
      messageId: input.messageId,
      content: input.content,
    });
    if (candidates.length === 0) {
      return;
    }

    try {
      await Promise.all(
        candidates.map((candidate) =>
          this.memoryStore.write(
            this.toDisplayPreferenceMemoryWriteInput(
              input.conversationId,
              candidate,
            ),
          ),
        ),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'unknown preference error';
      this.logger.warn(
        `Display preference capture skipped for conversation ${input.conversationId}: ${message}`,
      );
    }
  }

  /**
   * 将显式显示偏好候选项转换为 memory.write 输入。
   *
   * @param conversationId 当前会话 ID
   * @param candidate 已归一化的偏好候选项
   * @returns 可直接写入 MemoryStore 的 payload
   */
  private toDisplayPreferenceMemoryWriteInput(
    conversationId: string,
    candidate: DisplayPreferenceCandidate,
  ) {
    const mergeGroup = getDisplayPreferenceMergeGroup(candidate.key);
    const metadata: DisplayPreferenceMemoryMetadata = {
      category: candidate.category,
      key: candidate.key,
      normalizedValue: candidate.value,
      sourceKind: candidate.sourceKind,
      sourceRefKind: candidate.sourceRef.kind,
      mergeGroup,
      mergeStrategy: 'summarize',
    };

    return {
      conversationId,
      layer: 'preference' as const,
      scope: 'conversation' as const,
      content: `display_preference ${candidate.key}=${candidate.value}; user said: ${candidate.rawContent}`,
      summary: `Display preference: ${candidate.key}=${candidate.value}`,
      sourceRefs: [
        {
          kind: candidate.sourceRef.kind,
          sourceId: candidate.sourceRef.sourceId,
          fragment: candidate.sourceRef.fragment ?? null,
          title: 'display_preference',
          metadata: candidate.sourceRef.metadata,
        },
      ],
      mergeGroup,
      mergeStrategy: 'summarize' as const,
      metadata,
    };
  }
}
