import type {
  ObservabilityEvent,
  ObservabilityEventType,
} from '../../observability.types';
import type {
  ObservabilityDiagnosticCandidate,
  ObservabilityDiagnosticContext,
} from '../observability-diagnostic.types';
import type { ObservabilityDiagnosticRule } from '../observability-diagnostic-rule';
import {
  getPayloadBoolean,
  getPayloadNumber,
  getPayloadRecord,
  getPayloadString,
} from '../observability-diagnostic-rule';
import {
  findLastEventByTypes,
  OBSERVABILITY_TERMINAL_EVENT_TYPES,
} from '../observability-diagnostic.util';

const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

const TOOL_STARTED_TYPE: ObservabilityEventType = 'tool.call.started';
const TOOL_FINISHED_TYPE: ObservabilityEventType = 'tool.call.finished';

/**
 * 工具类规则：
 * - tool_failure：success=false 或携带 errorCode；
 * - tool_timeout：latency 超过阈值，或 started 后无 finished 且 run 已终态；
 * - tool_empty_result：success 但结果为空（事件 payload 当前未携带 result，
 *   规则预留：仅在 payload 显式出现 result/items/output 字段时评估，避免误报）。
 */

interface ToolCallSpan {
  event: ObservabilityEvent;
  spanId: string | null;
  toolName: string | null;
}

function collectToolCalls(ctx: ObservabilityDiagnosticContext): {
  started: Map<string, ToolCallSpan>;
  finished: ToolCallSpan[];
} {
  const started = new Map<string, ToolCallSpan>();
  const finished: ToolCallSpan[] = [];

  for (const event of ctx.events) {
    if (event.type === TOOL_STARTED_TYPE) {
      const toolName = getPayloadString(event.payload, 'toolName');
      started.set(event.spanId ?? event.eventId, {
        event,
        spanId: event.spanId,
        toolName,
      });
    } else if (event.type === TOOL_FINISHED_TYPE) {
      const toolName = getPayloadString(event.payload, 'toolName');
      finished.push({
        event,
        spanId: event.spanId,
        toolName,
      });
    }
  }

  return { started, finished };
}

export const toolDiagnosticRules: ObservabilityDiagnosticRule[] = [
  {
    ruleId: 'tool_failure',
    category: 'tool_failure',
    evaluate(ctx) {
      const candidates: ObservabilityDiagnosticCandidate[] = [];

      for (const event of ctx.events) {
        if (event.type !== TOOL_FINISHED_TYPE) {
          continue;
        }

        const success = getPayloadBoolean(event.payload, 'success', true);
        const errorCode = getPayloadString(event.payload, 'errorCode');
        const errorMessage = getPayloadString(event.payload, 'errorMessage');
        const toolName =
          getPayloadString(event.payload, 'toolName') ?? 'unknown';

        if (success === false || errorCode) {
          candidates.push({
            ruleId: 'tool_failure',
            category: 'tool_failure',
            severity: 'critical',
            spanId: event.spanId,
            title: `工具调用失败：${toolName}`,
            reason: `工具 ${toolName} 执行失败（success=${success}${
              errorCode ? `, errorCode=${errorCode}` : ''
            }）。`,
            suggestion: errorMessage
              ? `根据工具返回的错误信息 ${errorMessage} 排查调用参数或外部服务状态。`
              : '查看工具实现与外部依赖状态，确认失败是否为预期可恢复错误。',
            evidence: [
              {
                eventId: event.eventId,
                type: event.type,
                value: `${toolName}|success=${success}${
                  errorCode ? `|${errorCode}` : ''
                }`,
              },
            ],
          });
        }
      }

      return candidates;
    },
  },
  {
    ruleId: 'tool_timeout',
    category: 'tool_timeout',
    evaluate(ctx) {
      const { started, finished } = collectToolCalls(ctx);
      const finishedSpanIds = new Set(
        finished.map((call) => call.spanId ?? call.event.eventId),
      );
      const terminalEvent = findLastEventByTypes(
        ctx.events,
        OBSERVABILITY_TERMINAL_EVENT_TYPES,
      );
      const candidates: ObservabilityDiagnosticCandidate[] = [];

      // 1) finished 已闭合但 latency 超过阈值
      for (const call of finished) {
        const latencyMs = getPayloadNumber(call.event.payload, 'latencyMs');
        const toolName =
          getPayloadString(call.event.payload, 'toolName') ?? 'unknown';

        if (latencyMs !== null && latencyMs > DEFAULT_TOOL_TIMEOUT_MS) {
          candidates.push({
            ruleId: 'tool_timeout',
            category: 'tool_timeout',
            severity: 'critical',
            spanId: call.spanId,
            title: `工具执行超时：${toolName}`,
            reason: `工具 ${toolName} 耗时 ${latencyMs}ms，超过阈值 ${DEFAULT_TOOL_TIMEOUT_MS}ms。`,
            suggestion:
              '检查工具外部调用耗时与重试策略，必要时增加超时控制或降级逻辑。',
            evidence: [
              {
                eventId: call.event.eventId,
                type: call.event.type,
                value: `${toolName}|latencyMs=${latencyMs}`,
              },
            ],
          });
        }
      }

      // 2) started 后无 finished：仅在 run 已有终态时判定（避免把进行中的 run 误报）
      if (terminalEvent) {
        for (const [key, call] of started) {
          if (finishedSpanIds.has(key)) {
            continue;
          }

          const toolName = call.toolName ?? 'unknown';
          candidates.push({
            ruleId: 'tool_timeout',
            category: 'tool_timeout',
            severity: 'critical',
            spanId: call.spanId,
            title: `工具调用未闭合：${toolName}`,
            reason: `工具 ${toolName} 已发起调用但未收到 finished 事件，且 run 已进入终态（${terminalEvent.type}）。`,
            suggestion:
              '确认工具调用是否被中断、超时或执行器异常退出，补齐失败/超时收口事件。',
            evidence: [
              {
                eventId: call.event.eventId,
                type: call.event.type,
                value: `${toolName}|unclosed`,
              },
              {
                eventId: terminalEvent.eventId,
                type: terminalEvent.type,
                value: `terminal=${terminalEvent.type}`,
              },
            ],
          });
        }
      }

      return candidates;
    },
  },
  {
    ruleId: 'tool_empty_result',
    category: 'tool_failure',
    evaluate(ctx) {
      const candidates: ObservabilityDiagnosticCandidate[] = [];

      for (const event of ctx.events) {
        if (event.type !== TOOL_FINISHED_TYPE) {
          continue;
        }

        const success = getPayloadBoolean(event.payload, 'success', true);
        if (!success) {
          continue;
        }

        const toolName =
          getPayloadString(event.payload, 'toolName') ?? 'unknown';
        // 当前事件 payload 未携带 result；仅在显式出现时评估，避免误报
        const result = getPayloadRecord(event.payload, 'result');
        const items = event.payload.items;
        const output = event.payload.output;

        const hasExplicitResultField =
          'result' in event.payload ||
          'items' in event.payload ||
          'output' in event.payload;

        if (!hasExplicitResultField) {
          continue;
        }

        const isEmpty =
          result !== null && Object.keys(result).length === 0
            ? true
            : Array.isArray(items) && items.length === 0
              ? true
              : output === null ||
                output === undefined ||
                output === '' ||
                (Array.isArray(output) && output.length === 0);

        if (isEmpty) {
          candidates.push({
            ruleId: 'tool_empty_result',
            category: 'tool_failure',
            severity: 'warning',
            spanId: event.spanId,
            title: `工具返回空结果：${toolName}`,
            reason: `工具 ${toolName} 执行成功但未返回有效结果。`,
            suggestion:
              '检查工具输出解析与空态兜底逻辑，避免空结果被当作成功继续下游。',
            evidence: [
              {
                eventId: event.eventId,
                type: event.type,
                value: `${toolName}|empty_result`,
              },
            ],
          });
        }
      }

      return candidates;
    },
  },
];
