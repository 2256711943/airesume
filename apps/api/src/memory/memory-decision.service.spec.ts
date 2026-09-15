import { MemoryDecisionService } from './memory-decision.service';
import type {
  MemoryCandidate,
  MemoryDimensionScores,
} from './memory-candidate.types';

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

describe('MemoryDecisionService', () => {
  const service = new MemoryDecisionService();

  it('routes to persistent when all four durable dimensions pass the threshold', () => {
    const decision = service.decide(
      candidate({
        scores: scores({
          persistenceIntent: 0.8,
          stability: 0.9,
          reusability: 0.7,
          importance: 0.7,
        }),
      }),
    );

    expect(decision.kind).toBe('persistent');
  });

  it('keeps an explicit constraint in runtime context even without persistence intent', () => {
    const decision = service.decide(
      candidate({
        type: 'constraint',
        scores: scores({ importance: 0.6 }),
      }),
    );

    expect(decision.kind).toBe('constraint');
  });

  it('drops a constraint that is not important enough', () => {
    const decision = service.decide(
      candidate({
        type: 'constraint',
        scores: scores({ importance: 0.3, reusability: 0.2 }),
      }),
    );

    expect(decision.kind).toBe('discard');
  });

  it('sends medium-value candidates into observation', () => {
    const decision = service.decide(
      candidate({
        type: 'task_state',
        scores: scores({ importance: 0.4 }),
      }),
    );

    expect(decision.kind).toBe('candidate');
  });

  it('discards low-value candidates', () => {
    const decision = service.decide(
      candidate({
        type: 'other',
        scores: scores({ importance: 0.1, reusability: 0.2 }),
      }),
    );

    expect(decision.kind).toBe('discard');
  });
});
