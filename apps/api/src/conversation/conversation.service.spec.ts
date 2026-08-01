import { ConversationService } from './conversation.service';

describe('ConversationService', () => {
  const prisma = {
    conversation: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    conversationMessage: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
  };

  const resumeContextService = {
    buildConversationContext: jest.fn(),
    setActiveResumeContext: jest.fn(),
  };

  const memoryStore = {
    write: jest.fn(),
  };

  const service = new ConversationService(
    prisma as never,
    resumeContextService as never,
    memoryStore as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    memoryStore.write.mockResolvedValue({
      merged: false,
      memory: {},
    });
  });

  it('should persist selected resume ids through ResumeContextService', async () => {
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-1' });
    resumeContextService.setActiveResumeContext.mockResolvedValue(undefined);

    const result = await service.setResumeContext('user-1', 'conv-1', {
      resumeLibraryItemIds: [' resume-1 ', 'resume-1', 'resume-2', ''],
    });

    expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'conv-1',
        userId: 'user-1',
      },
      select: { id: true },
    });
    expect(resumeContextService.setActiveResumeContext).toHaveBeenCalledWith(
      'user-1',
      'conv-1',
      ['resume-1', 'resume-2'],
    );
    expect(result).toEqual({
      conversationId: 'conv-1',
      resumeLibraryItemIds: ['resume-1', 'resume-2'],
      slotKey: 'selected_resume_item_ids',
    });
  });

  it('should return active resume context for a conversation', async () => {
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-1' });
    resumeContextService.buildConversationContext.mockResolvedValue({
      activeResumeIds: ['resume-1'],
      activeResumeSummaries: [
        {
          id: 'resume-1',
          title: 'Backend Resume',
          summary: 'Backend engineer profile',
          sourceMode: 'hybrid',
          keySkills: ['NestJS', 'Node.js'],
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
    });

    const result = await service.getResumeContext('user-1', 'conv-1');

    expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'conv-1',
        userId: 'user-1',
      },
      select: { id: true },
    });
    expect(resumeContextService.buildConversationContext).toHaveBeenCalledWith(
      'user-1',
      'conv-1',
    );
    expect(result).toEqual({
      conversationId: 'conv-1',
      resumeLibraryItemIds: ['resume-1'],
      selectedCount: 1,
      slotKey: 'selected_resume_item_ids',
      activeResumeSummaries: [
        {
          id: 'resume-1',
          title: 'Backend Resume',
          summary: 'Backend engineer profile',
          sourceMode: 'hybrid',
          keySkills: ['NestJS', 'Node.js'],
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
    });
  });

  it('should reject when conversation does not belong to the user', async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);

    await expect(
      service.setResumeContext('user-1', 'conv-1', {
        resumeLibraryItemIds: ['resume-1'],
      }),
    ).rejects.toThrow('Conversation not found');

    expect(resumeContextService.setActiveResumeContext).not.toHaveBeenCalled();
  });

  it('captures explicit display preferences from user messages during append', async () => {
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-1' });
    prisma.conversationMessage.create.mockResolvedValue({
      id: 'msg-1',
      role: 'user',
      content: '请用中文回答，先给结论，再用表格给我',
      intent: 'interview_guidance',
      agentName: 'interviewCoachAgent',
      toolCallSummary: null,
      createdAt: new Date('2026-07-31T10:00:00.000Z'),
    });
    prisma.conversation.update.mockResolvedValue({ id: 'conv-1' });

    await service.appendMessage('user-1', 'conv-1', {
      role: 'user',
      content: '请用中文回答，先给结论，再用表格给我',
      intent: 'interview_guidance',
      agentName: 'interviewCoachAgent',
    });

    expect(memoryStore.write).toHaveBeenCalledTimes(3);
    expect(memoryStore.write).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        layer: 'preference',
        scope: 'conversation',
        mergeGroup: 'display_preference:response_language',
        mergeStrategy: 'summarize',
        summary: 'Display preference: response_language=zh-CN',
      }),
    );
    expect(memoryStore.write).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        layer: 'preference',
        scope: 'conversation',
        mergeGroup: 'display_preference:response_structure',
        mergeStrategy: 'summarize',
        summary: 'Display preference: response_structure=answer_first',
      }),
    );
    expect(memoryStore.write).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        layer: 'preference',
        scope: 'conversation',
        mergeGroup: 'display_preference:output_format',
        mergeStrategy: 'summarize',
        summary: 'Display preference: output_format=table',
      }),
    );
  });

  it('does not capture display preferences for assistant messages', async () => {
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-1' });
    prisma.conversationMessage.create.mockResolvedValue({
      id: 'msg-2',
      role: 'assistant',
      content: '我会用中文回答，并先给结论。',
      intent: 'interview_guidance',
      agentName: 'interviewCoachAgent',
      toolCallSummary: null,
      createdAt: new Date('2026-07-31T10:05:00.000Z'),
    });
    prisma.conversation.update.mockResolvedValue({ id: 'conv-1' });

    await service.appendMessage('user-1', 'conv-1', {
      role: 'assistant',
      content: '我会用中文回答，并先给结论。',
      intent: 'interview_guidance',
      agentName: 'interviewCoachAgent',
    });

    expect(memoryStore.write).not.toHaveBeenCalled();
  });
});
