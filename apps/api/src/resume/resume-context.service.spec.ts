import { ResumeContextService } from './resume-context.service';

describe('ResumeContextService', () => {
  const prisma = {
    conversationMemorySlot: {
      findFirst: jest.fn(),
      upsert: jest.fn(),
    },
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
  });

  it('uses cached resume memory before falling back to prisma', async () => {
    memoryStore.list.mockResolvedValue([
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
        updatedAt: new Date('2026-06-06T00:00:01.000Z'),
      },
    ]);
    prisma.conversationMemorySlot.findFirst.mockResolvedValueOnce({
      slotValue: {
        summary: 'Saved conversation summary',
        messageCount: 2,
        lastMessageAt: '2026-06-06T00:00:01.000Z',
      },
      updatedAt: new Date('2026-06-06T00:00:01.000Z'),
    });
    prisma.conversationMessage.findMany.mockResolvedValue([]);

    const result = await service.buildConversationContext('user-1', 'conv-1');

    expect(memoryStore.list).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      layer: 'resume',
    });
    expect(prisma.conversationMemorySlot.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.resumeLibraryItem.findMany).not.toHaveBeenCalled();
    expect(result.activeResumeIds).toEqual(['resume-1']);
    expect(result.selectedCount).toBe(1);
    expect(result.activeResumeSummaries).toEqual([
      {
        id: 'resume-1',
        title: 'Backend Resume',
        summary: 'Backend engineer profile',
        sourceMode: 'hybrid',
        keySkills: ['NestJS', 'Node.js'],
        keyProjects: [],
        keyExperiences: [],
      },
    ]);
  });

  it('falls back to prisma and writes a resume snapshot into memory', async () => {
    memoryStore.list.mockResolvedValue([]);
    prisma.conversationMemorySlot.findFirst
      .mockResolvedValueOnce({
        slotValue: {
          summary: 'Saved conversation summary',
          messageCount: 2,
          lastMessageAt: '2026-06-06T00:00:01.000Z',
        },
        updatedAt: new Date('2026-06-06T00:00:01.000Z'),
      })
      .mockResolvedValueOnce({
        slotValue: ['resume-1'],
      });
    prisma.conversationMessage.findMany.mockResolvedValue([]);
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

    const result = await service.buildConversationContext('user-1', 'conv-1');

    expect(prisma.conversationMemorySlot.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.resumeLibraryItem.findMany).toHaveBeenCalledTimes(1);
    expect(memoryStore.write).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        layer: 'resume',
        scope: 'conversation',
        mergeGroup: 'resume_snapshot',
        mergeStrategy: 'replace',
      }),
    );
    expect(result.activeResumeIds).toEqual(['resume-1']);
    expect(result.activeResumeSummaries[0]?.title).toBe('Backend Resume');
  });

  it('refreshes history summary in prisma and memory', async () => {
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
    prisma.conversationMemorySlot.upsert.mockResolvedValue({ id: 'slot-1' });

    await service.refreshConversationHistorySummary('user-1', 'conv-1');

    expect(prisma.conversationMemorySlot.upsert).toHaveBeenCalledTimes(1);
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
});
