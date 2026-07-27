import { reactive, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

import {
  createResumeFormState,
  type ApiEnvelope,
  type ChatResponseData,
  type ConversationDto,
} from '../utils/resume';
import { useResumeConversation } from './useResumeConversation';

function createForm() {
  return reactive({
    ...createResumeFormState(),
    fullName: '张三',
    background: '后端工程师',
    targetRole: '平台工程师',
    skillsText: 'TypeScript, Node.js',
  });
}

function createSseStream(frames: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
}

describe('useResumeConversation', () => {
  it('creates and syncs conversation context only once for identical content', async () => {
    const form = createForm();
    const errorMessage = ref('');
    const statusMessage = ref('');
    const apiFetch = vi.fn(async (path: string) => {
      if (path === '/conversations') {
        return {
          success: true,
          data: { id: 'conv-1', title: 't', status: 'open', createdAt: '', updatedAt: '' } satisfies ConversationDto,
          error: null,
          requestId: 'req-1',
        } satisfies ApiEnvelope<ConversationDto>;
      }

      return {
        success: true,
        data: { id: 'msg-1', role: 'system', content: '', intent: null, agentName: null, createdAt: '' },
        error: null,
        requestId: 'req-2',
      };
    });

    const conversation = useResumeConversation({
      form,
      token: ref(null),
      clearAuth: vi.fn(),
      errorMessage,
      statusMessage,
      apiFetch,
    });

    await conversation.syncSystemContext();
    await conversation.syncSystemContext();

    expect(conversation.conversationId.value).toBe('conv-1');
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch).toHaveBeenNthCalledWith(
      2,
      '/conversations/conv-1/messages',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('seeds generated conversation into API and local messages', async () => {
    const form = createForm();
    const errorMessage = ref('');
    const statusMessage = ref('');
    const apiFetch = vi.fn(async (path: string) => {
      if (path === '/conversations') {
        return {
          success: true,
          data: { id: 'conv-1', title: 't', status: 'open', createdAt: '', updatedAt: '' },
          error: null,
          requestId: 'req-1',
        };
      }

      return {
        success: true,
        data: { id: 'msg-1', role: 'assistant', content: '', intent: null, agentName: null, createdAt: '' },
        error: null,
        requestId: 'req-2',
      };
    });

    const conversation = useResumeConversation({
      form,
      token: ref(null),
      clearAuth: vi.fn(),
      errorMessage,
      statusMessage,
      apiFetch,
      getVariantSnapshot: () => '# 技术版',
      createId: (() => {
        let index = 0;
        return (role: string) => `${role}-${++index}`;
      })(),
    });

    await conversation.seedGeneratedConversation();

    expect(apiFetch).toHaveBeenCalledTimes(4);
    expect(conversation.chatMessages.value.slice(-2)).toMatchObject([
      { role: 'user', content: '请基于当前表单信息生成技术版、业务版和综合版三版简历。' },
      { role: 'assistant', content: '# 技术版' },
    ]);
  });

  it('sends chat messages through sync API when token is missing', async () => {
    const form = createForm();
    const errorMessage = ref('');
    const statusMessage = ref('');
    const apiFetch = vi.fn(async (path: string) => {
      if (path === '/conversations') {
        return {
          success: true,
          data: { id: 'conv-1', title: 't', status: 'open', createdAt: '', updatedAt: '' },
          error: null,
          requestId: 'req-1',
        };
      }

      if (path === '/chat/message') {
        return {
          success: true,
          data: {
            conversationId: 'conv-1',
            agentRunId: 'run-1',
            createdConversation: false,
            message: { id: 'user-1', role: 'user', content: '帮我优化', intent: null, agentName: null, createdAt: '' },
            assistantMessage: {
              id: 'assistant-1',
              role: 'assistant',
              content: '这是优化建议',
              intent: null,
              agentName: 'resume',
              toolCallSummary: [{ toolName: 'search_docs', success: true, latencyMs: 12 }],
              createdAt: '',
            },
            routeDecision: {
              intent: 'resume_help',
              selectedAgent: 'resume-agent',
              reason: 'matched',
              confidence: 0.9,
              fallbackUsed: false,
              matchedRules: [],
            },
            recentMessages: [],
          } satisfies ChatResponseData,
          error: null,
          requestId: 'req-2',
        };
      }

      return {
        success: true,
        data: { id: 'msg-1', role: 'system', content: '', intent: null, agentName: null, createdAt: '' },
        error: null,
        requestId: 'req-3',
      };
    });

    const conversation = useResumeConversation({
      form,
      token: ref(null),
      clearAuth: vi.fn(),
      errorMessage,
      statusMessage,
      apiFetch,
      createId: (() => {
        let index = 0;
        return (role: string) => `${role}-${++index}`;
      })(),
      now: () => '2026-07-15T00:00:00.000Z',
    });

    conversation.chatInput.value = '帮我优化';
    await conversation.sendChatMessage();

    expect(conversation.chatInput.value).toBe('');
    expect(statusMessage.value).toBe('已路由到 resume-agent');
    expect(conversation.chatMessages.value.slice(-2)).toMatchObject([
      { role: 'user', content: '帮我优化' },
      {
        role: 'assistant',
        content: '这是优化建议',
        streaming: false,
      },
    ]);
    expect(conversation.chatMessages.value.at(-1)?.trace?.toolCalls).toMatchObject([
      { toolName: 'search_docs', status: 'success' },
    ]);
  });

  it('consumes streaming chat responses and records route and tool traces', async () => {
    const form = createForm();
    const errorMessage = ref('');
    const statusMessage = ref('');
    const apiFetch = vi.fn(async (path: string) => {
      if (path === '/conversations') {
        return {
          success: true,
          data: { id: 'conv-1', title: 't', status: 'open', createdAt: '', updatedAt: '' },
          error: null,
          requestId: 'req-1',
        };
      }

      return {
        success: true,
        data: { id: 'msg-1', role: 'system', content: '', intent: null, agentName: null, createdAt: '' },
        error: null,
        requestId: 'req-2',
      };
    });
    const fetchFn = vi.fn(async () => {
      return {
        status: 200,
        ok: true,
        body: createSseStream([
          'event: start\ndata: {"ts":"1","runId":"chat_stream_req-stream-1","spanId":"chat_stream_req-stream-1"}\n\n',
          'event: route_decision\ndata: {"routeDecision":{"intent":"resume_help","selectedAgent":"planner","reason":"match","confidence":0.8,"fallbackUsed":false,"matchedRules":[]},"ts":"2","runId":"chat_stream_req-stream-1","spanId":"chat_stream_req-stream-1"}\n\n',
          'event: agent.step.started\ndata: {"agentRunId":"run-1","name":"planner","startedAt":"2.5","parentSpanId":"chat_stream_req-stream-1","status":"running","runId":"chat_stream_req-stream-1","spanId":"chat_stream_req-stream-1:step:1"}\n\n',
          'event: tool.call.started\ndata: {"agentRunId":"run-1","toolName":"search_docs","startedAt":"3","parentSpanId":"chat_stream_req-stream-1:step:1","status":"running","runId":"chat_stream_req-stream-1","spanId":"chat_stream_req-stream-1:tool:1:search_docs"}\n\n',
          'event: assistant_chunk\ndata: {"text":"第一段","parentSpanId":"chat_stream_req-stream-1:step:1","runId":"chat_stream_req-stream-1","spanId":"chat_stream_req-stream-1:text:1"}\n\n',
          'event: tool.call.finished\ndata: {"agentRunId":"run-1","toolName":"search_docs","success":true,"latencyMs":15,"startedAt":"3","finishedAt":"4","parentSpanId":"chat_stream_req-stream-1:step:1","status":"succeeded","runId":"chat_stream_req-stream-1","spanId":"chat_stream_req-stream-1:tool:1:search_docs"}\n\n',
          'event: assistant_done\ndata: {"content":"第一段第二段","toolCalls":[{"toolName":"search_docs","success":true,"latencyMs":15}],"parentSpanId":"chat_stream_req-stream-1:step:1","runId":"chat_stream_req-stream-1","spanId":"chat_stream_req-stream-1:text:1"}\n\n',
          'event: agent.step.finished\ndata: {"agentRunId":"run-1","name":"planner","startedAt":"2.5","finishedAt":"5","parentSpanId":"chat_stream_req-stream-1","status":"succeeded","runId":"chat_stream_req-stream-1","spanId":"chat_stream_req-stream-1:step:1"}\n\n',
          'event: done\ndata: {"conversationId":"conv-1","agentRunId":"run-1","runId":"chat_stream_req-stream-1","spanId":"chat_stream_req-stream-1"}\n\n',
        ]),
      } as Response;
    });

    const conversation = useResumeConversation({
      form,
      token: ref('token-1'),
      clearAuth: vi.fn(),
      errorMessage,
      statusMessage,
      apiFetch,
      fetchFn,
      createId: (() => {
        let index = 0;
        return (role: string) => `${role}-${++index}`;
      })(),
      now: () => '2026-07-15T00:00:00.000Z',
    });

    conversation.chatInput.value = '给我建议';
    await conversation.sendChatMessage();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(statusMessage.value).toBe('已路由到 planner');
    expect(conversation.chatMessages.value.at(-1)).toMatchObject({
      role: 'assistant',
      content: '第一段第二段',
      streaming: false,
      trace: {
        agentRunId: 'run-1',
        routeDecision: { selectedAgent: 'planner' },
        done: true,
      },
    });
    expect(conversation.chatMessages.value.at(-1)?.trace?.toolCalls).toMatchObject([
      { toolName: 'search_docs', status: 'success', latencyMs: 15 },
    ]);
    expect(conversation.chatSpanRunId.value).toBe('chat_stream_req-stream-1');
    expect(conversation.chatSpanTree.value.map((node) => node.span.spanId)).toEqual(['chat_stream_req-stream-1']);
    expect(conversation.chatSpanTree.value[0]?.children.map((node) => node.span.spanId)).toEqual([
      'chat_stream_req-stream-1:step:1',
    ]);
  });

  it('parses split SSE chunks, blank lines, and preserves raw event order', async () => {
    const form = createForm();
    const errorMessage = ref('');
    const statusMessage = ref('');
    const apiFetch = vi.fn(async (path: string) => {
      if (path === '/conversations') {
        return {
          success: true,
          data: { id: 'conv-1', title: 't', status: 'open', createdAt: '', updatedAt: '' },
          error: null,
          requestId: 'req-1',
        };
      }

      return {
        success: true,
        data: { id: 'msg-1', role: 'system', content: '', intent: null, agentName: null, createdAt: '' },
        error: null,
        requestId: 'req-2',
      };
    });
    const fetchFn = vi.fn(async () => {
      return {
        status: 200,
        ok: true,
        body: createSseStream([
          'event: start\ndata: {"ts":"1"}\n\n\n',
          'event: route_decision\ndata: {"routeDecision":{"intent":"resume_help","selectedAgent":"planner","reason":"match","confidence":0.8,"fallbackUsed":false,"matchedRules":[]},"ts":"2"}\n\nevent: tool_start\ndata: {"toolName":"search_docs","startedAt":"3","ts":"3"}\n\n',
          'event: assistant_chunk\ndata: {"text":"first "}\n\nevent: assistant_chunk\ndata:',
          ' {"text":"second"}\n\nevent: tool_done\ndata: {"toolName":"search_docs","success":true,"latencyMs":15,"ts":"4"}\n\n',
          'event: assistant_done\ndata: {"content":"first second","toolCalls":[{"toolName":"search_docs","success":true,"latencyMs":15}],"ts":"5"}\n\n',
          'event: done\ndata: {"conversationId":"conv-1","agentRunId":"run-1","ts":"6"}\n\n',
        ]),
      } as Response;
    });

    const conversation = useResumeConversation({
      form,
      token: ref('token-1'),
      clearAuth: vi.fn(),
      errorMessage,
      statusMessage,
      apiFetch,
      fetchFn,
      createId: (() => {
        let index = 0;
        return (role: string) => `${role}-${++index}`;
      })(),
      now: () => '2026-07-15T00:00:00.000Z',
    });

    conversation.chatInput.value = 'stream parser';
    await conversation.sendChatMessage();

    const assistantMessage = conversation.chatMessages.value.at(-1);

    expect(assistantMessage).toMatchObject({
      role: 'assistant',
      content: 'first second',
      streaming: false,
      trace: {
        agentRunId: 'run-1',
        routeDecision: { selectedAgent: 'planner' },
        routeDecisionStarted: true,
        done: true,
      },
    });
    expect(assistantMessage?.trace?.toolCalls).toMatchObject([
      {
        toolName: 'search_docs',
        status: 'success',
        startedAt: '3',
        latencyMs: 15,
      },
    ]);
    expect(assistantMessage?.trace?.rawEvents?.map((item) => item.event)).toEqual([
      'start',
      'route_decision',
      'tool_start',
      'assistant_chunk',
      'assistant_chunk',
      'tool_done',
      'assistant_done',
      'done',
    ]);
  });

  it('marks failed tool traces and surfaces SSE error payloads', async () => {
    const form = createForm();
    const errorMessage = ref('');
    const statusMessage = ref('');
    const apiFetch = vi.fn(async (path: string) => {
      if (path === '/conversations') {
        return {
          success: true,
          data: { id: 'conv-1', title: 't', status: 'open', createdAt: '', updatedAt: '' },
          error: null,
          requestId: 'req-1',
        };
      }

      return {
        success: true,
        data: { id: 'msg-1', role: 'system', content: '', intent: null, agentName: null, createdAt: '' },
        error: null,
        requestId: 'req-2',
      };
    });
    const fetchFn = vi.fn(async () => {
      return {
        status: 200,
        ok: true,
        body: createSseStream([
          'event: start\ndata: {"ts":"1"}\n\n',
          'event: tool_start\ndata: {"toolName":"jd_parse_and_score","startedAt":"3","ts":"3"}\n\n',
          'event: tool_done\ndata: {"toolName":"jd_parse_and_score","success":false,"latencyMs":27,"errorCode":"TOOL_FAIL","errorMessage":"tool failed","ts":"4"}\n\n',
          'event: error\ndata: {"code":"TOOL_FAIL","message":"tool failed","ts":"5"}\n\n',
        ]),
      } as Response;
    });

    const conversation = useResumeConversation({
      form,
      token: ref('token-1'),
      clearAuth: vi.fn(),
      errorMessage,
      statusMessage,
      apiFetch,
      fetchFn,
      createId: (() => {
        let index = 0;
        return (role: string) => `${role}-${++index}`;
      })(),
      now: () => '2026-07-15T00:00:00.000Z',
    });

    conversation.chatInput.value = 'failing stream';
    await conversation.sendChatMessage();

    const assistantMessage = conversation.chatMessages.value.at(-1);

    expect(errorMessage.value).toBe('[TOOL_FAIL] tool failed');
    expect(assistantMessage).toMatchObject({
      role: 'assistant',
      content: '[TOOL_FAIL] tool failed',
      streaming: false,
    });
    expect(assistantMessage?.trace?.toolCalls).toMatchObject([
      {
        toolName: 'jd_parse_and_score',
        status: 'fail',
        success: false,
        startedAt: '3',
        latencyMs: 27,
        errorCode: 'TOOL_FAIL',
        errorMessage: 'tool failed',
      },
    ]);
    expect(assistantMessage?.trace?.rawEvents?.map((item) => item.event)).toEqual([
      'start',
      'tool_start',
      'tool_done',
      'error',
    ]);
  });

  it('converts send failures into assistant error messages', async () => {
    const form = createForm();
    const errorMessage = ref('');
    const statusMessage = ref('');
    const apiFetch = vi.fn(async (path: string) => {
      if (path === '/conversations') {
        return {
          success: true,
          data: { id: 'conv-1', title: 't', status: 'open', createdAt: '', updatedAt: '' },
          error: null,
          requestId: 'req-1',
        };
      }

      if (path === '/chat/message') {
        throw new Error('boom');
      }

      return {
        success: true,
        data: { id: 'msg-1', role: 'system', content: '', intent: null, agentName: null, createdAt: '' },
        error: null,
        requestId: 'req-2',
      };
    });

    const conversation = useResumeConversation({
      form,
      token: ref(null),
      clearAuth: vi.fn(),
      errorMessage,
      statusMessage,
      apiFetch,
      createId: (() => {
        let index = 0;
        return (role: string) => `${role}-${++index}`;
      })(),
    });

    conversation.chatInput.value = '失败案例';
    await conversation.sendChatMessage();

    expect(errorMessage.value).toBe('boom');
    expect(conversation.chatMessages.value.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'boom',
      streaming: false,
      trace: null,
    });
  });
});
