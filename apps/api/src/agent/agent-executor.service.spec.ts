import type {
  AgentToolCall,
  AgentToolTraceEntry,
  OpenAiAgentClient,
} from '../common/llm/openai-agent.client';
import { ToolRegistry } from '../common/llm/tool-registry';
import type { ChatWebToolExecutor } from '../chat/tools/chat-web-tool-executor';
import { registerChatWebTools } from '../chat/tools/web-tools.schema';
import type { ContextPack } from '../memory/context-pack.types';
import { AgentConfigRegistry, registerDefaultAgents } from './agent.config';
import type { ToolCallLogService } from './tool-call-log.service';
import {
  AgentExecutorService,
  type AgentExecutionInput,
} from './agent-executor.service';

function makeInput(
  overrides: Partial<AgentExecutionInput> = {},
): AgentExecutionInput {
  return {
    agentRunId: 'run-1',
    conversationId: 'conv-1',
    messageId: 'msg-1',
    selectedAgent: 'interviewCoachAgent',
    userMessage: '请帮我准备面试回答',
    routeDecision: {
      intent: 'interview_guidance',
      selectedAgent: 'interviewCoachAgent',
      reason: 'match',
      confidence: 0.9,
      fallbackUsed: false,
      matchedRules: [],
    },
    ...overrides,
  };
}

function traceEntry(
  overrides: Partial<AgentToolTraceEntry> = {},
): AgentToolTraceEntry {
  return {
    step: 0,
    name: 'web_search',
    arguments: { query: 'NestJS' },
    result: { ok: true, data: { results: [] } },
    latencyMs: 12,
    ...overrides,
  };
}

describe('AgentExecutorService', () => {
  let agentClient: { strictSchema: boolean; runWithTools: jest.Mock };
  let registry: ToolRegistry;
  let webToolExecutor: { execute: jest.Mock };
  let toolCallLogService: { createLog: jest.Mock };
  let agentConfigRegistry: AgentConfigRegistry;
  let service: AgentExecutorService;

  beforeEach(() => {
    agentClient = {
      strictSchema: false,
      runWithTools: jest.fn(),
    };
    registry = new ToolRegistry();
    registerChatWebTools(registry);
    webToolExecutor = { execute: jest.fn() };
    toolCallLogService = {
      createLog: jest.fn().mockResolvedValue({ id: 'log-1' }),
    };
    agentConfigRegistry = new AgentConfigRegistry();
    registerDefaultAgents(agentConfigRegistry);
    service = new AgentExecutorService(
      agentClient as unknown as OpenAiAgentClient,
      registry,
      webToolExecutor as unknown as ChatWebToolExecutor,
      toolCallLogService as unknown as ToolCallLogService,
      agentConfigRegistry,
    );
  });

  it('runs all three agents through the tool loop with agent-specific prompts', async () => {
    agentClient.runWithTools.mockResolvedValue({
      outputText: 'final answer',
      toolTrace: [],
    });

    const cases = [
      {
        agent: 'resumeDiagnosisAgent' as const,
        prompt: '简历诊断助手',
        intent: 'resume_diagnosis' as const,
      },
      {
        agent: 'interviewCoachAgent' as const,
        prompt: '面试指导助手',
        intent: 'interview_guidance' as const,
      },
      {
        agent: 'careerPlannerAgent' as const,
        prompt: '职业规划助手',
        intent: 'career_planning' as const,
      },
    ];

    for (const { agent, intent } of cases) {
      await service.execute(
        makeInput({
          agentRunId: `run-${agent}`,
          selectedAgent: agent,
          routeDecision: {
            intent: intent as AgentExecutionInput['routeDecision']['intent'],
            selectedAgent: agent,
            reason: 'match',
            confidence: 0.9,
            fallbackUsed: false,
            matchedRules: [],
          },
        }),
      );
    }

    expect(agentClient.runWithTools).toHaveBeenCalledTimes(3);
    const prompts = agentClient.runWithTools.mock.calls.map(
      (call: unknown[]) => (call[0] as { instructions: string }).instructions,
    );
    expect(prompts[0]).toContain('简历诊断助手');
    expect(prompts[1]).toContain('面试指导助手');
    expect(prompts[2]).toContain('职业规划助手');
  });

  it('exposes only web tools and routes execute to the web tool executor', async () => {
    agentClient.runWithTools.mockResolvedValue({
      outputText: 'done',
      toolTrace: [],
    });

    await service.execute(makeInput());

    const [options] = agentClient.runWithTools.mock.calls[0] as [
      {
        instructions: string;
        input: string;
        tools: Array<{ name: string }>;
        execute: (call: AgentToolCall) => Promise<unknown>;
      },
    ];
    expect(options.input).toBe('请帮我准备面试回答');
    expect(options.tools.map((tool) => tool.name)).toEqual([
      'web_search',
      'web_browser',
    ]);

    await options.execute({
      callId: 'call_1',
      name: 'web_search',
      arguments: { query: 'NestJS' },
    });
    expect(webToolExecutor.execute).toHaveBeenCalledWith({
      callId: 'call_1',
      name: 'web_search',
      arguments: { query: 'NestJS' },
    });
  });

  it('maps tool trace to toolCalls and assistant text', async () => {
    agentClient.runWithTools.mockResolvedValue({
      outputText: '根据搜索结果整理如下',
      toolTrace: [traceEntry()],
    });

    const result = await service.execute(makeInput());

    expect(result.assistantText).toBe('根据搜索结果整理如下');
    expect(result.toolCalls).toEqual([
      { toolName: 'web_search', success: true, latencyMs: 12 },
    ]);
  });

  it('reports failed tool calls as unsuccessful with error message', async () => {
    const failedEntry = traceEntry({
      name: 'web_search',
      result: { ok: false, error: 'web_browser_invalid_url:blocked_ip' },
    });
    agentClient.runWithTools.mockImplementation(
      (options: { onToolDone?: (t: AgentToolTraceEntry) => void }) => {
        options.onToolDone?.(failedEntry);
        return Promise.resolve({
          outputText: '搜索失败，我基于已有信息回答',
          toolTrace: [failedEntry],
        });
      },
    );

    const onToolDone = jest.fn();
    const result = await service.execute(
      makeInput({
        toolProgress: { onToolStart: jest.fn(), onToolDone },
      }),
    );

    expect(result.toolCalls).toEqual([
      {
        toolName: 'web_search',
        success: false,
        latencyMs: 12,
      },
    ]);
    expect(onToolDone).toHaveBeenCalledWith({
      toolName: 'web_search',
      success: false,
      latencyMs: 12,
      errorMessage: 'web_browser_invalid_url:blocked_ip',
    });
    expect(toolCallLogService.createLog).toHaveBeenCalledWith({
      agentRunId: 'run-1',
      toolName: 'web_search',
      inputJson: { query: 'NestJS' },
      outputJson: { ok: false, error: 'web_browser_invalid_url:blocked_ip' },
      success: false,
      latencyMs: 12,
    });
  });

  it('injects ContextPack summary blocks into instructions when provided', async () => {
    agentClient.runWithTools.mockResolvedValue({
      outputText: 'ok',
      toolTrace: [],
    });

    const contextPack = {
      packId: 'pack-1',
      conversationId: 'conv-1',
      runId: 'run-1',
      intent: null,
      maxTokens: 4000,
      layerOrder: ['resume', 'preference', 'session'],
      selectedMemoryIds: ['m1', 'm2', 'm3'],
      droppedMemoryIds: [],
      droppedMemories: [],
      summaryBlocks: [
        {
          blockId: 'pack-1:block:1',
          type: 'memory',
          layer: 'resume',
          position: 1,
          title: 'Resume Context',
          content:
            '- 已启用简历上下文：Backend Resume（hybrid）；核心技能：NestJS、Node.js',
          memoryIds: ['m1'],
          tokenEstimate: 20,
          truncated: false,
        },
        {
          blockId: 'pack-1:block:2',
          type: 'system_instruction',
          layer: 'preference',
          position: 2,
          title: 'Display Preferences',
          content: '- 用中文回答\n- 回答保持简洁',
          memoryIds: ['m2'],
          tokenEstimate: 12,
          truncated: false,
        },
        {
          blockId: 'pack-1:block:3',
          type: 'summary',
          layer: 'session',
          position: 3,
          title: 'Conversation Summary',
          content: '- user: 想转行',
          memoryIds: ['m3'],
          tokenEstimate: 8,
          truncated: false,
        },
      ],
      finalPromptPreview: 'preview',
      usage: {
        maxTokens: 4000,
        reservedTokens: 500,
        usedTokens: 40,
        droppedTokens: 0,
      },
      metadata: { injectedIntoPrompt: true },
      generatedAt: new Date(),
    } as unknown as ContextPack;

    await service.execute(makeInput({ contextPack }));

    const [options] = agentClient.runWithTools.mock.calls[0] as [
      { instructions: string },
    ];
    expect(options.instructions).toContain('## 简历上下文');
    expect(options.instructions).toContain(
      '已启用简历上下文：Backend Resume（hybrid）；核心技能：NestJS、Node.js',
    );
    expect(options.instructions).toContain('## 用户偏好与约束');
    expect(options.instructions).toContain('用中文回答');
    expect(options.instructions).toContain('## 对话历史摘要');
    expect(options.instructions).toContain('user: 想转行');
  });

  it('uses the bare agent system prompt when no context pack is provided', async () => {
    agentClient.runWithTools.mockResolvedValue({
      outputText: 'ok',
      toolTrace: [],
    });

    await service.execute(makeInput());

    const [options] = agentClient.runWithTools.mock.calls[0] as [
      { instructions: string },
    ];
    expect(options.instructions).not.toContain('## ');
  });

  it('forwards tool progress to SSE events via toolProgress callbacks', async () => {
    const onToolStart = jest.fn();
    const onToolDone = jest.fn();
    agentClient.runWithTools.mockImplementation(
      (options: {
        onToolStart?: (c: AgentToolCall) => void;
        onToolDone?: (t: AgentToolTraceEntry) => void;
      }) => {
        options.onToolStart?.({
          callId: 'c1',
          name: 'web_search',
          arguments: {},
        });
        options.onToolDone?.(traceEntry());
        return Promise.resolve({ outputText: 'ok', toolTrace: [traceEntry()] });
      },
    );

    await service.execute(
      makeInput({ toolProgress: { onToolStart, onToolDone } }),
    );

    expect(onToolStart).toHaveBeenCalledWith('web_search');
    expect(onToolDone).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'web_search', success: true }),
    );
  });

  it('throws for unsupported agents', async () => {
    await expect(
      service.execute(makeInput({ selectedAgent: 'unknownAgent' })),
    ).rejects.toThrow('Unsupported agent: unknownAgent');
  });
});
