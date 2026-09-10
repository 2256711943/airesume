import type { ObservabilityEvent } from '../../observability.types';
import type { ObservabilityDiagnosticRule } from '../observability-diagnostic-rule';
import {
  getPayloadRecord,
  getPayloadString,
} from '../observability-diagnostic-rule';
import { hasEventType } from '../observability-diagnostic.util';

/**
 * 路由类规则：
 * - route_missing：进入 agent/tool 阶段但缺失 route_decision；
 * - route_agent_mismatch：route_decision 的 selectedAgent 与实际执行步骤不一致。
 */

function findFirstEventByTypes(
  events: ObservabilityEvent[],
  types: string[],
): ObservabilityEvent | null {
  for (const event of events) {
    if (types.includes(event.type)) {
      return event;
    }
  }

  return null;
}

function toEvidence(event: ObservabilityEvent, value: string) {
  return {
    eventId: event.eventId,
    type: event.type,
    value,
  };
}

export const routeMisjudgmentRules: ObservabilityDiagnosticRule[] = [
  {
    ruleId: 'route_missing',
    category: 'route_misjudgment',
    evaluate(ctx) {
      if (hasEventType(ctx.events, 'route_decision')) {
        return [];
      }

      const enteredExecution = findFirstEventByTypes(ctx.events, [
        'agent.step.started',
        'tool.call.started',
      ]);
      if (!enteredExecution) {
        return [];
      }

      const startEvent = findFirstEventByTypes(ctx.events, ['start']);

      return [
        {
          ruleId: 'route_missing',
          category: 'route_misjudgment',
          severity: 'warning',
          spanId: null,
          title: '路由决策缺失',
          reason:
            'run 已进入 agent/工具执行阶段，但缺少 route_decision 事件，无法确认意图路由依据。',
          suggestion:
            '检查编排层是否在进入执行前发出 route_decision，避免跨阶段事件丢失。',
          evidence: [
            ...(startEvent
              ? [toEvidence(startEvent, 'run started without route_decision')]
              : []),
            toEvidence(
              enteredExecution,
              `entered ${enteredExecution.type} without route_decision`,
            ),
          ],
        },
      ];
    },
  },
  {
    ruleId: 'route_agent_mismatch',
    category: 'route_misjudgment',
    evaluate(ctx) {
      const routeDecisionEvent = findFirstEventByTypes(ctx.events, [
        'route_decision',
      ]);
      if (!routeDecisionEvent) {
        return [];
      }

      const routeDecision = getPayloadRecord(
        routeDecisionEvent.payload,
        'routeDecision',
      );
      const selectedAgent = routeDecision
        ? getPayloadString(routeDecision, 'selectedAgent')
        : null;
      if (!selectedAgent) {
        return [];
      }

      const mismatchedSteps = ctx.events.filter(
        (event) =>
          event.type === 'agent.step.started' &&
          getPayloadString(event.payload, 'name') !== null &&
          getPayloadString(event.payload, 'name') !== selectedAgent,
      );

      if (mismatchedSteps.length === 0) {
        return [];
      }

      const mismatchedStep = mismatchedSteps[0];
      const executedAgent = getPayloadString(mismatchedStep.payload, 'name');

      return [
        {
          ruleId: 'route_agent_mismatch',
          category: 'route_misjudgment',
          severity: 'warning',
          spanId: mismatchedStep.spanId,
          title: '路由结果与执行链不匹配',
          reason: `route_decision 选择 ${selectedAgent}，但实际执行进入 ${executedAgent ?? '未知 agent'}，路由结果与执行链不一致。`,
          suggestion:
            '核对编排层路由输出与执行器 agent 选择逻辑，二者应使用同一决策源。',
          evidence: [
            toEvidence(routeDecisionEvent, `selectedAgent=${selectedAgent}`),
            toEvidence(
              mismatchedStep,
              `executed=${executedAgent ?? 'unknown'}`,
            ),
          ],
        },
      ];
    },
  },
];
