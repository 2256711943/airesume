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
  type ChatToolCallTrace,
  type ConversationDto,
  type ResumeFormState,
} from '../utils/resume';
import {
  isChatSseEventName,
  type ChatSseEvent,
} from '../utils/sse-events';
import { useApiFetch } from './useApiFetch';
import { useSseMachine, type SseMachineStateSnapshot, type SseMachineStateValue } from './useSseMachine';

const API_BASE_URL = 'http://127.0.0.1:3001';

type ApiFetch = typeof useApiFetch;
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

const RESETTABLE_MACHINE_STATES = new Set<SseMachineStateValue>(['done', 'error', 'canceled']);
const CANCELABLE_MACHINE_STATES = new Set<SseMachineStateValue>(['connecting', 'streaming', 'paused']);

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
  const lastSyncedSystemContext = ref('');
  const activeAssistantMessageId = ref('');
  const syncRequestPending = ref(false);

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

    const response: ApiEnvelope<ConversationDto> = await apiFetch('/conversations', {
      method: 'POST',
      body: {
        title: currentChatTitle.value,
      },
    });

    if (!response.success || !response.data) {
      throw new Error(response.error?.message || '閸掓稑缂撴导姘崇樈婢惰精瑙?');
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
    await apiFetch('/conversations/' + conversation + '/messages', {
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
        target.content = '正在整理回复...';
        break;
      case 'route_decision':
        target.trace.routeDecision = event.routeDecision;
        target.trace.routeDecisionStarted = true;
        options.statusMessage.value = '已路由到 ' + event.routeDecision.selectedAgent;
        break;
      case 'tool_start':
        if (event.toolName?.trim()) {
          target.trace.toolCalls.push(createPendingToolCall(event.toolName, event.startedAt ?? nowIso));
        }
        break;
      case 'tool_done': {
        if (!event.toolName?.trim()) {
          return;
        }

        const index = findPendingToolCallIndex(target.trace.toolCalls, event.toolName);
        const toolCall: ChatToolCallTrace = {
          toolName: event.toolName,
          status: event.success === true ? 'success' : 'fail',
          success: event.success === true,
          latencyMs: event.latencyMs,
          errorCode: event.errorCode,
          errorMessage: event.errorMessage,
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
      case 'assistant_chunk':
        if (event.text) {
          target.content = target.content === '濮濓絽婀弫瀵告倞閸ョ偛顦?..' ? event.text : `${target.content}${event.text}`;
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

        if (event.toolCalls) {
          for (const record of event.toolCalls) {
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
        break;
      case 'done':
        if (event.conversationId) {
          conversationId.value = event.conversationId;
        }

        if (event.agentRunId) {
          target.trace.agentRunId = event.agentRunId;
        }

        if (event.routeDecision) {
          target.trace.routeDecision = event.routeDecision;
          target.trace.routeDecisionStarted = true;
        }

        target.streaming = false;
        target.trace.done = true;
        break;
      case 'error':
        options.errorMessage.value = `${event.code ? `[${event.code}] ` : ''}${event.message ?? '閸氬海顏潻鏂挎礀娴滃棗绱撶敮闈╃礉鐠囬鈼㈤崥搴ㄥ櫢鐠囨洏鈧?'}`;
        target.streaming = false;
        target.content = options.errorMessage.value;
        break;
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
        if (!isChatSseEventName(eventName)) {
          return;
        }

        handleChatStreamEvent(
          assistantMessageId,
          {
            event: eventName,
            ...payload,
          } as ChatSseEvent,
        );
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

  const chatMachine = useSseMachine({
    consumeResponse: async (response) => {
      if (response.status === 401) {
        options.clearAuth();
        throw new Error('登录已过期，请重新登录。');
      }

      if (!response.ok) {
        throw new Error(`閼卞﹤銇夐幒銉ュ經鏉╂柨娲栭柨娆掝嚖閿涙TTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error('聊天接口返回了无效的数据流。');
      }

      if (!activeAssistantMessageId.value) {
        throw new Error('当前没有可消费的聊天流。');
      }

      await consumeChatSseStream(response.body, activeAssistantMessageId.value);
    },
  });
  const chatMachineState = ref<SseMachineStateSnapshot>(chatMachine.state);
  const sendingMessage = computed(() => {
    const state = chatMachineState.value.value;
    return syncRequestPending.value || state === 'connecting' || state === 'streaming' || state === 'paused' || state === 'retrying';
  });

  chatMachine.onStateChange = (_, next) => {
    chatMachineState.value = next;
  };

  const sendChatMessageSync = async (payload: {
    conversation: string;
    assistantMessageId: string;
    content: string;
  }) => {
    const response: ApiEnvelope<ChatResponseData> = await apiFetch('/chat/message', {
      method: 'POST',
      body: {
        conversationId: payload.conversation,
        message: payload.content,
        title: conversationId.value ? undefined : currentChatTitle.value,
        historyLimit: 12,
      },
    });

    if (!response.success || !response.data) {
      throw new Error(response.error?.message || '创建会话失败');
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

    if (RESETTABLE_MACHINE_STATES.has(chatMachine.state.value)) {
      chatMachine.reset();
    }

    activeAssistantMessageId.value = payload.assistantMessageId;

    await chatMachine.connect(
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
        }),
        signal: chatMachine.signal,
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

    const assistantMessageId = createId('assistant');

    try {
      const conversation = await syncSystemContext();
      appendChatMessage('user', content);
      chatMessages.value.push({
        id: assistantMessageId,
        role: 'assistant',
        kind: 'text',
        content: '濮濓絽婀弫瀵告倞閸ョ偛顦?..',
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
      if (chatMachine.state.value !== 'canceled') {
        options.errorMessage.value = error instanceof Error ? error.message : '发送失败，请稍后重试。';
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
    if (CANCELABLE_MACHINE_STATES.has(chatMachine.state.value)) {
      chatMachine.cancel();
    }
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
