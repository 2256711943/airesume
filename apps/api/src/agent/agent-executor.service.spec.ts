import type {
  AgentToolCall,
  AgentToolTraceEntry,
  OpenAiAgentClient,
} from '../common/llm/openai-agent.client';
import { ToolRegistry } from '../common/llm/tool-registry';
import type { ChatWebToolExecutor } from '../chat/tools/chat-web-tool-executor';
import { registerChatWebTools } from '../chat/tools/web-tools.schema';
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
    toolCallLogService = { createLog: jest.fn().mockResolvedValue({ id: 'log-1' }) };
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
        agent: 'resumeDiagnosisAgent',
        prompt: '简历诊断助手',
        intent: 'resume_diagnosis',
      },
      {
        agent: 'interviewCoachAgent',
        prompt: '面试指导助手',
        intent: 'interview_guidance',
      },
      {
        agent: 'careerPlannerAgent',
        prompt: '职业规划助手',
        intent: 'career_planning',
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

  it('includes resume context in instructions when provided', async () => {
    agentClient.runWithTools.mockResolvedValue({
      outputText: 'ok',
      toolTrace: [],
    });

    await service.execute(
      makeInput({
        resumeContext: {
          activeResumeIds: ['resume-1'],
          activeResumeSummaries: [
            {
              id: 'resume-1',
              title: 'Backend Resume',
              summary: 'profile',
              sourceMode: 'hybrid',
              keySkills: ['NestJS', 'Node.js'],
              keyProjects: [],
              keyExperiences: [],
            },
          ],
          selectedCount: 1,
          conversationHistorySummary: {
            summary: 'user: 想转行',
            messageCount: 2,
            lastMessageAt: '2026-06-06T00:00:01.000Z',
          },
          displayPreferences: [
            {
              category: 'language',
              key: 'response_language',
              normalizedValue: 'zh-CN',
              sourceKind: 'user_text',
              summary: 'pref',
              updatedAt: '2026-06-06T00:00:02.000Z',
            },
          ],
        },
      }),
    );

    const [options] = agentClient.runWithTools.mock.calls[0] as [
      { instructions: string },
    ];
    expect(options.instructions).toContain('已启用简历上下文：Backend Resume');
    expect(options.instructions).toContain('核心技能：NestJS、Node.js');
    expect(options.instructions).toContain('显示偏好：用中文回答');
    expect(options.instructions).toContain('对话历史摘要：user: 想转行');
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
