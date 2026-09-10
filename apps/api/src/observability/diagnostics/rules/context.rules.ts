import type { ObservabilityEvent } from '../../observability.types';
import type {
  ObservabilityDiagnosticCandidate,
  ObservabilityDiagnosticContext,
} from '../observability-diagnostic.types';
import type { ObservabilityDiagnosticRule } from '../observability-diagnostic-rule';
import {
  calcDuplicateRatio,
  getPayloadStringArray,
} from '../observability-diagnostic-rule';

const CONTEXT_CARRYING_EVENT_TYPES = [
  'start',
  'route_decision',
  'agent.step.started',
  'agent.step.finished',
  'assistant_done',
];

const CONTEXT_KEYS = [
  'contextPackId',
  'selectedMemoryIds',
  'droppedMemoryIds',
  'summaryBlocks',
] as const;

/**
 * 上下文类规则：
 * - context_missing：需要 context 的 run 未注入 contextPackId 或 summaryBlocks 为空；
 * - context_duplicate：selectedMemoryIds / summary block memoryIds 重复比例超阈值；
 * - context_truncation：droppedMemoryIds 非空且存在 truncated summary block。
 */

interface ContextSnapshot {
  event: ObservabilityEvent;
  contextPackId: unknown;
  selectedMemoryIds: string[];
  droppedMemoryIds: string[];
  summaryBlocks: Array<{
    truncated: boolean;
    memoryIds: string[];
  }>;
}

function readContextSnapshot(
  event: ObservabilityEvent,
): ContextSnapshot | null {
  const payload = event.payload;
  const hasContextFields = CONTEXT_KEYS.some((key) => key in payload);
  if (!hasContextFields) {
    return null;
  }

  const summaryBlocks = Array.isArray(payload.summaryBlocks)
    ? payload.summaryBlocks
        .map((block) => {
          if (
            typeof block !== 'object' ||
            block === null ||
            Array.isArray(block)
          ) {
            return null;
          }

          const record = block as unknown as Record<string, unknown>;
          return {
            truncated: record.truncated === true,
            memoryIds: Array.isArray(record.memoryIds)
              ? record.memoryIds.filter(
                  (id): id is string => typeof id === 'string',
                )
              : [],
          };
        })
        .filter(
          (block): block is { truncated: boolean; memoryIds: string[] } =>
            block !== null,
        )
    : [];

  return {
    event,
    contextPackId: payload.contextPackId,
    selectedMemoryIds: getPayloadStringArray(payload, 'selectedMemoryIds'),
    droppedMemoryIds: getPayloadStringArray(payload, 'droppedMemoryIds'),
    summaryBlocks,
  };
}

function findFirstContextSnapshot(
  ctx: ObservabilityDiagnosticContext,
): ContextSnapshot | null {
  for (const event of ctx.events) {
    if (CONTEXT_CARRYING_EVENT_TYPES.includes(event.type)) {
      const snapshot = readContextSnapshot(event);
      if (snapshot) {
        return snapshot;
      }
    }
  }

  return null;
}

export const contextDiagnosticRules: ObservabilityDiagnosticRule[] = [
  {
    ruleId: 'context_missing',
    category: 'context_missing',
    evaluate(ctx) {
      const snapshot = findFirstContextSnapshot(ctx);
      if (!snapshot) {
        return [];
      }

      // 上下文键存在但值为空，说明链路期望注入 context 却未注入
      const contextPackIdEmpty =
        snapshot.contextPackId === null ||
        snapshot.contextPackId === undefined ||
        snapshot.contextPackId === '';
      const summaryBlocksEmpty =
        snapshot.summaryBlocks.length === 0 ||
        snapshot.summaryBlocks.every((block) => block.memoryIds.length === 0);

      if (!contextPackIdEmpty && !summaryBlocksEmpty) {
        return [];
      }

      const candidates: ObservabilityDiagnosticCandidate[] = [];
      if (contextPackIdEmpty) {
        candidates.push({
          ruleId: 'context_missing',
          category: 'context_missing',
          severity: 'warning',
          spanId: snapshot.event.spanId,
          title: '上下文注入缺失',
          reason:
            'run 链路期望注入上下文，但 contextPackId 为空，无法定位实际注入的上下文包。',
          suggestion:
            '检查上下文打包流程是否生成 contextPackId，并确认注入事件未丢失。',
          evidence: [
            {
              eventId: snapshot.event.eventId,
              type: snapshot.event.type,
              value: 'contextPackId=empty',
            },
          ],
        });
      }

      if (summaryBlocksEmpty) {
        candidates.push({
          ruleId: 'context_missing',
          category: 'context_missing',
          severity: 'warning',
          spanId: snapshot.event.spanId,
          title: '上下文摘要为空',
          reason:
            '上下文包未产出任何 summary block（或全部 block 无 memoryId），模型侧无摘要上下文可用。',
          suggestion:
            '检查记忆摘要生成与注入逻辑，确认 summaryBlocks 是否正常产出。',
          evidence: [
            {
              eventId: snapshot.event.eventId,
              type: snapshot.event.type,
              value: 'summaryBlocks=empty',
            },
          ],
        });
      }

      return candidates;
    },
  },
  {
    ruleId: 'context_duplicate',
    category: 'context_duplicate',
    evaluate(ctx) {
      const threshold = 0.5;

      for (const event of ctx.events) {
        if (!CONTEXT_CARRYING_EVENT_TYPES.includes(event.type)) {
          continue;
        }

        const snapshot = readContextSnapshot(event);
        if (!snapshot) {
          continue;
        }

        const selectedRatio = calcDuplicateRatio(snapshot.selectedMemoryIds);
        const blockMemoryIds = snapshot.summaryBlocks.flatMap(
          (block) => block.memoryIds,
        );
        const blockRatio = calcDuplicateRatio(blockMemoryIds);

        if (selectedRatio < threshold && blockRatio < threshold) {
          continue;
        }

        return [
          {
            ruleId: 'context_duplicate',
            category: 'context_duplicate',
            severity: 'warning',
            spanId: event.spanId,
            title: '上下文重复注入',
            reason: `上下文存在重复 memoryId（selectedMemoryIds 重复率 ${selectedRatio.toFixed(2)}，summaryBlocks memoryIds 重复率 ${blockRatio.toFixed(2)}，阈值 ${threshold}），重复内容会挤占上下文预算。`,
            suggestion: '检查记忆选择与去重逻辑，避免同一记忆被重复注入多次。',
            evidence: [
              {
                eventId: event.eventId,
                type: event.type,
                value: `duplicate_ratio=${Math.max(selectedRatio, blockRatio).toFixed(2)}`,
              },
            ],
          },
        ];
      }

      return [];
    },
  },
  {
    ruleId: 'context_truncation',
    category: 'context_truncation',
    evaluate(ctx) {
      for (const event of ctx.events) {
        if (!CONTEXT_CARRYING_EVENT_TYPES.includes(event.type)) {
          continue;
        }

        const snapshot = readContextSnapshot(event);
        if (!snapshot) {
          continue;
        }

        const hasTruncatedBlock = snapshot.summaryBlocks.some(
          (block) => block.truncated,
        );
        if (snapshot.droppedMemoryIds.length === 0 || !hasTruncatedBlock) {
          continue;
        }

        return [
          {
            ruleId: 'context_truncation',
            category: 'context_truncation',
            severity: 'info',
            spanId: event.spanId,
            title: '上下文裁剪异常',
            reason: `上下文包丢弃了 ${snapshot.droppedMemoryIds.length} 条记忆且存在 truncated summary block，可能因预算裁剪丢失关键上下文。`,
            suggestion:
              '检查上下文预算分配，必要时提升摘要质量或调整 dropped 策略。',
            evidence: [
              {
                eventId: event.eventId,
                type: event.type,
                value: `dropped=${snapshot.droppedMemoryIds.length}|truncated=true`,
              },
            ],
          },
        ];
      }

      return [];
    },
  },
];
