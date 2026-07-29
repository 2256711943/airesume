import { ResumeContextService } from './resume-context.service';

describe('ResumeContextService', () => {
  const prisma = {
    conversationMessage: {
      findMany: jest.fn(),
    },
    resumeLibraryItem: {
      findMany: jest.fn(),
    },
  };

  const memoryStore = {
    list: jest.fn(),
    write: jest.fn(),
    deleteMany: jest.fn(),
  };

  const service = new ResumeContextService(
    prisma as never,
    memoryStore as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    memoryStore.list.mockResolvedValue([]);
    memoryStore.write.mockResolvedValue({
      merged: false,
      memory: {},
    });
    memoryStore.deleteMany.mockResolvedValue([]);
  });

  it('uses cached resume and history memories before falling back to prisma', async () => {
    memoryStore.list.mockImplementation(async (query) => {
      if (query.layer === 'resume') {
        return [
          {
            memoryId: 'resume-snapshot-1',
            metadata: {
              selectedResumeIds: ['resume-1'],
              resumeSummaries: [
                {
                  id: 'resume-1',
                  title: 'Backend Resume',
                  summary: 'Backend engineer profile',
                  sourceMode: 'hybrid',
                  keySkills: ['NestJS', 'Node.js'],
                  keyProjects: [],
                  keyExperiences: [],
                },
              ],
            },
            content: '',
            updatedAt: new Date('2026-06-06T00:00:01.000Z'),
          },
        ];
      }

      return [
        {
          memoryId: 'history-1',
          metadata: {
            summary: 'Saved conversation summary',
            messageCount: 2,
            lastMessageAt: '2026-06-06T00:00:01.000Z',
          },
          content: 'Saved conversation summary',
          summary: 'Saved conversation summary',
          updatedAt: new Date('2026-06-06T00:00:01.000Z'),
        },
      ];
    });

    const result = await service.buildConversationContext('user-1', 'conv-1');

    expect(memoryStore.list).toHaveBeenNthCalledWith(1, {
      conversationId: 'conv-1',
      layer: 'resume',
      mergeGroup: 'resume_snapshot',
      orderBy: {
        field: 'updatedAt',
        direction: 'desc',
      },
      limit: 1,
    });
    expect(memoryStore.list).toHaveBeenNthCalledWith(2, {
      conversationId: 'conv-1',
      layer: 'session',
      mergeGroup: 'conversation_history_summary',
      orderBy: {
        field: 'updatedAt',
        direction: 'desc',
      },
      limit: 1,
    });
    expect(prisma.resumeLibraryItem.findMany).not.toHaveBeenCalled();
    expect(prisma.conversationMessage.findMany).not.toHaveBeenCalled();
    expect(result.activeResumeIds).toEqual(['resume-1']);
    expect(result.selectedCount).toBe(1);
    expect(result.conversationHistorySummary).toEqual({
      summary: 'Saved conversation summary',
      messageCount: 2,
      lastMessageAt: '2026-06-06T00:00:01.000Z',
    });
  });

  it('writes a resume snapshot into memory from the selected resumes', async () => {
    prisma.resumeLibraryItem.findMany.mockResolvedValue([
      {
        id: 'resume-1',
        title: 'Backend Resume',
        summary: 'Backend engineer profile',
        sourceMode: 'hybrid',
        skills: ['NestJS', 'Node.js', 'PostgreSQL'],
        projects: [
          {
            name: 'AI Resume Assistant',
            highlights: ['Designed SSE output'],
          },
        ],
        experience: [
          {
            company: 'Acme Corp',
            role: 'Backend Engineer',
            highlights: ['Built API gateway'],
          },
        ],
      },
    ]);

    await service.setActiveResumeContext('user-1', 'conv-1', ['resume-1']);

    expect(prisma.resumeLibraryItem.findMany).toHaveBeenCalledTimes(1);
    expect(memoryStore.write).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        layer: 'resume',
        scope: 'conversation',
        mergeGroup: 'resume_snapshot',
        mergeStrategy: 'replace',
        metadata: expect.objectContaining({
          selectedResumeIds: ['resume-1'],
        }),
      }),
    );
    expect(memoryStore.deleteMany).not.toHaveBeenCalled();
  });

  it('clears the cached resume snapshot when the selection becomes empty', async () => {
    prisma.resumeLibraryItem.findMany.mockResolvedValue([]);

    await service.setActiveResumeContext('user-1', 'conv-1', []);

    expect(memoryStore.deleteMany).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      layer: 'resume',
      mergeGroup: 'resume_snapshot',
      includePinned: true,
    });
    expect(memoryStore.write).not.toHaveBeenCalled();
  });

  it('refreshes history summary in memory only', async () => {
    prisma.conversationMessage.findMany.mockResolvedValue([
      {
        role: 'assistant',
        content: 'Use STAR to structure the answer.',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        createdAt: new Date('2026-06-06T00:00:01.000Z'),
      },
      {
        role: 'user',
        content: 'I want to prepare a self introduction',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        createdAt: new Date('2026-06-06T00:00:00.000Z'),
      },
    ]);

    await service.refreshConversationHistorySummary('user-1', 'conv-1');

    expect(memoryStore.write).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        layer: 'session',
        scope: 'conversation',
        mergeGroup: 'conversation_history_summary',
        mergeStrategy: 'replace',
      }),
    );
  });

  it('removes stale history summary memory when there are no messages to summarize', async () => {
    prisma.conversationMessage.findMany.mockResolvedValue([]);

    await service.refreshConversationHistorySummary('user-1', 'conv-1');

    expect(memoryStore.deleteMany).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      layer: 'session',
      mergeGroup: 'conversation_history_summary',
      includePinned: true,
    });
    expect(memoryStore.write).not.toHaveBeenCalled();
  });
});
