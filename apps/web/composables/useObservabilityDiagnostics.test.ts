import { describe, expect, it } from "vitest";

import {
  toDiagnosticItems,
  useObservabilityDiagnostics,
  type ObservabilityDiagnosticIssue,
} from "./useObservabilityDiagnostics";
import type { SpanDerivedAnomaly, SpanEvent } from "./useSpanStore";

function createEvent(
  eventId: string,
  seq: number,
  type: string,
  spanId: string | null,
): SpanEvent {
  return {
    eventId,
    seq,
    runId: "run-1",
    spanId,
    type,
    sourceType: type,
    status: "normal",
    ts: String(seq),
    payload: {},
  };
}

function createAnomaly(
  overrides: Partial<SpanDerivedAnomaly> & { anomalyId: string },
): SpanDerivedAnomaly {
  return {
    kind: "tool_failure",
    severity: "warning",
    title: "异常",
    reason: "原因",
    spanId: null,
    eventId: null,
    seq: null,
    ...overrides,
  };
}

function createIssue(
  overrides: Partial<ObservabilityDiagnosticIssue> & { issueId: string },
): ObservabilityDiagnosticIssue {
  return {
    runId: "run-1",
    spanId: null,
    category: "other",
    severity: "warning",
    title: "问题",
    reason: "原因",
    evidence: [],
    suggestion: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("toDiagnosticItems", () => {
  it("maps local anomaly kinds into diagnostic categories", () => {
    const items = toDiagnosticItems([
      createAnomaly({ anomalyId: "a1", kind: "route_misjudgment" }),
      createAnomaly({ anomalyId: "a2", kind: "tool_failure" }),
      createAnomaly({ anomalyId: "a3", kind: "span_failed" }),
    ]);

    expect(items.map((item) => item.category)).toEqual([
      "route_misjudgment",
      "tool_failure",
      "other",
    ]);
    expect(items.every((item) => item.source === "local")).toBe(true);
  });

  it("builds evidence from anomaly event id", () => {
    const [item] = toDiagnosticItems([
      createAnomaly({
        anomalyId: "a1",
        kind: "tool_timeout",
        eventId: "evt-3",
        reason: "超时",
      }),
    ]);

    expect(item?.evidence).toEqual([
      { eventId: "evt-3", type: "tool_timeout", value: "超时" },
    ]);
    expect(item?.seq).toBeNull(); // 由聚合层补全
  });
});

describe("useObservabilityDiagnostics", () => {
  const events: SpanEvent[] = [
    createEvent("evt-1", 1, "start", "s-run"),
    createEvent("evt-2", 2, "route_decision", "s-run"),
    createEvent("evt-3", 3, "tool.call.started", "s-tool"),
    createEvent("evt-4", 4, "tool.call.finished", "s-tool"),
    createEvent("evt-5", 5, "done", "s-run"),
  ];

  it("merges remote issues and local anomalies, remote wins on duplicate span", () => {
    const remoteIssues: ObservabilityDiagnosticIssue[] = [
      createIssue({
        issueId: "issue-1",
        category: "tool_failure",
        spanId: "s-tool",
        severity: "critical",
        evidence: [
          { eventId: "evt-4", type: "tool.call.finished", value: "x" },
        ],
      }),
      createIssue({
        issueId: "issue-2",
        category: "context_missing",
        spanId: null,
        severity: "warning",
        evidence: [{ eventId: "evt-2", type: "route_decision", value: "y" }],
      }),
    ];
    const localAnomalies: SpanDerivedAnomaly[] = [
      // 与 issue-1 同 category 同 span：应被远程覆盖丢弃
      createAnomaly({
        anomalyId: "anomaly-1",
        kind: "tool_failure",
        spanId: "s-tool",
        eventId: null,
        severity: "warning",
      }),
      // 远程未覆盖：应保留
      createAnomaly({
        anomalyId: "anomaly-2",
        kind: "route_misjudgment",
        spanId: "s-run",
        eventId: "evt-3",
        severity: "warning",
      }),
      createAnomaly({
        anomalyId: "anomaly-3",
        kind: "stream_interrupt",
        spanId: "s-text",
        eventId: "evt-5",
        severity: "critical",
      }),
    ];

    const diagnostics = useObservabilityDiagnostics({
      localAnomalies: () => localAnomalies,
      remoteIssues: () => remoteIssues,
      events: () => events,
    });

    expect(diagnostics.items.value.map((item) => item.id)).toEqual([
      "issue-1",
      "anomaly-3",
      "issue-2",
      "anomaly-2",
    ]);
    // 远程 issue 通过 evidence.eventId 补全 seq
    expect(diagnostics.items.value[0]).toMatchObject({
      id: "issue-1",
      source: "remote",
      eventId: "evt-4",
      seq: 4,
    });
    // 被去重的本地异常不出现
    expect(
      diagnostics.items.value.some((item) => item.id === "anomaly-1"),
    ).toBe(false);
  });

  it("groups by severity and category with counts", () => {
    const remoteIssues: ObservabilityDiagnosticIssue[] = [
      createIssue({
        issueId: "issue-1",
        category: "tool_failure",
        severity: "critical",
        spanId: "s-tool",
        evidence: [
          { eventId: "evt-4", type: "tool.call.finished", value: "x" },
        ],
      }),
      createIssue({
        issueId: "issue-2",
        category: "context_missing",
        severity: "warning",
        evidence: [{ eventId: "evt-2", type: "route_decision", value: "y" }],
      }),
    ];

    const diagnostics = useObservabilityDiagnostics({
      localAnomalies: () => [],
      remoteIssues: () => remoteIssues,
      events: () => events,
    });

    expect(diagnostics.counts.value).toEqual({
      total: 2,
      critical: 1,
      warning: 1,
      info: 0,
    });

    expect(
      diagnostics.groupedBySeverity.value.map((group) => group.key),
    ).toEqual(["critical", "warning"]);
    expect(
      diagnostics.groupedBySeverity.value[0]?.items.map((item) => item.id),
    ).toEqual(["issue-1"]);

    expect(
      diagnostics.groupedByCategory.value.map((group) => group.label),
    ).toEqual(["工具失败", "上下文缺失"]);
  });

  it("returns empty aggregates when no sources", () => {
    const diagnostics = useObservabilityDiagnostics({
      localAnomalies: () => [],
      remoteIssues: () => [],
      events: () => [],
    });

    expect(diagnostics.items.value).toEqual([]);
    expect(diagnostics.groupedByCategory.value).toEqual([]);
    expect(diagnostics.groupedBySeverity.value).toEqual([]);
    expect(diagnostics.counts.value).toEqual({
      total: 0,
      critical: 0,
      warning: 0,
      info: 0,
    });
  });
});
