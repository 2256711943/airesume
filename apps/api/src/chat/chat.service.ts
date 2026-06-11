import { Injectable } from '@nestjs/common';
import { AgentExecutorService } from '../agent/agent-executor.service';
import { AgentRunService } from '../agent/agent-run.service';
import { OrchestratorService } from '../agent/orchestrator/orchestrator.service';
import { ConversationService } from '../conversation/conversation.service';
import { ResumeContextService } from '../resume/resume-context.service';
import { SendChatMessageDto } from './dto/send-chat-message.dto';
import { SendChatMessageResponseDto } from './dto/chat-response.dto';

@Injectable()
export class ChatService {
  constructor(
    private readonly conversationService: ConversationService,
    private readonly agentRunService: AgentRunService,
    private readonly agentExecutorService: AgentExecutorService,
    private readonly orchestratorService: OrchestratorService,
    private readonly resumeContextService: ResumeContextService,
  ) {}

  // 处理聊天入口：必要时创建会话，写入用户消息，注入简历上下文，再返回最近消息和路由结果。
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

    const resumeContext = await this.resumeContextService.buildConversationContext(userId, conversationId);

    const message = await this.conversationService.appendMessage(userId, conversationId, {
      role: 'user',
      content: dto.message,
      intent: routeDecision.intent,
      agentName: routeDecision.selectedAgent,
    });

    const agentRun = await this.agentRunService.createRunningRun({
      conversationId,
      messageId: message.id,
      selectedAgent: routeDecision.selectedAgent,
      orchestratorDecision: routeDecision,
    });

    try {
      const executionResult = await this.agentExecutorService.execute({
        agentRunId: agentRun.id,
        conversationId,
        messageId: message.id,
        selectedAgent: routeDecision.selectedAgent,
        userMessage: dto.message,
        routeDecision,
        resumeContext,
      });

      const assistantMessage = await this.conversationService.appendMessage(userId, conversationId, {
        role: 'assistant',
        content: executionResult.assistantText,
        intent: routeDecision.intent,
        agentName: routeDecision.selectedAgent,
      });

      await this.agentRunService.markSucceeded(agentRun.id, Date.now() - startedAt);

      const recentMessages = await this.conversationService.listRecentMessages(
        userId,
        conversationId,
        dto.historyLimit,
      );

      return {
        conversationId,
        agentRunId: agentRun.id,
        createdConversation,
        message,
        assistantMessage,
        routeDecision,
        recentMessages: recentMessages.messages,
      };
    } catch (error) {
      await this.agentRunService.markFailed(agentRun.id, error, Date.now() - startedAt);
      throw error;
    }
  }

  private buildConversationTitle(message: string): string {
    const normalized = message.trim().replace(/\s+/g, ' ');
    if (normalized.length === 0) {
      return 'New Conversation';
    }

    return normalized.slice(0, 40);
  }
}
