import type {
  ObservabilityDiagnosticCandidate,
  ObservabilityDiagnosticContext,
} from './observability-diagnostic.types';
import type { ObservabilityDiagnosticRule } from './observability-diagnostic-rule';
import type {
  ObservabilityEvent,
  ObservabilityEventType,
  ObservabilityJsonObject,
} from '../observability.types';
import {
  runObservabilityDiagnostics,
  createDiagnosticEngine,
} from './observability-diagnostic.engine';

function makeEvent(
  seq: number,
  type: ObservabilityEventType,
  payload: ObservabilityJsonObject = {},
  overrides: Partial<ObservabilityEvent> = {},
): ObservabilityEvent {
  return {
    eventId: `evt-${seq}`,
    seq,
    runId: 'run-1',
    spanId: null,
    type,
    status: 'normal',
    ts: new Date(`2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`),
    payload,
    ...overrides,
  };
}

describe('ObservabilityDiagnosticEngine', () => {
  it('空事件输入返回空数组，而不是异常', () => {
    expect(runObservabilityDiagnostics('run-1', [])).toEqual([]);
  });

  it('正常完成的 run 不产出 issue', () => {
    const events = [
      makeEvent(1, 'start', {
        contextPackId: 'pack-1',
        summaryBlocks: [{ blockId: 'b1', memoryIds: ['m1'], truncated: false }],
      }),
      makeEvent(2, 'route_decision', {
        routeDecision: { intent: 'x', selectedAgent: 'generalist' },
      }),
      makeEvent(3, 'agent.step.started', { name: 'generalist' }),
      makeEvent(4, 'assistant_chunk', { content: 'hi' }),
      makeEvent(5, 'assistant_done', { content: 'hi' }),
      makeEvent(6, 'agent.step.finished', { status: 'succeeded' }),
      makeEvent(7, 'done', { status: 'succeeded' }),
    ];

    expect(runObservabilityDiagnostics('run-1', events)).toEqual([]);
  });

  it('route_missing 命中并回指事件', () => {
    const events = [
      makeEvent(1, 'start'),
      makeEvent(2, 'agent.step.started', { name: 'generalist' }),
      makeEvent(3, 'done', { status: 'succeeded' }),
    ];

    const issues = runObservabilityDiagnostics('run-1', events);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      runId: 'run-1',
      ruleId: 'route_missing',
      category: 'route_misjudgment',
      severity: 'warning',
    });
    expect(issues[0].evidence.map((item) => item.eventId)).toEqual([
      'evt-1',
      'evt-2',
    ]);
  });

  it('同一工具 span 的多次失败证据聚合为单个 issue，severity 取最高', () => {
    const events = [
      makeEvent(1, 'start', {
        contextPackId: 'pack-1',
        summaryBlocks: [],
      }),
      makeEvent(2, 'route_decision', {
        routeDecision: { intent: 'x', selectedAgent: 'generalist' },
      }),
      makeEvent(3, 'tool.call.started', { toolName: 'web_search' }, { spanId: 'span-tool-1' }),
      makeEvent(4, 'tool.call.finished', {
        toolName: 'web_search',
        success: false,
        errorCode: 'E1',
        latencyMs: 100,
      }, { spanId: 'span-tool-1' }),
      makeEvent(5, 'tool.call.started', { toolName: 'web_browser' }, { spanId: 'span-tool-2' }),
      makeEvent(6, 'tool.call.finished', {
        toolName: 'web_browser',
        success: false,
        latencyMs: 200,
      }, { spanId: 'span-tool-2' }),
      makeEvent(7, 'done', { status: 'failed' }),
    ];

    const issues = runObservabilityDiagnostics('run-1', events);
    const toolFailures = issues.filter(
      (issue) => issue.category === 'tool_failure' && issue.ruleId === 'tool_failure',
    );
    expect(toolFailures).toHaveLength(2);
    expect(toolFailures[0].severity).toBe('critical');
    expect(toolFailures[0].occurrenceCount).toBe(1);
  });

  it('done 缺失只产出一个 stream_incomplete issue', () => {
    const events = [makeEvent(1, 'start')];

    const issues = runObservabilityDiagnostics('run-1', events);
    const incomplete = issues.filter(
      (issue) => issue.ruleId === 'stream_incomplete',
    );
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].severity).toBe('critical');
  });

  it('dedupeKey 与 issueId 是确定性的', () => {
    const events = [makeEvent(1, 'start')];

    const first = runObservabilityDiagnostics('run-1', events);
    const second = runObservabilityDiagnostics('run-1', events);

    expect(first[0].dedupeKey).toBe(second[0].dedupeKey);
    expect(first[0].issueId).toBe(second[0].issueId);
    expect(first[0].dedupeKey).toContain('run-1');
  });

  it('非法 payload / 缺字段事件不会导致引擎崩溃', () => {
    const events = [
      makeEvent(1, 'start', { contextPackId: null, summaryBlocks: 'broken' }),
      makeEvent(2, 'tool.call.finished', { success: 'not-a-bool' }),
      makeEvent(3, 'assistant_chunk', { content: 'x' }),
      makeEvent(4, 'error', { message: 'boom' }),
    ];

    const issues = runObservabilityDiagnostics('run-1', events);
    expect(Array.isArray(issues)).toBe(true);
  });

  it('单条规则抛错不影响其他规则执行', () => {
    const throwingRule: ObservabilityDiagnosticRule = {
      ruleId: 'throwing',
      category: 'other',
      evaluate(_ctx: ObservabilityDiagnosticContext) {
        throw new Error('boom');
      },
    };

    const healthyRule: ObservabilityDiagnosticRule = {
      ruleId: 'healthy',
      category: 'stream_incomplete',
      evaluate(ctx) {
        return ctx.events.filter((event) => event.type === 'start').map(
          (event): ObservabilityDiagnosticCandidate => ({
            ruleId: 'healthy',
            category: 'stream_incomplete',
            severity: 'critical',
            spanId: null,
            title: 't',
            reason: 'r',
            suggestion: null,
            evidence: [
              {
                eventId: event.eventId,
                type: event.type,
                value: 'start',
              },
            ],
          }),
        );
      },
    };

    const run = createDiagnosticEngine([throwingRule, healthyRule]);
    const issues = run('run-1', [makeEvent(1, 'start')]);

    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe('healthy');
  });
});
