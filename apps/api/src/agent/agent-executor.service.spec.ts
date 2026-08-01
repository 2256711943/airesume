import { AgentExecutorService } from './agent-executor.service';

describe('AgentExecutorService', () => {
  const toolCallLogService = {
    createLog: jest.fn().mockResolvedValue({ id: 'log-1' }),
  };

  const toolRegistryService = {
    execute: jest.fn(),
  };

  const memoryStore = {
    write: jest.fn().mockResolvedValue({
      merged: false,
      memory: {},
    }),
  };

  const service = new AgentExecutorService(
    toolCallLogService as never,
    toolRegistryService as never,
    memoryStore as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    memoryStore.write.mockResolvedValue({
      merged: false,
      memory: {},
    });
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

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.toolName).toBe('interview_coach_response');
    expect(result.toolCalls[0]?.success).toBe(true);
    expect(typeof result.toolCalls[0]?.latencyMs).toBe('number');
    expect(result.assistantText).toContain('自我介绍');
    expect(result.assistantText).toContain('回答策略');
    expect(result.assistantText).toContain('60 到 90 秒');
    expect(result.assistantText).toContain(
      '原始问题：请帮我准备一下自我介绍，面试官可能会怎么问？',
    );

    expect(toolCallLogService.createLog).toHaveBeenCalledTimes(1);
    const [logArg] = toolCallLogService.createLog.mock.calls[0] as [
      {
        agentRunId: string;
        toolName: string;
        success: boolean;
        inputJson: {
          routeDecision: {
            confidence: number;
            fallbackUsed: boolean;
            matchedRules: unknown[];
          };
          conversationId: string;
          messageId: string;
          selectedAgent: string;
        };
        outputJson: {
          assistantText: string;
        };
      },
    ];
    expect(logArg.agentRunId).toBe('run-1');
    expect(logArg.toolName).toBe('interview_coach_response');
    expect(logArg.success).toBe(true);
    expect(logArg.inputJson.routeDecision.fallbackUsed).toBe(false);
    expect(typeof logArg.inputJson.routeDecision.confidence).toBe('number');
    expect(Array.isArray(logArg.inputJson.routeDecision.matchedRules)).toBe(
      true,
    );
    expect(logArg.inputJson).toMatchObject({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      selectedAgent: 'interviewCoachAgent',
    });
    expect(logArg.outputJson.assistantText).toContain('自我介绍');
    expect(memoryStore.write).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        runId: 'run-1',
        layer: 'tool_result',
        scope: 'conversation',
        mergeGroup: 'interview_coach_response',
        mergeStrategy: 'replace',
      }),
    );
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
    expect(memoryStore.write).toHaveBeenCalledTimes(1);
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

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.toolName).toBe('career_planner_response');
    expect(result.toolCalls[0]?.success).toBe(true);
    expect(typeof result.toolCalls[0]?.latencyMs).toBe('number');
    expect(result.assistantText).toContain('职业规划');
    expect(result.assistantText).toContain('转型与方向选择');
    expect(result.assistantText).toContain('阶段判断');
    expect(result.assistantText).toContain('下一步行动');
    expect(result.assistantText).toContain('30/60/90 天');
    expect(result.assistantText).toContain(
      '原始问题：我想从测试转到数据分析，应该怎么规划职业路径？',
    );

    expect(toolCallLogService.createLog).toHaveBeenCalledTimes(1);
    const [careerLogArg] = toolCallLogService.createLog.mock.calls[0] as [
      {
        agentRunId: string;
        toolName: string;
        success: boolean;
        inputJson: {
          routeDecision: {
            confidence: number;
            fallbackUsed: boolean;
          };
          conversationId: string;
          messageId: string;
          selectedAgent: string;
        };
        outputJson: {
          assistantText: string;
        };
      },
    ];
    expect(careerLogArg.agentRunId).toBe('run-3');
    expect(careerLogArg.toolName).toBe('career_planner_response');
    expect(careerLogArg.success).toBe(true);
    expect(careerLogArg.inputJson.routeDecision.fallbackUsed).toBe(false);
    expect(typeof careerLogArg.inputJson.routeDecision.confidence).toBe(
      'number',
    );
    expect(careerLogArg.inputJson).toMatchObject({
      conversationId: 'conv-3',
      messageId: 'msg-3',
      selectedAgent: 'careerPlannerAgent',
    });
    expect(careerLogArg.outputJson.assistantText).toContain('职业规划');
    expect(memoryStore.write).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-3',
        runId: 'run-3',
        layer: 'tool_result',
        scope: 'conversation',
        mergeGroup: 'career_planner_response',
        mergeStrategy: 'replace',
      }),
    );
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
        displayPreferences: [
          {
            category: 'language',
            key: 'response_language',
            normalizedValue: 'zh-CN',
            sourceKind: 'user_text',
            summary: 'Display preference: response_language=zh-CN',
            updatedAt: '2026-06-06T00:00:02.000Z',
          },
          {
            category: 'format',
            key: 'output_format',
            normalizedValue: 'table',
            sourceKind: 'user_text',
            summary: 'Display preference: output_format=table',
            updatedAt: '2026-06-06T00:00:03.000Z',
          },
          {
            category: 'structure',
            key: 'response_structure',
            normalizedValue: 'answer_first',
            sourceKind: 'user_text',
            summary: 'Display preference: response_structure=answer_first',
            updatedAt: '2026-06-06T00:00:04.000Z',
          },
        ],
      },
    });

    expect(result.assistantText).toContain('已启用简历上下文');
    expect(result.assistantText).toContain('Backend Resume');
    expect(result.assistantText).toContain('NestJS');
    expect(result.assistantText).toContain('AI Resume Assistant');
    expect(result.assistantText).toContain('显示偏好');
    expect(result.assistantText).toContain('用中文回答');
    expect(result.assistantText).toContain('用表格展示');
    expect(result.assistantText).toContain('先给结论');
    expect(result.assistantText).toContain('对话历史摘要');
    expect(result.assistantText).toContain('想切到数据分析');
  });

  it('should persist failed jd tool results into memory', async () => {
    toolRegistryService.execute.mockResolvedValue({
      success: false,
      toolName: 'jd_parse_and_score',
      data: null,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'tool unavailable',
      },
      latencyMs: 123,
      sourceMeta: {
        source: 'internal',
        version: 'tool-registry-v1',
      },
    });

    const result = await service.execute({
      agentRunId: 'run-5',
      conversationId: 'conv-5',
      messageId: 'msg-5',
      selectedAgent: 'resumeDiagnosisAgent',
      userMessage: '岗位职责：负责后端接口开发，要求熟悉 Node.js 和 SQL',
      routeDecision: {
        intent: 'resume_diagnosis',
        selectedAgent: 'resumeDiagnosisAgent',
        reason: 'match jd keywords',
        confidence: 0.96,
        fallbackUsed: false,
        matchedRules: [
          {
            ruleId: 'jd_keywords',
            label: 'JD关键词',
            matchedKeywords: ['岗位职责', '要求'],
          },
        ],
      },
    });

    expect(result.toolCalls).toEqual([
      {
        toolName: 'jd_parse_and_score',
        success: false,
        latencyMs: 123,
      },
    ]);
    expect(memoryStore.write).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-5',
        runId: 'run-5',
        layer: 'tool_result',
        scope: 'conversation',
        mergeGroup: 'jd_parse_and_score',
        mergeStrategy: 'replace',
        summary: 'Tool result: jd_parse_and_score failed (SERVICE_UNAVAILABLE)',
      }),
    );
  });
});
