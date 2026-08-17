import type {
  ObservabilityCheckpoint,
  ObservabilityDiagnosticIssue,
  ObservabilityRunStatus,
  PersistedObservabilityEvent,
} from '../../observability.types';

/**
 * Run 摘要：从事件序列聚合出的可对比元信息，供 run 列表与 replay 包使用。
 * 不依赖 run 级别的落库表，全部由事件反推。
 */
export interface ObservabilityRunSummary {
  runId: string;
  conversationId: string | null;
  status: ObservabilityRunStatus;
  startedAt: string | null;
  endedAt: string | null;
  eventCount: number;
  firstSeq: number | null;
  lastSeq: number | null;
  agentRunId: string | null;
  contextPackId: string | null;
  routeDecision: {
    intent?: string;
    selectedAgent?: string;
    confidence?: number;
  } | null;
}

/**
 * Run 列表项：同一会话下可 replay 的 run 轻量摘要。
 */
export interface ObservabilityRunListItem {
  runId: string;
  conversationId: string | null;
  status: ObservabilityRunStatus;
  startedAt: string | null;
  endedAt: string | null;
  eventCount: number;
  lastSeq: number | null;
  agentRunId: string | null;
}

/**
 * Replay 完整包：一次历史 run 复盘所需的全部数据。
 * 前端基于该包驱动 replay store，不读取实时 SSE 流。
 */
export interface ObservabilityRunReplayResponse {
  runId: string;
  summary: ObservabilityRunSummary;
  events: PersistedObservabilityEvent[];
  checkpoints: ObservabilityCheckpoint[];
  diagnostics: ObservabilityDiagnosticIssue[];
}
