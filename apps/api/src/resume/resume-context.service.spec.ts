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

  const service = new ResumeContextService(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should build conversation context with resume data and history summary', async () => {
    prisma.conversationMemorySlot.findFirst
      .mockResolvedValueOnce({
        slotValue: ['resume-1'],
      })
      .mockResolvedValueOnce({
        slotValue: {
          summary: 'Saved conversation summary',
          messageCount: 2,
          lastMessageAt: '2026-06-06T00:00:01.000Z',
        },
        updatedAt: new Date('2026-06-06T00:00:01.000Z'),
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

    expect(result.activeResumeIds).toEqual(['resume-1']);
    expect(result.selectedCount).toBe(1);
    expect(result.activeResumeSummaries).toEqual([
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
    ]);
    expect(result.conversationHistorySummary).toEqual({
      summary: 'Saved conversation summary',
      messageCount: 2,
      lastMessageAt: '2026-06-06T00:00:01.000Z',
    });
  });

  it('should refresh the history summary slot from recent messages', async () => {
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

    const firstUpsertCall = prisma.conversationMemorySlot.upsert.mock
      .calls[0] as [unknown] | undefined;
    const upsertArg = firstUpsertCall?.[0] as {
      where: {
        conversationId_slotKey: {
          conversationId: string;
          slotKey: string;
        };
      };
      create: {
        conversationId: string;
        slotKey: string;
        slotValue: {
          summary: string;
          messageCount: number;
          lastMessageAt: string | null;
        };
      };
      update: {
        slotValue: {
          summary: string;
          messageCount: number;
          lastMessageAt: string | null;
        };
      };
    };

    expect(upsertArg.where).toEqual({
      conversationId_slotKey: {
        conversationId: 'conv-1',
        slotKey: 'conversation_history_summary',
      },
    });
    expect(upsertArg.create.conversationId).toBe('conv-1');
    expect(upsertArg.create.slotKey).toBe('conversation_history_summary');
    expect(typeof upsertArg.create.slotValue.summary).toBe('string');
    expect(upsertArg.create.slotValue.summary.length).toBeGreaterThan(0);
    expect(upsertArg.create.slotValue.messageCount).toBe(2);
    expect(upsertArg.create.slotValue.lastMessageAt).toBe(
      '2026-06-06T00:00:01.000Z',
    );
    expect(upsertArg.update.slotValue).toEqual(upsertArg.create.slotValue);
  });
});
