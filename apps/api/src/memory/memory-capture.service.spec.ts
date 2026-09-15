import {
  CANDIDATE_PROMOTION_OBSERVED_COUNT,
  MEMORY_CONSTRAINT_MERGE_GROUP,
  MEMORY_LONG_TERM_MERGE_GROUP,
  MEMORY_METADATA_CONSTRAINT_SOURCE,
  MEMORY_METADATA_OBSERVED_COUNT,
  type MemoryCandidate,
  type MemoryDimensionScores,
} from './memory-candidate.types';
import { MemoryCaptureService } from './memory-capture.service';
import { MemoryDecisionService } from './memory-decision.service';
import type { MemoryEntry } from './memory.types';

const scores = (
  overrides: Partial<MemoryDimensionScores> = {},
): MemoryDimensionScores => ({
  persistenceIntent: 0,
  stability: 0,
  reusability: 0,
  importance: 0,
  freshness: 0,
  ...overrides,
});

const candidate = (
  overrides: Partial<MemoryCandidate> = {},
): MemoryCandidate => ({
  type: 'fact',
  content: '用户在上海工作',
  evidence: '我在上海工作',
  scores: scores(),
  ...overrides,
});

describe('MemoryCaptureService', () => {
  const extractor = { extract: jest.fn() };
  const memoryStore = {
    write: jest.fn(),
    list: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  };
  const longTermMemoryStore = {
    save: jest.fn(),
    list: jest.fn(),
    delete: jest.fn(),
  };

  const service = new MemoryCaptureService(
    extractor as never,
    new MemoryDecisionService(),
    memoryStore as never,
    longTermMemoryStore as never,
  );

  const input = {
    userId: 'user-1',
    conversationId: 'conv-1',
    runId: 'run-1',
    userMessageId: 'msg-1',
    userMessage: '我在上海工作，以后记住这一点',
    assistantMessage: '好的，我已经记住了。',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    memoryStore.write.mockResolvedValue({ memory: {}, merged: false });
    memoryStore.list.mockResolvedValue([]);
    memoryStore.delete.mockResolvedValue(true);
    memoryStore.deleteMany.mockResolvedValue([]);
    longTermMemoryStore.save.mockImplementation(
      (_userId: string, memory: MemoryEntry) => memory,
    );
    longTermMemoryStore.list.mockResolvedValue([]);
    longTermMemoryStore.delete.mockResolvedValue(true);
  });

  it('writes a constraint into the preference layer for per-turn injection', async () => {
    extractor.extract.mockResolvedValue([
      candidate({
        type: 'constraint',
        content: '回答一律使用中文',
        scores: scores({ importance: 0.6 }),
      }),
    ]);

    await service.capture(input);

    expect(memoryStore.write).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        layer: 'preference',
        mergeGroup: MEMORY_CONSTRAINT_MERGE_GROUP,
        mergeStrategy: 'summarize',
      }),
    );
  });

  it('skips a constraint that is already stored in the preference layer', async () => {
    extractor.extract.mockResolvedValue([
      candidate({
        type: 'constraint',
        content: '回答一律使用中文',
        scores: scores({ importance: 0.6 }),
      }),
    ]);
    memoryStore.list.mockResolvedValue([
      {
        content: '回答一律使用中文',
        summary: '回答一律使用中文',
      },
    ]);

    await service.capture(input);

    expect(memoryStore.write).not.toHaveBeenCalled();
  });

  it('persists a high-value candidate into long-term memory', async () => {
    extractor.extract.mockResolvedValue([
      candidate({
        scores: scores({
          persistenceIntent: 0.9,
          stability: 0.9,
          reusability: 0.8,
          importance: 0.8,
        }),
      }),
    ]);

    await service.capture(input);

    expect(longTermMemoryStore.save).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        scope: 'user',
        layer: 'preference',
        mergeGroup: expect.stringContaining(
          `${MEMORY_LONG_TERM_MERGE_GROUP}:`,
        ) as string,
      }),
    );
    expect(memoryStore.write).not.toHaveBeenCalled();
  });

  it('skips long-term writes when an identical memory already exists', async () => {
    extractor.extract.mockResolvedValue([
      candidate({
        scores: scores({
          persistenceIntent: 0.9,
          stability: 0.9,
          reusability: 0.8,
          importance: 0.8,
        }),
      }),
    ]);
    longTermMemoryStore.list.mockResolvedValue([{ memoryId: 'um_existing' }]);

    await service.capture(input);

    expect(longTermMemoryStore.save).not.toHaveBeenCalled();
  });

  it('puts a medium-value candidate into the user-scoped observation layer with a TTL', async () => {
    extractor.extract.mockResolvedValue([
      candidate({ type: 'task_state', scores: scores({ importance: 0.5 }) }),
    ]);

    await service.capture(input);

    expect(longTermMemoryStore.save).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        layer: 'candidate',
        scope: 'user',
        expiresAt: expect.any(Date) as Date,
        metadata: expect.objectContaining({
          [MEMORY_METADATA_OBSERVED_COUNT]: 1,
        }) as Record<string, unknown>,
      }),
    );
    expect(memoryStore.write).not.toHaveBeenCalled();
  });

  it('promotes a candidate to long-term memory once it repeats to the threshold', async () => {
    extractor.extract.mockResolvedValue([
      candidate({ type: 'task_state', scores: scores({ importance: 0.5 }) }),
    ]);
    longTermMemoryStore.list.mockImplementation((query: { layer?: string }) =>
      query.layer === 'candidate'
        ? [
            {
              memoryId: 'cm_candidate',
              content: '用户在上海工作',
              summary: null,
              tokenEstimate: 4,
              priority: 50,
              createdAt: new Date('2026-06-06T00:00:01.000Z'),
              metadata: {
                [MEMORY_METADATA_OBSERVED_COUNT]:
                  CANDIDATE_PROMOTION_OBSERVED_COUNT - 1,
              },
            },
          ]
        : [],
    );

    await service.capture(input);

    expect(longTermMemoryStore.save).toHaveBeenCalledTimes(1);
    expect(longTermMemoryStore.delete).toHaveBeenCalledWith('cm_candidate');
  });

  it('ignores discarded candidates entirely', async () => {
    extractor.extract.mockResolvedValue([
      candidate({ type: 'other', scores: scores({ importance: 0.1 }) }),
    ]);

    await service.capture(input);

    expect(memoryStore.write).not.toHaveBeenCalled();
    expect(longTermMemoryStore.save).not.toHaveBeenCalled();
  });

  it('keeps processing remaining candidates when one write fails', async () => {
    extractor.extract.mockResolvedValue([
      candidate({ type: 'constraint', scores: scores({ importance: 0.6 }) }),
      candidate({
        type: 'profile',
        content: '用户是后端工程师',
        scores: scores({
          persistenceIntent: 0.9,
          stability: 0.9,
          reusability: 0.8,
          importance: 0.8,
        }),
      }),
    ]);
    memoryStore.write.mockRejectedValueOnce(new Error('write_failed'));

    await service.capture(input);

    expect(longTermMemoryStore.save).toHaveBeenCalledTimes(1);
  });

  describe('captureConstraints', () => {
    const constraintInput = {
      conversationId: 'conv-1',
      runId: 'run-1',
      userMessageId: 'msg-1',
      userMessage: '不要用 emoji',
    };

    it('writes a rule-extracted constraint as an independent preference row', async () => {
      await service.captureConstraints(constraintInput);

      expect(memoryStore.write).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-1',
          runId: 'run-1',
          layer: 'preference',
          scope: 'conversation',
          content: '禁止使用或提及「emoji」',
          summary: '禁止使用或提及「emoji」',
          mergeGroup: MEMORY_CONSTRAINT_MERGE_GROUP,
          mergeStrategy: null,
          metadata: expect.objectContaining({
            [MEMORY_METADATA_CONSTRAINT_SOURCE]: 'rule',
          }) as Record<string, unknown>,
        }),
      );
    });

    it('skips a constraint that is already stored', async () => {
      memoryStore.list.mockResolvedValue([
        {
          content: '禁止使用或提及「emoji」',
          summary: '禁止使用或提及「emoji」',
        },
      ]);

      await service.captureConstraints(constraintInput);

      expect(memoryStore.write).not.toHaveBeenCalled();
    });

    it('skips a constraint already present in a merged multi-line row', async () => {
      memoryStore.list.mockResolvedValue([
        {
          content: '用户身份：后端工程师\n禁止使用或提及「emoji」',
          summary: '禁止使用或提及「emoji」',
        },
      ]);

      await service.captureConstraints(constraintInput);

      expect(memoryStore.write).not.toHaveBeenCalled();
    });

    it('reads nothing when the message expresses no constraint', async () => {
      await service.captureConstraints({
        ...constraintInput,
        userMessage: '帮我看看这份简历',
      });

      expect(memoryStore.list).not.toHaveBeenCalled();
      expect(memoryStore.write).not.toHaveBeenCalled();
    });

    it('never throws when the memory store fails', async () => {
      memoryStore.list.mockRejectedValue(new Error('list_failed'));

      await expect(
        service.captureConstraints(constraintInput),
      ).resolves.toBeUndefined();
    });
  });
});
