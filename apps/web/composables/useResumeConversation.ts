import { computed, ref, type Ref } from 'vue';

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
} from '../utils/resume';
import {
  getChatSseEventRenderPhase,
  isChatSseEventName,
  type ChatSseEvent,
  type ChatSseEventName,
} from '../utils/sse-events';
import {
  consumeSseEventEnvelopeStream,
  SseStreamDisconnectedError,
  type SseEventEnvelope,
} from '../utils/sse';
import { useSpanStore, type Span } from './useSpanStore';
import { useApiFetch } from './useApiFetch';
import {
  createTypewriterFrameSelector,
  useSseRenderEngine,
} from './useSseRenderEngine';
import { useSseSupervisor } from './useSseSupervisor';
import type { SseMachineStateSnapshot, SseMachineStateValue } from './useSseMachine';

const API_BASE_URL = 'http://127.0.0.1:3001';
const CHAT_TYPEWRITER_CHARS_PER_SECOND = 120;
const CHAT_STREAMING_PLACEHOLDERS = new Set([
  '正在生成...',
  '正在整理回复...',
]);

type ApiFetch = typeof useApiFetch;
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

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

interface UpdateChatMessagePayload {
  content?: string;
  streaming?: boolean;
  trace?: ChatMessage['trace'];
}

interface ChatRenderIngressItem {
  assistantMessageId: string;
  envelope: SseEventEnvelope<ChatSseEventName>;
}

interface ChatRenderFrameItem {
  kind: 'event' | 'text';
  assistantMessageId: string;
  event: ChatSseEvent;
}

const RESETTABLE_MACHINE_STATES = new Set<SseMachineStateValue>(['done', 'error', 'canceled']);
const CANCELABLE_MACHINE_STATES = new Set<SseMachineStateValue>(['connecting', 'streaming', 'paused', 'retrying']);

function createChatStreamKey(): string {
  return `chat_stream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getSpanMetaString(span: Span, key: string): string | undefined {
  const value = span.meta[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function getSpanMetaNumber(span: Span, key: string): number | undefined {
  const value = span.meta[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getSpanMetaBoolean(span: Span, key: string): boolean | undefined {
  const value = span.meta[key];
  return typeof value === 'boolean' ? value : undefined;
}

function toTraceToolSpan(span: Span): ChatTraceToolSpan {
  return {
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: getSpanMetaString(span, 'toolName') ?? span.name,
    status: span.status,
    startTs: span.startTs,
    endTs: span.endTs,
    latencyMs: getSpanMetaNumber(span, 'latencyMs'),
    success: getSpanMetaBoolean(span, 'success'),
    errorCode: getSpanMetaString(span, 'errorCode'),
    errorMessage: getSpanMetaString(span, 'errorMessage'),
  };
}

function buildSyncToolSpans(
  agentRunId: string,
  toolCalls: readonly ConversationToolCallSummary[] | null | undefined,
  finishedAt: string,
): ChatTraceToolSpan[] {
  return (toolCalls ?? []).map((toolCall, index) => ({
    spanId: `sync:${agentRunId}:tool:${index + 1}:${toolCall.toolName}`,
    parentSpanId: `sync:${agentRunId}:run`,
    name: toolCall.toolName,
    status: toolCall.success ? 'succeeded' : 'failed',
    startTs: finishedAt,
    endTs: finishedAt,
    latencyMs: toolCall.latencyMs,
    success: toolCall.success,
    errorCode: toolCall.errorCode,
    errorMessage: toolCall.errorMessage,
  }));
}

export function useResumeConversation(options: UseResumeConversationOptions) {
  const apiFetch = options.apiFetch ?? useApiFetch;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? ((role: string) => createChatMessageId(role));

  const chatMessages = ref<ChatMessage[]>(getInitialChatMessages());
  const chatInput = ref('');
  const conversationId = ref('');
  const lastSyncedSystemContext = ref('');
  const activeAssistantMessageId = ref('');
  const syncRequestPending = ref(false);
  const lastEventSeq = ref(0);
  const activeStreamKey = ref('');
  const chatSpanStore = useSpanStore<ChatSseEventName>();
  const chatSpanTree = computed(() => chatSpanStore.buildSpanTree());
  const chatSpanRunId = computed(() => chatSpanStore.snapshot.value.runId);
  const hasChatSpanTimeline = computed(() => chatSpanTree.value.length > 0);

  const syncTraceToolSpans = (trace: ChatMessage['trace']) => {
    if (!trace) {
      return;
    }

    const fallbackRootSpanId = chatSpanStore.snapshot.value.rootSpanIds[0] ?? '';
    const scopeSpanId = trace.mainSpanId?.trim() || fallbackRootSpanId;
    if (!scopeSpanId) {
      trace.toolSpans = [];
      return;
    }

    trace.mainSpanId = scopeSpanId;
    const scopeSpan = chatSpanStore.getSpan(scopeSpanId);
    const descendantToolSpans = chatSpanStore
      .listDescendants(scopeSpanId)
      .filter((span) => span.kind === 'tool');
    const toolSpans = scopeSpan?.kind === 'tool'
      ? [scopeSpan, ...descendantToolSpans]
      : descendantToolSpans;

    trace.toolSpans = toolSpans.map((span) => toTraceToolSpan(span));
  };

  const currentChatTitle = computed(() => buildCurrentChatTitle(options.form.targetRole));
  const formSummaryLines = computed(() => buildFormSummaryLines(options.form));

  const appendChatMessage = (
    role: ChatRole,
    content: string,
    streaming = false,
    trace: ChatMessage['trace'] = null,
  ) => {
    chatMessages.value.push({
      id: createId(role),
      role,
      kind: 'text',
      content,
      streaming,
      trace,
    });
  };

  const updateChatMessage = (messageId: string, updates: UpdateChatMessagePayload) => {
    const target = chatMessages.value.find((item) => item.id === messageId);
    if (!target) {
      return;
    }

    if (typeof updates.content === 'string') {
      target.content = updates.content;
    }

    if (typeof updates.streaming === 'boolean') {
      target.streaming = updates.streaming;
    }

    if ('trace' in updates) {
      target.trace = updates.trace ?? null;
    }
  };

  const ensureConversation = async (): Promise<string> => {
    if (conversationId.value) {
      return conversationId.value;
    }

    const response = await apiFetch<ApiEnvelope<ConversationDto>>('/conversations', {
      method: 'POST',
      body: {
        title: currentChatTitle.value,
      },
    });

    if (!response.success || !response.data) {
      throw new Error(response.error?.message || '创建会话失败');
    }

    conversationId.value = response.data.id;
    return conversationId.value;
  };

  const appendConversationMessage = async (
    conversation: string,
    role: ChatRole | 'tool',
    content: string,
    intent?: string,
    agentName?: string,
  ) => {
    await apiFetch(`/conversations/${conversation}/messages`, {
      method: 'POST',
      body: {
        role,
        content,
        intent,
        agentName,
      },
    });
  };

  const syncSystemContext = async (): Promise<string> => {
    const content = buildSystemContextMessage(options.form);
    const conversation = await ensureConversation();

    if (lastSyncedSystemContext.value === content) {
      return conversation;
    }

    await appendConversationMessage(conversation, 'system', content, 'resume_context', 'resume_workbench');
    lastSyncedSystemContext.value = content;
    return conversation;
  };

  const seedGeneratedConversation = async () => {
    const conversation = await syncSystemContext();
    const requestMessage = '请基于当前表单信息生成技术版、业务版和综合版三版简历。';
    const assistantSnapshot = options.getVariantSnapshot?.() ?? buildAllVariantsMarkdown([]);

    await appendConversationMessage(conversation, 'user', requestMessage, 'resume_generation');
    await appendConversationMessage(conversation, 'assistant', assistantSnapshot, 'resume_generation');

    appendChatMessage('user', requestMessage);
    appendChatMessage('assistant', assistantSnapshot);
  };

  const handleChatStreamEvent = (assistantMessageId: string, event: ChatSseEvent) => {
    const target = chatMessages.value.find((item) => item.id === assistantMessageId);
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
      case 'start':
        target.streaming = true;
        target.trace.routeDecisionStarted = false;
        target.trace.done = false;
        target.trace.mainSpanId = event.spanId ?? chatSpanStore.snapshot.value.rootSpanIds[0] ?? target.trace.mainSpanId ?? '';
        target.content = '正在整理回复...';
        break;
      case 'route_decision':
        target.trace.routeDecision = event.routeDecision;
        target.trace.routeDecisionStarted = true;
        options.statusMessage.value = '已路由到 ' + event.routeDecision.selectedAgent;
        break;
      case 'agent.step.started':
      case 'agent.step.finished':
        if (event.agentRunId) {
          target.trace.agentRunId = event.agentRunId;
        }
        break;
      case 'tool_start':
      case 'tool.call.started':
        if (event.agentRunId) {
          target.trace.agentRunId = event.agentRunId;
        }
        break;
      case 'tool_done':
      case 'tool.call.finished': {
        if (event.agentRunId) {
          target.trace.agentRunId = event.agentRunId;
        }
        break;
      }
      case 'assistant_chunk':
        if (event.text) {
          target.content = CHAT_STREAMING_PLACEHOLDERS.has(target.content)
            ? event.text
            : `${target.content}${event.text}`;
          target.streaming = true;
        }
        break;
      case 'assistant_done':
        if (event.content) {
          target.content = event.content;
        }

        if (event.routeDecision) {
          target.trace.routeDecision = event.routeDecision;
          target.trace.routeDecisionStarted = true;
        }

        target.streaming = false;
        target.trace.done = true;
        break;
      case 'done':
        if (event.conversationId) {
          conversationId.value = event.conversationId;
        }

        if (event.agentRunId) {
          target.trace.agentRunId = event.agentRunId;
        }

        target.trace.mainSpanId = event.spanId ?? chatSpanStore.snapshot.value.rootSpanIds[0] ?? target.trace.mainSpanId ?? '';

        if (event.routeDecision) {
          target.trace.routeDecision = event.routeDecision;
          target.trace.routeDecisionStarted = true;
        }

        target.streaming = false;
        target.trace.done = true;
        break;
      case 'error':
        options.errorMessage.value = (event.code ? '[' + event.code + '] ' : '') + (event.message ?? '聊天流发生异常，请稍后重试。');
        target.streaming = false;
        target.content = options.errorMessage.value;
        target.trace.mainSpanId = event.spanId ?? chatSpanStore.snapshot.value.rootSpanIds[0] ?? target.trace.mainSpanId ?? '';
        break;
    }

    syncTraceToolSpans(target.trace);
  };

  const chatTypewriterSelector = createTypewriterFrameSelector<ChatRenderFrameItem>({
    charsPerSecond: CHAT_TYPEWRITER_CHARS_PER_SECOND,
    getText: async (item) => {
      return item.kind === 'text' && item.event.event === 'assistant_chunk' && typeof item.event.text === 'string'
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
      return item.kind === 'event' && (
        item.event.event === 'done' ||
        item.event.event === 'error'
      );
    },
  });

  const mergeChatRenderFrameItems = async (previous: ChatRenderFrameItem, next: ChatRenderFrameItem) => {
    if (
      previous.kind !== 'text' ||
      next.kind !== 'text' ||
      previous.assistantMessageId !== next.assistantMessageId ||
      previous.event.event !== 'assistant_chunk' ||
      next.event.event !== 'assistant_chunk'
    ) {
      return undefined;
    }

    return {
      ...previous,
      event: {
        ...next.event,
        text: `${previous.event.text ?? ''}${next.event.text ?? ''}`,
      } as ChatSseEvent,
    } satisfies ChatRenderFrameItem;
  };

  const chatRenderEngine = useSseRenderEngine<ChatRenderIngressItem, ChatRenderFrameItem>({
    classifyIngressPhase: async (item) => getChatSseEventRenderPhase(item.envelope.type),
    transformIngress: async (item) => {
      const event = {
        event: item.envelope.type,
        ts: item.envelope.ts,
        ...item.envelope.payload,
        spanId: item.envelope.spanId,
      } as ChatSseEvent;

      if (event.event === 'assistant_chunk' && typeof event.text === 'string' && event.text.length > 0) {
        return [{
          kind: 'text',
          assistantMessageId: item.assistantMessageId,
          event,
        }];
      }

      return [{
        kind: 'event',
        assistantMessageId: item.assistantMessageId,
        event,
      }];
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
        error instanceof Error ? error.message : '聊天渲染失败，请稍后重试。';
    },
  });

  const supervisor = useSseSupervisor({
    consumeResponse: async (response) => {
      if (response.status === 401) {
        options.clearAuth();
        throw new Error('登录状态已过期，请重新登录。');
      }

      if (!response.ok) {
        throw new Error(`聊天接口返回 HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error('聊天接口没有返回可读数据流。');
      }

      if (!activeAssistantMessageId.value) {
        throw new Error('当前没有可消费的聊天流。');
      }

      await chatTypewriterSelector.reset();
      await chatRenderEngine.dispose();
      await chatRenderEngine.start();

      const assistantMessageId = activeAssistantMessageId.value;
      let enqueueRenderTask = Promise.resolve();
      const result = await consumeSseEventEnvelopeStream(response.body, {
        lastSeq: lastEventSeq.value,
        isTerminalEvent: (type) => type === 'done' || type === 'error',
        onEvent: (envelope) => {
          lastEventSeq.value = envelope.seq;
          if (!isChatSseEventName(envelope.type)) {
            return;
          }

          chatSpanStore.ingestEnvelope(envelope as SseEventEnvelope<ChatSseEventName>);
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

  const chatMachineState = ref<SseMachineStateSnapshot>(supervisor.state);
  const sendingMessage = computed(() => {
    const state = chatMachineState.value.value;
    return (
      syncRequestPending.value ||
      state === 'connecting' ||
      state === 'streaming' ||
      state === 'paused' ||
      state === 'retrying'
    );
  });

  supervisor.onStateChange = (_, next) => {
    chatMachineState.value = next;
  };

  const sendChatMessageSync = async (payload: {
    conversation: string;
    assistantMessageId: string;
    content: string;
  }) => {
    const response = await apiFetch<ApiEnvelope<ChatResponseData>>('/chat/message', {
      method: 'POST',
      body: {
        conversationId: payload.conversation,
        message: payload.content,
        title: conversationId.value ? undefined : currentChatTitle.value,
        historyLimit: 12,
      },
    });

    if (!response.success || !response.data) {
      throw new Error(response.error?.message || '发送消息失败');
    }

    conversationId.value = response.data.conversationId;
    const responseFinishedAt = now();
    const assistantContent = response.data.assistantMessage?.content?.trim() || '我已收到你的问题。';
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
      ? '已路由到 ' + response.data.routeDecision.selectedAgent
      : '消息发送成功。';
  };

  const sendChatMessageStream = async (payload: {
    conversation: string;
    content: string;
    assistantMessageId: string;
  }) => {
    if (!options.token.value) {
      throw new Error('未登录，请先重新登录。');
    }

    if (!fetchFn) {
      throw new Error('当前环境不支持流式请求。');
    }

    if (RESETTABLE_MACHINE_STATES.has(supervisor.state.value)) {
      supervisor.reset();
    }

    activeAssistantMessageId.value = payload.assistantMessageId;
    activeStreamKey.value = createChatStreamKey();
    lastEventSeq.value = 0;

    await supervisor.connect(({ signal }) =>
      fetchFn(`${API_BASE_URL}/chat/message/stream`, {
        method: 'POST',
        headers: (() => {
          const headers = new Headers();
          if (options.token.value) {
            headers.set('Authorization', `Bearer ${options.token.value}`);
          }
          headers.set('Accept', 'text/event-stream');
          headers.set('Content-Type', 'application/json');
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

  const sendChatMessage = async () => {
    const content = chatInput.value.trim();
    if (!content || sendingMessage.value) {
      return;
    }

    chatInput.value = '';
    options.errorMessage.value = '';
    chatSpanStore.reset();

    const assistantMessageId = createId('assistant');

    try {
      const conversation = await syncSystemContext();
      appendChatMessage('user', content);
      chatMessages.value.push({
        id: assistantMessageId,
        role: 'assistant',
        kind: 'text',
        content: '姝ｅ湪鐢熸垚...',
        streaming: true,
        trace: buildChatTrace('', defaultRouteDecision),
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
      if (supervisor.state.value !== 'canceled') {
        options.errorMessage.value = error instanceof Error ? error.message : '发送失败，请重试。';
        const assistantMessage = chatMessages.value.find((item) => item.id === assistantMessageId);
        if (assistantMessage) {
          assistantMessage.content = options.errorMessage.value;
          assistantMessage.streaming = false;
          assistantMessage.trace = null;
        }
      }
    } finally {
      syncRequestPending.value = false;
      activeAssistantMessageId.value = '';
    }
  };

  const applyQuickPrompt = async (prompt: string) => {
    chatInput.value = prompt;
  };

  const dispose = () => {
    if (CANCELABLE_MACHINE_STATES.has(supervisor.state.value)) {
      supervisor.cancel();
    }

    void chatRenderEngine.dispose();
    void chatTypewriterSelector.reset();
  };

  return {
    appendChatMessage,
    applyQuickPrompt,
    chatInput,
    chatMessages,
    activeAssistantMessageId,
    chatSpanRunId,
    chatSpanTree,
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




