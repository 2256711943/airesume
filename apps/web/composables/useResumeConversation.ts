/**
 * useResumeConversation —— 会话（聊天）核心组合式函数
 *
 * 职责概览：
 * - 维护聊天消息列表（chatMessages）与输入框（chatInput）
 * - 调用后端 POST /chat/message（同步）与 POST /chat/message/stream（SSE 流式）
 * - 借助 useSseSupervisor（连接/重连）+ useSseRenderEngine（打字机渲染）消费流式事件
 * - 同步表单上下文（system 消息）、管理会话 ID、维护链路追踪（trace / span）
 */
import { computed, ref, type Ref } from "vue";

import {
  buildAllVariantsMarkdown,
  buildChatTrace,
  buildCurrentChatTitle,
  buildFormSummaryLines,
  buildSystemContextMessage,
  createChatMessageId,
  defaultRouteDecision,
  getInitialChatMessages,
  type ApiEnvelope,
  type ChatMessage,
  type ChatResponseData,
  type ChatRole,
  type ChatTraceToolSpan,
  type ConversationToolCallSummary,
  type ConversationDto,
  type ResumeFormState,
} from "../utils/resume";
import { API_BASE_URL } from "../utils/api";
import { getStableMarkdownSlice } from "../utils/markdown-stream";
import {
  getChatSseEventRenderPhase,
  isChatSseEventName,
  type ChatSseEvent,
  type ChatSseEventName,
} from "../utils/sse-events";
import {
  consumeSseEventEnvelopeStream,
  SseStreamDisconnectedError,
  type SseEventEnvelope,
} from "../utils/sse";
import { useSpanStore, type Span } from "./useSpanStore";
import {
  useObservabilityDiagnostics,
  type ObservabilityDiagnosticIssue,
  type ObservabilityDiagnosticResponse,
} from "./useObservabilityDiagnostics";
import { useApiFetch } from "./useApiFetch";
import {
  createTypewriterFrameSelector,
  useSseRenderEngine,
} from "./useSseRenderEngine";
import { useSseSupervisor } from "./useSseSupervisor";
import type {
  SseMachineStateSnapshot,
  SseMachineStateValue,
} from "./useSseMachine";
/** 打字机效果渲染速率：每秒输出的字符数 */
const CHAT_TYPEWRITER_CHARS_PER_SECOND = 120;
/** 流式生成占位文案：收到首个 assistant_chunk 后会被真实内容替换 */
const CHAT_STREAMING_PLACEHOLDERS = new Set(["正在生成...", "正在整理回复..."]);
/** 实时诊断工具超时阈值（毫秒）：与后端规则引擎默认参数保持一致 */
const DIAGNOSTIC_TOOL_TIMEOUT_MS = 60_000;
/** 实时诊断流空闲阈值（毫秒）：无终态事件且超过该时长视为运行未闭环 */
const DIAGNOSTIC_STREAM_IDLE_MS = 60_000;
/** SSE 终态事件集合：到达任一终态即视为本次流式运行闭环 */
const CHAT_TERMINAL_SSE_EVENTS = new Set<ChatSseEventName>([
  "done",
  "error",
  "canceled",
]);
/** 判定某 SSE 事件是否为终态事件（供流消费与诊断拉取共用） */
const isChatTerminalSseEvent = (type: ChatSseEventName): boolean =>
  CHAT_TERMINAL_SSE_EVENTS.has(type);

/**
 * 判定消息内容是否已包含真实的流式产出。
 * 占位文案与空内容都不算，据此区分"完整错误信息"与"部分内容被中断"。
 */
const hasStreamedPartialContent = (content: string): boolean =>
  content.trim().length > 0 && !CHAT_STREAMING_PLACEHOLDERS.has(content);

/**
 * 终态兜底校验：对服务端权威内容做一次全量解析。
 * 若仍检测到未闭合结构（围栏 / 表格），仅打点记录，不修改内容。
 */
const verifyFinalMarkdown = (messageId: string, content: string): void => {
  const normalized =
    content.endsWith("\n") || content.endsWith("\r") ? content : `${content}\n`;
  const { diagnostics } = getStableMarkdownSlice(normalized);

  if (diagnostics.fenceOpen || diagnostics.tablePending) {
    console.warn("[chat-markdown] 终态内容仍存在未闭合结构", {
      messageId,
      diagnostics,
    });
  }
};

type ApiFetch = typeof useApiFetch;
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** 组合式函数入参：表单状态、鉴权、UI 状态回调，以及可注入的测试替身 */
interface UseResumeConversationOptions {
  form: ResumeFormState;
  token: Ref<string | null>;
  clearAuth: () => void;
  errorMessage: Ref<string>;
  statusMessage: Ref<string>;
  getVariantSnapshot?: () => string;
  apiFetch?: ApiFetch;
  fetchFn?: FetchFn;
  now?: () => string;
  createId?: (role: string) => string;
}

/** 更新聊天消息的可选字段（局部更新，仅更新提供的字段） */
interface UpdateChatMessagePayload {
  content?: string;
  streaming?: boolean;
  trace?: ChatMessage["trace"];
}

/** 渲染引擎的输入项：由 SSE 信封（envelope）转换而来 */
interface ChatRenderIngressItem {
  assistantMessageId: string;
  envelope: SseEventEnvelope<ChatSseEventName>;
}

/** 渲染引擎的帧项：event 为普通事件帧，text 为可打字机输出的文本帧 */
interface ChatRenderFrameItem {
  kind: "event" | "text";
  assistantMessageId: string;
  event: ChatSseEvent;
}

/** 可重置的 SSE 状态机终态：发起新一轮会话前需将状态机恢复为初始态 */
const RESETTABLE_MACHINE_STATES = new Set<SseMachineStateValue>([
  "done",
  "error",
  "canceled",
]);
/** 可取消的 SSE 状态机状态：组件卸载时应主动取消进行中的连接 */
const CANCELABLE_MACHINE_STATES = new Set<SseMachineStateValue>([
  "connecting",
  "streaming",
  "paused",
  "retrying",
]);

/** 生成本次流式会话的传输层 streamKey，用于断线重连后找回同一会话 */
function createChatStreamKey(): string {
  return `chat_stream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getSpanMetaString(span: Span, key: string): string | undefined {
  const value = span.meta[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function getSpanMetaNumber(span: Span, key: string): number | undefined {
  const value = span.meta[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function getSpanMetaBoolean(span: Span, key: string): boolean | undefined {
  const value = span.meta[key];
  return typeof value === "boolean" ? value : undefined;
}

/** 将内部 span 转换为界面展示用的工具调用追踪（tool trace）结构 */
function toTraceToolSpan(span: Span): ChatTraceToolSpan {
  return {
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: getSpanMetaString(span, "toolName") ?? span.name,
    status: span.status,
    startTs: span.startTs,
    endTs: span.endTs,
    latencyMs: getSpanMetaNumber(span, "latencyMs"),
    success: getSpanMetaBoolean(span, "success"),
    errorCode: getSpanMetaString(span, "errorCode"),
    errorMessage: getSpanMetaString(span, "errorMessage"),
  };
}

/** 同步（非流式）模式下，依据接口返回的工具调用汇总构造工具追踪 */
function buildSyncToolSpans(
  agentRunId: string,
  toolCalls: readonly ConversationToolCallSummary[] | null | undefined,
  finishedAt: string,
): ChatTraceToolSpan[] {
  return (toolCalls ?? []).map((toolCall, index) => ({
    spanId: `sync:${agentRunId}:tool:${index + 1}:${toolCall.toolName}`,
    parentSpanId: `sync:${agentRunId}:run`,
    name: toolCall.toolName,
    status: toolCall.success ? "succeeded" : "failed",
    startTs: finishedAt,
    endTs: finishedAt,
    latencyMs: toolCall.latencyMs,
    success: toolCall.success,
    errorCode: toolCall.errorCode,
    errorMessage: toolCall.errorMessage,
  }));
}

export function useResumeConversation(options: UseResumeConversationOptions) {
  // 运行期依赖（默认实现，可在测试中替换）
  const apiFetch = options.apiFetch ?? useApiFetch;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const now = options.now ?? (() => new Date().toISOString());
  const createId =
    options.createId ?? ((role: string) => createChatMessageId(role));

  // ---- 会话状态 ----
  const chatMessages = ref<ChatMessage[]>(getInitialChatMessages()); // 消息列表（渲染数据源）
  const chatInput = ref(""); // 输入框内容
  const conversationId = ref(""); // 当前会话 ID（首次发送时懒创建）
  const lastSyncedSystemContext = ref(""); // 已同步的表单上下文摘要（避免重复写入 system 消息）
  const activeAssistantMessageId = ref(""); // 当前正在流式生成的 assistant 消息 ID
  const syncRequestPending = ref(false); // 同步（非流式）请求进行中标记
  const lastEventSeq = ref(0); // 已消费的最后一条 SSE 事件序号（断线续传用）
  const activeStreamKey = ref(""); // 当前流式会话的 streamKey

  // ---- 链路追踪（span）----
  const chatSpanStore = useSpanStore<ChatSseEventName>();
  const chatSpanTree = computed(() => chatSpanStore.buildSpanTree()); // span 树（追踪时间线卡片数据源）
  const chatSpanRunId = computed(() => chatSpanStore.snapshot.value.runId);
  const chatSpanEvents = computed(() => chatSpanStore.listFilteredEvents());
  const chatSpanStats = computed(() => chatSpanStore.getStats());
  /** 本地实时轻量派生异常：启用超时/上下文/流完整性规则 */
  const chatSpanAnomalies = computed(() =>
    chatSpanStore.listAnomalies({
      now: now(),
      toolTimeoutMs: DIAGNOSTIC_TOOL_TIMEOUT_MS,
      streamIdleMs: DIAGNOSTIC_STREAM_IDLE_MS,
    }),
  );
  /** 后端规则引擎诊断结果：run 到达终态后自动拉取补全 */
  const chatSpanDiagnostics = ref<ObservabilityDiagnosticIssue[]>([]);
  /** 已拉取诊断的 runId，避免同一 run 重复请求 */
  const diagnosticsFetchedForRun = ref<string | null>(null);
  const diagnosticsLoading = ref(false);
  const hasChatSpanTimeline = computed(() => chatSpanTree.value.length > 0);

  /**
   * 终态自动拉取后端规则引擎诊断（失败静默降级，不影响聊天主链路）。
   *
   * @param runId 需要诊断的 runId。
   * @returns 无返回值。
   */
  const fetchRunDiagnostics = async (runId: string): Promise<void> => {
    if (!runId || diagnosticsFetchedForRun.value === runId) {
      return;
    }

    diagnosticsFetchedForRun.value = runId;
    diagnosticsLoading.value = true;
    try {
      const response = await apiFetch<ObservabilityDiagnosticResponse>(
        `/observability/runs/${encodeURIComponent(runId)}/diagnostics`,
      );
      // 竞态保护：请求期间若已开启新一轮会话（runId 已变化），丢弃过期结果
      if (diagnosticsFetchedForRun.value !== runId) {
        return;
      }
      if (response && Array.isArray(response.issues)) {
        chatSpanDiagnostics.value = response.issues;
      }
    } catch {
      // 诊断失败静默降级：规则引擎非主链路，不影响聊天体验
    } finally {
      // 仅在仍属当前 run 时关闭加载态，避免误关新一轮的加载指示
      if (diagnosticsFetchedForRun.value === runId) {
        diagnosticsLoading.value = false;
      }
    }
  };

  /**
   * 将 span 存储中的工具调用信息同步到消息 trace 上。
   * 以 trace.mainSpanId 为作用域，收集其下所有 tool 类型的后代 span。
   */
  const syncTraceToolSpans = (trace: ChatMessage["trace"]) => {
    if (!trace) {
      return;
    }

    const fallbackRootSpanId =
      chatSpanStore.snapshot.value.rootSpanIds[0] ?? "";
    const scopeSpanId = trace.mainSpanId?.trim() || fallbackRootSpanId;
    if (!scopeSpanId) {
      trace.toolSpans = [];
      return;
    }

    trace.mainSpanId = scopeSpanId;
    const scopeSpan = chatSpanStore.getSpan(scopeSpanId);
    const descendantToolSpans = chatSpanStore
      .listDescendants(scopeSpanId)
      .filter((span) => span.kind === "tool");
    const toolSpans =
      scopeSpan?.kind === "tool"
        ? [scopeSpan, ...descendantToolSpans]
        : descendantToolSpans;

    trace.toolSpans = toolSpans.map((span) => toTraceToolSpan(span));
  };

  // ---- 派生计算属性 ----
  const currentChatTitle = computed(() =>
    buildCurrentChatTitle(options.form.targetRole),
  ); // 依据目标岗位生成会话标题
  const formSummaryLines = computed(() => buildFormSummaryLines(options.form)); // 表单摘要行（写入 system 上下文）

  /** 向消息列表追加一条消息（仅本地 UI 层，不落库） */
  const appendChatMessage = (
    role: ChatRole,
    content: string,
    streaming = false,
    trace: ChatMessage["trace"] = null,
  ) => {
    chatMessages.value.push({
      id: createId(role),
      role,
      kind: "text",
      content,
      streaming,
      trace,
    });
  };

  /** 局部更新某条消息的内容 / 流式状态 / 追踪信息 */
  const updateChatMessage = (
    messageId: string,
    updates: UpdateChatMessagePayload,
  ) => {
    const target = chatMessages.value.find((item) => item.id === messageId);
    if (!target) {
      return;
    }

    if (typeof updates.content === "string") {
      target.content = updates.content;
    }

    if (typeof updates.streaming === "boolean") {
      target.streaming = updates.streaming;
    }

    if ("trace" in updates) {
      target.trace = updates.trace ?? null;
    }
  };

  /** 确保存在会话：无会话时调用 POST /conversations 创建并缓存 ID */
  const ensureConversation = async (): Promise<string> => {
    if (conversationId.value) {
      return conversationId.value;
    }

    const response = await apiFetch<ApiEnvelope<ConversationDto>>(
      "/conversations",
      {
        method: "POST",
        body: {
          title: currentChatTitle.value,
        },
      },
    );

    if (!response.success || !response.data) {
      throw new Error(response.error?.message || "创建会话失败");
    }

    conversationId.value = response.data.id;
    return conversationId.value;
  };

  /** 向后端会话追加一条消息（服务端持久化，供多轮上下文使用） */
  const appendConversationMessage = async (
    conversation: string,
    role: ChatRole | "tool",
    content: string,
    intent?: string,
    agentName?: string,
  ) => {
    await apiFetch(`/conversations/${conversation}/messages`, {
      method: "POST",
      body: {
        role,
        content,
        intent,
        agentName,
      },
    });
  };

  /**
   * 同步表单上下文：将当前表单摘要以 system 消息写入会话。
   * 内容未变化时跳过写入（幂等）。
   */
  const syncSystemContext = async (): Promise<string> => {
    const content = buildSystemContextMessage(options.form);
    const conversation = await ensureConversation();

    if (lastSyncedSystemContext.value === content) {
      return conversation;
    }

    await appendConversationMessage(
      conversation,
      "system",
      content,
      "resume_context",
      "resume_workbench",
    );
    lastSyncedSystemContext.value = content;
    return conversation;
  };

  /** 预置一次"生成三版简历"的完整会话：同步上下文 + 写入 user/assistant 消息并渲染到列表 */
  const seedGeneratedConversation = async () => {
    const conversation = await syncSystemContext();
    const requestMessage =
      "请基于当前表单信息生成技术版、业务版和综合版三版简历。";
    const assistantSnapshot =
      options.getVariantSnapshot?.() ?? buildAllVariantsMarkdown([]);

    await appendConversationMessage(
      conversation,
      "user",
      requestMessage,
      "resume_generation",
    );
    await appendConversationMessage(
      conversation,
      "assistant",
      assistantSnapshot,
      "resume_generation",
    );

    appendChatMessage("user", requestMessage);
    appendChatMessage("assistant", assistantSnapshot);
  };

  /**
   * 消费单条聊天流事件并更新目标 assistant 消息的 UI 状态。
   * 负责：记录 rawEvents、更新 trace 字段、切换流式占位符、填充最终内容。
   */
  const handleChatStreamEvent = (
    assistantMessageId: string,
    event: ChatSseEvent,
  ) => {
    const target = chatMessages.value.find(
      (item) => item.id === assistantMessageId,
    );
    if (!target) {
      return;
    }

    if (!target.trace) {
      target.trace = buildChatTrace();
    }

    const nowIso = now();
    target.trace.rawEvents?.push({
      ...event,
      ts: event.ts ?? nowIso,
    });

    switch (event.event) {
      case "start": // 流开始：进入流式状态，展示占位文案
        target.streaming = true;
        target.trace.routeDecisionStarted = false;
        target.trace.done = false;
        target.trace.mainSpanId =
          event.spanId ??
          chatSpanStore.snapshot.value.rootSpanIds[0] ??
          target.trace.mainSpanId ??
          "";
        target.content = "正在整理回复...";
        break;
      case "route_decision":
        target.trace.routeDecision = event.routeDecision;
        target.trace.routeDecisionStarted = true;
        options.statusMessage.value =
          "已路由到 " + event.routeDecision.selectedAgent;
        break;
      case "agent.step.started":
      case "agent.step.finished":
        if (event.agentRunId) {
          target.trace.agentRunId = event.agentRunId;
        }
        break;
      case "tool_start":
      case "tool.call.started":
        if (event.agentRunId) {
          target.trace.agentRunId = event.agentRunId;
        }
        break;
      case "tool_done":
      case "tool.call.finished": {
        if (event.agentRunId) {
          target.trace.agentRunId = event.agentRunId;
        }
        break;
      }
      case "assistant_chunk": // 文本增量：占位符后首个分片直接替换，其余追加
        if (event.text) {
          target.content = CHAT_STREAMING_PLACEHOLDERS.has(target.content)
            ? event.text
            : `${target.content}${event.text}`;
          target.streaming = true;
        }
        break;
      case "assistant_done": // 完整回复：直接替换为最终内容，结束流式状态
        if (event.content) {
          target.content = event.content;
        }

        if (event.routeDecision) {
          target.trace.routeDecision = event.routeDecision;
          target.trace.routeDecisionStarted = true;
        }

        target.streaming = false;
        target.trace.done = true;
        verifyFinalMarkdown(target.id, target.content);
        break;
      case "done":
        if (event.conversationId) {
          conversationId.value = event.conversationId;
        }

        if (event.agentRunId) {
          target.trace.agentRunId = event.agentRunId;
        }

        target.trace.mainSpanId =
          event.spanId ??
          chatSpanStore.snapshot.value.rootSpanIds[0] ??
          target.trace.mainSpanId ??
          "";

        if (event.routeDecision) {
          target.trace.routeDecision = event.routeDecision;
          target.trace.routeDecisionStarted = true;
        }

        target.streaming = false;
        target.trace.done = true;
        verifyFinalMarkdown(target.id, target.content);
        break;
      case "error": {
        const errorText =
          (event.code ? "[" + event.code + "] " : "") +
          (event.message ?? "聊天流发生异常，请稍后重试。");
        options.errorMessage.value = errorText;
        target.streaming = false;
        target.trace.mainSpanId =
          event.spanId ??
          chatSpanStore.snapshot.value.rootSpanIds[0] ??
          target.trace.mainSpanId ??
          "";

        if (hasStreamedPartialContent(target.content)) {
          // 部分流内容被中断：保留已产出内容，仅标记未完成，交由渲染侧安全降级
          target.incomplete = true;
        } else {
          // 服务端返回的是完整错误信息：直接作为正文展示
          target.content = errorText;
        }
        break;
      }
    }

    syncTraceToolSpans(target.trace);
  };

  /** 打字机帧选择器：按速率挑选可输出的文本帧，并支持相邻文本帧合并 */
  const chatTypewriterSelector =
    createTypewriterFrameSelector<ChatRenderFrameItem>({
      charsPerSecond: CHAT_TYPEWRITER_CHARS_PER_SECOND,
      getText: async (item) => {
        return item.kind === "text" &&
          item.event.event === "assistant_chunk" &&
          typeof item.event.text === "string"
          ? item.event.text
          : null;
      },
      cloneWithText: async (item, text) => {
        return {
          ...item,
          event: {
            ...item.event,
            text,
          } as ChatSseEvent,
        };
      },
      isTerminalItem: async (item) => {
        return (
          item.kind === "event" &&
          (item.event.event === "done" || item.event.event === "error")
        );
      },
    });

  /** 合并两个连续的 assistant_chunk 文本帧，减少渲染次数 */
  const mergeChatRenderFrameItems = async (
    previous: ChatRenderFrameItem,
    next: ChatRenderFrameItem,
  ) => {
    if (
      previous.kind !== "text" ||
      next.kind !== "text" ||
      previous.assistantMessageId !== next.assistantMessageId ||
      previous.event.event !== "assistant_chunk" ||
      next.event.event !== "assistant_chunk"
    ) {
      return undefined;
    }

    return {
      ...previous,
      event: {
        ...next.event,
        text: `${previous.event.text ?? ""}${next.event.text ?? ""}`,
      } as ChatSseEvent,
    } satisfies ChatRenderFrameItem;
  };

  /** 渲染引擎：将 SSE 信封事件转化为渲染帧，驱动打字机效果并提交到消息状态 */
  const chatRenderEngine = useSseRenderEngine<
    ChatRenderIngressItem,
    ChatRenderFrameItem
  >({
    classifyIngressPhase: async (item) =>
      getChatSseEventRenderPhase(item.envelope.type),
    transformIngress: async (item) => {
      const event = {
        event: item.envelope.type,
        ts: item.envelope.ts,
        ...item.envelope.payload,
        spanId: item.envelope.spanId,
      } as ChatSseEvent;

      if (
        event.event === "assistant_chunk" &&
        typeof event.text === "string" &&
        event.text.length > 0
      ) {
        return [
          {
            kind: "text",
            assistantMessageId: item.assistantMessageId,
            event,
          },
        ];
      }

      return [
        {
          kind: "event",
          assistantMessageId: item.assistantMessageId,
          event,
        },
      ];
    },
    mergeFrameItems: mergeChatRenderFrameItems,
    selectFrameItems: chatTypewriterSelector.selectFrameItems,
    commitFrame: async (items) => {
      for (const item of items) {
        handleChatStreamEvent(item.assistantMessageId, item.event);
      }
    },
    onError: async (error) => {
      options.errorMessage.value =
        error instanceof Error ? error.message : "聊天渲染失败，请稍后重试。";
    },
  });

  /** SSE 连接监督器：负责建连、消费流、断线重试，并驱动渲染引擎 */
  const supervisor = useSseSupervisor({
    consumeResponse: async (response) => {
      if (response.status === 401) {
        options.clearAuth();
        throw new Error("登录状态已过期，请重新登录。");
      }

      if (!response.ok) {
        throw new Error(`聊天接口返回 HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error("聊天接口没有返回可读数据流。");
      }

      if (!activeAssistantMessageId.value) {
        throw new Error("当前没有可消费的聊天流。");
      }

      // 建连成功后：重置并启动渲染引擎，准备消费事件流
      await chatTypewriterSelector.reset();
      await chatRenderEngine.dispose();
      await chatRenderEngine.start();

      const assistantMessageId = activeAssistantMessageId.value;
      let enqueueRenderTask = Promise.resolve();
      const result = await consumeSseEventEnvelopeStream(response.body, {
        lastSeq: lastEventSeq.value,
        isTerminalEvent: isChatTerminalSseEvent,
        onEvent: (envelope) => {
          lastEventSeq.value = envelope.seq; // 记录事件序号，支持断线续传
          if (!isChatSseEventName(envelope.type)) {
            return; // 忽略未知事件类型
          }

          // 事件进入 span 存储（供追踪时间线使用），并按序送入渲染引擎
          chatSpanStore.ingestEnvelope(
            envelope as SseEventEnvelope<ChatSseEventName>,
          );
          // run 到达终态后自动拉取后端规则引擎诊断补全
          if (isChatTerminalSseEvent(envelope.type) && chatSpanRunId.value) {
            void fetchRunDiagnostics(chatSpanRunId.value);
          }
          enqueueRenderTask = enqueueRenderTask.then(async () => {
            await chatRenderEngine.enqueueIngress({
              assistantMessageId,
              envelope: envelope as SseEventEnvelope<ChatSseEventName>,
            });
          });
        },
      });

      await enqueueRenderTask;
      await chatRenderEngine.flush();
      lastEventSeq.value = result.lastSeq;
    },
    maxRetries: 1,
    shouldRetry: (error, attempt) => {
      return attempt <= 1 && error instanceof SseStreamDisconnectedError;
    },
  });

  // 订阅状态机变更，供 sendingMessage 等计算属性响应式更新
  const chatMachineState = ref<SseMachineStateSnapshot>(supervisor.state);
  /** 是否正在发送消息：同步请求中或 SSE 处于连接/流式/暂停/重试任一状态 */
  const sendingMessage = computed(() => {
    const state = chatMachineState.value.value;
    return (
      syncRequestPending.value ||
      state === "connecting" ||
      state === "streaming" ||
      state === "paused" ||
      state === "retrying"
    );
  });

  supervisor.onStateChange = (_, next) => {
    chatMachineState.value = next;
  };

  /** 同步发送（非流式）：调用 POST /chat/message，拿到完整回复后一次性更新消息 */
  const sendChatMessageSync = async (payload: {
    conversation: string;
    assistantMessageId: string;
    content: string;
  }) => {
    const response = await apiFetch<ApiEnvelope<ChatResponseData>>(
      "/chat/message",
      {
        method: "POST",
        body: {
          conversationId: payload.conversation,
          message: payload.content,
          title: conversationId.value ? undefined : currentChatTitle.value,
          historyLimit: 12,
        },
      },
    );

    if (!response.success || !response.data) {
      throw new Error(response.error?.message || "发送消息失败");
    }

    conversationId.value = response.data.conversationId;
    const responseFinishedAt = now();
    const assistantContent =
      response.data.assistantMessage?.content?.trim() || "我已收到你的问题。";
    updateChatMessage(payload.assistantMessageId, {
      content: assistantContent,
      streaming: false,
      trace: {
        agentRunId: response.data.agentRunId,
        mainSpanId: `sync:${response.data.agentRunId}:run`,
        routeDecision: response.data.routeDecision,
        toolSpans: buildSyncToolSpans(
          response.data.agentRunId,
          response.data.assistantMessage?.toolCallSummary,
          responseFinishedAt,
        ),
        rawEvents: [],
        routeDecisionStarted: true,
        done: true,
      },
    });
    options.statusMessage.value = response.data.routeDecision?.selectedAgent
      ? "已路由到 " + response.data.routeDecision.selectedAgent
      : "消息发送成功。";
  };

  /** 流式发送：经 SSE 连接 POST /chat/message/stream，由渲染引擎逐步呈现回复 */
  const sendChatMessageStream = async (payload: {
    conversation: string;
    content: string;
    assistantMessageId: string;
  }) => {
    if (!options.token.value) {
      throw new Error("未登录，请先重新登录。");
    }

    if (!fetchFn) {
      throw new Error("当前环境不支持流式请求。");
    }

    if (RESETTABLE_MACHINE_STATES.has(supervisor.state.value)) {
      supervisor.reset();
    }

    activeAssistantMessageId.value = payload.assistantMessageId;
    activeStreamKey.value = createChatStreamKey();
    lastEventSeq.value = 0;

    await supervisor.connect(({ signal }) =>
      fetchFn(`${API_BASE_URL}/chat/message/stream`, {
        method: "POST",
        headers: (() => {
          const headers = new Headers();
          if (options.token.value) {
            headers.set("Authorization", `Bearer ${options.token.value}`);
          }
          headers.set("Accept", "text/event-stream");
          headers.set("Content-Type", "application/json");
          return headers;
        })(),
        body: JSON.stringify({
          conversationId: payload.conversation,
          message: payload.content,
          title: conversationId.value ? undefined : currentChatTitle.value,
          historyLimit: 12,
          streamKey: activeStreamKey.value,
          sinceSeq: lastEventSeq.value,
        }),
        signal,
      }),
    );
  };

  /** 发送聊天消息主入口：先同步上下文与用户消息，再按登录态选择流式或同步方式请求 */
  const sendChatMessage = async () => {
    const content = chatInput.value.trim();
    if (!content || sendingMessage.value) {
      return; // 空内容或正在发送中则忽略
    }

    chatInput.value = "";
    options.errorMessage.value = "";
    chatSpanStore.reset(); // 新一轮会话，清空上一轮的 span 追踪
    chatSpanDiagnostics.value = []; // 清空上一轮的后端诊断结果
    diagnosticsFetchedForRun.value = null; // 允许新一轮再次拉取
    diagnosticsLoading.value = false; // 复位诊断加载态（同步模式不触发拉取）

    const assistantMessageId = createId("assistant");

    try {
      const conversation = await syncSystemContext();
      appendChatMessage("user", content);
      // 预置一条"正在生成"的 assistant 占位消息，等待流式/同步内容填充
      chatMessages.value.push({
        id: assistantMessageId,
        role: "assistant",
        kind: "text",
        content: "正在生成...",
        streaming: true,
        trace: buildChatTrace("", defaultRouteDecision),
      });

      if (options.token.value) {
        await sendChatMessageStream({
          assistantMessageId,
          conversation,
          content,
        });
        return;
      }

      syncRequestPending.value = true;
      await sendChatMessageSync({
        assistantMessageId,
        conversation,
        content,
      });
    } catch (error) {
      const canceled = supervisor.state.value === "canceled";
      const errorText =
        error instanceof Error ? error.message : "发送失败，请重试。";

      // 用户主动取消时不展示错误提示
      if (!canceled) {
        options.errorMessage.value = errorText;
      }

      const assistantMessage = chatMessages.value.find(
        (item) => item.id === assistantMessageId,
      );

      if (assistantMessage) {
        if (hasStreamedPartialContent(assistantMessage.content)) {
          // 已产出部分内容却被中断（重试耗尽 / 连接失败 / 用户取消）：
          // 保留内容并标记未完成，交由渲染侧安全降级，避免用错误文案覆盖已生成内容
          assistantMessage.streaming = false;
          assistantMessage.incomplete = true;
        } else if (canceled) {
          // 用户主动取消且尚无内容：给出明确的取消反馈
          assistantMessage.content = "已取消本次生成。";
          assistantMessage.streaming = false;
        } else {
          // 无部分内容：以完整错误信息作为正文
          assistantMessage.content = errorText;
          assistantMessage.streaming = false;
          assistantMessage.trace = null;
        }
      }
    } finally {
      // 无论成败，清理请求中的临时状态
      syncRequestPending.value = false;
      activeAssistantMessageId.value = "";
    }
  };

  /** 快捷提示：将预设 prompt 填入输入框（由用户确认后发送） */
  const applyQuickPrompt = async (prompt: string) => {
    chatInput.value = prompt;
  };

  /**
   * 统一诊断视图：合并本地实时异常与后端规则结果，供时间线组件分组展示。
   */
  const chatSpanDiagnosticsView = useObservabilityDiagnostics({
    localAnomalies: () => chatSpanAnomalies.value,
    remoteIssues: () => chatSpanDiagnostics.value,
    events: () => chatSpanEvents.value,
  });

  /** 组件卸载清理：取消进行中的 SSE 连接并释放渲染资源 */
  const dispose = () => {
    if (CANCELABLE_MACHINE_STATES.has(supervisor.state.value)) {
      supervisor.cancel();
    }

    void chatRenderEngine.dispose();
    void chatTypewriterSelector.reset();
  };

  // 对外暴露的组合式函数 API
  return {
    appendChatMessage,
    applyQuickPrompt,
    chatInput,
    chatMessages,
    activeAssistantMessageId,
    chatSpanAnomalies,
    chatSpanDiagnostics,
    chatSpanDiagnosticItems: chatSpanDiagnosticsView.items,
    chatSpanDiagnosticGroups: chatSpanDiagnosticsView.groupedByCategory,
    chatSpanDiagnosticCounts: chatSpanDiagnosticsView.counts,
    chatSpanEvents,
    chatSpanRunId,
    chatSpanStats,
    chatSpanTree,
    diagnosticsLoading,
    hasChatSpanTimeline,
    conversationId,
    currentChatTitle,
    dispose,
    formSummaryLines,
    lastSyncedSystemContext,
    chatRenderMonitoring: chatRenderEngine.monitoring,
    seedGeneratedConversation,
    sendChatMessage,
    sendingMessage,
    syncSystemContext,
    updateChatMessage,
  };
}
