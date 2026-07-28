import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Observable } from 'rxjs';
import { AgentExecutorService } from '../agent/agent-executor.service';
import { AgentRunService } from '../agent/agent-run.service';
import { OrchestratorService } from '../agent/orchestrator/orchestrator.service';
import { ConversationService } from '../conversation/conversation.service';
import { ResumeContextService } from '../resume/resume-context.service';
import {
  ReplayableSseSession,
  ReplayableSseSessionStore,
} from '../common/sse-session';
import { SendChatMessageDto } from './dto/send-chat-message.dto';
import { SendChatMessageResponseDto } from './dto/chat-response.dto';
import type { SseEnvelopeMessageEvent } from '../common/sse';

export type ChatStreamEventType =
  | 'start'
  | 'route_decision'
  | 'tool_start'
  | 'tool_done'
  | 'agent.step.started'
  | 'agent.step.finished'
  | 'tool.call.started'
  | 'tool.call.finished'
  | 'assistant_chunk'
  | 'assistant_done'
  | 'done'
  | 'error';

export type ChatSsePayload = SseEnvelopeMessageEvent<ChatStreamEventType>;
const chatStreamSessions = new ReplayableSseSessionStore<ChatStreamEventType>();

@Injectable()
export class ChatService {
  constructor(
    private readonly conversationService: ConversationService,
    private readonly agentRunService: AgentRunService,
    private readonly agentExecutorService: AgentExecutorService,
    private readonly orchestratorService: OrchestratorService,
    private readonly resumeContextService: ResumeContextService,
  ) {}

  async sendMessage(
    userId: string,
    dto: SendChatMessageDto,
  ): Promise<SendChatMessageResponseDto> {
    return this.executeMessageFlow(userId, dto);
  }

  sendMessageStream(
    userId: string,
    dto: SendChatMessageDto,
    requestId = 'unknown',
  ): Observable<ChatSsePayload> {
    const streamKey = this.resolveStreamKey(
      dto.streamKey,
      `chat_stream_${requestId}`,
    );
    const sinceSeq = this.normalizeSinceSeq(dto.sinceSeq);
    const existingSession = chatStreamSessions.get(streamKey);

    if (existingSession) {
      return this.observeSession(existingSession, sinceSeq);
    }

    const session = chatStreamSessions.create(streamKey, streamKey);

    this.executeMessageFlow(userId, dto, {
      streamKey,
      emitProgress: (type, data, emitOptions) => {
        session.emit(type, data, emitOptions);
      },
      requestId,
    })
      .then((result) => {
        session.emit('done', {
          requestId,
          conversationId: result.conversationId,
          agentRunId: result.agentRunId,
          createdConversation: result.createdConversation,
          routeDecision: result.routeDecision,
        });
        session.complete();
      })
      .catch((error) => {
        session.emit('error', {
          requestId,
          code: this.normalizeErrorCode(error),
          message:
            error instanceof Error
              ? error.message
              : 'Chat stream execution failed',
        });
        session.complete();
      });

    return this.observeSession(session, sinceSeq);
  }

  private async executeMessageFlow(
    userId: string,
    dto: SendChatMessageDto,
    options?: {
      streamKey?: string;
      emitProgress?: (
        type: ChatStreamEventType,
        data: Record<string, unknown>,
        options?: {
          spanId?: string;
        },
      ) => void;
      requestId?: string;
    },
  ): Promise<SendChatMessageResponseDto> {
    const startedAt = Date.now();
    const requestId = options?.requestId ?? 'unknown';
    const emitProgress = options?.emitProgress ?? (() => {});
    const runSpanId = options?.streamKey ?? requestId;
    const stepSpanId = `${runSpanId}:step:1`;
    const textSpanId = `${runSpanId}:text:1`;
    const pendingToolSpans = new Map<
      string,
      Array<{
        spanId: string;
        startedAt: string;
      }>
    >();
    let toolSpanIndex = 0;
    let stepFinished = false;
    let stepStartedAt = '';

    const emitWithSpan = (
      type: ChatStreamEventType,
      data: Record<string, unknown>,
      spanId?: string,
    ) => {
      emitProgress(type, data, spanId ? { spanId } : undefined);
    };

    const pushToolSpan = (toolName: string, startedAtIso: string) => {
      toolSpanIndex += 1;
      const spanId = `${runSpanId}:tool:${toolSpanIndex}:${toolName}`;
      const queue = pendingToolSpans.get(toolName) ?? [];
      queue.push({ spanId, startedAt: startedAtIso });
      pendingToolSpans.set(toolName, queue);
      return spanId;
    };

    const popToolSpan = (toolName: string) => {
      const queue = pendingToolSpans.get(toolName);
      const next = queue?.shift();
      if (queue && queue.length === 0) {
        pendingToolSpans.delete(toolName);
      }

      if (next) {
        return next;
      }

      const fallbackStartedAt = new Date().toISOString();
      toolSpanIndex += 1;
      return {
        spanId: `${runSpanId}:tool:${toolSpanIndex}:${toolName}`,
        startedAt: fallbackStartedAt,
      };
    };

    emitWithSpan(
      'start',
      {
        requestId,
        routeDecisionStarted: false,
      },
      runSpanId,
    );

    let conversationId = dto.conversationId?.trim();
    let createdConversation = false;
    const routeDecision = this.orchestratorService.decideNextAgent(dto.message);

    emitWithSpan(
      'route_decision',
      {
        routeDecision,
      },
      runSpanId,
    );

    if (!conversationId) {
      const conversation = await this.conversationService.createConversation(
        userId,
        {
          title: dto.title?.trim() || this.buildConversationTitle(dto.message),
        },
      );
      conversationId = conversation.id;
      createdConversation = true;
    }

    const resumeContext =
      await this.resumeContextService.buildConversationContext(
        userId,
        conversationId,
      );

    const message = await this.conversationService.appendMessage(
      userId,
      conversationId,
      {
        role: 'user',
        content: dto.message,
        intent: routeDecision.intent,
        agentName: routeDecision.selectedAgent,
      },
    );

    const agentRun = await this.agentRunService.createRunningRun({
      conversationId,
      messageId: message.id,
      selectedAgent: routeDecision.selectedAgent,
      orchestratorDecision: routeDecision,
    });

    let assistantMessagePersisted = false;
    try {
      stepStartedAt = new Date().toISOString();
      emitWithSpan(
        'agent.step.started',
        {
          agentRunId: agentRun.id,
          name: routeDecision.selectedAgent,
          parentSpanId: runSpanId,
          startedAt: stepStartedAt,
          status: 'running',
        },
        stepSpanId,
      );

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
            const startedAtIso = new Date().toISOString();
            const toolSpanId = pushToolSpan(toolName, startedAtIso);
            emitWithSpan(
              'tool.call.started',
              {
                agentRunId: agentRun.id,
                toolName,
                name: toolName,
                parentSpanId: stepSpanId,
                startedAt: startedAtIso,
                status: 'running',
              },
              toolSpanId,
            );
          },
          onToolDone: (result) => {
            const finishedAt = new Date().toISOString();
            const toolSpan = popToolSpan(result.toolName);
            emitWithSpan(
              'tool.call.finished',
              {
                agentRunId: agentRun.id,
                toolName: result.toolName,
                name: result.toolName,
                parentSpanId: stepSpanId,
                success: result.success,
                latencyMs: result.latencyMs,
                errorCode: result.errorCode,
                errorMessage: result.errorMessage,
                startedAt: toolSpan.startedAt,
                finishedAt,
                status: result.success ? 'succeeded' : 'failed',
              },
              toolSpan.spanId,
            );
          },
        },
      });

      const assistantText = executionResult.assistantText;
      this.emitAssistantTextChunks({
        assistantText,
        emitProgress,
        parentSpanId: stepSpanId,
        spanId: textSpanId,
      });

      emitWithSpan(
        'assistant_done',
        {
          content: assistantText,
          routeDecision,
          toolCalls: executionResult.toolCalls,
          parentSpanId: stepSpanId,
        },
        textSpanId,
      );

      emitWithSpan(
        'agent.step.finished',
        {
          agentRunId: agentRun.id,
          name: routeDecision.selectedAgent,
          parentSpanId: runSpanId,
          startedAt: stepStartedAt,
          finishedAt: new Date().toISOString(),
          status: 'succeeded',
        },
        stepSpanId,
      );
      stepFinished = true;

      const assistantMessage = await this.conversationService.appendMessage(
        userId,
        conversationId,
        {
          role: 'assistant',
          content: executionResult.assistantText,
          intent: routeDecision.intent,
          agentName: routeDecision.selectedAgent,
          toolCallSummary: executionResult.toolCalls,
        },
      );
      assistantMessagePersisted = true;

      try {
        await this.resumeContextService.refreshConversationHistorySummary(
          userId,
          conversationId,
        );
      } catch {
        // Best-effort memory sync. The chat response itself should still succeed.
      }

      await this.agentRunService.markSucceeded(
        agentRun.id,
        Date.now() - startedAt,
      );

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
      if (!stepFinished) {
        emitWithSpan(
          'agent.step.finished',
          {
            agentRunId: agentRun.id,
            name: routeDecision.selectedAgent,
            parentSpanId: runSpanId,
            startedAt: stepStartedAt,
            finishedAt: new Date().toISOString(),
            status: 'failed',
            errorCode: this.normalizeErrorCode(error),
            errorMessage:
              error instanceof Error
                ? error.message
                : 'Chat stream execution failed',
          },
          stepSpanId,
        );
      }

      if (this.isTimeoutError(error)) {
        await this.agentRunService.markTimeout(
          agentRun.id,
          Date.now() - startedAt,
        );
      } else if (assistantMessagePersisted) {
        await this.agentRunService.markPartialSuccess(
          agentRun.id,
          Date.now() - startedAt,
        );
      } else {
        await this.agentRunService.markFailed(
          agentRun.id,
          error,
          Date.now() - startedAt,
        );
      }
      throw error;
    }
  }

  private emitAssistantTextChunks(params: {
    assistantText: string;
    emitProgress: (
      type: ChatStreamEventType,
      data: Record<string, unknown>,
      options?: {
        spanId?: string;
      },
    ) => void;
    parentSpanId?: string;
    spanId?: string;
  }): void {
    const text = params.assistantText ?? '';
    const step = 80;
    for (let index = 0; index < text.length; index += step) {
      params.emitProgress(
        'assistant_chunk',
        {
          text: text.slice(index, index + step),
          parentSpanId: params.parentSpanId,
        },
        params.spanId ? { spanId: params.spanId } : undefined,
      );
    }
  }

  private buildConversationTitle(message: string): string {
    const normalized = message.trim().replace(/\s+/g, ' ');
    if (normalized.length === 0) {
      return 'New Conversation';
    }

    return normalized.slice(0, 40);
  }

  private isTimeoutError(error: unknown): boolean {
    return (
      error instanceof ServiceUnavailableException &&
      error.message.includes('TOOL_TIMEOUT')
    );
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

  private observeSession(
    session: ReplayableSseSession<ChatStreamEventType>,
    sinceSeq: number,
  ): Observable<ChatSsePayload> {
    return new Observable<ChatSsePayload>((subscriber) =>
      session.subscribe(
        {
          next: (event) => subscriber.next(event),
          complete: () => subscriber.complete(),
        },
        sinceSeq,
      ),
    );
  }

  private resolveStreamKey(
    streamKey: string | undefined,
    fallback: string,
  ): string {
    const normalized = streamKey?.trim();
    return normalized && normalized.length > 0 ? normalized : fallback;
  }

  private normalizeSinceSeq(sinceSeq: number | undefined): number {
    if (!Number.isFinite(sinceSeq)) {
      return 0;
    }

    return Math.max(0, Math.floor(sinceSeq ?? 0));
  }
}
