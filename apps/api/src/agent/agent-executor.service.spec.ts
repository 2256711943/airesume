import { AgentExecutorService } from './agent-executor.service';

describe('AgentExecutorService', () => {
  const toolCallLogService = {
    createLog: jest.fn().mockResolvedValue({ id: 'log-1' }),
  };

  const toolRegistryService = {
    execute: jest.fn(),
  };

  const service = new AgentExecutorService(
    toolCallLogService as never,
    toolRegistryService as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should generate structured interview guidance for self introduction questions', async () => {
    const result = await service.execute({
      agentRunId: 'run-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      selectedAgent: 'interviewCoachAgent',
      userMessage: '请帮我准备一下自我介绍，面试官可能会怎么问？',
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
    });

    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        toolName: 'interview_coach_response',
        success: true,
        latencyMs: expect.any(Number),
      }),
    ]);
    expect(result.assistantText).toContain('自我介绍');
    expect(result.assistantText).toContain('回答策略');
    expect(result.assistantText).toContain('60 到 90 秒');
    expect(result.assistantText).toContain('原始问题：请帮我准备一下自我介绍，面试官可能会怎么问？');

    expect(toolCallLogService.createLog).toHaveBeenCalledTimes(1);
    expect(toolCallLogService.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRunId: 'run-1',
        toolName: 'interview_coach_response',
        success: true,
        inputJson: expect.objectContaining({
          routeDecision: expect.objectContaining({
            confidence: expect.any(Number),
            fallbackUsed: false,
            matchedRules: expect.any(Array),
          }),
        }),
      }),
    );

    const logArg = toolCallLogService.createLog.mock.calls[0][0];
    expect(logArg.inputJson).toMatchObject({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      selectedAgent: 'interviewCoachAgent',
    });
    expect(logArg.outputJson).toMatchObject({
      assistantText: expect.stringContaining('自我介绍'),
    });
  });

  it('should classify technical interview questions differently', async () => {
    const result = await service.execute({
      agentRunId: 'run-2',
      conversationId: 'conv-2',
      messageId: 'msg-2',
      selectedAgent: 'interviewCoachAgent',
      userMessage: '这道题如果问系统设计和性能调优，我该怎么回答？',
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
            matchedKeywords: ['系统设计', '性能调优'],
          },
        ],
      },
    });

    expect(result.assistantText).toContain('技术题');
    expect(result.assistantText).toContain('先说结论');
    expect(result.assistantText).toContain('核心概念');
    expect(toolCallLogService.createLog).toHaveBeenCalledTimes(1);
  });

  it('should generate structured career planning guidance', async () => {
    const result = await service.execute({
      agentRunId: 'run-3',
      conversationId: 'conv-3',
      messageId: 'msg-3',
      selectedAgent: 'careerPlannerAgent',
      userMessage: '我想从测试转到数据分析，应该怎么规划职业路径？',
      routeDecision: {
        intent: 'career_planning',
        selectedAgent: 'careerPlannerAgent',
        reason: 'match career keywords',
        confidence: 0.9,
        fallbackUsed: false,
        matchedRules: [
          {
            ruleId: 'career_keywords',
            label: '职业规划关键词',
            matchedKeywords: ['转到', '职业路径'],
          },
        ],
      },
    });

    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        toolName: 'career_planner_response',
        success: true,
        latencyMs: expect.any(Number),
      }),
    ]);
    expect(result.assistantText).toContain('职业规划');
    expect(result.assistantText).toContain('转型与方向选择');
    expect(result.assistantText).toContain('阶段判断');
    expect(result.assistantText).toContain('下一步行动');
    expect(result.assistantText).toContain('30/60/90 天');
    expect(result.assistantText).toContain('原始问题：我想从测试转到数据分析，应该怎么规划职业路径？');

    expect(toolCallLogService.createLog).toHaveBeenCalledTimes(1);
    expect(toolCallLogService.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRunId: 'run-3',
        toolName: 'career_planner_response',
        success: true,
        inputJson: expect.objectContaining({
          routeDecision: expect.objectContaining({
            confidence: expect.any(Number),
            fallbackUsed: false,
          }),
        }),
      }),
    );

    const logArg = toolCallLogService.createLog.mock.calls[0][0];
    expect(logArg.inputJson).toMatchObject({
      conversationId: 'conv-3',
      messageId: 'msg-3',
      selectedAgent: 'careerPlannerAgent',
    });
    expect(logArg.outputJson).toMatchObject({
      assistantText: expect.stringContaining('职业规划'),
    });
  });

  it('should include resume context hints when provided', async () => {
    const result = await service.execute({
      agentRunId: 'run-4',
      conversationId: 'conv-4',
      messageId: 'msg-4',
      selectedAgent: 'interviewCoachAgent',
      userMessage: '请帮我准备技术面试回答',
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
            matchedKeywords: ['技术面试'],
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
                highlights: ['Designed SSE output'],
              },
            ],
            keyExperiences: [
              {
                company: 'Acme Corp',
                role: 'Backend Engineer',
                highlights: ['Built API gateway'],
              },
            ],
          },
        ],
        selectedCount: 1,
        conversationHistorySummary: {
          summary: 'user: 想切到数据分析',
          messageCount: 2,
          lastMessageAt: '2026-06-06T00:00:01.000Z',
        },
      },
    });

    expect(result.assistantText).toContain('已启用简历上下文');
    expect(result.assistantText).toContain('Backend Resume');
    expect(result.assistantText).toContain('NestJS');
    expect(result.assistantText).toContain('AI Resume Assistant');
    expect(result.assistantText).toContain('对话历史摘要');
    expect(result.assistantText).toContain('想切到数据分析');
  });
});
