import type {
  ObservabilityEvent,
  ObservabilityEventType,
  ObservabilityJsonObject,
} from '../../observability.types';
import { contextDiagnosticRules } from './context.rules';

function makeEvent(
  seq: number,
  type: ObservabilityEventType,
  payload: ObservabilityJsonObject = {},
): ObservabilityEvent {
  return {
    eventId: `evt-${seq}`,
    seq,
    runId: 'run-1',
    spanId: null,
    type,
    status: 'normal',
    ts: new Date(),
    payload,
  };
}

const ctx = (events: ObservabilityEvent[]) => ({
  runId: 'run-1',
  events,
});

const normalContext = {
  contextPackId: 'pack-1',
  selectedMemoryIds: ['m1', 'm2'],
  droppedMemoryIds: [],
  summaryBlocks: [
    {
      blockId: 'b1',
      memoryIds: ['m1'],
      truncated: false,
    },
  ],
};

describe('context.rules', () => {
  it('context_missing：contextPackId 为空命中 warning', () => {
    const rule = contextDiagnosticRules[0];
    const hits = rule.evaluate(
      ctx([
        makeEvent(1, 'start', {
          contextPackId: null,
          selectedMemoryIds: [],
          summaryBlocks: [],
        }),
      ]),
    );

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({
      ruleId: 'context_missing',
      category: 'context_missing',
      severity: 'warning',
    });
  });

  it('context_missing：正常 context 不命中', () => {
    const rule = contextDiagnosticRules[0];
    const hits = rule.evaluate(ctx([makeEvent(1, 'start', normalContext)]));

    expect(hits).toHaveLength(0);
  });

  it('context_missing：payload 无 context 字段时不命中', () => {
    const rule = contextDiagnosticRules[0];
    const hits = rule.evaluate(
      ctx([makeEvent(1, 'start', { requestId: 'r' })]),
    );

    expect(hits).toHaveLength(0);
  });

  it('context_duplicate：selectedMemoryIds 重复比例超阈值命中', () => {
    const rule = contextDiagnosticRules[1];
    const hits = rule.evaluate(
      ctx([
        makeEvent(1, 'start', {
          contextPackId: 'pack-1',
          selectedMemoryIds: ['m1', 'm1', 'm1', 'm2'],
          summaryBlocks: [],
        }),
      ]),
    );

    expect(hits).toHaveLength(1);
    expect(hits[0].ruleId).toBe('context_duplicate');
    expect(hits[0].severity).toBe('warning');
  });

  it('context_duplicate：无重复不命中', () => {
    const rule = contextDiagnosticRules[1];
    const hits = rule.evaluate(
      ctx([
        makeEvent(1, 'start', {
          contextPackId: 'pack-1',
          selectedMemoryIds: ['m1', 'm2', 'm3'],
          summaryBlocks: [],
        }),
      ]),
    );

    expect(hits).toHaveLength(0);
  });

  it('context_truncation：dropped 非空且 truncated block 命中 info', () => {
    const rule = contextDiagnosticRules[2];
    const hits = rule.evaluate(
      ctx([
        makeEvent(1, 'route_decision', {
          contextPackId: 'pack-1',
          droppedMemoryIds: ['m9'],
          summaryBlocks: [{ memoryIds: ['m1'], truncated: true }],
        }),
      ]),
    );

    expect(hits).toHaveLength(1);
    expect(hits[0].ruleId).toBe('context_truncation');
    expect(hits[0].severity).toBe('info');
  });

  it('context_truncation：仅 dropped 或仅 truncated 不命中', () => {
    const rule = contextDiagnosticRules[2];
    const onlyDropped = rule.evaluate(
      ctx([
        makeEvent(1, 'start', {
          droppedMemoryIds: ['m9'],
          summaryBlocks: [{ memoryIds: ['m1'], truncated: false }],
        }),
      ]),
    );
    const onlyTruncated = rule.evaluate(
      ctx([
        makeEvent(1, 'start', {
          droppedMemoryIds: [],
          summaryBlocks: [{ memoryIds: ['m1'], truncated: true }],
        }),
      ]),
    );

    expect(onlyDropped).toHaveLength(0);
    expect(onlyTruncated).toHaveLength(0);
  });
});
