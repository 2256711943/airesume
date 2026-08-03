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

  const contextPackReadService = {
    getLatestForConversation: jest.fn(),
    listConversationHistory: jest.fn(),
    getConversationPack: jest.fn(),
  };

  const service = new ConversationService(
    prisma as never,
    resumeContextService as never,
    memoryStore as never,
    contextPackReadService as never,
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

  it('returns a nullable latest context pack when none exists', async () => {
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-1' });
    contextPackReadService.getLatestForConversation.mockResolvedValue(null);

    const result = await service.getLatestContextPack('user-1', 'conv-1');

    expect(
      contextPackReadService.getLatestForConversation,
    ).toHaveBeenCalledWith('conv-1');
    expect(result).toEqual({
      conversationId: 'conv-1',
      contextPack: null,
    });
  });

  it('aggregates resume context, latest context pack, and recent messages for restore', async () => {
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-1' });
    prisma.conversationMessage.findMany.mockResolvedValue([
      {
        id: 'msg-2',
        role: 'assistant',
        content: '已生成综合版简历建议',
        intent: 'resume_generation',
        agentName: 'resumeWorkbenchAgent',
        toolCallSummary: [
          { toolName: 'search_docs', success: true, latencyMs: 12 },
        ],
        createdAt: new Date('2026-08-01T10:02:00.000Z'),
      },
      {
        id: 'msg-1',
        role: 'system',
        content: 'SYSTEM / UP AI 简历上下文',
        intent: 'resume_context',
        agentName: 'resume_workbench',
        toolCallSummary: null,
        createdAt: new Date('2026-08-01T10:01:00.000Z'),
      },
    ]);
    resumeContextService.buildConversationContext.mockResolvedValue({
      activeResumeIds: ['resume-1'],
      activeResumeSummaries: [
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
      selectedCount: 1,
      conversationHistorySummary: {
        summary: '用户正在围绕简历继续追问',
        messageCount: 2,
        lastMessageAt: '2026-08-01T10:02:00.000Z',
      },
    });
    contextPackReadService.getLatestForConversation.mockResolvedValue({
      packId: 'pack-1',
      conversationId: 'conv-1',
      runId: 'run-1',
      intent: 'resume_generation',
      maxTokens: 1_000,
      layerOrder: ['resume', 'preference'],
      selectedMemoryIds: ['memory-1'],
      droppedMemoryIds: [],
      droppedMemories: [],
      summaryBlocks: [],
      finalPromptPreview: '## Resume Context',
      usage: {
        maxTokens: 1_000,
        reservedTokens: 0,
        usedTokens: 180,
        droppedTokens: 0,
      },
      metadata: null,
      generatedAt: new Date('2026-08-01T10:03:00.000Z'),
    });

    const result = await service.getResumeSession('user-1', 'conv-1', 20);

    expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'conv-1',
        userId: 'user-1',
      },
      select: { id: true },
    });
    expect(prisma.conversationMessage.findMany).toHaveBeenCalledWith({
      where: { conversationId: 'conv-1' },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    expect(result).toEqual({
      conversationId: 'conv-1',
      resumeContext: {
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
            keyProjects: [],
            keyExperiences: [],
          },
        ],
        conversationHistorySummary: {
          summary: '用户正在围绕简历继续追问',
          messageCount: 2,
          lastMessageAt: '2026-08-01T10:02:00.000Z',
        },
      },
      latestContextPack: {
        packId: 'pack-1',
        conversationId: 'conv-1',
        runId: 'run-1',
        intent: 'resume_generation',
        maxTokens: 1_000,
        layerOrder: ['resume', 'preference'],
        selectedMemoryIds: ['memory-1'],
        droppedMemoryIds: [],
        droppedMemories: [],
        summaryBlocks: [],
        finalPromptPreview: '## Resume Context',
        usage: {
          maxTokens: 1_000,
          reservedTokens: 0,
          usedTokens: 180,
          droppedTokens: 0,
        },
        metadata: null,
        selectedCount: 1,
        droppedCount: 0,
        summaryBlockCount: 0,
        generatedAt: '2026-08-01T10:03:00.000Z',
      },
      messages: [
        {
          id: 'msg-1',
          role: 'system',
          content: 'SYSTEM / UP AI 简历上下文',
          intent: 'resume_context',
          agentName: 'resume_workbench',
          toolCallSummary: null,
          createdAt: '2026-08-01T10:01:00.000Z',
        },
        {
          id: 'msg-2',
          role: 'assistant',
          content: '已生成综合版简历建议',
          intent: 'resume_generation',
          agentName: 'resumeWorkbenchAgent',
          toolCallSummary: [
            { toolName: 'search_docs', success: true, latencyMs: 12 },
          ],
          createdAt: '2026-08-01T10:02:00.000Z',
        },
      ],
    });
  });

  it('lists context pack history with derived summary counts', async () => {
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-1' });
    contextPackReadService.listConversationHistory.mockResolvedValue([
      {
        packId: 'pack-1',
        conversationId: 'conv-1',
        runId: 'run-1',
        intent: 'interview_guidance',
        maxTokens: 1_000,
        layerOrder: ['resume', 'preference'],
        selectedMemoryIds: ['memory-1', 'memory-2'],
        droppedMemoryIds: ['memory-3'],
        droppedMemories: [],
        summaryBlocks: [{ blockId: 'block-1' }, { blockId: 'block-2' }],
        finalPromptPreview: 'preview',
        usage: {
          maxTokens: 1_000,
          reservedTokens: 0,
          usedTokens: 200,
          droppedTokens: 50,
        },
        metadata: null,
        generatedAt: new Date('2026-08-01T10:00:00.000Z'),
      },
    ]);

    const result = await service.listContextPackHistory('user-1', 'conv-1', 20);

    expect(contextPackReadService.listConversationHistory).toHaveBeenCalledWith(
      'conv-1',
      20,
    );
    expect(result).toEqual({
      conversationId: 'conv-1',
      packs: [
        {
          packId: 'pack-1',
          runId: 'run-1',
          intent: 'interview_guidance',
          maxTokens: 1_000,
          layerOrder: ['resume', 'preference'],
          usage: {
            maxTokens: 1_000,
            reservedTokens: 0,
            usedTokens: 200,
            droppedTokens: 50,
          },
          selectedCount: 2,
          droppedCount: 1,
          summaryBlockCount: 2,
          generatedAt: '2026-08-01T10:00:00.000Z',
        },
      ],
    });
  });

  it('returns full context pack detail with ISO timestamps', async () => {
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-1' });
    contextPackReadService.getConversationPack.mockResolvedValue({
      packId: 'pack-1',
      conversationId: 'conv-1',
      runId: 'run-1',
      intent: 'interview_guidance',
      maxTokens: 1_000,
      layerOrder: ['resume', 'preference'],
      selectedMemoryIds: ['memory-1'],
      droppedMemoryIds: ['memory-2'],
      droppedMemories: [
        {
          memoryId: 'memory-2',
          layer: 'session',
          reason: 'pack_token_limit',
          tokenEstimate: 50,
          priority: 1,
          pinned: false,
          summary: 'Old summary',
        },
      ],
      summaryBlocks: [
        {
          blockId: 'block-1',
          type: 'memory',
          layer: 'resume',
          position: 1,
          title: 'Resume Context',
          content: '- Backend engineer profile',
          memoryIds: ['memory-1'],
          tokenEstimate: 100,
          truncated: false,
          metadata: {
            memoryCount: 1,
          },
        },
      ],
      finalPromptPreview: '## Resume Context',
      usage: {
        maxTokens: 1_000,
        reservedTokens: 0,
        usedTokens: 100,
        droppedTokens: 50,
      },
      metadata: {
        selectedCount: 1,
      },
      generatedAt: new Date('2026-08-01T10:00:00.000Z'),
    });

    const result = await service.getContextPack('user-1', 'conv-1', 'pack-1');

    expect(contextPackReadService.getConversationPack).toHaveBeenCalledWith(
      'conv-1',
      'pack-1',
    );
    expect(result).toEqual({
      packId: 'pack-1',
      conversationId: 'conv-1',
      runId: 'run-1',
      intent: 'interview_guidance',
      maxTokens: 1_000,
      layerOrder: ['resume', 'preference'],
      selectedMemoryIds: ['memory-1'],
      droppedMemoryIds: ['memory-2'],
      droppedMemories: [
        {
          memoryId: 'memory-2',
          layer: 'session',
          reason: 'pack_token_limit',
          tokenEstimate: 50,
          priority: 1,
          pinned: false,
          summary: 'Old summary',
        },
      ],
      summaryBlocks: [
        {
          blockId: 'block-1',
          type: 'memory',
          layer: 'resume',
          position: 1,
          title: 'Resume Context',
          content: '- Backend engineer profile',
          memoryIds: ['memory-1'],
          tokenEstimate: 100,
          truncated: false,
          metadata: {
            memoryCount: 1,
          },
        },
      ],
      finalPromptPreview: '## Resume Context',
      usage: {
        maxTokens: 1_000,
        reservedTokens: 0,
        usedTokens: 100,
        droppedTokens: 50,
      },
      metadata: {
        selectedCount: 1,
      },
      selectedCount: 1,
      droppedCount: 1,
      summaryBlockCount: 1,
      generatedAt: '2026-08-01T10:00:00.000Z',
    });
  });

  it('throws when a context pack is not found for the conversation', async () => {
    prisma.conversation.findFirst.mockResolvedValue({ id: 'conv-1' });
    contextPackReadService.getConversationPack.mockResolvedValue(null);

    await expect(
      service.getContextPack('user-1', 'conv-1', 'missing-pack'),
    ).rejects.toThrow('Context pack not found');
  });

  it('should reject when conversation does not belong to the user', async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);

    await expect(
      service.setResumeContext('user-1', 'conv-1', {
        resumeLibraryItemIds: ['resume-1'],
      }),
    ).rejects.toThrow('Conversation not found');

    expect(resumeContextService.setActiveResumeContext).not.toHaveBeenCalled();
    expect(
      contextPackReadService.getLatestForConversation,
    ).not.toHaveBeenCalled();
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
