import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { AppendConversationMessageDto } from './dto/append-conversation-message.dto';
import type {
  ConversationDto,
  ConversationListResponseDto,
  ConversationMessageDto,
  ConversationMessageListResponseDto,
} from './dto/conversation-response.dto';

@Injectable()
export class ConversationService {
  constructor(private readonly prisma: PrismaService) {}

  // 创建会话基础记录，供后续多轮对话继续追加消息。
  async createConversation(userId: string, dto: CreateConversationDto): Promise<ConversationDto> {
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
  async listConversations(userId: string): Promise<ConversationListResponseDto> {
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
      messages: messages.reverse().map((item) => this.toConversationMessageDto(item)),
    };
  }

  private async ensureConversationOwner(userId: string, conversationId: string): Promise<void> {
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
    createdAt: Date;
  }): ConversationMessageDto {
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      intent: message.intent,
      agentName: message.agentName,
      createdAt: message.createdAt.toISOString(),
    };
  }
}
