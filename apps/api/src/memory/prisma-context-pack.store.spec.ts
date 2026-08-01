import { PrismaContextPackStore } from './prisma-context-pack.store';
import { Logger } from '@nestjs/common';
import type {
  ContextPackDropReason,
  ContextPackWriteInput,
} from './context-pack.types';
import type { MemoryLayer } from './memory.types';

describe('PrismaContextPackStore', () => {
  const prisma = {
    conversationContextPack: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
  };

  const store = new PrismaContextPackStore(prisma as never);

  function createPackInput(
    overrides: Partial<ContextPackWriteInput> = {},
  ): ContextPackWriteInput {
    return {
      packId: 'pack-1',
      conversationId: 'conversation-1',
      runId: 'run-1',
      intent: 'interview_guidance',
      maxTokens: 1_000,
      layerOrder: [
        'resume',
        'preference',
        'tool_result',
        'session',
      ] satisfies MemoryLayer[],
      selectedMemoryIds: ['memory-1'],
      droppedMemoryIds: ['memory-2'],
      droppedMemories: [
        {
          memoryId: 'memory-2',
          layer: 'session',
          reason: 'pack_token_limit' satisfies ContextPackDropReason,
          tokenEstimate: 50,
          priority: 1,
          pinned: false,
          summary: 'dropped summary',
        },
      ],
      summaryBlocks: [
        {
          blockId: 'pack-1:block:1',
          type: 'memory',
          layer: 'resume',
          position: 1,
          title: 'Resume Context',
          content: '- summary',
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
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('saves and reloads packs from prisma', async () => {
    prisma.conversationContextPack.upsert.mockResolvedValue({
      id: 'pack-1',
      conversationId: 'conversation-1',
      runId: 'run-1',
      intent: 'interview_guidance',
      maxTokens: 1_000,
      layerOrder: ['resume', 'preference', 'tool_result', 'session'],
      selectedMemoryIds: ['memory-1'],
      droppedMemoryIds: ['memory-2'],
      droppedMemories: [],
      summaryBlocks: [],
      finalPromptPreview: '## Resume Context',
      usage: {
        maxTokens: 1_000,
        reservedTokens: 0,
        usedTokens: 100,
        droppedTokens: 50,
      },
      metadata: null,
      generatedAt: new Date('2026-08-01T10:00:00.000Z'),
    });

    const saved = await store.save(createPackInput());

    expect(prisma.conversationContextPack.upsert).toHaveBeenCalledTimes(1);
    expect(saved.packId).toBe('pack-1');
    expect(saved.selectedMemoryIds).toEqual(['memory-1']);
  });

  it('loads the latest pack by conversation scope', async () => {
    prisma.conversationContextPack.findFirst.mockResolvedValue({
      id: 'pack-new',
      conversationId: 'conversation-1',
      runId: 'run-1',
      intent: 'interview_guidance',
      maxTokens: 1_000,
      layerOrder: ['resume'],
      selectedMemoryIds: ['memory-1'],
      droppedMemoryIds: [],
      droppedMemories: [],
      summaryBlocks: [],
      finalPromptPreview: '## Resume Context',
      usage: {
        maxTokens: 1_000,
        reservedTokens: 0,
        usedTokens: 100,
        droppedTokens: 0,
      },
      metadata: null,
      generatedAt: new Date('2026-08-01T11:00:00.000Z'),
    });

    const latest = await store.getLatest({
      conversationId: 'conversation-1',
      runId: 'run-1',
      intent: 'interview_guidance',
    });

    expect(prisma.conversationContextPack.findFirst).toHaveBeenCalledTimes(1);
    expect(latest?.packId).toBe('pack-new');
  });

  it('deletes packs by filter', async () => {
    prisma.conversationContextPack.findMany.mockResolvedValue([
      { id: 'pack-1' },
      { id: 'pack-2' },
    ]);

    const deleted = await store.deleteMany({
      conversationId: 'conversation-1',
    });

    expect(deleted).toEqual(['pack-1', 'pack-2']);
    expect(prisma.conversationContextPack.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('falls back when database json is malformed', async () => {
    prisma.conversationContextPack.findUnique.mockResolvedValue({
      id: 'pack-bad',
      conversationId: 'conversation-1',
      runId: 'run-1',
      intent: 'interview_guidance',
      maxTokens: 1_000,
      layerOrder: ['resume', 'bad-layer'],
      selectedMemoryIds: 'not-an-array',
      droppedMemoryIds: [123],
      droppedMemories: [
        {
          memoryId: 'memory-2',
          layer: 'bad-layer',
          reason: 'bad-reason',
          tokenEstimate: '50',
          priority: null,
          pinned: 'false',
          summary: {},
        },
      ],
      summaryBlocks: [
        {
          blockId: 123,
          type: 'bad-type',
          layer: 'resume',
          position: '1',
          title: null,
          content: 999,
          memoryIds: ['memory-1', 1],
          tokenEstimate: '100',
          truncated: 'no',
          metadata: [],
        },
      ],
      finalPromptPreview: '## Resume Context',
      usage: {
        maxTokens: '1000',
        reservedTokens: '0',
        usedTokens: null,
        droppedTokens: undefined,
      },
      metadata: [],
      generatedAt: new Date('2026-08-01T12:00:00.000Z'),
    });

    const loaded = await store.get('pack-bad');

    expect(loaded?.layerOrder).toEqual([]);
    expect(loaded?.selectedMemoryIds).toEqual([]);
    expect(loaded?.droppedMemoryIds).toEqual([]);
    expect(loaded?.droppedMemories).toEqual([]);
    expect(loaded?.summaryBlocks).toEqual([]);
    expect(loaded?.usage).toEqual({
      maxTokens: 1_000,
      reservedTokens: 0,
      usedTokens: 0,
      droppedTokens: 0,
    });
    expect(loaded?.metadata).toBeNull();
  });
});
