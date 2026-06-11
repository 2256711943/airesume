import { ChatService } from './chat.service';

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
  };

  const agentExecutorService = {
    execute: jest.fn(),
  };

  const orchestratorService = {
    decideNextAgent: jest.fn(),
  };

  const resumeContextService = {
    buildConversationContext: jest.fn(),
  };

  const service = new ChatService(
    conversationService as never,
    agentRunService as never,
    agentExecutorService as never,
    orchestratorService as never,
    resumeContextService as never,
  );

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
    });
    conversationService.appendMessage
      .mockResolvedValueOnce({
        id: 'msg-user-1',
        role: 'user',
        content: '请帮我准备一下自我介绍',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        createdAt: new Date('2026-06-06T00:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        id: 'msg-assistant-1',
        role: 'assistant',
        content: '面试指导：我判断你这次提问更偏向「自我介绍」。',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        createdAt: new Date('2026-06-06T00:00:01.000Z'),
      });
    agentRunService.createRunningRun.mockResolvedValue({ id: 'run-1' });
    agentExecutorService.execute.mockResolvedValue({
      assistantText: '面试指导：我判断你这次提问更偏向「自我介绍」。',
      toolCalls: [{ toolName: 'interview_coach_response', success: true }],
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
          createdAt: '2026-06-06T00:00:00.000Z',
        },
        {
          id: 'msg-assistant-1',
          role: 'assistant',
          content: '面试指导：我判断你这次提问更偏向「自我介绍」。',
          intent: 'interview_guidance',
          agentName: 'interviewCoachAgent',
          createdAt: '2026-06-06T00:00:01.000Z',
        },
      ],
    });

    const result = await service.sendMessage('user-1', {
      message: '请帮我准备一下自我介绍',
      historyLimit: 5,
    });

    expect(orchestratorService.decideNextAgent).toHaveBeenCalledWith('请帮我准备一下自我介绍');
    expect(conversationService.createConversation).toHaveBeenCalledWith('user-1', {
      title: '请帮我准备一下自我介绍',
    });
    expect(resumeContextService.buildConversationContext).toHaveBeenCalledWith('user-1', 'conv-1');
    expect(conversationService.appendMessage).toHaveBeenNthCalledWith(1, 'user-1', 'conv-1', {
      role: 'user',
      content: '请帮我准备一下自我介绍',
      intent: 'interview_guidance',
      agentName: 'interviewCoachAgent',
    });
    expect(agentRunService.createRunningRun).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      messageId: 'msg-user-1',
      selectedAgent: 'interviewCoachAgent',
      orchestratorDecision: {
        intent: 'interview_guidance',
        selectedAgent: 'interviewCoachAgent',
        reason: 'match interview keywords',
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
      },
    });
    expect(conversationService.appendMessage).toHaveBeenNthCalledWith(2, 'user-1', 'conv-1', {
      role: 'assistant',
      content: '面试指导：我判断你这次提问更偏向「自我介绍」。',
      intent: 'interview_guidance',
      agentName: 'interviewCoachAgent',
    });
    expect(agentRunService.markSucceeded).toHaveBeenCalledWith('run-1', 120);
    expect(conversationService.listRecentMessages).toHaveBeenCalledWith('user-1', 'conv-1', 5);
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
        createdAt: new Date('2026-06-06T00:00:00.000Z'),
      },
      assistantMessage: {
        id: 'msg-assistant-1',
        role: 'assistant',
        content: '面试指导：我判断你这次提问更偏向「自我介绍」。',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        createdAt: new Date('2026-06-06T00:00:01.000Z'),
      },
      routeDecision: {
        intent: 'interview_guidance',
        selectedAgent: 'interviewCoachAgent',
        reason: 'match interview keywords',
      },
      recentMessages: [
        {
          id: 'msg-user-1',
          role: 'user',
          content: '请帮我准备一下自我介绍',
          intent: 'interview_guidance',
          agentName: 'interviewCoachAgent',
          createdAt: '2026-06-06T00:00:00.000Z',
        },
        {
          id: 'msg-assistant-1',
          role: 'assistant',
          content: '面试指导：我判断你这次提问更偏向「自我介绍」。',
          intent: 'interview_guidance',
          agentName: 'interviewCoachAgent',
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

    expect(resumeContextService.buildConversationContext).toHaveBeenCalledWith('user-1', 'conv-2');
    expect(agentRunService.markFailed).toHaveBeenCalledWith('run-2', expect.any(Error), 130);
    expect(conversationService.appendMessage).toHaveBeenCalledTimes(1);
    expect(conversationService.listRecentMessages).not.toHaveBeenCalled();
    expect(agentRunService.markSucceeded).not.toHaveBeenCalled();
  });
});
