import { computed, ref, type Ref } from 'vue';

import { createAuthHeaders } from '../utils/auth';
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
  type ChatRouteDecision,
  type ChatSseAssistantDonePayload,
  type ChatSseDonePayload,
  type ChatSseErrorPayload,
  type ChatSseEventName,
  type ChatToolCallTrace,
  type ConversationDto,
  type ConversationMessageDto,
  type ResumeFormState,
  type StreamChunkPayload,
} from '../utils/resume';
import { useApiFetch } from './useApiFetch';

const API_BASE_URL = 'http://127.0.0.1:3001';

type ApiFetch = <T>(path: string, options?: Record<string, unknown>) => Promise<T>;
type FetchFn = typeof fetch;

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

function isRouteDecision(value: unknown): value is ChatRouteDecision {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return typeof (value as ChatRouteDecision).selectedAgent === 'string';
}

function createPendingToolCall(toolName: string, startedAt: string): ChatToolCallTrace {
  return {
    toolName,
    status: 'pending',
    startedAt,
    ts: startedAt,
  };
}

function findPendingToolCallIndex(toolCalls: ChatToolCallTrace[], toolName: string): number {
  return toolCalls.findLastIndex((item) => item.toolName === toolName && item.status === 'pending');
}

function findLatestToolCallIndex(toolCalls: ChatToolCallTrace[], toolName: string): number {
  return toolCalls.findLastIndex((item) => item.toolName === toolName);
}

export function useResumeConversation(options: UseResumeConversationOptions) {
  const apiFetch = options.apiFetch ?? useApiFetch;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? ((role: string) => createChatMessageId(role));

  const chatMessages = ref<ChatMessage[]>(getInitialChatMessages());
  const chatInput = ref('');
  const conversationId = ref('');
  const sendingMessage = ref(false);
  const lastSyncedSystemContext = ref('');
  const currentChatStreamController = ref<AbortController | null>(null);

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
    await apiFetch<ApiEnvelope<ConversationMessageDto>>(`/conversations/${conversation}/messages`, {
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

  const handleChatStreamEvent = (assistantMessageId: string, eventName: string, payload: Record<string, unknown>) => {
    const target = chatMessages.value.find((item) => item.id === assistantMessageId);
    if (!target) {
      return;
    }

    const event = eventName as ChatSseEventName;
    if (!target.trace) {
      target.trace = buildChatTrace();
    }

    const nowIso = now();
    target.trace.rawEvents?.push({
      event,
      data: payload,
      ts: typeof payload.ts === 'string' ? payload.ts : nowIso,
    });

    if (event === 'start') {
      target.streaming = true;
      target.trace.routeDecisionStarted = false;
      target.trace.done = false;
      target.content = '正在整理回复...';
      return;
    }

    if (event === 'route_decision') {
      if (isRouteDecision(payload.routeDecision)) {
        target.trace.routeDecision = payload.routeDecision;
        target.trace.routeDecisionStarted = true;
        options.statusMessage.value = `已路由到 ${payload.routeDecision.selectedAgent}`;
      }
      return;
    }

    if (event === 'tool_start') {
      if (typeof payload.toolName === 'string' && payload.toolName.trim()) {
        target.trace.toolCalls.push(
          createPendingToolCall(
            payload.toolName,
            typeof payload.startedAt === 'string' ? payload.startedAt : nowIso,
          ),
        );
      }
      return;
    }

    if (event === 'tool_done') {
      if (typeof payload.toolName !== 'string' || !payload.toolName.trim()) {
        return;
      }

      const index = findPendingToolCallIndex(target.trace.toolCalls, payload.toolName);
      const toolCall: ChatToolCallTrace = {
        toolName: payload.toolName,
        status: payload.success === true ? 'success' : 'fail',
        success: payload.success === true,
        latencyMs: typeof payload.latencyMs === 'number' ? payload.latencyMs : undefined,
        errorCode: typeof payload.errorCode === 'string' ? payload.errorCode : undefined,
        errorMessage: typeof payload.errorMessage === 'string' ? payload.errorMessage : undefined,
        doneAt: nowIso,
        ts: nowIso,
      };

      if (index >= 0) {
        target.trace.toolCalls[index] = {
          ...target.trace.toolCalls[index],
          ...toolCall,
        };
        return;
      }

      target.trace.toolCalls.push(toolCall);
      return;
    }

    if (event === 'assistant_chunk') {
      const chunkPayload = payload as StreamChunkPayload;
      if (typeof chunkPayload.text === 'string') {
        target.content = target.content === '正在整理回复...' ? chunkPayload.text : `${target.content}${chunkPayload.text}`;
        target.streaming = true;
      }
      return;
    }

    if (event === 'assistant_done') {
      const donePayload = payload as ChatSseAssistantDonePayload;
      if (typeof donePayload.content === 'string') {
        target.content = donePayload.content;
      }

      if (isRouteDecision(donePayload.routeDecision)) {
        target.trace.routeDecision = donePayload.routeDecision;
        target.trace.routeDecisionStarted = true;
      }

      if (Array.isArray(donePayload.toolCalls)) {
        for (const record of donePayload.toolCalls) {
          const index = findPendingToolCallIndex(target.trace.toolCalls, record.toolName);
          const latestIndex = index >= 0 ? index : findLatestToolCallIndex(target.trace.toolCalls, record.toolName);
          const fallback: ChatToolCallTrace = {
            toolName: record.toolName,
            status: record.success ? 'success' : 'fail',
            success: record.success,
            latencyMs: record.latencyMs,
            errorCode: record.errorCode,
            errorMessage: record.errorMessage,
            doneAt: nowIso,
            ts: nowIso,
          };

          if (latestIndex >= 0) {
            target.trace.toolCalls[latestIndex] = {
              ...target.trace.toolCalls[latestIndex],
              ...fallback,
            };
            continue;
          }

          target.trace.toolCalls.push(fallback);
        }
      }

      target.streaming = false;
      target.trace.done = true;
      return;
    }

    if (event === 'done') {
      const donePayload = payload as ChatSseDonePayload;
      if (typeof donePayload.conversationId === 'string') {
        conversationId.value = donePayload.conversationId;
      }

      if (typeof donePayload.agentRunId === 'string') {
        target.trace.agentRunId = donePayload.agentRunId;
      }

      if (isRouteDecision(donePayload.routeDecision)) {
        target.trace.routeDecision = donePayload.routeDecision;
        target.trace.routeDecisionStarted = true;
      }

      target.streaming = false;
      target.trace.done = true;
      return;
    }

    if (event === 'error') {
      const errorPayload = payload as ChatSseErrorPayload;
      const code = typeof errorPayload.code === 'string' ? `[${errorPayload.code}] ` : '';
      const message = typeof errorPayload.message === 'string' ? errorPayload.message : '后端返回了异常，请稍后重试。';
      options.errorMessage.value = `${code}${message}`;
      target.streaming = false;
      target.content = options.errorMessage.value;
    }
  };

  const consumeChatSseStream = async (body: ReadableStream<Uint8Array>, assistantMessageId: string) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const parseFrame = (frame: string) => {
      const lines = frame.split('\n');
      let eventName = '';
      const dataParts: string[] = [];

      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataParts.push(line.slice(5).trim());
        }
      }

      if (!eventName || dataParts.length === 0) {
        return;
      }

      try {
        const payload = JSON.parse(dataParts.join('\n')) as Record<string, unknown>;
        handleChatStreamEvent(assistantMessageId, eventName, payload);
      } catch {
        // Ignore malformed SSE frames and continue consuming the stream.
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        parseFrame(frame);
      }
    }

    if (buffer.trim().length > 0) {
      parseFrame(buffer);
    }
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
      throw new Error(response.error?.message || '消息发送失败');
    }

    conversationId.value = response.data.conversationId;
    const assistantContent = response.data.assistantMessage?.content?.trim() || '我已收到你的问题。';
    updateChatMessage(payload.assistantMessageId, {
      content: assistantContent,
      streaming: false,
      trace: {
        agentRunId: response.data.agentRunId,
        routeDecision: response.data.routeDecision,
        toolCalls:
          response.data.assistantMessage?.toolCallSummary?.map((toolCall) => ({
            ...toolCall,
            status: toolCall.success ? 'success' : 'fail',
            ts: now(),
            doneAt: now(),
            startedAt: undefined,
          })) ?? [],
        rawEvents: [],
        routeDecisionStarted: true,
        done: true,
      },
    });
    options.statusMessage.value = response.data.routeDecision?.selectedAgent
      ? `已路由到 ${response.data.routeDecision.selectedAgent}`
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

    const controller = new AbortController();
    currentChatStreamController.value = controller;

    const response = await fetchFn(`${API_BASE_URL}/chat/message/stream`, {
      method: 'POST',
      headers: {
        ...createAuthHeaders(options.token.value),
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        conversationId: payload.conversation,
        message: payload.content,
        title: conversationId.value ? undefined : currentChatTitle.value,
        historyLimit: 12,
      }),
      signal: controller.signal,
    });

    if (response.status === 401) {
      options.clearAuth();
      throw new Error('登录已过期，请重新登录。');
    }

    if (!response.ok) {
      throw new Error(`聊天接口返回错误：HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error('聊天接口返回了无效的流数据。');
    }

    await consumeChatSseStream(response.body, payload.assistantMessageId);
  };

  const sendChatMessage = async () => {
    const content = chatInput.value.trim();
    if (!content || sendingMessage.value) {
      return;
    }

    chatInput.value = '';
    options.errorMessage.value = '';
    sendingMessage.value = true;

    const assistantMessageId = createId('assistant');

    try {
      const conversation = await syncSystemContext();
      appendChatMessage('user', content);
      chatMessages.value.push({
        id: assistantMessageId,
        role: 'assistant',
        kind: 'text',
        content: '正在整理回复...',
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

      await sendChatMessageSync({
        assistantMessageId,
        conversation,
        content,
      });
    } catch (error) {
      options.errorMessage.value = error instanceof Error ? error.message : '发送失败，请稍后重试。';
      const assistantMessage = chatMessages.value.find((item) => item.id === assistantMessageId);
      if (assistantMessage) {
        assistantMessage.content = options.errorMessage.value;
        assistantMessage.streaming = false;
        assistantMessage.trace = null;
      }
    } finally {
      sendingMessage.value = false;
      currentChatStreamController.value = null;
    }
  };

  const applyQuickPrompt = async (prompt: string) => {
    chatInput.value = prompt;
  };

  const dispose = () => {
    currentChatStreamController.value?.abort();
  };

  return {
    appendChatMessage,
    applyQuickPrompt,
    chatInput,
    chatMessages,
    conversationId,
    currentChatTitle,
    dispose,
    formSummaryLines,
    lastSyncedSystemContext,
    seedGeneratedConversation,
    sendChatMessage,
    sendingMessage,
    syncSystemContext,
    updateChatMessage,
  };
}
