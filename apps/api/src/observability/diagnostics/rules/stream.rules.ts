import type { ObservabilityEvent } from '../../observability.types';
import type { ObservabilityDiagnosticRule } from '../observability-diagnostic-rule';
import {
  countEventsByType,
  findLastEventByTypes,
  hasEventType,
  OBSERVABILITY_TERMINAL_EVENT_TYPES,
} from '../observability-diagnostic.util';

/**
 * 文本流类规则：
 * - stream_interrupt：有 assistant_chunk 但无 assistant_done，且 run 终态非 succeeded；
 * - stream_incomplete：有 start 但缺失所有终态事件（done/error/canceled）。
 */

function findFirstEventByType(
  events: ObservabilityEvent[],
  type: string,
): ObservabilityEvent | null {
  for (const event of events) {
    if (event.type === type) {
      return event;
    }
  }

  return null;
}

export const streamDiagnosticRules: ObservabilityDiagnosticRule[] = [
  {
    ruleId: 'stream_interrupt',
    category: 'stream_interrupt',
    evaluate(ctx) {
      if (countEventsByType(ctx.events, 'assistant_chunk') === 0) {
        return [];
      }

      if (hasEventType(ctx.events, 'assistant_done')) {
        return [];
      }

      const terminalEvent = findLastEventByTypes(
        ctx.events,
        OBSERVABILITY_TERMINAL_EVENT_TYPES,
      );
      // 仅当 run 已进入非 succeeded 终态时判定中断；
      // 若完全缺失终态，交由 stream_incomplete 单独报告，避免重复。
      if (!terminalEvent || terminalEvent.type === 'done') {
        return [];
      }

      const lastChunk = findFirstEventByType(
        [...ctx.events].reverse(),
        'assistant_chunk',
      );
      if (!lastChunk) {
        return [];
      }

      return [
        {
          ruleId: 'stream_interrupt',
          category: 'stream_interrupt',
          severity: 'critical',
          spanId: lastChunk.spanId,
          title: '文本流中断',
          reason: `已产出 assistant_chunk 但未收到 assistant_done，run 终态为 ${terminalEvent.type}，文本输出不完整。`,
          suggestion:
            '检查流式收口逻辑，确保中断/失败路径也发出 assistant_done 或明确错误事件。',
          evidence: [
            {
              eventId: lastChunk.eventId,
              type: lastChunk.type,
              value: 'chunk_without_done',
            },
            {
              eventId: terminalEvent.eventId,
              type: terminalEvent.type,
              value: `terminal=${terminalEvent.type}`,
            },
          ],
        },
      ];
    },
  },
  {
    ruleId: 'stream_incomplete',
    category: 'stream_incomplete',
    evaluate(ctx) {
      const startEvent = findFirstEventByType(ctx.events, 'start');
      if (!startEvent) {
        return [];
      }

      if (
        hasEventType(ctx.events, 'done') ||
        hasEventType(ctx.events, 'error') ||
        hasEventType(ctx.events, 'canceled')
      ) {
        return [];
      }

      return [
        {
          ruleId: 'stream_incomplete',
          category: 'stream_incomplete',
          severity: 'critical',
          spanId: null,
          title: 'run 终态缺失',
          reason:
            '存在 start 事件但缺失 done/error/canceled 任一终态事件，run 状态无法闭环。',
          suggestion:
            '检查断线补偿与终态落盘逻辑，确认 run 结束时终态事件一定持久化。',
          evidence: [
            {
              eventId: startEvent.eventId,
              type: startEvent.type,
              value: 'start_without_terminal',
            },
          ],
        },
      ];
    },
  },
];
