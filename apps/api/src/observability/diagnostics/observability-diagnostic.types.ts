import type {
  ObservabilityDiagnosticCategory,
  ObservabilityDiagnosticEvidence,
  ObservabilityDiagnosticSeverity,
  ObservabilityEvent,
} from '../observability.types';

/**
 * 规则执行上下文。
 *
 * MVP 阶段仅消费 `runId` 与按 seq 有序排列的 events；
 * spans、checkpoints 作为后续扩展保留，不进入当前输入契约。
 */
export interface ObservabilityDiagnosticContext {
  runId: string;
  events: ObservabilityEvent[];
}

/**
 * 规则评估的中间产出：一次命中可能携带多条 evidence，
 * 最终由引擎按去重 key 聚合成一个 `ObservabilityDiagnosticIssue`。
 */
export interface ObservabilityDiagnosticCandidate {
  ruleId: string;
  category: ObservabilityDiagnosticCategory;
  severity: ObservabilityDiagnosticSeverity;
  spanId: string | null;
  title: string;
  reason: string;
  suggestion: string | null;
  evidence: ObservabilityDiagnosticEvidence[];
}

/**
 * 引擎可选项，全部有默认值，MVP 阶段可通过常量调整。
 */
export interface ObservabilityDiagnosticEngineOptions {
  /** 工具超时阈值（毫秒），默认 60_000。 */
  toolTimeoutMs?: number;
  /** 上下文 memoryId 重复比例阈值（0~1），默认 0.5。 */
  contextDuplicateRatioThreshold?: number;
}

/**
 * 去重聚合时的分组 key（不含 runId，引擎单 run 执行）。
 */
export interface ObservabilityDiagnosticGroupKey {
  category: ObservabilityDiagnosticCategory;
  ruleId: string;
  spanKey: string;
  primaryEvidenceEventId: string;
}

/**
 * 按去重 key 合并后的中间结果。
 */
export interface ObservabilityDiagnosticGroup {
  groupKey: ObservabilityDiagnosticGroupKey;
  severity: ObservabilityDiagnosticSeverity;
  title: string;
  reason: string;
  suggestion: string | null;
  evidence: ObservabilityDiagnosticEvidence[];
}
