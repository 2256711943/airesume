import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ResumeContextService } from '../resume/resume-context.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { AppendConversationMessageDto } from './dto/append-conversation-message.dto';
import { SetConversationResumeContextDto } from './dto/set-conversation-resume-context.dto';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly resumeContextService: ResumeContextService,
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
    await this.prisma.conversationMemorySlot.upsert({
      where: {
        conversationId_slotKey: {
          conversationId,
          slotKey: 'selected_resume_item_ids',
        },
      },
      create: {
        conversationId,
        slotKey: 'selected_resume_item_ids',
        slotValue: resumeLibraryItemIds,
      },
      update: {
        slotValue: resumeLibraryItemIds,
      },
    });

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

  private normalizeResumeIds(ids: string[]): string[] {
    return Array.from(
      new Set(ids.map((item) => item.trim()).filter((item) => item.length > 0)),
    );
  }
}
