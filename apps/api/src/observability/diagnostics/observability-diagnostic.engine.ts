import type {
  ObservabilityDiagnosticCategory,
  ObservabilityDiagnosticEvidence,
  ObservabilityDiagnosticIssue,
  ObservabilityDiagnosticSeverity,
  ObservabilityEvent,
} from '../observability.types';
import type { ObservabilityDiagnosticRule } from './observability-diagnostic-rule';
import type {
  ObservabilityDiagnosticCandidate,
  ObservabilityDiagnosticContext,
  ObservabilityDiagnosticEngineOptions,
  ObservabilityDiagnosticGroup,
  ObservabilityDiagnosticGroupKey,
} from './observability-diagnostic.types';
import { routeMisjudgmentRules } from './rules/route.rules';
import { toolDiagnosticRules } from './rules/tool.rules';
import { contextDiagnosticRules } from './rules/context.rules';
import { streamDiagnosticRules } from './rules/stream.rules';

/**
 * 规则引擎：确定性、纯函数，不写数据库、不调用外部 LLM、不阻塞主链路。
 *
 * 输入：runId + 按 seq 有序的 events。
 * 输出：聚合去重后的 `ObservabilityDiagnosticIssue[]`。
 * 容错：单条规则抛错时跳过该规则，不影响其余规则与其他调用方。
 */

const SEVERITY_ORDER: Record<ObservabilityDiagnosticSeverity, number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

export const DEFAULT_DIAGNOSTIC_RULES: ObservabilityDiagnosticRule[] = [
  ...routeMisjudgmentRules,
  ...toolDiagnosticRules,
  ...contextDiagnosticRules,
  ...streamDiagnosticRules,
];

const DEFAULT_ENGINE_OPTIONS: Required<ObservabilityDiagnosticEngineOptions> = {
  toolTimeoutMs: 60_000,
  contextDuplicateRatioThreshold: 0.5,
};

/**
 * 创建可复用的诊断执行函数，规则列表与默认参数在此固化。
 */
export function createDiagnosticEngine(
  rules: ObservabilityDiagnosticRule[] = DEFAULT_DIAGNOSTIC_RULES,
  options: ObservabilityDiagnosticEngineOptions = {},
): (
  runId: string,
  events: ObservabilityEvent[],
) => ObservabilityDiagnosticIssue[] {
  const mergedOptions: Required<ObservabilityDiagnosticEngineOptions> = {
    ...DEFAULT_ENGINE_OPTIONS,
    ...options,
  };

  return (runId: string, events: ObservabilityEvent[]) =>
    runObservabilityDiagnosticsWithRules(runId, events, rules, mergedOptions);
}

/**
 * 便捷入口：使用默认规则列表执行诊断。
 */
export function runObservabilityDiagnostics(
  runId: string,
  events: ObservabilityEvent[],
  options: ObservabilityDiagnosticEngineOptions = {},
): ObservabilityDiagnosticIssue[] {
  return runObservabilityDiagnosticsWithRules(
    runId,
    events,
    DEFAULT_DIAGNOSTIC_RULES,
    { ...DEFAULT_ENGINE_OPTIONS, ...options },
  );
}

function runObservabilityDiagnosticsWithRules(
  runId: string,
  events: ObservabilityEvent[],
  rules: ObservabilityDiagnosticRule[],
  options: Required<ObservabilityDiagnosticEngineOptions>,
): ObservabilityDiagnosticIssue[] {
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }

  const ctx: ObservabilityDiagnosticContext = { runId, events };
  const candidates: ObservabilityDiagnosticCandidate[] = [];

  for (const rule of rules) {
    try {
      const hits = rule.evaluate(ctx);
      for (const hit of hits) {
        if (hit.evidence.length > 0) {
          candidates.push(hit);
        }
      }
    } catch {
      // 单条规则失败不阻塞整体诊断；后续可扩展规则级错误上报。
    }
  }

  return aggregateCandidates(runId, candidates, events, options);
}

/**
 * 按去重 key 聚合候选命中。
 *
 * 去重 key（计划文档 10.5）：
 * {runId}:{category}:{ruleId}:{spanId || "run"}:{primaryEvidenceEventId}
 *
 * 聚合规则：
 * - 同 key 的 evidence 合并去重；
 * - severity 取同组最高；
 * - occurrenceCount 为合并前命中数。
 */
function aggregateCandidates(
  runId: string,
  candidates: ObservabilityDiagnosticCandidate[],
  events: ObservabilityEvent[],
  options: Required<ObservabilityDiagnosticEngineOptions>,
): ObservabilityDiagnosticIssue[] {
  void options;
  if (candidates.length === 0) {
    return [];
  }

  const seqByEventId = new Map<string, number>();
  for (const event of events) {
    seqByEventId.set(event.eventId, event.seq);
  }

  const groups = new Map<string, ObservabilityDiagnosticGroup>();
  const occurrenceCountByKey = new Map<string, number>();

  for (const candidate of candidates) {
    const sortedEvidence = sortEvidenceBySeq(candidate.evidence, seqByEventId);
    const primaryEventId = sortedEvidence[0]?.eventId ?? 'unknown';
    const groupKey: ObservabilityDiagnosticGroupKey = {
      category: candidate.category,
      ruleId: candidate.ruleId,
      spanKey: candidate.spanId || 'run',
      primaryEvidenceEventId: primaryEventId,
    };
    const mapKey = buildGroupMapKey(groupKey);
    const existing = groups.get(mapKey);

    occurrenceCountByKey.set(
      mapKey,
      (occurrenceCountByKey.get(mapKey) ?? 0) + 1,
    );

    if (!existing) {
      groups.set(mapKey, {
        groupKey,
        severity: candidate.severity,
        title: candidate.title,
        reason: candidate.reason,
        suggestion: candidate.suggestion,
        evidence: sortedEvidence,
      });
      continue;
    }

    existing.severity = higherSeverity(existing.severity, candidate.severity);
    existing.evidence = mergeEvidence(existing.evidence, sortedEvidence);
  }

  const now = new Date();
  return [...groups.values()].map((group) => {
    const { category, ruleId, spanKey, primaryEvidenceEventId } = group.groupKey;
    const dedupeKey = `${runId}:${category}:${ruleId}:${spanKey}:${primaryEvidenceEventId}`;

    return {
      issueId: `diag-${hashString(dedupeKey)}`,
      runId,
      spanId: spanKey === 'run' ? null : spanKey,
      category: group.groupKey.category,
      severity: group.severity,
      title: group.title,
      reason: group.reason,
      evidence: group.evidence,
      suggestion: group.suggestion,
      createdAt: now,
      updatedAt: now,
      ruleId,
      dedupeKey,
      occurrenceCount: occurrenceCountByKey.get(
        buildGroupMapKey(group.groupKey),
      ),
    };
  });
}

function buildGroupMapKey(key: ObservabilityDiagnosticGroupKey): string {
  return `${key.category}:${key.ruleId}:${key.spanKey}:${key.primaryEvidenceEventId}`;
}

function sortEvidenceBySeq(
  evidence: ObservabilityDiagnosticEvidence[],
  seqByEventId: Map<string, number>,
): ObservabilityDiagnosticEvidence[] {
  return [...evidence].sort((a, b) => {
    const seqA = seqByEventId.get(a.eventId) ?? Number.MAX_SAFE_INTEGER;
    const seqB = seqByEventId.get(b.eventId) ?? Number.MAX_SAFE_INTEGER;
    return seqA - seqB || a.eventId.localeCompare(b.eventId);
  });
}

function mergeEvidence(
  current: ObservabilityDiagnosticEvidence[],
  incoming: ObservabilityDiagnosticEvidence[],
): ObservabilityDiagnosticEvidence[] {
  const seen = new Set(
    current.map(
      (item) => `${item.eventId}:${item.type}:${item.value}`,
    ),
  );
  const merged = [...current];

  for (const item of incoming) {
    const key = `${item.eventId}:${item.type}:${item.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }

  return merged;
}

function higherSeverity(
  a: ObservabilityDiagnosticSeverity,
  b: ObservabilityDiagnosticSeverity,
): ObservabilityDiagnosticSeverity {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

/**
 * 确定性的短 hash（djb2），保证同一 dedupeKey 恒定产出同一 issueId。
 */
function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
}
