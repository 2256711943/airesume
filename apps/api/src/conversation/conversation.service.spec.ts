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

  const service = new ConversationService(
    prisma as never,
    resumeContextService as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
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
});
