/**
 * useObservabilityDiagnostics —— 实时轻量诊断聚合
 *
 * 职责：
 * - 定义后端规则引擎诊断结果的轻量前端镜像类型（ObservabilityDiagnosticIssue）
 * - 合并本地实时派生异常（SpanDerivedAnomaly）与后端规则引擎结果（终态自动拉取）
 * - 按 severity / category 分组，供 DiagnosticStrip 分组展示
 * - 通过 evidence.eventId 反查本地事件，补全定位信息（spanId / eventId / seq）
 */
import { computed, type ComputedRef } from "vue";

import type { SpanDerivedAnomaly, SpanEvent } from "./useSpanStore";

export type DiagnosticSeverity = "critical" | "warning" | "info";

/** 后端规则引擎诊断 evidence 的轻量镜像。 */
export interface ObservabilityDiagnosticEvidence {
  eventId: string;
  type: string;
  value: string;
}

/** 后端规则引擎诊断 issue 的轻量镜像（与 apps/api observability.types.ts 对齐）。 */
export interface ObservabilityDiagnosticIssue {
  issueId: string;
  runId: string;
  spanId: string | null;
  category: string;
  severity: DiagnosticSeverity;
  title: string;
  reason: string;
  evidence: ObservabilityDiagnosticEvidence[];
  suggestion: string | null;
  createdAt: string;
  ruleId?: string;
  dedupeKey?: string;
  updatedAt?: string;
  occurrenceCount?: number;
}

/** 后端 GET /observability/runs/:runId/diagnostics 的响应体。 */
export interface ObservabilityDiagnosticResponse {
  runId: string;
  count: number;
  issues: ObservabilityDiagnosticIssue[];
}

/**
 * 统一展示模型：本地派生异常与后端规则结果归一化后的诊断项，
 * 供 DiagnosticStrip 与时间线组件直接消费。
 */
export interface DiagnosticItem {
  /** 稳定去重 ID（本地取 anomalyId，远程取 issueId）。 */
  id: string;
  /** 数据来源：本地实时派生 / 后端规则引擎。 */
  source: "local" | "remote";
  category: string;
  severity: DiagnosticSeverity;
  title: string;
  reason: string;
  suggestion: string | null;
  spanId: string | null;
  eventId: string | null;
  seq: number | null;
  evidence: ObservabilityDiagnosticEvidence[];
  occurrenceCount?: number;
  ruleId?: string;
}

/** 诊断分组：按 category 或 severity 聚合，组内按严重级别与 seq 排序。 */
export interface DiagnosticGroup {
  key: string;
  label: string;
  severity: DiagnosticSeverity;
  items: DiagnosticItem[];
}

export interface DiagnosticCounts {
  total: number;
  critical: number;
  warning: number;
  info: number;
}

export interface UseObservabilityDiagnosticsSources {
  localAnomalies: () => readonly SpanDerivedAnomaly[];
  remoteIssues: () => readonly ObservabilityDiagnosticIssue[];
  events: () => readonly SpanEvent[];
}

export interface UseObservabilityDiagnosticsResult {
  /** 合并去重排序后的全部诊断项（远程优先）。 */
  items: ComputedRef<DiagnosticItem[]>;
  /** 按 category 分组，组内按严重级别与 seq 排序。 */
  groupedByCategory: ComputedRef<DiagnosticGroup[]>;
  /** 按 severity 分组（critical > warning > info）。 */
  groupedBySeverity: ComputedRef<DiagnosticGroup[]>;
  counts: ComputedRef<DiagnosticCounts>;
}

/** 本地派生异常 kind 到后端 category 维度的映射。 */
const LOCAL_KIND_TO_CATEGORY: Record<string, string> = {
  route_misjudgment: "route_misjudgment",
  tool_failure: "tool_failure",
  tool_timeout: "tool_timeout",
  context_missing: "context_missing",
  stream_interrupt: "stream_interrupt",
  stream_incomplete: "stream_incomplete",
  span_failed: "other",
  error_event: "other",
};

/** 诊断分类的中文标签，供分组标题展示。 */
export const DIAGNOSTIC_CATEGORY_LABELS: Record<string, string> = {
  route_misjudgment: "路由决策",
  tool_failure: "工具失败",
  tool_timeout: "工具超时",
  context_missing: "上下文缺失",
  context_duplicate: "上下文重复",
  context_truncation: "上下文截断",
  stream_interrupt: "文本流中断",
  stream_incomplete: "运行未闭环",
  agent_loop: "Agent 循环",
  other: "其他",
};

const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const SEVERITY_LABELS: Record<DiagnosticSeverity, string> = {
  critical: "严重",
  warning: "警告",
  info: "提示",
};

/**
 * 将本地派生异常归一化为统一展示模型。
 *
 * @param anomalies 本地派生异常列表。
 * @returns 统一诊断项列表（source 为 local）。
 */
export function toDiagnosticItems(
  anomalies: readonly SpanDerivedAnomaly[],
): DiagnosticItem[] {
  return anomalies.map((anomaly) => ({
    id: anomaly.anomalyId,
    source: "local",
    category: LOCAL_KIND_TO_CATEGORY[anomaly.kind] ?? "other",
    severity: anomaly.severity,
    title: anomaly.title,
    reason: anomaly.reason,
    suggestion: null,
    spanId: anomaly.spanId,
    eventId: anomaly.eventId,
    seq: anomaly.seq,
    evidence: anomaly.eventId
      ? [
          {
            eventId: anomaly.eventId,
            type: anomaly.kind,
            value: anomaly.reason,
          },
        ]
      : [],
  }));
}

function toRemoteItem(issue: ObservabilityDiagnosticIssue): DiagnosticItem {
  const primaryEvidence = issue.evidence[0];
  return {
    id: issue.issueId,
    source: "remote",
    category: issue.category,
    severity: issue.severity,
    title: issue.title,
    reason: issue.reason,
    suggestion: issue.suggestion,
    spanId: issue.spanId,
    eventId: primaryEvidence?.eventId ?? null,
    seq: null,
    evidence: issue.evidence,
    occurrenceCount: issue.occurrenceCount,
    ruleId: issue.ruleId,
  };
}

function toExactDedupeKey(item: DiagnosticItem): string {
  return `${item.category}:${item.spanId ?? "run"}:${item.eventId ?? "run"}`;
}

function toSpanDedupeKey(item: DiagnosticItem): string {
  return `${item.category}:${item.spanId ?? "run"}`;
}

function compareItems(left: DiagnosticItem, right: DiagnosticItem): number {
  const severityDelta =
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
  if (severityDelta !== 0) {
    return severityDelta;
  }

  return (
    (left.seq ?? Number.MAX_SAFE_INTEGER) -
    (right.seq ?? Number.MAX_SAFE_INTEGER)
  );
}

function groupItems(
  items: DiagnosticItem[],
  resolveKey: (item: DiagnosticItem) => { key: string; label: string },
): DiagnosticGroup[] {
  const groups = new Map<string, DiagnosticItem[]>();

  for (const item of items) {
    const { key } = resolveKey(item);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  return [...groups.entries()]
    .map(([key, list]) => {
      const sorted = [...list].sort(compareItems);
      const head = sorted[0];
      return {
        key,
        label: head ? resolveKey(head).label : key,
        severity: head ? head.severity : "warning",
        items: sorted,
      };
    })
    .sort((left, right) =>
      compareItems(
        { ...left.items[0]!, severity: left.severity },
        { ...right.items[0]!, severity: right.severity },
      ),
    );
}

/**
 * 合并本地派生异常与后端规则结果，远程优先去重并补全定位信息。
 *
 * 去重策略（单 run 维度）：
 * - 精确维度：category + spanId + 主证据 eventId 完全相同则合并；
 * - span 维度：本地异常与远程 issue 同 category 同 span 时保留远程（含可定位证据）。
 *
 * @param sources 本地异常、远程结果与本地事件列表的读取器。
 * @returns 合并后的展示模型。
 */
export function useObservabilityDiagnostics(
  sources: UseObservabilityDiagnosticsSources,
): UseObservabilityDiagnosticsResult {
  const items = computed<DiagnosticItem[]>(() => {
    const remoteIssues = sources.remoteIssues();
    const localAnomalies = sources.localAnomalies();
    const events = sources.events();

    const seqByEventId = new Map<string, number>();
    for (const event of events) {
      seqByEventId.set(event.eventId, event.seq);
    }

    const remoteItems = remoteIssues.map((issue) => {
      const item = toRemoteItem(issue);
      if (item.eventId) {
        item.seq = seqByEventId.get(item.eventId) ?? null;
      }
      return item;
    });

    const exactRemoteKeys = new Set(remoteItems.map(toExactDedupeKey));
    const spanRemoteKeys = new Set(remoteItems.map(toSpanDedupeKey));
    const merged: DiagnosticItem[] = [...remoteItems];

    for (const anomaly of localAnomalies) {
      const local = toDiagnosticItems([anomaly])[0];
      if (!local) {
        continue;
      }
      if (exactRemoteKeys.has(toExactDedupeKey(local))) {
        continue;
      }
      if (spanRemoteKeys.has(toSpanDedupeKey(local))) {
        continue;
      }
      merged.push(local);
    }

    return merged.sort(compareItems);
  });

  const groupedByCategory = computed<DiagnosticGroup[]>(() =>
    groupItems(items.value, (item) => ({
      key: item.category,
      label: DIAGNOSTIC_CATEGORY_LABELS[item.category] ?? item.category,
    })),
  );

  const groupedBySeverity = computed<DiagnosticGroup[]>(() =>
    groupItems(items.value, (item) => ({
      key: item.severity,
      label: SEVERITY_LABELS[item.severity],
    })),
  );

  const counts = computed<DiagnosticCounts>(() => {
    const result: DiagnosticCounts = {
      total: 0,
      critical: 0,
      warning: 0,
      info: 0,
    };
    for (const item of items.value) {
      result.total += 1;
      result[item.severity] += 1;
    }
    return result;
  });

  return { items, groupedByCategory, groupedBySeverity, counts };
}
