import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Observable } from 'rxjs';
import { AgentExecutorService } from '../agent/agent-executor.service';
import { AgentRunService } from '../agent/agent-run.service';
import { OrchestratorService } from '../agent/orchestrator/orchestrator.service';
import { ConversationService } from '../conversation/conversation.service';
import { ResumeContextService } from '../resume/resume-context.service';
import { SendChatMessageDto } from './dto/send-chat-message.dto';
import { SendChatMessageResponseDto } from './dto/chat-response.dto';

export type ChatStreamEventType =
  | 'start'
  | 'route_decision'
  | 'tool_start'
  | 'tool_done'
  | 'assistant_chunk'
  | 'assistant_done'
  | 'done'
  | 'error';

export type ChatSsePayload = {
  event: ChatStreamEventType;
  data: Record<string, unknown>;
};

export type ChatProgressEmitter = (payload: ChatSsePayload) => void;

@Injectable()
export class ChatService {
  constructor(
    private readonly conversationService: ConversationService,
    private readonly agentRunService: AgentRunService,
    private readonly agentExecutorService: AgentExecutorService,
    private readonly orchestratorService: OrchestratorService,
    private readonly resumeContextService: ResumeContextService,
  ) {}

  async sendMessage(userId: string, dto: SendChatMessageDto): Promise<SendChatMessageResponseDto> {
    return this.executeMessageFlow(userId, dto);
  }

  sendMessageStream(
    userId: string,
    dto: SendChatMessageDto,
    requestId = 'unknown',
  ): Observable<ChatSsePayload> {
    return new Observable<ChatSsePayload>((subscriber) => {
      const emit: ChatProgressEmitter = (event) => {
        if (!subscriber.closed) {
          subscriber.next(event);
        }
      };

      this.executeMessageFlow(userId, dto, {
        emit,
        requestId,
      })
        .then((result) => {
          emit(
            this.toSseEvent('done', {
              requestId,
              conversationId: result.conversationId,
              agentRunId: result.agentRunId,
              createdConversation: result.createdConversation,
              routeDecision: result.routeDecision,
            }),
          );
          subscriber.complete();
        })
        .catch((error) => {
          emit(
            this.toSseEvent('error', {
              requestId,
              code: this.normalizeErrorCode(error),
              message: error instanceof Error ? error.message : 'Chat stream execution failed',
            }),
          );
          subscriber.complete();
        });
    });
  }

  private async executeMessageFlow(
    userId: string,
    dto: SendChatMessageDto,
    options?: {
      emit?: ChatProgressEmitter;
      requestId?: string;
    },
  ): Promise<SendChatMessageResponseDto> {
    const startedAt = Date.now();
    const emit = options?.emit ?? (() => {});
    const requestId = options?.requestId ?? 'unknown';

    const emitProgress = (type: ChatStreamEventType, data: Record<string, unknown>) => {
      emit(this.toSseEvent(type, data));
    };

    emitProgress('start', {
      requestId,
      routeDecisionStarted: false,
    });

    let conversationId = dto.conversationId?.trim();
    let createdConversation = false;
    const routeDecision = this.orchestratorService.decideNextAgent(dto.message);

    emitProgress('route_decision', {
      routeDecision,
    });

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

    let assistantMessagePersisted = false;
    try {
      const executionResult = await this.agentExecutorService.execute({
        agentRunId: agentRun.id,
        conversationId,
        messageId: message.id,
        selectedAgent: routeDecision.selectedAgent,
        userMessage: dto.message,
        routeDecision,
        resumeContext,
        toolProgress: {
          onToolStart: (toolName) => {
            emitProgress('tool_start', {
              agentRunId: agentRun.id,
              toolName,
              startedAt: new Date().toISOString(),
            });
          },
          onToolDone: (result) => {
            emitProgress('tool_done', {
              agentRunId: agentRun.id,
              toolName: result.toolName,
              success: result.success,
              latencyMs: result.latencyMs,
              errorCode: result.errorCode,
              errorMessage: result.errorMessage,
            });
          },
        },
      });

      const assistantText = executionResult.assistantText;
      this.emitAssistantTextChunks({
        assistantText,
        emit,
      });

      emitProgress('assistant_done', {
        content: assistantText,
        routeDecision,
        toolCalls: executionResult.toolCalls,
      });

      const assistantMessage = await this.conversationService.appendMessage(userId, conversationId, {
        role: 'assistant',
        content: executionResult.assistantText,
        intent: routeDecision.intent,
        agentName: routeDecision.selectedAgent,
        toolCallSummary: executionResult.toolCalls,
      });
      assistantMessagePersisted = true;

      try {
        await this.resumeContextService.refreshConversationHistorySummary(userId, conversationId);
      } catch {
        // Best-effort memory sync. The chat response itself should still succeed.
      }

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
      if (this.isTimeoutError(error)) {
        await this.agentRunService.markTimeout(agentRun.id, Date.now() - startedAt);
      } else if (assistantMessagePersisted) {
        await this.agentRunService.markPartialSuccess(agentRun.id, Date.now() - startedAt);
      } else {
        await this.agentRunService.markFailed(agentRun.id, error, Date.now() - startedAt);
      }
      throw error;
    }
  }

  private emitAssistantTextChunks(params: {
    assistantText: string;
    emit: ChatProgressEmitter;
  }): void {
    const text = params.assistantText ?? '';
    const step = 80;
    for (let index = 0; index < text.length; index += step) {
      params.emit(
        this.toSseEvent('assistant_chunk', {
          text: text.slice(index, index + step),
        }),
      );
    }
  }

  private toSseEvent(type: ChatStreamEventType, data: Record<string, unknown>): ChatSsePayload {
    return {
      event: type,
      data: {
        ...data,
        ts: new Date().toISOString(),
      },
    };
  }

  private buildConversationTitle(message: string): string {
    const normalized = message.trim().replace(/\s+/g, ' ');
    if (normalized.length === 0) {
      return 'New Conversation';
    }

    return normalized.slice(0, 40);
  }

  private isTimeoutError(error: unknown): boolean {
    return error instanceof ServiceUnavailableException && error.message.includes('TOOL_TIMEOUT');
  }

  private normalizeErrorCode(error: unknown): string {
    if (error && typeof error === 'object') {
      const candidate = (error as { code?: unknown }).code;
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim().slice(0, 80);
      }
      const errMessage = (error as { message?: unknown }).message;
      if (typeof errMessage === 'string' && errMessage.trim().length > 0) {
        return errMessage.trim().slice(0, 80);
      }
    }

    if (error instanceof Error) {
      return error.message.slice(0, 80);
    }

    return 'INTERNAL_ERROR';
  }
}
