/**
 * ChatService —— 聊天（会话）核心服务
 *
 * 职责概览：
 * - sendMessage：同步发送消息（非流式，返回结构化响应）
 * - sendMessageStream：SSE 流式发送（可回放、断线续传）
 * - executeMessageFlow：统一的消息执行编排（路由 → 会话 → Agent 执行 → 落库 → 事件回放）
 * - 将流式事件异步持久化到 observability，并维护 span 追踪信息
 */
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Observable } from 'rxjs';
import { Logger } from '@nestjs/common';
import { AgentExecutorService } from '../agent/agent-executor.service';
import { AgentRunService } from '../agent/agent-run.service';
import { OrchestratorService } from '../agent/orchestrator/orchestrator.service';
import { ConversationService } from '../conversation/conversation.service';
import {
  ContextBudgetManagerService,
  type ContextBudgetLayerLimit,
} from '../memory/context-budget-manager.service';
import { MemoryCaptureService } from '../memory/memory-capture.service';
import type {
  ContextPack,
  ContextPackSummaryBlock,
} from '../memory/context-pack.types';
import type { MemoryLayer } from '../memory/memory.types';
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

/** 聊天流 SSE 事件类型（前后端契约，前端 sse-events.ts 有对应解析） */
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

/** 聊天 SSE 信封消息（带 seq / spanId 元数据） */
export type ChatSsePayload = SseEnvelopeMessageEvent<ChatStreamEventType>;
/** 全局可回放 SSE 会话存储：以 streamKey 为键，支持断线后增量续传 */
const chatStreamSessions = new ReplayableSseSessionStore<ChatStreamEventType>();
/** ContextPack 组装的最大 token 预算 */
const CHAT_CONTEXT_PACK_MAX_TOKENS = 4_000;
/** ContextPack 预留 token（覆盖系统提示词等固定开销） */
const CHAT_CONTEXT_PACK_RESERVED_TOKENS = 500;
/**
 * 按层预算校准：与原固定注入窗口等价（显示偏好 + 约束 + 长期记忆均落在
 * preference/session 层竞争预算，放宽条目数以保证不因层预算误伤）。
 */
const CHAT_CONTEXT_PACK_LAYER_LIMITS: Partial<
  Record<MemoryLayer, Partial<ContextBudgetLayerLimit>>
> = {
  preference: { maxItems: 16, maxTokens: 1_600 },
  session: { maxItems: 9, maxTokens: 2_000 },
};

/** 随 SSE 事件下发给前端的 context pack 结构化载荷 */
interface ChatContextPackPayload {
  contextPackId: string;
  selectedMemoryIds: string[];
  droppedMemoryIds: string[];
  summaryBlocks: ContextPackSummaryBlock[];
  finalPromptPreview: string;
}

/** executeMessageFlow 的完整执行结果（对外响应 DTO + 内部使用的 contextPack） */
interface ExecuteMessageFlowResult extends SendChatMessageResponseDto {
  contextPack: ContextPack;
}

/** 流式事件的持久化上下文（从请求参数中提取，供 observability 落库使用） */
interface ChatStreamPersistenceState {
  transportStreamKey: string;
  conversationId: string | null;
  userId: string | null;
  agentRunId: string | null;
}

/**
 * 聊天服务：串联会话管理、Agent 编排、上下文构建与 SSE 事件回放。
 * 同步接口与流式接口共用 executeMessageFlow，保证两种模式行为一致。
 */
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
    private readonly memoryCaptureService: MemoryCaptureService,
    private readonly observabilityEventStore: ObservabilityEventStore,
  ) {}

  /** 同步发送消息：执行完整流程后返回结构化响应（不含流式事件） */
  async sendMessage(
    userId: string,
    dto: SendChatMessageDto,
  ): Promise<SendChatMessageResponseDto> {
    const result = await this.executeMessageFlow(userId, dto);

    return this.toSendChatMessageResponse(result);
  }

  /**
   * 流式发送消息：建立可回放 SSE 会话并返回 Observable。
   * - 相同 streamKey 已存在会话时，直接订阅既有会话（断线续传）
   * - 异步执行 executeMessageFlow，进度事件实时推送给订阅者
   * - 每个发出的事件同时异步持久化到 observability
   */
  sendMessageStream(
    userId: string,
    dto: SendChatMessageDto,
    requestId = 'unknown',
  ): Observable<ChatSsePayload> {
    // 解析传输层 streamKey 与起始事件序号（支持断线后增量补发）
    const streamKey = this.resolveStreamKey(
      dto.streamKey,
      `chat_stream_${requestId}`,
    );
    const sinceSeq = this.normalizeSinceSeq(dto.sinceSeq);
    const existingSession = chatStreamSessions.get(streamKey);

    if (existingSession) {
      // 会话已存在（如断线重连），直接订阅既有会话的后续事件
      return this.observeSession(existingSession, sinceSeq);
    }

    // 记录本次流的持久化上下文；每条事件发出时触发一次异步落库
    const persistenceState: ChatStreamPersistenceState = {
      transportStreamKey: streamKey,
      conversationId: dto.conversationId?.trim() || null,
      userId,
      agentRunId: null,
    };
    const persistenceTasks = new Set<Promise<void>>();
    const session = chatStreamSessions.create(
      streamKey,
      `pending:${streamKey}`, // 真实 runId 会在 agentRun 创建后通过 bindRunId 绑定
      {
        onEmit: (event) => {
          this.trackPersistenceTask(
            persistenceTasks,
            this.persistChatEvent(event, persistenceState),
          );
        },
      },
    );

    // 异步执行消息流程；进度事件实时转发给 SSE 会话，完成后广播 done
    this.executeMessageFlow(userId, dto, {
      streamKey,
      emitProgress: (type, data, emitOptions) => {
        session.emit(type, data, emitOptions);
      },
      bindRunId: (runId) => {
        session.setRunId(runId); // 绑定真实 runId 到事件信封
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
        // 等待所有持久化任务收口后结束会话
        await this.waitForPersistenceTasks(persistenceTasks);
        session.complete();
      })
      .catch(async (error) => {
        // 失败时广播 error 事件并结束会话
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

  /**
   * 消息执行主流程（同步/流式共用）：
   * 1. 意图路由（Orchestrator）决定使用哪个 Agent
   * 2. 创建/复用会话，落库用户消息，创建 agent run
   * 3. 构建 resume 上下文与 context pack（记忆/token 预算）
   * 4. 执行 Agent，期间通过 emitProgress 上报 span 与工具事件
   * 5. 落库 assistant 消息、标记 run 状态，返回响应所需数据
   */
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
    const startedAt = Date.now(); // 用于计算 run 耗时
    const requestId = options?.requestId ?? 'unknown';
    const emitProgress = options?.emitProgress ?? (() => {}); // 事件上报回调
    // 初始 spanId 基于 requestId 生成；agentRun 创建后替换为真实 runId
    let runSpanId = `${requestId}:run`;
    let stepSpanId = `${requestId}:step:1`;
    let textSpanId = `${requestId}:text:1`;
    // 记录尚未结束的工具 span（同一工具可并发调用，按队列 FIFO 匹配结束事件）
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

    /** 带可选 spanId 的事件上报（spanId 用于前端构建追踪时间线） */
    const emitWithSpan = (
      type: ChatStreamEventType,
      data: Record<string, unknown>,
      spanId?: string,
    ) => {
      emitProgress(type, data, spanId ? { spanId } : undefined);
    };

    /** 登记一次工具调用的开始（生成工具 spanId 并入队） */
    const pushToolSpan = (toolName: string, startedAtIso: string) => {
      toolSpanIndex += 1;
      const spanId = `${runSpanId}:tool:${toolSpanIndex}:${toolName}`;
      const queue = pendingToolSpans.get(toolName) ?? [];
      queue.push({ spanId, startedAt: startedAtIso });
      pendingToolSpans.set(toolName, queue);
      return spanId;
    };

    /** 取出该工具最早未结束的 span；队列为空时兜底生成新 span */
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
    // 1. 意图路由：根据消息内容选择 Specialist Agent
    const routeDecision = this.orchestratorService.decideNextAgent(dto.message);

    // 2a. 首次消息无会话时自动创建会话
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

    // 2b. 落库用户消息（附带路由意图与 Agent 名，供后续上下文读取）
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

    // History Summary 是“已完成历史”的压缩缓存（rebuildable cache, not source of truth）。
    // 这里刻意不在 append 当前用户消息后、读取上下文前刷新：否则本轮请求会读到一个
    // 已包含当前消息 N 的 Summary(N)，与 input 中的 User Message N 重复。
    // 本轮只读取上一轮完成时写入的 Summary(N-1)；若缓存缺失，读取侧会基于
    // “已完成对话”重建，同样不会把正在进行中的用户消息折进摘要。
    // Summary 的新版本在下方“本轮 Agent 完成之后”才重建。

    // 3. Constraint 快通道：规则抽取硬约束并同步写入（零 LLM）。
    // 刻意放在上下文构建之前：本轮新增的约束必须当轮注入，而不是下一轮才生效。
    // 内部已降级为 best-effort（失败仅告警），不会影响主链路。
    await this.memoryCaptureService.captureConstraints({
      conversationId,
      runId: agentRun.id,
      userMessageId: message.id,
      userMessage: dto.message,
    });

    // 3a. 构建简历会话上下文（含显示偏好提取），同时收集注入候选
    // （ContextPack 单装配点：候选即预算裁剪的输入，选出的即注入的）
    const { context: resumeContext, candidates: memoryCandidates } =
      await this.resumeContextService.buildConversationContextWithCandidates(
        userId,
        conversationId,
      );
    // 3b. 在 token 预算内组装 context pack（记忆选择/丢弃/摘要）
    const contextPack = await this.contextBudgetManagerService.buildContextPack(
      {
        conversationId,
        runId: agentRun.id,
        intent: routeDecision.intent,
        maxTokens: CHAT_CONTEXT_PACK_MAX_TOKENS,
        reservedTokens: CHAT_CONTEXT_PACK_RESERVED_TOKENS,
        candidates: memoryCandidates,
        layerLimits: CHAT_CONTEXT_PACK_LAYER_LIMITS,
      },
    );
    const contextPackPayload = this.toContextPackPayload(contextPack);

    // 广播 start：通知前端流开始，附带 context pack 摘要
    emitWithSpan(
      'start',
      {
        requestId,
        routeDecisionStarted: false,
        ...contextPackPayload,
      },
      runSpanId,
    );

    // 广播路由决策结果
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
      // 广播 Agent 步骤开始（携带 prompt 预览，供前端诊断展示）
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

      // 4. 执行 Agent：工具开始/结束事件通过 toolProgress 回调实时广播
      const executionResult = await this.agentExecutorService.execute({
        agentRunId: agentRun.id,
        conversationId,
        messageId: message.id,
        selectedAgent: routeDecision.selectedAgent,
        userMessage: dto.message,
        routeDecision,
        contextPack,
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
            // 匹配并弹出对应工具的开始 span，形成完整的工具调用追踪
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

      // 将最终文本按 80 字符切片，模拟流式输出 assistant_chunk
      const assistantText = executionResult.assistantText;
      this.emitAssistantTextChunks({
        assistantText,
        emitProgress,
        parentSpanId: stepSpanId,
        spanId: textSpanId,
      });

      // 广播完整回复与展示偏好
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

      // 广播步骤成功结束
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

      // 5a. 落库 assistant 回复（含工具调用摘要）
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

      // 本轮 Agent 已完成后，重建 History Summary 缓存为包含本轮的“已完成历史”。
      // 本轮 LLM 请求在上面读取的是上一状态摘要，这里生成的新摘要不会参与本轮请求。
      // 纯缓存重建：失败只影响缓存新鲜度，绝不能影响本轮响应（best-effort）。
      try {
        await this.resumeContextService.refreshConversationHistorySummary(
          userId,
          conversationId,
        );
      } catch {
        // Best-effort cache sync. The chat response itself should still succeed.
      }

      // 记忆捕获（慢通道）：助手回复完成后异步抽取候选并按 5 维评分分流写入。
      // 刻意不 await：抽取会调用 LLM，绝不能阻塞本轮响应（best-effort）。
      void this.memoryCaptureService
        .capture({
          userId,
          conversationId,
          runId: agentRun.id,
          userMessageId: message.id,
          userMessage: dto.message,
          assistantMessage: executionResult.assistantText,
        })
        .catch((error: unknown) => {
          const reason =
            error instanceof Error ? error.message : 'unknown_error';
          this.logger.warn(`Memory capture skipped: ${reason}`);
        });

      // 5b. 标记 run 成功，并读取最近消息历史返回给调用方
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
      // 步骤未正常结束时广播失败事件，保证前端追踪时间线闭合
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

  /** 将整段 assistant 文本按固定步长切片，逐片发出 assistant_chunk 事件（模拟流式输出） */
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

  /** 判断错误是否为工具调用超时（TOOL_TIMEOUT） */
  private isTimeoutError(error: unknown): boolean {
    return (
      error instanceof ServiceUnavailableException &&
      error.message.includes('TOOL_TIMEOUT')
    );
  }
  /** 从任意错误中提取稳定错误码（优先 code 字段，其次 message），最长 80 字符 */

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

  /** 规整断线续传的起始序号：非有限值取 0，向下取整且不小于 0 */
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
  private toContextPackPayload(
    contextPack: ContextPack,
  ): ChatContextPackPayload {
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
