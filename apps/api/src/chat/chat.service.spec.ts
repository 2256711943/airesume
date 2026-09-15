import type { ResumeConversationContext } from '../resume/resume-context.service';
import type { ChatSsePayload } from './chat.service';
import { ChatService } from './chat.service';

type ToolProgressInput = {
  toolProgress?: {
    onToolStart?: (toolName: string) => void;
    onToolDone?: (result: {
      toolName: string;
      success: boolean;
      latencyMs: number;
      errorCode?: string;
      errorMessage?: string;
    }) => void;
  };
};

describe('ChatService', () => {
  const conversationService = {
    createConversation: jest.fn(),
    appendMessage: jest.fn(),
    listRecentMessages: jest.fn(),
  };

  const agentRunService = {
    createRunningRun: jest.fn(),
    markSucceeded: jest.fn(),
    markFailed: jest.fn(),
    markTimeout: jest.fn(),
    markPartialSuccess: jest.fn(),
  };

  const agentExecutorService = {
    execute: jest.fn(),
  };

  const orchestratorService = {
    decideNextAgent: jest.fn(),
  };

  const resumeContextService = {
    buildConversationContext: jest.fn(),
    buildConversationContextWithCandidates: jest.fn(),
    refreshConversationHistorySummary: jest.fn(),
  };

  const contextBudgetManagerService = {
    buildContextPack: jest.fn(),
  };

  const observabilityEventStore = {
    save: jest.fn(),
  };

  const memoryCaptureService = {
    capture: jest.fn().mockResolvedValue(undefined),
    captureConstraints: jest.fn().mockResolvedValue(undefined),
  };

  /** contextBudgetManagerService.buildContextPack 的默认返回（chat.service 仅消费以下字段） */
  const minimalContextPack = {
    packId: 'pack-1',
    conversationId: 'conv-1',
    runId: null,
    intent: null,
    selectedMemoryIds: [],
    droppedMemoryIds: [],
    summaryBlocks: [],
    finalPromptPreview: 'prompt preview',
    usage: {
      maxTokens: 4000,
      reservedTokens: 500,
      usedTokens: 0,
      droppedTokens: 0,
    },
  };

  const service = new ChatService(
    conversationService as never,
    agentRunService as never,
    agentExecutorService as never,
    orchestratorService as never,
    contextBudgetManagerService as never,
    resumeContextService as never,
    memoryCaptureService as never,
    observabilityEventStore as never,
  );

  const collectStreamEvents = async (
    stream: ReturnType<ChatService['sendMessageStream']>,
  ): Promise<ChatSsePayload[]> => {
    return new Promise((resolve) => {
      const events: ChatSsePayload[] = [];
      stream.subscribe({
        next: (event) => {
          events.push(event);
        },
        complete: () => {
          resolve(events);
        },
      });
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // 组合方法委托给 buildConversationContext 的既有 mock，candidates 默认为空
    resumeContextService.buildConversationContextWithCandidates.mockImplementation(
      async (userId: string, conversationId: string) => ({
        context: (await resumeContextService.buildConversationContext(
          userId,
          conversationId,
        )) as ResumeConversationContext,
        candidates: [],
      }),
    );
    contextBudgetManagerService.buildContextPack.mockResolvedValue(
      minimalContextPack,
    );
    observabilityEventStore.save.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should create a conversation and return assistant response on success', async () => {
    jest.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1120);

    orchestratorService.decideNextAgent.mockReturnValue({
      intent: 'interview_guidance',
      selectedAgent: 'interviewCoachAgent',
      reason: 'match interview keywords',
      confidence: 0.93,
      fallbackUsed: false,
      matchedRules: [
        {
          ruleId: 'interview_keywords',
          label: '面试指导关键词',
          matchedKeywords: ['自我介绍'],
        },
      ],
    });
    conversationService.createConversation.mockResolvedValue({
      id: 'conv-1',
    });
    resumeContextService.buildConversationContext.mockResolvedValue({
      activeResumeIds: ['resume-1'],
      activeResumeSummaries: [
        {
          id: 'resume-1',
          title: 'Backend Resume',
          summary: 'Backend engineer profile',
          sourceMode: 'hybrid',
          keySkills: ['NestJS', 'Node.js', 'PostgreSQL'],
          keyProjects: [
            {
              name: 'AI Resume Assistant',
              highlights: ['Designed SSE output', 'Improved variant selection'],
            },
          ],
          keyExperiences: [
            {
              company: 'Acme Corp',
              role: 'Backend Engineer',
              highlights: ['Built API gateway', 'Reduced latency by 28%'],
            },
          ],
        },
      ],
      selectedCount: 1,
      conversationHistorySummary: {
        summary: 'user: 请帮我准备一下自我介绍',
        messageCount: 2,
        lastMessageAt: '2026-06-06T00:00:01.000Z',
      },
    });
    conversationService.appendMessage
      .mockResolvedValueOnce({
        id: 'msg-user-1',
        role: 'user',
        content: '请帮我准备一下自我介绍',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        toolCallSummary: null,
        createdAt: new Date('2026-06-06T00:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        id: 'msg-assistant-1',
        role: 'assistant',
        content: '面试指导：我判断你这次提问更偏向「自我介绍」。',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        toolCallSummary: [
          {
            toolName: 'interview_coach_response',
            success: true,
            latencyMs: 20,
          },
        ],
        createdAt: new Date('2026-06-06T00:00:01.000Z'),
      });
    agentRunService.createRunningRun.mockResolvedValue({ id: 'run-1' });
    agentExecutorService.execute.mockResolvedValue({
      assistantText: '面试指导：我判断你这次提问更偏向「自我介绍」。',
      toolCalls: [
        { toolName: 'interview_coach_response', success: true, latencyMs: 20 },
      ],
    });
    conversationService.listRecentMessages.mockResolvedValue({
      conversationId: 'conv-1',
      messages: [
        {
          id: 'msg-user-1',
          role: 'user',
          content: '请帮我准备一下自我介绍',
          intent: 'interview_guidance',
          agentName: 'interviewCoachAgent',
          toolCallSummary: null,
          createdAt: '2026-06-06T00:00:00.000Z',
        },
        {
          id: 'msg-assistant-1',
          role: 'assistant',
          content: '面试指导：我判断你这次提问更偏向「自我介绍」。',
          intent: 'interview_guidance',
          agentName: 'interviewCoachAgent',
          toolCallSummary: [
            {
              toolName: 'interview_coach_response',
              success: true,
              latencyMs: 20,
            },
          ],
          createdAt: '2026-06-06T00:00:01.000Z',
        },
      ],
    });

    const result = await service.sendMessage('user-1', {
      message: '请帮我准备一下自我介绍',
      historyLimit: 5,
    });

    expect(orchestratorService.decideNextAgent).toHaveBeenCalledWith(
      '请帮我准备一下自我介绍',
    );
    expect(conversationService.createConversation).toHaveBeenCalledWith(
      'user-1',
      {
        title: '请帮我准备一下自我介绍',
      },
    );
    expect(resumeContextService.buildConversationContext).toHaveBeenCalledWith(
      'user-1',
      'conv-1',
    );
    expect(conversationService.appendMessage).toHaveBeenNthCalledWith(
      1,
      'user-1',
      'conv-1',
      {
        role: 'user',
        content: '请帮我准备一下自我介绍',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
      },
    );
    expect(agentRunService.createRunningRun).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      messageId: 'msg-user-1',
      selectedAgent: 'interviewCoachAgent',
      orchestratorDecision: {
        intent: 'interview_guidance',
        selectedAgent: 'interviewCoachAgent',
        reason: 'match interview keywords',
        confidence: 0.93,
        fallbackUsed: false,
        matchedRules: [
          {
            ruleId: 'interview_keywords',
            label: '面试指导关键词',
            matchedKeywords: ['自我介绍'],
          },
        ],
      },
    });
    expect(agentExecutorService.execute).toHaveBeenCalledWith({
      agentRunId: 'run-1',
      conversationId: 'conv-1',
      messageId: 'msg-user-1',
      selectedAgent: 'interviewCoachAgent',
      userMessage: '请帮我准备一下自我介绍',
      routeDecision: {
        intent: 'interview_guidance',
        selectedAgent: 'interviewCoachAgent',
        reason: 'match interview keywords',
        confidence: 0.93,
        fallbackUsed: false,
        matchedRules: [
          {
            ruleId: 'interview_keywords',
            label: '面试指导关键词',
            matchedKeywords: ['自我介绍'],
          },
        ],
      },
      contextPack: minimalContextPack,
      toolProgress: {
        onToolStart: expect.any(Function) as (toolName: string) => void,
        onToolDone: expect.any(Function) as (result: {
          toolName: string;
          success: boolean;
          latencyMs: number;
          errorCode?: string;
          errorMessage?: string;
        }) => void,
      },
    });
    // 本轮只读取上一状态摘要：摘要刷新必须发生在 Agent 执行完成、assistant 落库之后，
    // 且刷新前已经先读过 buildConversationContext 返回的历史摘要（Summary(A)），
    // 因此本轮 LLM 的 resumeContext 不会包含刚生成的 Summary(A+B)。
    expect(
      resumeContextService.refreshConversationHistorySummary,
    ).toHaveBeenCalledTimes(1);
    expect(
      resumeContextService.refreshConversationHistorySummary,
    ).toHaveBeenCalledWith('user-1', 'conv-1');
    const buildCtxOrder =
      resumeContextService.buildConversationContextWithCandidates.mock
        .invocationCallOrder[0];
    const executeOrder =
      agentExecutorService.execute.mock.invocationCallOrder[0];
    const refreshOrder =
      resumeContextService.refreshConversationHistorySummary.mock
        .invocationCallOrder[0];
    expect(refreshOrder).toBeGreaterThan(buildCtxOrder);
    expect(refreshOrder).toBeGreaterThan(executeOrder);
    expect(conversationService.appendMessage).toHaveBeenNthCalledWith(
      2,
      'user-1',
      'conv-1',
      {
        role: 'assistant',
        content: '面试指导：我判断你这次提问更偏向「自我介绍」。',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        toolCallSummary: [
          {
            toolName: 'interview_coach_response',
            success: true,
            latencyMs: 20,
          },
        ],
      },
    );
    expect(agentRunService.markSucceeded).toHaveBeenCalledWith('run-1', 120);
    expect(conversationService.listRecentMessages).toHaveBeenCalledWith(
      'user-1',
      'conv-1',
      5,
    );
    expect(result).toEqual({
      conversationId: 'conv-1',
      agentRunId: 'run-1',
      createdConversation: true,
      displayPreferences: [],
      message: {
        id: 'msg-user-1',
        role: 'user',
        content: '请帮我准备一下自我介绍',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        toolCallSummary: null,
        createdAt: new Date('2026-06-06T00:00:00.000Z'),
      },
      assistantMessage: {
        id: 'msg-assistant-1',
        role: 'assistant',
        content: '面试指导：我判断你这次提问更偏向「自我介绍」。',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        toolCallSummary: [
          {
            toolName: 'interview_coach_response',
            success: true,
            latencyMs: 20,
          },
        ],
        createdAt: new Date('2026-06-06T00:00:01.000Z'),
      },
      routeDecision: {
        intent: 'interview_guidance',
        selectedAgent: 'interviewCoachAgent',
        reason: 'match interview keywords',
        confidence: 0.93,
        fallbackUsed: false,
        matchedRules: [
          {
            ruleId: 'interview_keywords',
            label: '面试指导关键词',
            matchedKeywords: ['自我介绍'],
          },
        ],
      },
      recentMessages: [
        {
          id: 'msg-user-1',
          role: 'user',
          content: '请帮我准备一下自我介绍',
          intent: 'interview_guidance',
          agentName: 'interviewCoachAgent',
          toolCallSummary: null,
          createdAt: '2026-06-06T00:00:00.000Z',
        },
        {
          id: 'msg-assistant-1',
          role: 'assistant',
          content: '面试指导：我判断你这次提问更偏向「自我介绍」。',
          intent: 'interview_guidance',
          agentName: 'interviewCoachAgent',
          toolCallSummary: [
            {
              toolName: 'interview_coach_response',
              success: true,
              latencyMs: 20,
            },
          ],
          createdAt: '2026-06-06T00:00:01.000Z',
        },
      ],
    });
  });

  it('passes collected memory candidates into buildContextPack (single assembly point)', async () => {
    orchestratorService.decideNextAgent.mockReturnValue({
      intent: 'interview_guidance',
      selectedAgent: 'interviewCoachAgent',
      reason: 'match interview keywords',
      confidence: 0.93,
      fallbackUsed: false,
      matchedRules: [],
    });
    conversationService.createConversation.mockResolvedValue({
      id: 'conv-1',
    });
    const candidate = {
      memoryId: 'mem-1',
      conversationId: 'conv-1',
      runId: null,
      layer: 'preference',
      scope: 'conversation',
      content: '回答保持简洁',
      summary: '回答保持简洁',
      tokenEstimate: 5,
      priority: 80,
      pinned: false,
      freshnessScore: 1,
      relevanceScore: 1,
      sourceRefs: [],
      mergeGroup: 'memory_constraint',
      mergeStrategy: null,
      version: 1,
      metadata: null,
      expiresAt: null,
      createdAt: new Date('2026-06-06T00:00:00.000Z'),
      updatedAt: new Date('2026-06-06T00:00:00.000Z'),
      lastAccessedAt: null,
      accessCount: 0,
    };
    resumeContextService.buildConversationContextWithCandidates.mockResolvedValue(
      {
        context: {
          activeResumeIds: [],
          activeResumeSummaries: [],
          selectedCount: 0,
          conversationHistorySummary: null,
        },
        candidates: [candidate],
      },
    );
    conversationService.appendMessage.mockResolvedValue({
      id: 'msg-user-1',
      role: 'user',
      content: '请帮我准备一下自我介绍',
    });
    agentRunService.createRunningRun.mockResolvedValue({ id: 'run-1' });
    agentExecutorService.execute.mockResolvedValue({
      assistantText: 'ok',
      toolCalls: [],
    });

    await collectStreamEvents(
      service.sendMessageStream('user-1', {
        message: '请帮我准备一下自我介绍',
        historyLimit: 10,
        sinceSeq: 0,
      }),
    );

    expect(contextBudgetManagerService.buildContextPack).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        candidates: [candidate],
        layerLimits: {
          preference: { maxItems: 16, maxTokens: 1600 },
          session: { maxItems: 9, maxTokens: 2000 },
        },
      }),
    );
    expect(agentExecutorService.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        contextPack: minimalContextPack,
      }),
    );
    expect(agentExecutorService.execute).toHaveBeenCalledWith(
      expect.not.objectContaining<{
        resumeContext?: unknown;
      }>({ resumeContext: expect.anything() }),
    );
  });

  it('succeeds the turn even when the post-turn summary refresh fails (Case 3)', async () => {
    jest.spyOn(Date, 'now').mockReturnValueOnce(1500).mockReturnValueOnce(1640);

    orchestratorService.decideNextAgent.mockReturnValue({
      intent: 'interview_guidance',
      selectedAgent: 'interviewCoachAgent',
      reason: 'match interview keywords',
      confidence: 0.93,
      fallbackUsed: false,
      matchedRules: [
        {
          ruleId: 'interview_keywords',
          label: '面试指导关键词',
          matchedKeywords: ['自我介绍'],
        },
      ],
    });
    resumeContextService.buildConversationContext.mockResolvedValue({
      activeResumeIds: [],
      activeResumeSummaries: [],
      selectedCount: 0,
      conversationHistorySummary: null,
    });
    conversationService.appendMessage
      .mockResolvedValueOnce({
        id: 'msg-c3-user-1',
        role: 'user',
        content: '请帮我准备自我介绍',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        toolCallSummary: null,
        createdAt: new Date('2026-06-06T00:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        id: 'msg-c3-assistant-1',
        role: 'assistant',
        content: '这是自我介绍准备建议。',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        toolCallSummary: [],
        createdAt: new Date('2026-06-06T00:00:01.000Z'),
      });
    agentRunService.createRunningRun.mockResolvedValue({ id: 'run-c3-1' });
    agentExecutorService.execute.mockResolvedValue({
      assistantText: '这是自我介绍准备建议。',
      toolCalls: [],
    });
    // Summary 只是缓存：刷新失败必须被吞掉，不能影响本轮 Agent 回复。
    resumeContextService.refreshConversationHistorySummary.mockRejectedValue(
      new Error('summary sync failed'),
    );
    conversationService.listRecentMessages.mockResolvedValue({
      conversationId: 'conv-c3-1',
      messages: [],
    });

    const result = await service.sendMessage('user-1', {
      conversationId: 'conv-c3-1',
      message: '请帮我准备自我介绍',
      historyLimit: 5,
    });

    expect(
      resumeContextService.refreshConversationHistorySummary,
    ).toHaveBeenCalledWith('user-1', 'conv-c3-1');
    expect(agentRunService.markSucceeded).toHaveBeenCalledWith('run-c3-1', 140);
    expect(result.assistantMessage.content).toBe('这是自我介绍准备建议。');
  });

  it('should mark the agent run as failed when execution throws', async () => {
    jest.spyOn(Date, 'now').mockReturnValueOnce(2000).mockReturnValueOnce(2130);

    orchestratorService.decideNextAgent.mockReturnValue({
      intent: 'resume_diagnosis',
      selectedAgent: 'resumeDiagnosisAgent',
      reason: 'match resume keywords',
      confidence: 0.88,
      fallbackUsed: false,
      matchedRules: [
        {
          ruleId: 'resume_keywords',
          label: '简历诊断关键词',
          matchedKeywords: ['岗位描述'],
        },
      ],
    });
    resumeContextService.buildConversationContext.mockResolvedValue({
      activeResumeIds: [],
      activeResumeSummaries: [],
      selectedCount: 0,
    });
    conversationService.appendMessage.mockResolvedValueOnce({
      id: 'msg-user-2',
      role: 'user',
      content: '这是我的岗位描述',
      intent: 'resume_diagnosis',
      agentName: 'resumeDiagnosisAgent',
      toolCallSummary: null,
      createdAt: new Date('2026-06-06T00:00:00.000Z'),
    });
    agentRunService.createRunningRun.mockResolvedValue({ id: 'run-2' });
    agentExecutorService.execute.mockRejectedValue(new Error('agent failed'));

    await expect(
      service.sendMessage('user-1', {
        conversationId: 'conv-2',
        message: '这是我的岗位描述',
        historyLimit: 3,
      }),
    ).rejects.toThrow('agent failed');

    expect(resumeContextService.buildConversationContext).toHaveBeenCalledWith(
      'user-1',
      'conv-2',
    );
    expect(
      resumeContextService.refreshConversationHistorySummary,
    ).not.toHaveBeenCalled();
    expect(agentRunService.markFailed).toHaveBeenCalledWith(
      'run-2',
      expect.any(Error),
      130,
    );
    expect(conversationService.appendMessage).toHaveBeenCalledTimes(1);
    expect(conversationService.listRecentMessages).not.toHaveBeenCalled();
    expect(agentRunService.markSucceeded).not.toHaveBeenCalled();
    expect(agentRunService.markTimeout).not.toHaveBeenCalled();
  });

  it('should mark the run as partially successful if response persistence fails after assistant generation', async () => {
    jest.spyOn(Date, 'now').mockReturnValueOnce(3000).mockReturnValueOnce(3140);

    orchestratorService.decideNextAgent.mockReturnValue({
      intent: 'interview_guidance',
      selectedAgent: 'interviewCoachAgent',
      reason: 'match interview keywords',
      confidence: 0.93,
      fallbackUsed: false,
      matchedRules: [
        {
          ruleId: 'interview_keywords',
          label: '面试指导关键词',
          matchedKeywords: ['自我介绍'],
        },
      ],
    });
    resumeContextService.buildConversationContext.mockResolvedValue({
      activeResumeIds: [],
      activeResumeSummaries: [],
      selectedCount: 0,
      conversationHistorySummary: null,
    });
    conversationService.appendMessage
      .mockResolvedValueOnce({
        id: 'msg-user-3',
        role: 'user',
        content: '请帮我准备自我介绍',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        toolCallSummary: null,
        createdAt: new Date('2026-06-06T00:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        id: 'msg-assistant-3',
        role: 'assistant',
        content: '面试指导：我判断你这次提问更偏向「自我介绍」。',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        toolCallSummary: [
          {
            toolName: 'interview_coach_response',
            success: true,
            latencyMs: 15,
          },
        ],
        createdAt: new Date('2026-06-06T00:00:01.000Z'),
      });
    agentRunService.createRunningRun.mockResolvedValue({ id: 'run-3' });
    agentExecutorService.execute.mockResolvedValue({
      assistantText: '面试指导：我判断你这次提问更偏向「自我介绍」。',
      toolCalls: [
        { toolName: 'interview_coach_response', success: true, latencyMs: 15 },
      ],
    });
    conversationService.listRecentMessages.mockRejectedValue(
      new Error('list failed'),
    );

    await expect(
      service.sendMessage('user-1', {
        conversationId: 'conv-3',
        message: '请帮我准备自我介绍',
        historyLimit: 5,
      }),
    ).rejects.toThrow('list failed');

    expect(agentRunService.markPartialSuccess).toHaveBeenCalledWith(
      'run-3',
      expect.any(Number),
    );
    expect(agentRunService.markSucceeded).toHaveBeenCalledWith('run-3', 140);
    expect(agentRunService.markFailed).not.toHaveBeenCalled();
    expect(agentRunService.markTimeout).not.toHaveBeenCalled();
  });

  it('should emit ordered stream events for a successful response', async () => {
    orchestratorService.decideNextAgent.mockReturnValue({
      intent: 'interview_guidance',
      selectedAgent: 'interviewCoachAgent',
      reason: 'match interview keywords',
      confidence: 0.93,
      fallbackUsed: false,
      matchedRules: [
        {
          ruleId: 'interview_keywords',
          label: 'interview keyword',
          matchedKeywords: ['self intro'],
        },
      ],
    });
    conversationService.createConversation.mockResolvedValue({
      id: 'conv-stream-1',
    });
    resumeContextService.buildConversationContext.mockResolvedValue({
      activeResumeIds: [],
      activeResumeSummaries: [],
      selectedCount: 0,
      conversationHistorySummary: null,
    });
    conversationService.appendMessage
      .mockResolvedValueOnce({
        id: 'msg-stream-user-1',
        role: 'user',
        content: 'help me prepare a self intro',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        toolCallSummary: null,
        createdAt: new Date('2026-06-06T00:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        id: 'msg-stream-assistant-1',
        role: 'assistant',
        content: 'hello stream response',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        toolCallSummary: [
          {
            toolName: 'interview_coach_response',
            success: true,
            latencyMs: 18,
          },
        ],
        createdAt: new Date('2026-06-06T00:00:01.000Z'),
      });
    agentRunService.createRunningRun.mockResolvedValue({ id: 'run-stream-1' });
    agentExecutorService.execute.mockImplementation(
      (input: ToolProgressInput) => {
        input.toolProgress?.onToolStart?.('interview_coach_response');
        input.toolProgress?.onToolDone?.({
          toolName: 'interview_coach_response',
          success: true,
          latencyMs: 18,
        });

        return Promise.resolve({
          assistantText: 'hello stream response',
          toolCalls: [
            {
              toolName: 'interview_coach_response',
              success: true,
              latencyMs: 18,
            },
          ],
        });
      },
    );
    conversationService.listRecentMessages.mockResolvedValue({
      conversationId: 'conv-stream-1',
      messages: [],
    });

    const events = await collectStreamEvents(
      service.sendMessageStream(
        'user-1',
        {
          message: 'help me prepare a self intro',
          historyLimit: 5,
        },
        'req-stream-1',
      ),
    );

    expect(events.map((event) => event.event)).toEqual([
      'start',
      'route_decision',
      'agent.step.started',
      'tool.call.started',
      'tool.call.finished',
      'assistant_chunk',
      'assistant_done',
      'agent.step.finished',
      'done',
    ]);
    const startData = events[0]?.data as {
      requestId: string;
      routeDecisionStarted: boolean;
      ts: string;
    };
    expect(events[0]?.event).toBe('start');
    expect(startData.requestId).toBe('req-stream-1');
    expect(startData.routeDecisionStarted).toBe(false);
    expect(typeof startData.ts).toBe('string');

    const toolStartData = events[3]?.data as {
      agentRunId: string;
      toolName: string;
      startedAt: string;
    };
    expect(events[3]?.event).toBe('tool.call.started');
    expect(toolStartData.agentRunId).toBe('run-stream-1');
    expect(toolStartData.toolName).toBe('interview_coach_response');
    expect(typeof toolStartData.startedAt).toBe('string');

    const toolDoneData = events[4]?.data as {
      agentRunId: string;
      toolName: string;
      success: boolean;
      latencyMs: number;
    };
    expect(events[4]?.event).toBe('tool.call.finished');
    expect(toolDoneData.agentRunId).toBe('run-stream-1');
    expect(toolDoneData.toolName).toBe('interview_coach_response');
    expect(toolDoneData.success).toBe(true);
    expect(toolDoneData.latencyMs).toBe(18);

    const assistantDoneData = events[6]?.data as {
      content: string;
    };
    expect(events[6]?.event).toBe('assistant_done');
    expect(assistantDoneData.content).toBe('hello stream response');

    const doneData = events[8]?.data as {
      conversationId: string;
      agentRunId: string;
      createdConversation: boolean;
    };
    expect(events[8]?.event).toBe('done');
    expect(doneData.conversationId).toBe('conv-stream-1');
    expect(doneData.agentRunId).toBe('run-stream-1');
    expect(doneData.createdConversation).toBe(true);
  });

  it('should replay buffered stream events for the same stream key without re-executing the agent flow', async () => {
    orchestratorService.decideNextAgent.mockReturnValue({
      intent: 'interview_guidance',
      selectedAgent: 'interviewCoachAgent',
      reason: 'match interview keywords',
      confidence: 0.93,
      fallbackUsed: false,
      matchedRules: [
        {
          ruleId: 'interview_keywords',
          label: 'interview keyword',
          matchedKeywords: ['self intro'],
        },
      ],
    });
    conversationService.createConversation.mockResolvedValue({
      id: 'conv-replay-1',
    });
    resumeContextService.buildConversationContext.mockResolvedValue({
      activeResumeIds: [],
      activeResumeSummaries: [],
      selectedCount: 0,
      conversationHistorySummary: null,
    });
    conversationService.appendMessage
      .mockResolvedValueOnce({
        id: 'msg-replay-user-1',
        role: 'user',
        content: 'help me prepare a replay intro',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        toolCallSummary: null,
        createdAt: new Date('2026-06-06T00:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        id: 'msg-replay-assistant-1',
        role: 'assistant',
        content: 'hello replay response',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        toolCallSummary: [
          {
            toolName: 'interview_coach_response',
            success: true,
            latencyMs: 18,
          },
        ],
        createdAt: new Date('2026-06-06T00:00:01.000Z'),
      });
    agentRunService.createRunningRun.mockResolvedValue({ id: 'run-replay-1' });
    agentExecutorService.execute.mockImplementation(
      (input: ToolProgressInput) => {
        input.toolProgress?.onToolStart?.('interview_coach_response');
        input.toolProgress?.onToolDone?.({
          toolName: 'interview_coach_response',
          success: true,
          latencyMs: 18,
        });

        return Promise.resolve({
          assistantText: 'hello replay response',
          toolCalls: [
            {
              toolName: 'interview_coach_response',
              success: true,
              latencyMs: 18,
            },
          ],
        });
      },
    );
    conversationService.listRecentMessages.mockResolvedValue({
      conversationId: 'conv-replay-1',
      messages: [],
    });

    const streamKey = 'chat_stream_replay_case';
    const firstPassEvents = await collectStreamEvents(
      service.sendMessageStream(
        'user-1',
        {
          message: 'help me prepare a replay intro',
          historyLimit: 5,
          streamKey,
        },
        'req-replay-1',
      ),
    );

    const replaySinceSeq = firstPassEvents[2].data.seq;
    const replayEvents = await collectStreamEvents(
      service.sendMessageStream(
        'user-1',
        {
          message: 'help me prepare a replay intro',
          historyLimit: 5,
          streamKey,
          sinceSeq: replaySinceSeq,
        },
        'req-replay-2',
      ),
    );

    expect(agentExecutorService.execute).toHaveBeenCalledTimes(1);
    expect(agentRunService.createRunningRun).toHaveBeenCalledTimes(1);
    expect(replayEvents.map((event) => event.event)).toEqual([
      'tool.call.started',
      'tool.call.finished',
      'assistant_chunk',
      'assistant_done',
      'agent.step.finished',
      'done',
    ]);
    expect(replayEvents[0].data.seq).toBeGreaterThan(replaySinceSeq);
    const replayDoneData = replayEvents[5]?.data as {
      requestId: string;
      conversationId: string;
      agentRunId: string;
    };
    expect(replayEvents[5]?.event).toBe('done');
    expect(replayDoneData.requestId).toBe('req-replay-1');
    expect(replayDoneData.conversationId).toBe('conv-replay-1');
    expect(replayDoneData.agentRunId).toBe('run-replay-1');
  });

  it('should emit tool failure then error for a failed stream response', async () => {
    jest.spyOn(Date, 'now').mockReturnValueOnce(5000).mockReturnValueOnce(5125);

    orchestratorService.decideNextAgent.mockReturnValue({
      intent: 'resume_diagnosis',
      selectedAgent: 'resumeDiagnosisAgent',
      reason: 'match resume keywords',
      confidence: 0.88,
      fallbackUsed: false,
      matchedRules: [
        {
          ruleId: 'resume_keywords',
          label: 'resume keyword',
          matchedKeywords: ['jd'],
        },
      ],
    });
    resumeContextService.buildConversationContext.mockResolvedValue({
      activeResumeIds: [],
      activeResumeSummaries: [],
      selectedCount: 0,
      conversationHistorySummary: null,
    });
    conversationService.appendMessage.mockResolvedValueOnce({
      id: 'msg-stream-user-2',
      role: 'user',
      content: 'this is the jd',
      intent: 'resume_diagnosis',
      agentName: 'resumeDiagnosisAgent',
      toolCallSummary: null,
      createdAt: new Date('2026-06-06T00:00:00.000Z'),
    });
    agentRunService.createRunningRun.mockResolvedValue({ id: 'run-stream-2' });
    agentExecutorService.execute.mockImplementation(
      (input: ToolProgressInput) => {
        input.toolProgress?.onToolStart?.('jd_parse');
        input.toolProgress?.onToolDone?.({
          toolName: 'jd_parse',
          success: false,
          latencyMs: 321,
          errorCode: 'TOOL_FAIL',
          errorMessage: 'tool failed',
        });

        return Promise.reject(new Error('tool failed'));
      },
    );

    const events = await collectStreamEvents(
      service.sendMessageStream(
        'user-1',
        {
          conversationId: 'conv-stream-2',
          message: 'this is the jd',
          historyLimit: 3,
        },
        'req-stream-2',
      ),
    );

    expect(events.map((event) => event.event)).toEqual([
      'start',
      'route_decision',
      'agent.step.started',
      'tool.call.started',
      'tool.call.finished',
      'agent.step.finished',
      'error',
    ]);
    const failedToolDoneData = events[4]?.data as {
      toolName: string;
      success: boolean;
      latencyMs: number;
      errorCode: string;
      errorMessage: string;
    };
    expect(events[4]?.event).toBe('tool.call.finished');
    expect(failedToolDoneData.toolName).toBe('jd_parse');
    expect(failedToolDoneData.success).toBe(false);
    expect(failedToolDoneData.latencyMs).toBe(321);
    expect(failedToolDoneData.errorCode).toBe('TOOL_FAIL');
    expect(failedToolDoneData.errorMessage).toBe('tool failed');

    const errorData = events[6]?.data as {
      requestId: string;
      code: string;
      message: string;
    };
    expect(events[6]?.event).toBe('error');
    expect(errorData.requestId).toBe('req-stream-2');
    expect(errorData.code).toBe('tool failed');
    expect(errorData.message).toBe('tool failed');
    expect(agentRunService.markFailed).toHaveBeenCalledWith(
      'run-stream-2',
      expect.any(Error),
      expect.any(Number),
    );
  });
});
