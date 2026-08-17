import type {
  ObservabilityEvent,
  ObservabilityEventType,
  ObservabilityJsonObject,
} from '../../observability.types';
import { routeMisjudgmentRules } from './route.rules';

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

describe('route.rules', () => {
  it('route_missing：进入执行阶段但无 route_decision', () => {
    const rule = routeMisjudgmentRules[0];
    const hits = rule.evaluate(
      ctx([
        makeEvent(1, 'start'),
        makeEvent(2, 'agent.step.started', { name: 'generalist' }),
      ]),
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      ruleId: 'route_missing',
      severity: 'warning',
      category: 'route_misjudgment',
    });
  });

  it('route_missing：存在 route_decision 时不命中', () => {
    const rule = routeMisjudgmentRules[0];
    const hits = rule.evaluate(
      ctx([
        makeEvent(1, 'start'),
        makeEvent(2, 'route_decision', {
          routeDecision: { selectedAgent: 'generalist' },
        }),
        makeEvent(3, 'agent.step.started', { name: 'generalist' }),
      ]),
    );

    expect(hits).toHaveLength(0);
  });

  it('route_agent_mismatch：selectedAgent 与实际执行 agent 不一致', () => {
    const rule = routeMisjudgmentRules[1];
    const hits = rule.evaluate(
      ctx([
        makeEvent(1, 'start'),
        makeEvent(2, 'route_decision', {
          routeDecision: { selectedAgent: 'generalist' },
        }),
        makeEvent(3, 'agent.step.started', { name: 'researcher' }),
      ]),
    );

    expect(hits).toHaveLength(1);
    expect(hits[0].ruleId).toBe('route_agent_mismatch');
    expect(hits[0].evidence).toHaveLength(2);
  });

  it('route_agent_mismatch：一致时不命中', () => {
    const rule = routeMisjudgmentRules[1];
    const hits = rule.evaluate(
      ctx([
        makeEvent(1, 'route_decision', {
          routeDecision: { selectedAgent: 'generalist' },
        }),
        makeEvent(2, 'agent.step.started', { name: 'generalist' }),
      ]),
    );

    expect(hits).toHaveLength(0);
  });

  it('route_agent_mismatch：缺 route_decision 不命中（交给 route_missing）', () => {
    const rule = routeMisjudgmentRules[1];
    const hits = rule.evaluate(
      ctx([makeEvent(1, 'agent.step.started', { name: 'generalist' })]),
    );

    expect(hits).toHaveLength(0);
  });
});
