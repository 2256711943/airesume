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
import { consumeSseEventEnvelopeStream, SseStreamDisconnectedError } from '../utils/sse';
import { useApiFetch } from './useApiFetch';
import { useSseSupervisor } from './useSseSupervisor';
import type { SseMachineStateSnapshot, SseMachineStateValue } from './useSseMachine';

const API_BASE_URL = 'http://127.0.0.1:3001';

type ApiFetch = (path: string, options?: Record<string, unknown>) => Promise<any>;
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

const RESETTABLE_MACHINE_STATES = new Set<SseMachineStateValue>(['done', 'error', 'canceled']);
const CANCELABLE_MACHINE_STATES = new Set<SseMachineStateValue>(['connecting', 'streaming', 'paused', 'retrying']);

function createPendingToolCall(toolName: string, startedAt: string): ChatToolCallTrace {
  return {
    toolName,
    status: 'pending',
    startedAt,
    ts: startedAt,
  };
}

function findPendingToolCallIndex(toolCalls: ChatToolCallTrace[], toolName: string): number {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const item = toolCalls[index];
    if (item.toolName === toolName && item.status === 'pending') {
      return index;
    }
  }

  return -1;
}

function findLatestToolCallIndex(toolCalls: ChatToolCallTrace[], toolName: string): number {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    if (toolCalls[index].toolName === toolName) {
      return index;
    }
  }

  return -1;
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
      throw new Error(response.error?.message || '闁告帗绋戠紓鎾村濮樺磭妯堝鎯扮簿鐟?');
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
    const requestMessage = '璇峰熀浜庡綋鍓嶈〃鍗曚俊鎭敓鎴愭妧鏈増銆佷笟鍔＄増鍜岀患鍚堢増涓夌増绠€鍘嗐€?';
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
        target.content = '姝ｅ湪鏁寸悊鍥炲...';
        break;
      case 'route_decision':
        target.trace.routeDecision = event.routeDecision;
        target.trace.routeDecisionStarted = true;
        options.statusMessage.value = '宸茶矾鐢卞埌 ' + event.routeDecision.selectedAgent;
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
          target.content = target.content === '婵繐绲藉﹢顏堝极鐎靛憡鍊為柛銉у仜椤?..' ? event.text : `${target.content}${event.text}`;
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
        options.errorMessage.value = `${event.code ? `[${event.code}] ` : ''}${event.message ?? '闁告艾娴烽顒佹交閺傛寧绀€濞存粌妫楃槐鎾舵暜闂堚晝绀夐悹鍥棑閳笺垽宕ユ惔銊ユ閻犲洦娲忛埀?'}`;
        target.streaming = false;
        target.content = options.errorMessage.value;
        break;
    }
  };

  const supervisor = useSseSupervisor({
    consumeResponse: async (response) => {
      if (response.status === 401) {
        options.clearAuth();
        throw new Error('鐧诲綍宸茶繃鏈燂紝璇烽噸鏂扮櫥褰曘€?');
      }

      if (!response.ok) {
        throw new Error(`闁煎崬锕ら妵澶愬箳閵夈儱缍撻弶鈺傛煥濞叉牠鏌ㄥ▎鎺濆殩闁挎稒顑朤TP ${response.status}`);
      }

      if (!response.body) {
        throw new Error('鑱婂ぉ鎺ュ彛杩斿洖浜嗘棤鏁堢殑鏁版嵁娴併€?');
      }

      if (!activeAssistantMessageId.value) {
        throw new Error('褰撳墠娌℃湁鍙秷璐圭殑鑱婂ぉ娴併€?');
      }

      const assistantMessageId = activeAssistantMessageId.value;
      const result = await consumeSseEventEnvelopeStream(response.body, {
        lastSeq: lastEventSeq.value,
        isTerminalEvent: (type) => type === 'done' || type === 'error',
        onEvent: (envelope) => {
          lastEventSeq.value = envelope.seq;
          if (!isChatSseEventName(envelope.type)) {
            return;
          }

          handleChatStreamEvent(
            assistantMessageId,
            {
              event: envelope.type,
              ts: envelope.ts,
              ...envelope.payload,
            } as ChatSseEvent,
          );
        },
      });

      lastEventSeq.value = result.lastSeq;
    },
    maxRetries: 1,
    shouldRetry: (error, attempt) => {
      return attempt <= 1 && lastEventSeq.value === 0 && error instanceof SseStreamDisconnectedError;
    },
  });

  const chatMachineState = ref<SseMachineStateSnapshot>(supervisor.state);
  const sendingMessage = computed(() => {
    const state = chatMachineState.value.value;
    return syncRequestPending.value || state === 'connecting' || state === 'streaming' || state === 'paused' || state === 'retrying';
  });

  supervisor.onStateChange = (_, next) => {
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
      throw new Error(response.error?.message || '鍒涘缓浼氳瘽澶辫触');
    }

    conversationId.value = response.data.conversationId;
    const assistantContent = response.data.assistantMessage?.content?.trim() || '鎴戝凡鏀跺埌浣犵殑闂銆?';
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
      ? '宸茶矾鐢卞埌 ' + response.data.routeDecision.selectedAgent
      : '娑堟伅鍙戦€佹垚鍔熴€?';
  };

  const sendChatMessageStream = async (payload: {
    conversation: string;
    content: string;
    assistantMessageId: string;
  }) => {
    if (!options.token.value) {
      throw new Error('鏈櫥褰曪紝璇峰厛閲嶆柊鐧诲綍銆?');
    }

    if (!fetchFn) {
      throw new Error('褰撳墠鐜涓嶆敮鎸佹祦寮忚姹傘€?');
    }

    if (RESETTABLE_MACHINE_STATES.has(supervisor.state.value)) {
      supervisor.reset();
    }

    activeAssistantMessageId.value = payload.assistantMessageId;
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

    const assistantMessageId = createId('assistant');

    try {
      const conversation = await syncSystemContext();
      appendChatMessage('user', content);
      chatMessages.value.push({
        id: assistantMessageId,
        role: 'assistant',
        kind: 'text',
        content: '婵繐绲藉﹢顏堝极鐎靛憡鍊為柛銉у仜椤?..',
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
        options.errorMessage.value = error instanceof Error ? error.message : '鍙戦€佸け璐ワ紝璇风◢鍚庨噸璇曘€?';
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
