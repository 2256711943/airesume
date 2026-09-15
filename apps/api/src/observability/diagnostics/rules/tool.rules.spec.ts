import type {
  ObservabilityEvent,
  ObservabilityEventType,
  ObservabilityJsonObject,
} from '../../observability.types';
import { toolDiagnosticRules } from './tool.rules';

function makeEvent(
  seq: number,
  type: ObservabilityEventType,
  payload: ObservabilityJsonObject = {},
  spanId: string | null = null,
): ObservabilityEvent {
  return {
    eventId: `evt-${seq}`,
    seq,
    runId: 'run-1',
    spanId,
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

describe('tool.rules', () => {
  it('tool_failure：success=false 命中 critical', () => {
    const rule = toolDiagnosticRules[0];
    const hits = rule.evaluate(
      ctx([
        makeEvent(
          1,
          'tool.call.finished',
          { toolName: 'web_search', success: false, errorCode: 'E1' },
          'span-tool',
        ),
      ]),
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      ruleId: 'tool_failure',
      severity: 'critical',
      spanId: 'span-tool',
    });
  });

  it('tool_failure：成功调用不命中', () => {
    const rule = toolDiagnosticRules[0];
    const hits = rule.evaluate(
      ctx([
        makeEvent(1, 'tool.call.finished', {
          toolName: 'web_search',
          success: true,
          latencyMs: 100,
        }),
      ]),
    );

    expect(hits).toHaveLength(0);
  });

  it('tool_timeout：latency 超过阈值命中 critical', () => {
    const rule = toolDiagnosticRules[1];
    const hits = rule.evaluate(
      ctx([
        makeEvent(1, 'tool.call.finished', {
          toolName: 'web_search',
          success: true,
          latencyMs: 120_000,
        }),
      ]),
    );

    expect(hits).toHaveLength(1);
    expect(hits[0].ruleId).toBe('tool_timeout');
    expect(hits[0].severity).toBe('critical');
  });

  it('tool_timeout：started 无 finished 且 run 已终态', () => {
    const rule = toolDiagnosticRules[1];
    const hits = rule.evaluate(
      ctx([
        makeEvent(
          1,
          'tool.call.started',
          { toolName: 'web_search' },
          'span-tool',
        ),
        makeEvent(2, 'done', { status: 'failed' }),
      ]),
    );

    expect(hits).toHaveLength(1);
    expect(hits[0].ruleId).toBe('tool_timeout');
    expect(hits[0].evidence.map((item) => item.eventId)).toEqual([
      'evt-1',
      'evt-2',
    ]);
  });

  it('tool_timeout：started 无 finished 但 run 未终态时不命中', () => {
    const rule = toolDiagnosticRules[1];
    const hits = rule.evaluate(
      ctx([makeEvent(1, 'tool.call.started', { toolName: 'web_search' })]),
    );

    expect(hits).toHaveLength(0);
  });

  it('tool_empty_result：显式空 result 命中 warning', () => {
    const rule = toolDiagnosticRules[2];
    const hits = rule.evaluate(
      ctx([
        makeEvent(1, 'tool.call.finished', {
          toolName: 'web_search',
          success: true,
          result: {},
        }),
      ]),
    );

    expect(hits).toHaveLength(1);
    expect(hits[0].ruleId).toBe('tool_empty_result');
    expect(hits[0].severity).toBe('warning');
  });

  it('tool_empty_result：payload 无 result 字段时不命中（预留规则）', () => {
    const rule = toolDiagnosticRules[2];
    const hits = rule.evaluate(
      ctx([
        makeEvent(1, 'tool.call.finished', {
          toolName: 'web_search',
          success: true,
          latencyMs: 100,
        }),
      ]),
    );

    expect(hits).toHaveLength(0);
  });
});
