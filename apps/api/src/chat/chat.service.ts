import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Observable } from 'rxjs';
import { Logger } from '@nestjs/common';
import { AgentExecutorService } from '../agent/agent-executor.service';
import { AgentRunService } from '../agent/agent-run.service';
import { OrchestratorService } from '../agent/orchestrator/orchestrator.service';
import { ConversationService } from '../conversation/conversation.service';
import { ContextBudgetManagerService } from '../memory/context-budget-manager.service';
import type {
  ContextPack,
  ContextPackSummaryBlock,
} from '../memory/context-pack.types';
import { ResumeContextService } from '../resume/resume-context.service';
import {
  ReplayableSseSession,
  ReplayableSseSessionStore,
} from '../common/sse-session';
import {
  ObservabilityEventStore,
  type ObservabilityJsonObject,
  type ObservabilityJsonValue,
} from '../observability';
import { SendChatMessageDto } from './dto/send-chat-message.dto';
import { SendChatMessageResponseDto } from './dto/chat-response.dto';
import type { SseEnvelopeMessageEvent } from '../common/sse';
import type { DisplayPreferenceContextItem } from '../resume/resume-context.service';

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
const CHAT_CONTEXT_PACK_MAX_TOKENS = 4_000;
const CHAT_CONTEXT_PACK_RESERVED_TOKENS = 500;

interface ChatContextPackPayload {
  contextPackId: string;
  selectedMemoryIds: string[];
  droppedMemoryIds: string[];
  summaryBlocks: ContextPackSummaryBlock[];
  finalPromptPreview: string;
}

interface ExecuteMessageFlowResult extends SendChatMessageResponseDto {
  contextPack: ContextPack;
}

interface ChatStreamPersistenceState {
  transportStreamKey: string;
  conversationId: string | null;
  userId: string | null;
  agentRunId: string | null;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly agentRunService: AgentRunService,
    private readonly agentExecutorService: AgentExecutorService,
    private readonly orchestratorService: OrchestratorService,
    private readonly contextBudgetManagerService: ContextBudgetManagerService,
    private readonly resumeContextService: ResumeContextService,
    private readonly observabilityEventStore: ObservabilityEventStore,
  ) {}

  async sendMessage(
    userId: string,
    dto: SendChatMessageDto,
  ): Promise<SendChatMessageResponseDto> {
    const result = await this.executeMessageFlow(userId, dto);

    return this.toSendChatMessageResponse(result);
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

    const persistenceState: ChatStreamPersistenceState = {
      transportStreamKey: streamKey,
      conversationId: dto.conversationId?.trim() || null,
      userId,
      agentRunId: null,
    };
    const persistenceTasks = new Set<Promise<void>>();
    const session = chatStreamSessions.create(streamKey, `pending:${streamKey}`, {
      onEmit: (event) => {
        this.trackPersistenceTask(
          persistenceTasks,
          this.persistChatEvent(event, persistenceState),
        );
      },
    });

    this.executeMessageFlow(userId, dto, {
      streamKey,
      emitProgress: (type, data, emitOptions) => {
        session.emit(type, data, emitOptions);
      },
      bindRunId: (runId) => {
        session.setRunId(runId);
      },
      requestId,
      persistenceState,
    })
      .then(async (result) => {
        session.emit('done', {
          requestId,
          conversationId: result.conversationId,
          agentRunId: result.agentRunId,
          createdConversation: result.createdConversation,
          routeDecision: result.routeDecision,
          displayPreferences: result.displayPreferences,
          ...(result.contextPack
            ? this.toContextPackPayload(result.contextPack)
            : {}),
        });
        await this.waitForPersistenceTasks(persistenceTasks);
        session.complete();
      })
      .catch(async (error) => {
        session.emit('error', {
          requestId,
          code: this.normalizeErrorCode(error),
          message:
            error instanceof Error
              ? error.message
              : 'Chat stream execution failed',
        });
        await this.waitForPersistenceTasks(persistenceTasks);
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
      bindRunId?: (runId: string) => void;
      requestId?: string;
      persistenceState?: ChatStreamPersistenceState;
    },
  ): Promise<ExecuteMessageFlowResult> {
    const startedAt = Date.now();
    const requestId = options?.requestId ?? 'unknown';
    const emitProgress = options?.emitProgress ?? (() => {});
    let runSpanId = `${requestId}:run`;
    let stepSpanId = `${requestId}:step:1`;
    let textSpanId = `${requestId}:text:1`;
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

    let conversationId = dto.conversationId?.trim();
    let createdConversation = false;
    const routeDecision = this.orchestratorService.decideNextAgent(dto.message);

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
    if (options?.persistenceState) {
      options.persistenceState.conversationId = conversationId;
    }

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
    options?.bindRunId?.(agentRun.id);
    if (options?.persistenceState) {
      options.persistenceState.agentRunId = agentRun.id;
    }
    runSpanId = `${agentRun.id}:run`;
    stepSpanId = `${agentRun.id}:step:1`;
    textSpanId = `${agentRun.id}:text:1`;

    try {
      await this.resumeContextService.refreshConversationHistorySummary(
        userId,
        conversationId,
      );
    } catch {
      // Best-effort sync so the current turn can read the latest history when available.
    }

    const resumeContext =
      await this.resumeContextService.buildConversationContext(
        userId,
        conversationId,
      );
    const contextPack = await this.contextBudgetManagerService.buildContextPack({
      conversationId,
      runId: agentRun.id,
      intent: routeDecision.intent,
      maxTokens: CHAT_CONTEXT_PACK_MAX_TOKENS,
      reservedTokens: CHAT_CONTEXT_PACK_RESERVED_TOKENS,
    });
    const contextPackPayload = this.toContextPackPayload(contextPack);

    emitWithSpan(
      'start',
      {
        requestId,
        routeDecisionStarted: false,
        ...contextPackPayload,
      },
      runSpanId,
    );

    emitWithSpan(
      'route_decision',
      {
        routeDecision,
        ...contextPackPayload,
      },
      runSpanId,
    );

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
          ...this.cloneContextPackPayload(contextPackPayload),
          promptPreview: contextPackPayload.finalPromptPreview,
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
          displayPreferences: this.toDisplayPreferencePayload(
            resumeContext.displayPreferences,
          ),
          ...contextPackPayload,
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
          ...this.cloneContextPackPayload(contextPackPayload),
          promptPreview: contextPackPayload.finalPromptPreview,
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
        displayPreferences: this.toDisplayPreferencePayload(
          resumeContext.displayPreferences,
        ),
        contextPack,
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
            ...this.cloneContextPackPayload(contextPackPayload),
            promptPreview: contextPackPayload.finalPromptPreview,
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

  private toDisplayPreferencePayload(
    displayPreferences?: DisplayPreferenceContextItem[],
  ): DisplayPreferenceContextItem[] {
    return [...(displayPreferences ?? [])];
  }

  /**
   * 跟踪异步持久化任务，并在失败时降级为日志告警而不影响主链路。
   */
  private trackPersistenceTask(
    target: Set<Promise<void>>,
    task: Promise<void>,
  ): void {
    const trackedTask = task.catch((error: unknown) => {
      this.logger.warn(
        `Failed to persist observability event: ${this.normalizeErrorCode(error)}`,
      );
    });
    target.add(trackedTask);
    void trackedTask.finally(() => {
      target.delete(trackedTask);
    });
  }

  /**
   * 在流式请求结束前等待本次已触发的持久化任务收口。
   */
  private async waitForPersistenceTasks(
    target: Set<Promise<void>>,
  ): Promise<void> {
    if (target.size === 0) {
      return;
    }

    await Promise.allSettled([...target]);
  }

  /**
   * 将聊天流事件写入 observability 事件日志。
   */
  private async persistChatEvent(
    event: ChatSsePayload,
    state: ChatStreamPersistenceState,
  ): Promise<void> {
    await this.observabilityEventStore.save({
      eventId: event.data.id,
      seq: event.data.seq,
      runId: event.data.runId,
      conversationId: state.conversationId,
      userId: state.userId,
      agentRunId: state.agentRunId,
      spanId: event.data.spanId ?? null,
      type: event.data.type,
      status: 'normal',
      ts: new Date(event.data.ts),
      payload: this.toObservabilityJsonObject({
        ...event.data.payload,
        transportStreamKey: state.transportStreamKey,
      }),
    });
  }

  /**
   * 将内部执行结果投影为对外响应 DTO，避免把调试字段直接暴露到普通接口响应。
   */
  private toSendChatMessageResponse(
    result: ExecuteMessageFlowResult,
  ): SendChatMessageResponseDto {
    return {
      conversationId: result.conversationId,
      agentRunId: result.agentRunId,
      createdConversation: result.createdConversation,
      message: result.message,
      assistantMessage: result.assistantMessage,
      routeDecision: result.routeDecision,
      displayPreferences: result.displayPreferences,
      recentMessages: result.recentMessages,
    };
  }

  /**
   * 将 context pack 投影为可安全挂到 SSE 事件中的结构化载荷。
   */
  private toContextPackPayload(contextPack: ContextPack): ChatContextPackPayload {
    return {
      contextPackId: contextPack.packId,
      selectedMemoryIds: [...contextPack.selectedMemoryIds],
      droppedMemoryIds: [...contextPack.droppedMemoryIds],
      summaryBlocks: contextPack.summaryBlocks.map((block) => ({
        ...block,
        memoryIds: [...block.memoryIds],
        metadata: block.metadata ? { ...block.metadata } : undefined,
      })),
      finalPromptPreview: contextPack.finalPromptPreview,
    };
  }

  /**
   * 深拷贝 SSE context pack 载荷，避免事件间共享数组/对象引用。
   */
  private cloneContextPackPayload(
    payload: ChatContextPackPayload,
  ): ChatContextPackPayload {
    return {
      contextPackId: payload.contextPackId,
      selectedMemoryIds: [...payload.selectedMemoryIds],
      droppedMemoryIds: [...payload.droppedMemoryIds],
      summaryBlocks: payload.summaryBlocks.map((block) => ({
        ...block,
        memoryIds: [...block.memoryIds],
        metadata: block.metadata ? { ...block.metadata } : undefined,
      })),
      finalPromptPreview: payload.finalPromptPreview,
    };
  }

  /**
   * 将 SSE payload 规整为可安全入库的 JSON 对象。
   */
  private toObservabilityJsonObject(
    payload: Record<string, unknown>,
  ): ObservabilityJsonObject {
    const normalized: ObservabilityJsonObject = {};

    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === 'undefined') {
        continue;
      }

      normalized[key] = this.toObservabilityJsonValue(value);
    }

    return normalized;
  }

  /**
   * 递归规整任意 payload 值，确保满足 observability JSON 边界。
   */
  private toObservabilityJsonValue(value: unknown): ObservabilityJsonValue {
    if (value === null) {
      return null;
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    switch (typeof value) {
      case 'string':
        return value;
      case 'number':
        return Number.isFinite(value) ? value : null;
      case 'boolean':
        return value;
      case 'object':
        if (Array.isArray(value)) {
          return value.map((item) => this.toObservabilityJsonValue(item));
        }

        return this.toObservabilityJsonObject(value as Record<string, unknown>);
      default:
        return null;
    }
  }
}
