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
          summary: '主要话题：面试指导 | 用户关注：自我介绍',
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

    expect(result).toEqual({
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
        summary: '主要话题：面试指导 | 用户关注：自我介绍',
        messageCount: 2,
        lastMessageAt: '2026-06-06T00:00:01.000Z',
      },
    });
  });

  it('should refresh the history summary slot from recent messages', async () => {
    prisma.conversationMessage.findMany.mockResolvedValue([
      {
        role: 'assistant',
        content: '可以用 STAR 结构来回答',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        createdAt: new Date('2026-06-06T00:00:01.000Z'),
      },
      {
        role: 'user',
        content: '我想准备自我介绍',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        createdAt: new Date('2026-06-06T00:00:00.000Z'),
      },
    ]);
    prisma.conversationMemorySlot.upsert.mockResolvedValue({ id: 'slot-1' });

    await service.refreshConversationHistorySummary('user-1', 'conv-1');

    expect(prisma.conversationMemorySlot.upsert).toHaveBeenCalledWith({
      where: {
        conversationId_slotKey: {
          conversationId: 'conv-1',
          slotKey: 'conversation_history_summary',
        },
      },
      create: expect.objectContaining({
        conversationId: 'conv-1',
        slotKey: 'conversation_history_summary',
        slotValue: expect.objectContaining({
          summary: expect.stringContaining('主要话题：面试指导'),
          messageCount: 2,
          lastMessageAt: '2026-06-06T00:00:01.000Z',
        }),
      }),
      update: expect.objectContaining({
        slotValue: expect.objectContaining({
          summary: expect.stringContaining('用户关注：我想准备自我介绍'),
          messageCount: 2,
          lastMessageAt: '2026-06-06T00:00:01.000Z',
        }),
      }),
    });
  });
});
