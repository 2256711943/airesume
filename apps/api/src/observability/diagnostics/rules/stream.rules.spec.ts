import type {
  ObservabilityEvent,
  ObservabilityEventType,
  ObservabilityJsonObject,
} from '../../observability.types';
import { streamDiagnosticRules } from './stream.rules';

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

describe('stream.rules', () => {
  it('stream_interrupt：有 chunk 无 done 且终态非 succeeded', () => {
    const rule = streamDiagnosticRules[0];
    const hits = rule.evaluate(
      ctx([
        makeEvent(1, 'start'),
        makeEvent(2, 'assistant_chunk', { content: 'part' }),
        makeEvent(3, 'error', { message: 'boom' }),
      ]),
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      ruleId: 'stream_interrupt',
      severity: 'critical',
      category: 'stream_interrupt',
    });
  });

  it('stream_interrupt：有 assistant_done 不命中', () => {
    const rule = streamDiagnosticRules[0];
    const hits = rule.evaluate(
      ctx([
        makeEvent(1, 'assistant_chunk', { content: 'part' }),
        makeEvent(2, 'assistant_done', { content: 'part' }),
      ]),
    );

    expect(hits).toHaveLength(0);
  });

  it('stream_interrupt：无终态时不命中（交给 stream_incomplete）', () => {
    const rule = streamDiagnosticRules[0];
    const hits = rule.evaluate(
      ctx([makeEvent(1, 'assistant_chunk', { content: 'part' })]),
    );

    expect(hits).toHaveLength(0);
  });

  it('stream_incomplete：有 start 但无终态命中 critical', () => {
    const rule = streamDiagnosticRules[1];
    const hits = rule.evaluate(
      ctx([
        makeEvent(1, 'start'),
        makeEvent(2, 'assistant_chunk', { content: 'part' }),
      ]),
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      ruleId: 'stream_incomplete',
      severity: 'critical',
      category: 'stream_incomplete',
    });
  });

  it('stream_incomplete：存在任一终态不命中', () => {
    const rule = streamDiagnosticRules[1];
    const done = rule.evaluate(
      ctx([makeEvent(1, 'start'), makeEvent(2, 'done', {})]),
    );
    const canceled = rule.evaluate(
      ctx([makeEvent(1, 'start'), makeEvent(2, 'canceled', {})]),
    );

    expect(done).toHaveLength(0);
    expect(canceled).toHaveLength(0);
  });
});
