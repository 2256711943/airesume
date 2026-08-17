/**
 * useReplaySpanStore —— 历史 run 回放状态存储
 *
 * 职责：
 * - 以后端 replay 完整包（ObservabilityRunReplayResponse）为唯一数据源；
 * - 内部持有独立的 useSpanStore 实例，按回放游标（activeSeq）重建快照，
 *   保证回放态与实时态（useResumeConversation 内的 chatSpanStore）完全隔离；
 * - 复用 live store 的派生查询（span 树、统计、筛选、异常提示、checkpoint 定位），
 *   因此 replay 面板与实时观测面板能共享同一套渲染组件。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue';

import type { SseEventEnvelope } from '../utils/sse';
import type { ObservabilityDiagnosticIssue } from './useObservabilityDiagnostics';
import {
  useSpanStore,
  type Span,
  type SpanCheckpoint,
  type SpanDerivedAnomaly,
  type SpanDerivedAnomalyOptions,
  type SpanEvent,
  type SpanEventFilter,
  type SpanFilter,
  type SpanStoreSnapshot,
  type SpanStoreStats,
  type SpanTreeNode,
} from './useSpanStore';

// ---- 后端 replay DTO 的前端镜像类型（与 apps/api/observability.types.ts 对齐）----

export type ObservabilityRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export type ObservabilityEventStatus = 'normal' | 'replay' | 'suppressed';

/** 后端落库事件的前端镜像（Date 序列化后为 ISO 字符串）。 */
export interface PersistedObservabilityEvent {
  eventId: string;
  seq: number;
  runId: string;
  conversationId: string | null;
  userId: string | null;
  agentRunId: string | null;
  spanId: string | null;
  type: string;
  status: ObservabilityEventStatus | null;
  ts: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

/** 恢复锚点（checkpoint）的前端镜像。 */
export interface ObservabilityCheckpoint {
  checkpointId: string;
  runId: string;
  spanId: string | null;
  seq: number;
  label: string;
  keyValues: Record<string, unknown>;
  createdAt: string;
}

/** Run 摘要：由事件序列反推，供 replay 包头部展示。 */
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

/** Run 列表项：同一会话下可 replay 的 run 轻量摘要。 */
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

/** GET /observability/runs/:runId/replay 的响应体。 */
export interface ObservabilityRunReplayResponse {
  runId: string;
  summary: ObservabilityRunSummary;
  events: PersistedObservabilityEvent[];
  checkpoints: ObservabilityCheckpoint[];
  diagnostics: ObservabilityDiagnosticIssue[];
}

/** GET /observability/conversations/:conversationId/runs 的响应体。 */
export interface ObservabilityRunListResponse {
  conversationId: string;
  count: number;
  runs: ObservabilityRunListItem[];
}

/** 回放游标处的状态存储接口。 */
export interface ReplaySpanStore {
  /** 当前已加载的 runId。 */
  readonly runId: Readonly<Ref<string | null>>;
  /** 完整回放事件序列（按 seq 升序）。 */
  readonly events: Readonly<Ref<readonly PersistedObservabilityEvent[]>>;
  /** 当前 run 的 checkpoint 列表（按 seq 升序）。 */
  readonly checkpoints: Readonly<Ref<readonly ObservabilityCheckpoint[]>>;
  /** 当前 run 的诊断 issue 列表。 */
  readonly diagnostics: Readonly<Ref<readonly ObservabilityDiagnosticIssue[]>>;
  /** 当前 run 的摘要信息。 */
  readonly summary: Readonly<Ref<ObservabilityRunSummary | null>>;
  /** 当前回放游标 seq（已应用到快照的最大事件 seq）。 */
  readonly activeSeq: Readonly<Ref<number>>;
  readonly firstSeq: ComputedRef<number | null>;
  readonly lastSeq: ComputedRef<number | null>;
  /** 回放进度（0-100），依据 first/last/activeSeq 计算。 */
  readonly progress: ComputedRef<number>;
  /** 是否已加载 run 且存在事件。 */
  readonly hasRun: ComputedRef<boolean>;

  /** 载入一个 replay 完整包，并将游标移动到末尾（完整快照）。 */
  loadReplayPackage: (replay: ObservabilityRunReplayResponse) => void;
  /** 清空全部回放状态。 */
  reset: () => void;
  /** 将游标移动到包含 target seq 的最新位置（无匹配时清空快照）。 */
  seekToSeq: (seq: number) => void;
  seekToFirst: () => void;
  seekToEnd: () => void;
  /** 返回 seq 之后 / 之前最近的事件 seq，不存在返回 null。 */
  getNextSeq: (seq: number) => number | null;
  getPrevSeq: (seq: number) => number | null;
  hasPrev: () => boolean;
  hasNext: () => boolean;

  // ---- 基于回放游标处快照的派生查询（与 live store 同构）----
  readonly snapshot: Readonly<Ref<SpanStoreSnapshot>>;
  buildSpanTree: (parentSpanId?: string | null) => SpanTreeNode[];
  getStats: () => SpanStoreStats;
  listFilteredEvents: (filter?: SpanEventFilter) => SpanEvent[];
  listFilteredSpans: (filter?: SpanFilter) => Span[];
  listEvents: (spanId?: string | null) => SpanEvent[];
  getEvent: (eventId: string) => SpanEvent | undefined;
  getSpan: (spanId: string) => Span | undefined;
  listCheckpoints: (spanId?: string | null) => SpanCheckpoint[];
  getCheckpoint: (checkpointId: string) => SpanCheckpoint | undefined;
  listAnomalies: (options?: SpanDerivedAnomalyOptions) => SpanDerivedAnomaly[];
}

/** 将落库事件映射为 live store 可消费的 SSE envelope（spanId 缺失时由 live store 兜底合成）。 */
function toEnvelope(event: PersistedObservabilityEvent): SseEventEnvelope<string> {
  return {
    id: event.eventId,
    seq: event.seq,
    runId: event.runId,
    spanId: event.spanId ?? undefined,
    type: event.type,
    ts: event.ts,
    payload: { ...event.payload },
  };
}

function sortEvents(
  events: readonly PersistedObservabilityEvent[],
): PersistedObservabilityEvent[] {
  return [...events].sort(
    (left, right) =>
      left.seq - right.seq || left.eventId.localeCompare(right.eventId),
  );
}

function sortCheckpoints(
  checkpoints: readonly ObservabilityCheckpoint[],
): ObservabilityCheckpoint[] {
  return [...checkpoints].sort(
    (left, right) =>
      left.seq - right.seq || left.checkpointId.localeCompare(right.checkpointId),
  );
}

/**
 * 创建回放状态存储。
 *
 * 说明：seek 时通过 inner.replay 从事件起点重建快照，语义与实时态一致；
 * 事件量较大时可在此处引入 checkpoint 增量缓存（见实施计划 11.5）。
 */
export function useReplaySpanStore(): ReplaySpanStore {
  const inner = useSpanStore<string>();
  const runId = ref<string | null>(null);
  const events = ref<PersistedObservabilityEvent[]>([]);
  const checkpoints = ref<ObservabilityCheckpoint[]>([]);
  const diagnostics = ref<ObservabilityDiagnosticIssue[]>([]);
  const summary = ref<ObservabilityRunSummary | null>(null);
  const activeSeq = ref(0);

  const firstSeq = computed(() => events.value[0]?.seq ?? null);
  const lastSeq = computed(() => events.value.at(-1)?.seq ?? null);
  const hasRun = computed(() => events.value.length > 0);
  const progress = computed(() => {
    const first = firstSeq.value;
    const last = lastSeq.value;
    if (first === null || last === null || last <= first) {
      return 0;
    }
    return Math.min(
      100,
      Math.max(0, Math.round(((activeSeq.value - first) / (last - first)) * 100)),
    );
  });

  /** 二分查找 seq <= target 的最后一个事件下标；无匹配返回 -1。 */
  const lastIndexAtOrBefore = (target: number): number => {
    const list = events.value;
    let low = 0;
    let high = list.length - 1;
    let result = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (list[mid].seq <= target) {
        result = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return result;
  };

  /** 以包含 target seq 的前缀事件重建 inner 快照。 */
  const applyToSeq = (target: number): void => {
    if (events.value.length === 0) {
      activeSeq.value = 0;
      inner.reset();
      return;
    }

    const index = lastIndexAtOrBefore(target);
    if (index < 0) {
      activeSeq.value = 0;
      inner.reset();
      return;
    }

    activeSeq.value = events.value[index].seq;
    inner.replay(events.value.slice(0, index + 1).map(toEnvelope));
  };

  const loadReplayPackage = (replay: ObservabilityRunReplayResponse): void => {
    runId.value = replay.runId;
    events.value = sortEvents(replay.events ?? []);
    checkpoints.value = sortCheckpoints(replay.checkpoints ?? []);
    diagnostics.value = [...(replay.diagnostics ?? [])];
    summary.value = replay.summary ?? null;
    const last = events.value.at(-1);
    applyToSeq(last ? last.seq : 0);
  };

  const reset = (): void => {
    runId.value = null;
    events.value = [];
    checkpoints.value = [];
    diagnostics.value = [];
    summary.value = null;
    activeSeq.value = 0;
    inner.reset();
  };

  const seekToSeq = (seq: number): void => {
    const first = firstSeq.value;
    const last = lastSeq.value;
    if (first !== null && last !== null) {
      applyToSeq(Math.min(last, Math.max(first, seq)));
      return;
    }
    applyToSeq(seq);
  };

  const seekToFirst = (): void => {
    const first = firstSeq.value;
    if (first !== null) {
      applyToSeq(first);
    }
  };

  const seekToEnd = (): void => {
    const last = lastSeq.value;
    if (last !== null) {
      applyToSeq(last);
    }
  };

  /** 二分查找第一个 seq > 目标值的事件 seq。 */
  const getNextSeq = (seq: number): number | null => {
    const list = events.value;
    let low = 0;
    let high = list.length - 1;
    let result: number | null = null;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (list[mid].seq > seq) {
        result = list[mid].seq;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return result;
  };

  /** 二分查找最后一个 seq < 目标值的事件 seq。 */
  const getPrevSeq = (seq: number): number | null => {
    const list = events.value;
    let low = 0;
    let high = list.length - 1;
    let result: number | null = null;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (list[mid].seq < seq) {
        result = list[mid].seq;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return result;
  };

  const hasPrev = (): boolean => getPrevSeq(activeSeq.value) !== null;
  const hasNext = (): boolean => getNextSeq(activeSeq.value) !== null;

  return {
    runId,
    events,
    checkpoints,
    diagnostics,
    summary,
    activeSeq,
    firstSeq,
    lastSeq,
    progress,
    hasRun,
    loadReplayPackage,
    reset,
    seekToSeq,
    seekToFirst,
    seekToEnd,
    getNextSeq,
    getPrevSeq,
    hasPrev,
    hasNext,
    snapshot: inner.snapshot,
    buildSpanTree: inner.buildSpanTree,
    getStats: inner.getStats,
    listFilteredEvents: inner.listFilteredEvents,
    listFilteredSpans: inner.listFilteredSpans,
    listEvents: inner.listEvents,
    getEvent: inner.getEvent,
    getSpan: inner.getSpan,
    listCheckpoints: inner.listCheckpoints,
    getCheckpoint: inner.getCheckpoint,
    listAnomalies: inner.listAnomalies,
  };
}
