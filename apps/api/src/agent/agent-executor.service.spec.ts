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
      },
    });

    expect(result.toolCalls).toEqual([
      {
        toolName: 'interview_coach_response',
        success: true,
      },
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
      },
    });

    expect(result.assistantText).toContain('技术题');
    expect(result.assistantText).toContain('先说结论');
    expect(result.assistantText).toContain('核心概念');
    expect(toolCallLogService.createLog).toHaveBeenCalledTimes(1);
  });
});
