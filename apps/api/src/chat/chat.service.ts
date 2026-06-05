import { Injectable } from '@nestjs/common';
import { AgentRunService } from '../agent/agent-run.service';
import { OrchestratorService } from '../agent/orchestrator/orchestrator.service';
import { ConversationService } from '../conversation/conversation.service';
import { SendChatMessageDto } from './dto/send-chat-message.dto';
import { SendChatMessageResponseDto } from './dto/chat-response.dto';

@Injectable()
export class ChatService {
  constructor(
    private readonly conversationService: ConversationService,
    private readonly agentRunService: AgentRunService,
    private readonly orchestratorService: OrchestratorService,
  ) {}

  // 处理聊天入口：必要时创建会话，写入用户消息，并返回最近消息历史和路由结果。
  async sendMessage(userId: string, dto: SendChatMessageDto): Promise<SendChatMessageResponseDto> {
    const startedAt = Date.now();
    let conversationId = dto.conversationId?.trim();
    let createdConversation = false;
    const routeDecision = this.orchestratorService.decideNextAgent(dto.message);

    if (!conversationId) {
      const conversation = await this.conversationService.createConversation(userId, {
        title: dto.title?.trim() || this.buildConversationTitle(dto.message),
      });
      conversationId = conversation.id;
      createdConversation = true;
    }

    const message = await this.conversationService.appendMessage(userId, conversationId, {
      role: 'user',
      content: dto.message,
      intent: routeDecision.intent,
      agentName: routeDecision.selectedAgent,
    });
    const recentMessages = await this.conversationService.listRecentMessages(
      userId,
      conversationId,
      dto.historyLimit,
    );
    const agentRun = await this.agentRunService.createSucceededRun({
      conversationId,
      messageId: message.id,
      selectedAgent: routeDecision.selectedAgent,
      orchestratorDecision: routeDecision,
      latencyMs: Date.now() - startedAt,
    });

    return {
      conversationId,
      agentRunId: agentRun.id,
      createdConversation,
      message,
      routeDecision,
      recentMessages: recentMessages.messages,
    };
  }

  private buildConversationTitle(message: string): string {
    const normalized = message.trim().replace(/\s+/g, ' ');
    if (normalized.length === 0) {
      return 'New Conversation';
    }

    return normalized.slice(0, 40);
  }
}
