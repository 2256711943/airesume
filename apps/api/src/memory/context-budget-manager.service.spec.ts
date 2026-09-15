import { ContextBudgetManagerService } from './context-budget-manager.service';
import type { ContextPack } from './context-pack.types';
import type { MemoryEntry, MemoryLayer } from './memory.types';

describe('ContextBudgetManagerService', () => {
  const memoryStore = {
    list: jest.fn(),
  };
  const contextPackStore = {
    save: jest.fn(),
  };

  const service = new ContextBudgetManagerService(
    memoryStore as never,
    contextPackStore as never,
  );

  function createMemoryEntry(
    memoryId: string,
    overrides: Partial<MemoryEntry> = {},
  ): MemoryEntry {
    const baseTime = new Date('2026-08-01T10:00:00.000Z');

    return {
      memoryId,
      conversationId: 'conversation-1',
      runId: 'run-1',
      layer: 'resume' satisfies MemoryLayer,
      scope: 'conversation',
      content: `content-${memoryId}`,
      summary: `summary-${memoryId}`,
      tokenEstimate: 100,
      priority: 1,
      pinned: false,
      freshnessScore: 0.1,
      relevanceScore: 0.1,
      sourceRefs: [],
      mergeGroup: null,
      mergeStrategy: null,
      version: 1,
      metadata: null,
      expiresAt: null,
      createdAt: baseTime,
      updatedAt: baseTime,
      lastAccessedAt: null,
      accessCount: 0,
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    contextPackStore.save.mockImplementation(
      (pack: ContextPack): Promise<ContextPack> => Promise.resolve(pack),
    );
  });

  it('keeps preference blocks ahead of tool results in the generated pack', async () => {
    memoryStore.list.mockResolvedValue([
      createMemoryEntry('resume-1', {
        layer: 'resume',
        tokenEstimate: 120,
      }),
      createMemoryEntry('pref-1', {
        layer: 'preference',
        tokenEstimate: 40,
      }),
      createMemoryEntry('tool-1', {
        layer: 'tool_result',
        tokenEstimate: 60,
      }),
    ]);

    const pack = await service.buildContextPack({
      conversationId: 'conversation-1',
      maxTokens: 1_000,
    });

    expect(contextPackStore.save).toHaveBeenCalledTimes(1);
    expect(pack.summaryBlocks.map((block) => block.title)).toEqual([
      'Resume Context',
      'Display Preferences',
      'Recent Tool Results',
    ]);
    expect(pack.selectedMemoryIds).toEqual(['resume-1', 'pref-1', 'tool-1']);
  });

  it('builds the pack from provided candidates without querying the store', async () => {
    const pack = await service.buildContextPack({
      conversationId: 'conversation-1',
      maxTokens: 1_000,
      candidates: [
        createMemoryEntry('candidate-live', {
          layer: 'preference',
          tokenEstimate: 40,
        }),
        // 过期候选必须被过滤，不得进入注入内容
        createMemoryEntry('candidate-expired', {
          layer: 'preference',
          tokenEstimate: 40,
          expiresAt: new Date('2026-08-01T09:00:00.000Z'),
        }),
      ],
    });

    expect(memoryStore.list).not.toHaveBeenCalled();
    expect(pack.selectedMemoryIds).toEqual(['candidate-live']);
    expect(pack.droppedMemoryIds).toEqual([]);
    expect(pack.metadata).toEqual(
      expect.objectContaining({ injectedIntoPrompt: true }),
    );
  });

  it('drops lower-priority memories first when the token budget is tight', async () => {
    memoryStore.list.mockResolvedValue([
      createMemoryEntry('resume-high', {
        layer: 'resume',
        tokenEstimate: 90,
        priority: 10,
      }),
      createMemoryEntry('resume-low', {
        layer: 'resume',
        tokenEstimate: 80,
        priority: 1,
      }),
    ]);

    const pack = await service.buildContextPack({
      conversationId: 'conversation-1',
      maxTokens: 100,
      layerLimits: {
        resume: {
          maxItems: 2,
          maxTokens: 100,
        },
      },
    });

    expect(contextPackStore.save).toHaveBeenCalledTimes(1);
    expect(pack.selectedMemoryIds).toEqual(['resume-high']);
    expect(pack.droppedMemoryIds).toEqual(['resume-low']);
    expect(pack.usage.usedTokens).toBe(90);
    expect(pack.usage.droppedTokens).toBe(80);
  });

  it('selects the latest preference when the layer item limit only allows one', async () => {
    memoryStore.list.mockResolvedValue([
      createMemoryEntry('pref-old', {
        layer: 'preference',
        tokenEstimate: 30,
        updatedAt: new Date('2026-08-01T09:00:00.000Z'),
      }),
      createMemoryEntry('pref-new', {
        layer: 'preference',
        tokenEstimate: 30,
        updatedAt: new Date('2026-08-01T10:30:00.000Z'),
      }),
    ]);

    const pack = await service.buildContextPack({
      conversationId: 'conversation-1',
      maxTokens: 200,
      layerLimits: {
        preference: {
          maxItems: 1,
          maxTokens: 200,
        },
      },
    });

    expect(contextPackStore.save).toHaveBeenCalledTimes(1);
    expect(pack.selectedMemoryIds).toEqual(['pref-new']);
    expect(pack.droppedMemoryIds).toEqual(['pref-old']);
    expect(pack.summaryBlocks[0]?.memoryIds).toEqual(['pref-new']);
  });
});
