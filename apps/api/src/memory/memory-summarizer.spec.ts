import { DefaultMemorySummarizer } from './memory-summarizer';
import type {
  MemoryEntry,
  MemoryLayer,
  MemorySummarizeInput,
  MemoryWriteInput,
} from './memory.types';

describe('DefaultMemorySummarizer', () => {
  const originalEnv = {
    apiKey: process.env.DASHSCOPE_API_KEY,
    model: process.env.DASHSCOPE_MODEL,
    baseUrl: process.env.DASHSCOPE_BASE_URL,
    timeoutMs: process.env.DASHSCOPE_TIMEOUT_MS,
  };

  afterEach(() => {
    jest.restoreAllMocks();
    process.env.DASHSCOPE_API_KEY = originalEnv.apiKey;
    process.env.DASHSCOPE_MODEL = originalEnv.model;
    process.env.DASHSCOPE_BASE_URL = originalEnv.baseUrl;
    process.env.DASHSCOPE_TIMEOUT_MS = originalEnv.timeoutMs;
  });

  function createMemoryEntry(
    memoryId: string,
    overrides: Partial<MemoryEntry> = {},
  ): MemoryEntry {
    const baseTime = new Date('2026-07-28T09:00:00.000Z');

    return {
      memoryId,
      conversationId: 'conversation-1',
      runId: 'run-1',
      layer: 'session' satisfies MemoryLayer,
      scope: 'conversation',
      content: `content-${memoryId}`,
      summary: `summary-${memoryId}`,
      tokenEstimate: 100,
      priority: 1,
      pinned: false,
      freshnessScore: 0.1,
      relevanceScore: 0.2,
      sourceRefs: [],
      mergeGroup: null,
      mergeStrategy: 'summarize',
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

  function createWriteInput(
    overrides: Partial<MemoryWriteInput> = {},
  ): MemoryWriteInput {
    return {
      conversationId: 'conversation-1',
      runId: 'run-2',
      layer: 'session' satisfies MemoryLayer,
      scope: 'conversation',
      content: 'incoming content',
      mergeGroup: 'conversation_history_summary',
      mergeStrategy: 'summarize',
      ...overrides,
    };
  }

  function createInput(
    overrides: {
      previous?: Partial<MemoryEntry>;
      incoming?: Partial<MemoryWriteInput>;
      now?: Date;
    } = {},
  ): MemorySummarizeInput {
    return {
      previous: createMemoryEntry('memory-1', overrides.previous),
      incoming: createWriteInput(overrides.incoming),
      now: overrides.now ?? new Date('2026-07-31T02:00:00.000Z'),
    };
  }

  it('keeps short merged content as pass-through', async () => {
    const summarizer = new DefaultMemorySummarizer({
      maxContentLength: 200,
    });

    const result = await summarizer.summarize(
      createInput({
        previous: {
          content: 'short previous',
          summary: 'old summary',
          tokenEstimate: 50,
        },
        incoming: {
          content: 'short incoming',
          tokenEstimate: 20,
        },
      }),
    );

    expect(result.compactionMode).toBe('pass-through');
    expect(result.content).toBe('short previous\nshort incoming');
    expect(result.summary).toBe('old summary');
    expect(result.tokenEstimate).toBe(70);
    expect(result.metadata?.compactionMode).toBe('pass-through');
  });

  it('falls back to deterministic compaction for oversized merged content', async () => {
    const summarizer = new DefaultMemorySummarizer({
      maxContentLength: 80,
      summaryLength: 90,
    });

    const result = await summarizer.summarize(
      createInput({
        previous: {
          content: 'previous '.repeat(20),
          summary: null,
          sourceRefs: [{ kind: 'message', sourceId: 'msg-1' }],
          tokenEstimate: 80,
        },
        incoming: {
          content: 'incoming '.repeat(20),
          sourceRefs: [{ kind: 'tool', sourceId: 'tool-1' }],
          tokenEstimate: 40,
        },
      }),
    );

    expect(result.compactionMode).toBe('fallback');
    expect(result.content.length).toBeLessThanOrEqual(80);
    expect(result.summary).not.toBeNull();
    expect(result.tokenEstimate).toBeLessThan(120);
    expect(result.sourceRefs.map((ref) => ref.sourceId)).toEqual([
      'msg-1',
      'tool-1',
    ]);
    expect(result.metadata?.compactionMode).toBe('fallback');
  });

  it('uses llm compaction when dashscope is configured and returns valid json', async () => {
    process.env.DASHSCOPE_API_KEY = 'test-key';
    process.env.DASHSCOPE_MODEL = 'qwen-plus';
    process.env.DASHSCOPE_BASE_URL = 'https://dashscope.test/v1';
    process.env.DASHSCOPE_TIMEOUT_MS = '1000';

    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                content: 'LLM compacted memory content',
                summary: 'LLM compacted summary',
              }),
            },
          },
        ],
      }),
    } as Response);

    const summarizer = new DefaultMemorySummarizer({
      maxContentLength: 80,
      summaryLength: 90,
    });

    const result = await summarizer.summarize(
      createInput({
        previous: {
          content: 'previous '.repeat(20),
          summary: 'old summary',
          sourceRefs: [{ kind: 'message', sourceId: 'msg-1' }],
          tokenEstimate: 80,
        },
        incoming: {
          content: 'incoming '.repeat(20),
          sourceRefs: [{ kind: 'tool', sourceId: 'tool-1' }],
          tokenEstimate: 40,
        },
      }),
    );

    expect(result.compactionMode).toBe('llm');
    expect(result.content).toBe('LLM compacted memory content');
    expect(result.summary).toBe('LLM compacted summary');
    expect(result.sourceRefs.map((ref) => ref.sourceId)).toEqual([
      'msg-1',
      'tool-1',
    ]);
    expect(result.metadata?.compactionMode).toBe('llm');
  });

  it('falls back when llm compaction fails', async () => {
    process.env.DASHSCOPE_API_KEY = 'test-key';
    process.env.DASHSCOPE_MODEL = 'qwen-plus';

    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('dashscope unavailable'));

    const summarizer = new DefaultMemorySummarizer({
      maxContentLength: 80,
      summaryLength: 90,
    });

    const result = await summarizer.summarize(
      createInput({
        previous: {
          content: 'previous '.repeat(20),
          summary: null,
          tokenEstimate: 80,
        },
        incoming: {
          content: 'incoming '.repeat(20),
          tokenEstimate: 40,
        },
      }),
    );

    expect(result.compactionMode).toBe('fallback');
    expect(result.content.length).toBeLessThanOrEqual(80);
    expect(result.metadata?.compactionMode).toBe('fallback');
  });
});
