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
    refreshConversationHistorySummary: jest.fn(),
  };

  const service = new ChatService(
    conversationService as never,
    agentRunService as never,
    agentExecutorService as never,
    orchestratorService as never,
    resumeContextService as never,
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
      sinceSeq: 0,
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
      resumeContext: {
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
                highlights: [
                  'Designed SSE output',
                  'Improved variant selection',
                ],
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
      },
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
    expect(
      resumeContextService.refreshConversationHistorySummary,
    ).toHaveBeenCalledWith('user-1', 'conv-1');
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
        sinceSeq: 0,
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
        sinceSeq: 0,
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
          sinceSeq: 0,
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
    const startData = events[0]?.data as unknown as {
      requestId: string;
      routeDecisionStarted: boolean;
      ts: string;
    };
    expect(events[0]?.event).toBe('start');
    expect(startData.requestId).toBe('req-stream-1');
    expect(startData.routeDecisionStarted).toBe(false);
    expect(typeof startData.ts).toBe('string');

    const stepStartedData = events[2]?.data as unknown as {
      agentRunId: string;
      name: string;
      parentSpanId: string;
      startedAt: string;
      status: string;
    };
    expect(events[2]?.event).toBe('agent.step.started');
    expect(stepStartedData.agentRunId).toBe('run-stream-1');
    expect(stepStartedData.name).toBe('interviewCoachAgent');
    expect(stepStartedData.parentSpanId).toBe('chat_stream_req-stream-1');
    expect(stepStartedData.status).toBe('running');
    expect(typeof stepStartedData.startedAt).toBe('string');
    expect(typeof events[2]?.data.spanId).toBe('string');

    const toolStartData = events[3]?.data as unknown as {
      agentRunId: string;
      toolName: string;
      parentSpanId: string;
      startedAt: string;
      status: string;
    };
    expect(events[3]?.event).toBe('tool.call.started');
    expect(toolStartData.agentRunId).toBe('run-stream-1');
    expect(toolStartData.toolName).toBe('interview_coach_response');
    expect(toolStartData.parentSpanId).toBe('chat_stream_req-stream-1:step:1');
    expect(toolStartData.status).toBe('running');
    expect(typeof toolStartData.startedAt).toBe('string');
    expect(typeof events[3]?.data.spanId).toBe('string');

    const toolDoneData = events[4]?.data as unknown as {
      agentRunId: string;
      toolName: string;
      success: boolean;
      latencyMs: number;
      startedAt: string;
      finishedAt: string;
      status: string;
    };
    expect(events[4]?.event).toBe('tool.call.finished');
    expect(toolDoneData.agentRunId).toBe('run-stream-1');
    expect(toolDoneData.toolName).toBe('interview_coach_response');
    expect(toolDoneData.success).toBe(true);
    expect(toolDoneData.latencyMs).toBe(18);
    expect(toolDoneData.status).toBe('succeeded');
    expect(typeof toolDoneData.startedAt).toBe('string');
    expect(typeof toolDoneData.finishedAt).toBe('string');

    const assistantDoneData = events[6]?.data as unknown as {
      content: string;
    };
    expect(events[6]?.event).toBe('assistant_done');
    expect(assistantDoneData.content).toBe('hello stream response');

    const stepFinishedData = events[7]?.data as unknown as {
      agentRunId: string;
      startedAt: string;
      finishedAt: string;
      status: string;
    };
    expect(events[7]?.event).toBe('agent.step.finished');
    expect(stepFinishedData.agentRunId).toBe('run-stream-1');
    expect(stepFinishedData.status).toBe('succeeded');
    expect(typeof stepFinishedData.startedAt).toBe('string');
    expect(typeof stepFinishedData.finishedAt).toBe('string');

    const doneData = events[8]?.data as unknown as {
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
          sinceSeq: 0,
        },
        'req-replay-1',
      ),
    );

    const replaySinceSeq = firstPassEvents[3].data.seq;
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
      'tool.call.finished',
      'assistant_chunk',
      'assistant_done',
      'agent.step.finished',
      'done',
    ]);
    expect(replayEvents[0].data.seq).toBeGreaterThan(replaySinceSeq);
    const replayDoneData = replayEvents[4]?.data as unknown as {
      requestId: string;
      conversationId: string;
      agentRunId: string;
    };
    expect(replayEvents[4]?.event).toBe('done');
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
        input.toolProgress?.onToolStart?.('jd_parse_and_score');
        input.toolProgress?.onToolDone?.({
          toolName: 'jd_parse_and_score',
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
          sinceSeq: 0,
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
    const failedToolDoneData = events[4]?.data as unknown as {
      toolName: string;
      success: boolean;
      latencyMs: number;
      errorCode: string;
      errorMessage: string;
      status: string;
    };
    expect(events[4]?.event).toBe('tool.call.finished');
    expect(failedToolDoneData.toolName).toBe('jd_parse_and_score');
    expect(failedToolDoneData.success).toBe(false);
    expect(failedToolDoneData.latencyMs).toBe(321);
    expect(failedToolDoneData.errorCode).toBe('TOOL_FAIL');
    expect(failedToolDoneData.errorMessage).toBe('tool failed');
    expect(failedToolDoneData.status).toBe('failed');

    const failedStepData = events[5]?.data as unknown as {
      agentRunId: string;
      status: string;
      errorCode: string;
      errorMessage: string;
    };
    expect(events[5]?.event).toBe('agent.step.finished');
    expect(failedStepData.agentRunId).toBe('run-stream-2');
    expect(failedStepData.status).toBe('failed');
    expect(failedStepData.errorCode).toBe('tool failed');
    expect(failedStepData.errorMessage).toBe('tool failed');

    const errorData = events[6]?.data as unknown as {
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
