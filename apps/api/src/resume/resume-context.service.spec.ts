import { ResumeContextService } from './resume-context.service';

const HISTORY_SLOT = 'conversation_history_summary';

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
    memoryStore.list.mockImplementation((query: { layer?: string }) => {
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

      if (query.layer === 'preference') {
        return [
          {
            memoryId: 'preference-1',
            metadata: {
              category: 'language',
              key: 'response_language',
              normalizedValue: 'zh-CN',
              sourceKind: 'user_text',
            },
            content: 'display_preference response_language=zh-CN',
            summary: 'Display preference: response_language=zh-CN',
            updatedAt: new Date('2026-06-06T00:00:02.000Z'),
          },
          {
            memoryId: 'preference-2',
            metadata: {
              category: 'structure',
              key: 'response_structure',
              normalizedValue: 'answer_first',
              sourceKind: 'user_text',
            },
            content: 'display_preference response_structure=answer_first',
            summary: 'Display preference: response_structure=answer_first',
            updatedAt: new Date('2026-06-06T00:00:03.000Z'),
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
      mergeGroup: HISTORY_SLOT,
      orderBy: {
        field: 'updatedAt',
        direction: 'desc',
      },
      limit: 1,
    });
    expect(memoryStore.list).toHaveBeenNthCalledWith(3, {
      conversationId: 'conv-1',
      layer: 'preference',
      orderBy: {
        field: 'updatedAt',
        direction: 'desc',
      },
      limit: 20,
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
    expect(result.displayPreferences).toEqual([
      {
        category: 'structure',
        key: 'response_structure',
        normalizedValue: 'answer_first',
        sourceKind: 'user_text',
        summary: 'Display preference: response_structure=answer_first',
        updatedAt: '2026-06-06T00:00:03.000Z',
      },
      {
        category: 'language',
        key: 'response_language',
        normalizedValue: 'zh-CN',
        sourceKind: 'user_text',
        summary: 'Display preference: response_language=zh-CN',
        updatedAt: '2026-06-06T00:00:02.000Z',
      },
    ]);
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
        }) as Record<string, unknown>,
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

  it('refreshes history summary from raw messages and records provenance metadata', async () => {
    prisma.conversationMessage.findMany.mockResolvedValue([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Use STAR to structure the answer.',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        createdAt: new Date('2026-06-06T00:00:01.000Z'),
      },
      {
        id: 'user-1',
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
        mergeGroup: HISTORY_SLOT,
        mergeStrategy: 'replace',
        metadata: expect.objectContaining({
          messageCount: 2,
          lastMessageAt: '2026-06-06T00:00:01.000Z',
          lastMessageId: 'assistant-1',
          summaryVersion: 1,
        }) as Record<string, unknown>,
      }),
    );
  });

  it('removes stale history summary memory when there are no messages to summarize', async () => {
    prisma.conversationMessage.findMany.mockResolvedValue([]);

    await service.refreshConversationHistorySummary('user-1', 'conv-1');

    expect(memoryStore.deleteMany).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      layer: 'session',
      mergeGroup: HISTORY_SLOT,
      includePinned: true,
    });
    expect(memoryStore.write).not.toHaveBeenCalled();
  });

  it('skips an outdated refresh when the current slot already covers the same or newer history', async () => {
    prisma.conversationMessage.findMany.mockResolvedValue([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Use STAR to structure the answer.',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        createdAt: new Date('2026-06-06T00:00:01.000Z'),
      },
      {
        id: 'user-1',
        role: 'user',
        content: 'I want to prepare a self introduction',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        createdAt: new Date('2026-06-06T00:00:00.000Z'),
      },
    ]);
    // 槽位已存在且覆盖到相同的最后一条消息（assistant-1），说明是过期刷新。
    memoryStore.list.mockResolvedValue([
      {
        memoryId: 'history-2',
        metadata: {
          summary: 'Newer summary',
          messageCount: 2,
          lastMessageAt: '2026-06-06T00:00:02.000Z',
          lastMessageId: 'assistant-2',
          summaryVersion: 3,
        },
        content: 'Newer summary',
        summary: 'Newer summary',
        updatedAt: new Date('2026-06-06T00:00:02.000Z'),
      },
    ]);

    await service.refreshConversationHistorySummary('user-1', 'conv-1');

    expect(memoryStore.write).not.toHaveBeenCalled();
    expect(memoryStore.deleteMany).not.toHaveBeenCalled();
  });

  it('keeps the newest summary when concurrent refreshes are triggered out of completion order', async () => {
    // 第一次刷新（旧状态，覆盖到 assistant-2）
    prisma.conversationMessage.findMany
      .mockResolvedValueOnce([
        {
          id: 'assistant-2',
          role: 'assistant',
          content: 'Answer for message N',
          intent: 'interview_guidance',
          agentName: 'interviewCoachAgent',
          createdAt: new Date('2026-06-06T00:00:02.000Z'),
        },
        {
          id: 'user-2',
          role: 'user',
          content: 'User message N',
          intent: 'interview_guidance',
          agentName: 'interviewCoachAgent',
          createdAt: new Date('2026-06-06T00:00:01.000Z'),
        },
      ])
      // 第二次刷新（新状态，覆盖到 assistant-3）
      .mockResolvedValueOnce([
        {
          id: 'assistant-3',
          role: 'assistant',
          content: 'Answer for message N+2',
          intent: 'interview_guidance',
          agentName: 'interviewCoachAgent',
          createdAt: new Date('2026-06-06T00:00:04.000Z'),
        },
        {
          id: 'user-3',
          role: 'user',
          content: 'User message N+2',
          intent: 'interview_guidance',
          agentName: 'interviewCoachAgent',
          createdAt: new Date('2026-06-06T00:00:03.000Z'),
        },
      ]);

    // 模拟持久层：write 后 list 能读到刚写入的槽位，供第二次刷新做单调比较。
    let storedSlot: Array<Record<string, unknown>> = [];
    memoryStore.list.mockImplementation(() => storedSlot);
    memoryStore.write.mockImplementation(
      (input: { metadata?: Record<string, unknown>; summary?: string }) => {
        storedSlot = [
          {
            metadata: input.metadata,
            summary: input.summary,
            content: input.summary,
            updatedAt: new Date(),
          },
        ];
        return { merged: true, memory: {} };
      },
    );

    await Promise.all([
      service.refreshConversationHistorySummary('user-1', 'conv-1'),
      service.refreshConversationHistorySummary('user-1', 'conv-1'),
    ]);

    const metadata = storedSlot[0]?.metadata as {
      lastMessageId: string;
      summaryVersion: number;
    };
    expect(memoryStore.write).toHaveBeenCalledTimes(2);
    expect(metadata.lastMessageId).toBe('assistant-3');
    expect(metadata.summaryVersion).toBe(2);
  });

  it('rebuilds an equivalent summary from raw messages after the slot is lost', async () => {
    prisma.conversationMessage.findMany.mockResolvedValue([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Use STAR to structure the answer.',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        createdAt: new Date('2026-06-06T00:00:01.000Z'),
      },
      {
        id: 'user-1',
        role: 'user',
        content: 'I want to prepare a self introduction',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        createdAt: new Date('2026-06-06T00:00:00.000Z'),
      },
    ]);
    // 首次刷新成功写入
    await service.refreshConversationHistorySummary('user-1', 'conv-1');
    const firstWriteCalls = memoryStore.write.mock.calls as Array<
      [{ metadata: Record<string, unknown>; content: string }]
    >;
    const firstWrite = firstWriteCalls[0]?.[0];
    expect(firstWrite.content.length).toBeGreaterThan(0);

    // 槽位被删除（list 变空），再次刷新应从原始消息重建等价摘要
    memoryStore.write.mockClear();
    memoryStore.list.mockResolvedValue([]);
    await service.refreshConversationHistorySummary('user-1', 'conv-1');

    const secondWriteCalls = memoryStore.write.mock.calls as Array<
      [{ metadata: Record<string, unknown>; content: string }]
    >;
    const secondWrite = secondWriteCalls[0]?.[0];
    expect(secondWrite.content).toBe(firstWrite.content);
    expect(secondWrite.metadata.lastMessageId).toBe('assistant-1');
  });

  it('does not fold a trailing in-flight user message into the summary rebuilt while the slot is missing', async () => {
    // 无缓存槽位（buildConversationContext 走原始消息重建路径），
    // 消息尾是一条正在进行、尚未有回复的用户消息 B。
    memoryStore.list.mockImplementation(() => []);

    prisma.conversationMessage.findMany.mockResolvedValue([
      {
        id: 'user-b',
        role: 'user',
        content: '这是对 B 的追问，B 尚未被回复',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        createdAt: new Date('2026-06-06T00:00:03.000Z'),
      },
      {
        id: 'assistant-a',
        role: 'assistant',
        content: 'A 的回答',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        createdAt: new Date('2026-06-06T00:00:02.000Z'),
      },
      {
        id: 'user-a',
        role: 'user',
        content: 'A 的问题',
        intent: 'interview_guidance',
        agentName: 'interviewCoachAgent',
        createdAt: new Date('2026-06-06T00:00:01.000Z'),
      },
    ]);

    const result = await service.buildConversationContext('user-1', 'conv-1');

    expect(prisma.conversationMessage.findMany).toHaveBeenCalledTimes(1);
    expect(result.conversationHistorySummary).not.toBeNull();
    expect(result.conversationHistorySummary?.summary).not.toContain(
      'B 的追问',
    );
    expect(result.conversationHistorySummary?.messageCount).toBe(2);
    expect(result.conversationHistorySummary?.lastMessageId).toBe(
      'assistant-a',
    );
  });
});
