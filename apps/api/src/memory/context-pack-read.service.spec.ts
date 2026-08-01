import { ContextPackReadService } from './context-pack-read.service';
import type { ContextPackWriteInput } from './context-pack.types';

describe('ContextPackReadService', () => {
  const contextPackStore = {
    get: jest.fn(),
    getLatest: jest.fn(),
    list: jest.fn(),
  };

  const service = new ContextPackReadService(contextPackStore as never);

  function createPack(
    overrides: Partial<ContextPackWriteInput & { packId: string }> = {},
  ) {
    return {
      packId: 'pack-1',
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
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the latest pack for a conversation', async () => {
    const pack = createPack({ packId: 'pack-latest' });
    contextPackStore.getLatest.mockResolvedValue(pack);

    const result = await service.getLatestForConversation('conversation-1');

    expect(contextPackStore.getLatest).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
    });
    expect(result).toEqual(pack);
  });

  it('lists conversation history with descending generatedAt order and limit', async () => {
    const packs = [createPack({ packId: 'pack-2' }), createPack()];
    contextPackStore.list.mockResolvedValue(packs);

    const result = await service.listConversationHistory('conversation-1', 20);

    expect(contextPackStore.list).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      limit: 20,
      orderBy: {
        field: 'generatedAt',
        direction: 'desc',
      },
    });
    expect(result).toEqual(packs);
  });

  it('returns null when a pack belongs to another conversation', async () => {
    contextPackStore.get.mockResolvedValue(
      createPack({
        packId: 'pack-foreign',
        conversationId: 'conversation-2',
      }),
    );

    const result = await service.getConversationPack(
      'conversation-1',
      'pack-foreign',
    );

    expect(result).toBeNull();
  });
});
