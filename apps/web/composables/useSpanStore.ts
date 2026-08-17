import { ref, type Ref } from 'vue';

import type { SseEventEnvelope } from '../utils/sse';

export type SpanKind = 'run' | 'step' | 'tool' | 'text' | 'checkpoint';

export type SpanStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled';

export type SpanDerivedAnomalyKind =
  | 'route_misjudgment'
  | 'tool_failure'
  | 'tool_timeout'
  | 'context_missing'
  | 'stream_interrupt'
  | 'stream_incomplete'
  | 'span_failed'
  | 'error_event';

export type SpanDerivedAnomalySeverity = 'critical' | 'warning' | 'info';

export interface Span {
  spanId: string;
  parentSpanId: string | null;
  runId: string;
  kind: SpanKind;
  name: string;
  status: SpanStatus;
  startTs: string;
  endTs: string | null;
  seqStart: number;
  seqEnd: number | null;
  messageIds: string[];
  meta: Record<string, unknown>;
}

/**
 * 归一化后的事件记录，作为回放与诊断的基础日志。
 */
export interface SpanEvent {
  eventId: string;
  seq: number;
  runId: string;
  spanId: string | null;
  type: string;
  sourceType: string;
  status: 'normal' | 'replay' | 'suppressed';
  ts: string;
  payload: Record<string, unknown>;
}

/**
 * Checkpoint 索引记录，用于后续的回放定位。
 */
export interface SpanCheckpoint {
  checkpointId: string;
  runId: string;
  spanId: string | null;
  seq: number;
  label: string;
  keyValues: Record<string, unknown>;
  createdAt: string;
}

export interface SpanStoreSnapshot {
  runId: string | null;
  spansById: Record<string, Span>;
  eventsById: Record<string, SpanEvent>;
  eventIds: string[];
  checkpointsById: Record<string, SpanCheckpoint>;
  checkpointIds: string[];
  rootSpanIds: string[];
  activeSpanIds: string[];
  lastSeq: number;
}

export interface SpanTreeNode {
  span: Span;
  depth: number;
  isActive: boolean;
  children: SpanTreeNode[];
}

/**
 * 事件筛选条件，用于实时观测面板按类型、状态和所属 span 快速收窄事件列表。
 */
export interface SpanEventFilter {
  eventTypes?: readonly string[];
  sourceTypes?: readonly string[];
  eventStatuses?: readonly SpanEvent['status'][];
  spanIds?: readonly (string | null)[];
  spanKinds?: readonly SpanKind[];
  spanStatuses?: readonly SpanStatus[];
  seqGte?: number;
  seqLte?: number;
  onlyActive?: boolean;
  onlyErrors?: boolean;
  onlyCheckpoints?: boolean;
}

/**
 * Span 筛选条件，用于 span 树、时间线和详情面板共享同一套派生查询。
 */
export interface SpanFilter {
  spanIds?: readonly string[];
  parentSpanIds?: readonly (string | null)[];
  spanKinds?: readonly SpanKind[];
  statuses?: readonly SpanStatus[];
  eventTypes?: readonly string[];
  onlyActive?: boolean;
  onlyErrors?: boolean;
  onlyCheckpoints?: boolean;
}

/**
 * 当前 run 的轻量统计结果，供实时观测总览直接展示。
 */
export interface SpanStoreStats {
  runId: string | null;
  totalSpans: number;
  totalEvents: number;
  rootSpanCount: number;
  activeSpanCount: number;
  runningSpanCount: number;
  failedSpanCount: number;
  canceledSpanCount: number;
  checkpointCount: number;
  toolSpanCount: number;
  failedToolSpanCount: number;
  textSpanCount: number;
  assistantChunkEventCount: number;
  errorEventCount: number;
  checkpointEventCount: number;
  firstSeq: number | null;
  lastSeq: number;
  startedAt: string | null;
  endedAt: string | null;
  lastEventAt: string | null;
  durationMs: number | null;
  spanKindCounts: Record<SpanKind, number>;
  spanStatusCounts: Record<SpanStatus, number>;
  eventTypeCounts: Record<string, number>;
}

/**
 * 派生异常项，仅用于实时 UI 快速提示；完整诊断仍由后端规则引擎负责。
 */
export interface SpanDerivedAnomaly {
  anomalyId: string;
  kind: SpanDerivedAnomalyKind;
  severity: SpanDerivedAnomalySeverity;
  title: string;
  reason: string;
  spanId: string | null;
  eventId: string | null;
  seq: number | null;
}

/**
 * 派生异常计算参数，用于控制超时阈值和上下文是否必须存在。
 */
export interface SpanDerivedAnomalyOptions {
  now?: string;
  toolTimeoutMs?: number;
  streamIdleMs?: number;
  requireContext?: boolean;
}

export type SpanStoreEnvelope<TType extends string = string> = SseEventEnvelope<TType>;

export interface SpanStore<TType extends string = string> {
  readonly snapshot: Readonly<Ref<SpanStoreSnapshot>>;
  ingestEnvelope: (envelope: SpanStoreEnvelope<TType>) => void;
  ingestEnvelopes: (envelopes: readonly SpanStoreEnvelope<TType>[]) => void;
  replay: (envelopes: readonly SpanStoreEnvelope<TType>[]) => void;
  reset: (runId?: string) => void;
  getSpan: (spanId: string) => Span | undefined;
  getEvent: (eventId: string) => SpanEvent | undefined;
  listEvents: (spanId?: string | null) => SpanEvent[];
  listFilteredEvents: (filter?: SpanEventFilter) => SpanEvent[];
  getCheckpoint: (checkpointId: string) => SpanCheckpoint | undefined;
  listCheckpoints: (spanId?: string | null) => SpanCheckpoint[];
  listChildren: (parentSpanId?: string | null) => Span[];
  listRootSpans: () => Span[];
  listActiveSpans: () => Span[];
  listFilteredSpans: (filter?: SpanFilter) => Span[];
  listDescendants: (spanId: string) => Span[];
  listSpanPath: (spanId: string) => Span[];
  buildSpanTree: (parentSpanId?: string | null) => SpanTreeNode[];
  getStats: () => SpanStoreStats;
  listAnomalies: (options?: SpanDerivedAnomalyOptions) => SpanDerivedAnomaly[];
}

const SPAN_KINDS: readonly SpanKind[] = ['run', 'step', 'tool', 'text', 'checkpoint'];
const SPAN_STATUSES: readonly SpanStatus[] = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'canceled',
];
const TERMINAL_STATUSES = new Set<SpanStatus>(['succeeded', 'failed', 'canceled']);

function createSnapshot(runId: string | null = null): SpanStoreSnapshot {
  return {
    runId,
    spansById: {},
    eventsById: {},
    eventIds: [],
    checkpointsById: {},
    checkpointIds: [],
    rootSpanIds: [],
    activeSpanIds: [],
    lastSeq: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function getNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getPositiveInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = getNumber(record, key);
  return typeof value === 'number' && value > 0 ? Math.floor(value) : undefined;
}

function getStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function getOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

interface ContextPackSummaryBlockMeta {
  blockId: string;
  type: string;
  layer: string;
  position: number;
  title: string;
  content: string;
  memoryIds: string[];
  tokenEstimate: number;
  truncated: boolean;
  metadata?: Record<string, unknown>;
}

function getContextPackSummaryBlocks(
  record: Record<string, unknown>,
  key: string,
): ContextPackSummaryBlockMeta[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .map((item) => {
      if (!isRecord(item)) {
        return null;
      }

      const metadata = isRecord(item.metadata) ? { ...item.metadata } : undefined;

      return {
        blockId: getString(item, 'blockId') ?? '',
        type: getString(item, 'type') ?? '',
        layer: getString(item, 'layer') ?? '',
        position: getNumber(item, 'position') ?? 0,
        title: getString(item, 'title') ?? '',
        content: getString(item, 'content') ?? '',
        memoryIds: getOptionalStringArray(item, 'memoryIds') ?? [],
        tokenEstimate: getNumber(item, 'tokenEstimate') ?? 0,
        truncated: item.truncated === true,
        ...(metadata ? { metadata } : {}),
      };
    })
    .filter((item): item is ContextPackSummaryBlockMeta => !!item);
}

function normalizeStatus(value: unknown, fallback: SpanStatus): SpanStatus {
  switch (value) {
    case 'pending':
    case 'running':
    case 'succeeded':
    case 'failed':
    case 'canceled':
      return value;
    default:
      return fallback;
  }
}

function normalizeCheckpointStatus(value: unknown): SpanStatus {
  const status = normalizeStatus(value, 'succeeded');
  if (status === 'pending' || status === 'running') {
    return 'succeeded';
  }

  return status;
}

function isTerminalStatus(status: SpanStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function isTerminalKind(kind: SpanKind): boolean {
  return kind === 'checkpoint';
}

function setMetaField(meta: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === 'undefined') {
    delete meta[key];
    return;
  }

  meta[key] = value;
}

function pushUnique(target: string[], value: string): void {
  if (!value || target.includes(value)) {
    return;
  }

  target.push(value);
}

function removeValue(target: string[], value: string): void {
  const index = target.indexOf(value);
  if (index >= 0) {
    target.splice(index, 1);
  }
}

function normalizeEventType(type: string): string {
  switch (type) {
    case 'tool_start':
      return 'tool.call.started';
    case 'tool_done':
      return 'tool.call.finished';
    default:
      return type;
  }
}

function clonePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload };
}

function cloneContextPackSummaryBlock(
  block: ContextPackSummaryBlockMeta,
): ContextPackSummaryBlockMeta {
  return {
    ...block,
    memoryIds: [...block.memoryIds],
    ...(block.metadata ? { metadata: { ...block.metadata } } : {}),
  };
}

function clearRecord(target: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
}

function clearArray<TValue>(target: TValue[]): void {
  if (target.length > 0) {
    target.splice(0, target.length);
  }
}

function compareSpanOrder(left: Span, right: Span): number {
  if (left.seqStart !== right.seqStart) {
    return left.seqStart - right.seqStart;
  }

  return left.spanId.localeCompare(right.spanId);
}

function dedupeSpanList(spans: Span[]): Span[] {
  const seen = new Set<string>();
  const next: Span[] = [];

  for (const span of spans) {
    if (seen.has(span.spanId)) {
      continue;
    }

    seen.add(span.spanId);
    next.push(span);
  }

  next.sort(compareSpanOrder);
  return next;
}

function compareSpanEventOrder(left: SpanEvent, right: SpanEvent): number {
  if (left.seq !== right.seq) {
    return left.seq - right.seq;
  }

  return left.eventId.localeCompare(right.eventId);
}

function compareCheckpointOrder(left: SpanCheckpoint, right: SpanCheckpoint): number {
  if (left.seq !== right.seq) {
    return left.seq - right.seq;
  }

  return left.checkpointId.localeCompare(right.checkpointId);
}

function createStringSet(values?: readonly string[]): Set<string> | null {
  return values && values.length > 0 ? new Set(values) : null;
}

function createNullableStringSet(
  values?: readonly (string | null)[],
): Set<string | null> | null {
  return values && values.length > 0 ? new Set(values) : null;
}

function createSpanKindSet(values?: readonly SpanKind[]): Set<SpanKind> | null {
  return values && values.length > 0 ? new Set(values) : null;
}

function createSpanStatusSet(values?: readonly SpanStatus[]): Set<SpanStatus> | null {
  return values && values.length > 0 ? new Set(values) : null;
}

function createEventStatusSet(
  values?: readonly SpanEvent['status'][],
): Set<SpanEvent['status']> | null {
  return values && values.length > 0 ? new Set(values) : null;
}

function getDateTime(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function getLatestDate(left: string | null, right: string | null): string | null {
  const leftTime = getDateTime(left);
  const rightTime = getDateTime(right);

  if (leftTime === null) {
    return right;
  }

  if (rightTime === null) {
    return left;
  }

  return rightTime >= leftTime ? right : left;
}

function getEarliestDate(left: string | null, right: string | null): string | null {
  const leftTime = getDateTime(left);
  const rightTime = getDateTime(right);

  if (leftTime === null) {
    return right;
  }

  if (rightTime === null) {
    return left;
  }

  return rightTime <= leftTime ? right : left;
}

function getDurationMs(startTs: string | null, endTs: string | null): number | null {
  const startTime = getDateTime(startTs);
  const endTime = getDateTime(endTs);

  if (startTime === null || endTime === null || endTime < startTime) {
    return null;
  }

  return endTime - startTime;
}

function isErrorLikeEvent(event: SpanEvent): boolean {
  if (event.type === 'error') {
    return true;
  }

  if (event.payload.success === false) {
    return true;
  }

  return !!getString(event.payload, 'errorCode') || !!getString(event.payload, 'errorMessage');
}

function isErrorLikeSpan(span: Span): boolean {
  if (span.status === 'failed') {
    return true;
  }

  if (span.meta.success === false) {
    return true;
  }

  return !!getString(span.meta, 'errorCode') || !!getString(span.meta, 'errorMessage');
}

function hasContextPackMeta(span: Span): boolean {
  const contextPackId = typeof span.meta.contextPackId === 'string'
    ? span.meta.contextPackId.trim()
    : '';
  const summaryBlocks = Array.isArray(span.meta.summaryBlocks) ? span.meta.summaryBlocks : [];

  return contextPackId.length > 0 || summaryBlocks.length > 0;
}

function createSpanKindCountMap(): Record<SpanKind, number> {
  return SPAN_KINDS.reduce<Record<SpanKind, number>>((counts, kind) => {
    counts[kind] = 0;
    return counts;
  }, {
    run: 0,
    step: 0,
    tool: 0,
    text: 0,
    checkpoint: 0,
  });
}

function createSpanStatusCountMap(): Record<SpanStatus, number> {
  return SPAN_STATUSES.reduce<Record<SpanStatus, number>>((counts, status) => {
    counts[status] = 0;
    return counts;
  }, {
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    canceled: 0,
  });
}

function extractStepIndex(spanId: string, fallback: number): number {
  const match = spanId.match(/:step:(\d+)/);
  if (!match) {
    return fallback;
  }

  const parsed = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function setContextPackMeta(
  meta: Record<string, unknown>,
  payload: Record<string, unknown>,
): void {
  const contextPackId = getString(payload, 'contextPackId');
  if (typeof contextPackId !== 'undefined') {
    setMetaField(meta, 'contextPackId', contextPackId);
  }

  const selectedMemoryIds = getOptionalStringArray(payload, 'selectedMemoryIds');
  if (selectedMemoryIds) {
    setMetaField(meta, 'selectedMemoryIds', selectedMemoryIds);
  }

  const droppedMemoryIds = getOptionalStringArray(payload, 'droppedMemoryIds');
  if (droppedMemoryIds) {
    setMetaField(meta, 'droppedMemoryIds', droppedMemoryIds);
  }

  const summaryBlocks = getContextPackSummaryBlocks(payload, 'summaryBlocks');
  if (summaryBlocks) {
    setMetaField(
      meta,
      'summaryBlocks',
      summaryBlocks.map((block) => cloneContextPackSummaryBlock(block)),
    );
  }

  const finalPromptPreview = getString(payload, 'finalPromptPreview');
  if (typeof finalPromptPreview !== 'undefined') {
    setMetaField(meta, 'finalPromptPreview', finalPromptPreview);
  }
}

interface LegacyEnvelopeState {
  runSpanId: string | null;
  textSpanId: string | null;
  stepIndex: number;
  toolIndex: number;
  textIndex: number;
  pendingToolSpanIdsByName: Record<string, string[]>;
}

function createLegacyEnvelopeState(): LegacyEnvelopeState {
  return {
    runSpanId: null,
    textSpanId: null,
    stepIndex: 0,
    toolIndex: 0,
    textIndex: 0,
    pendingToolSpanIdsByName: {},
  };
}

interface NormalizedSpanEnvelope {
  id: string;
  seq: number;
  runId: string;
  spanId?: string;
  type: string;
  sourceType: string;
  ts: string;
  payload: Record<string, unknown>;
}

interface SpanEnvelopeCore {
  runId: string;
  spanId?: string;
  seq: number;
  ts: string;
  payload: Record<string, unknown>;
}

export function useSpanStore<TType extends string = string>(): SpanStore<TType> {
  const snapshot = ref<SpanStoreSnapshot>(createSnapshot());
  const legacyState = createLegacyEnvelopeState();

  const getSpan = (spanId: string): Span | undefined => {
    return snapshot.value.spansById[spanId];
  };

  const getEvent = (eventId: string): SpanEvent | undefined => {
    return snapshot.value.eventsById[eventId];
  };

  const getCheckpoint = (checkpointId: string): SpanCheckpoint | undefined => {
    return snapshot.value.checkpointsById[checkpointId];
  };

  const syncRootMembership = (span: Span): void => {
    if (span.parentSpanId === null) {
      pushUnique(snapshot.value.rootSpanIds, span.spanId);
      return;
    }

    removeValue(snapshot.value.rootSpanIds, span.spanId);
  };

  const syncActiveMembership = (span: Span): void => {
    if (isTerminalKind(span.kind) || isTerminalStatus(span.status)) {
      removeValue(snapshot.value.activeSpanIds, span.spanId);
      return;
    }

    pushUnique(snapshot.value.activeSpanIds, span.spanId);
  };

  const appendMessageIds = (span: Span, payload: Record<string, unknown>): void => {
    const messageId = getString(payload, 'messageId');
    if (messageId) {
      pushUnique(span.messageIds, messageId);
    }

    for (const item of getStringArray(payload, 'messageIds')) {
      pushUnique(span.messageIds, item);
    }
  };

  const addSpan = (span: Span): Span => {
    const existing = getSpan(span.spanId);
    if (existing) {
      return existing;
    }

    snapshot.value.spansById[span.spanId] = span;
    syncRootMembership(span);
    syncActiveMembership(span);

    if (!snapshot.value.runId && span.runId) {
      snapshot.value.runId = span.runId;
    }

    return span;
  };

  const appendEvent = (
    envelope: NormalizedSpanEnvelope,
    status: SpanEvent['status'],
  ): SpanEvent => {
    const existing = getEvent(envelope.id);
    if (existing) {
      return existing;
    }

    const event: SpanEvent = {
      eventId: envelope.id,
      seq: envelope.seq,
      runId: envelope.runId,
      spanId: envelope.spanId?.trim() || null,
      type: envelope.type,
      sourceType: envelope.sourceType,
      status,
      ts: envelope.ts,
      payload: clonePayload(envelope.payload),
    };

    snapshot.value.eventsById[event.eventId] = event;
    snapshot.value.eventIds.push(event.eventId);
    return event;
  };

  const upsertCheckpoint = (checkpoint: SpanCheckpoint): SpanCheckpoint => {
    const existing = getCheckpoint(checkpoint.checkpointId);
    if (existing) {
      existing.runId = checkpoint.runId;
      existing.spanId = checkpoint.spanId;
      existing.seq = checkpoint.seq;
      existing.label = checkpoint.label;
      existing.keyValues = clonePayload(checkpoint.keyValues);
      existing.createdAt = checkpoint.createdAt;
      return existing;
    }

    snapshot.value.checkpointsById[checkpoint.checkpointId] = checkpoint;
    snapshot.value.checkpointIds.push(checkpoint.checkpointId);
    return checkpoint;
  };

  const updateSpan = (spanId: string, mutate: (target: Span) => void): Span | undefined => {
    const target = getSpan(spanId);
    if (!target) {
      return undefined;
    }

    mutate(target);
    syncRootMembership(target);
    syncActiveMembership(target);
    return target;
  };

  const ensureSpan = (params: {
    envelope: SpanEnvelopeCore;
    kind: SpanKind;
    parentSpanId: string | null;
    name: string;
    status: SpanStatus;
    startTs: string;
    endTs: string | null;
  }): Span | undefined => {
    const spanId = params.envelope.spanId?.trim();
    if (!spanId) {
      return undefined;
    }

    const existing = getSpan(spanId);
    if (existing) {
      return existing;
    }

    return addSpan({
      spanId,
      parentSpanId: params.parentSpanId,
      runId: params.envelope.runId,
      kind: params.kind,
      name: params.name,
      status: params.status,
      startTs: params.startTs,
      endTs: params.endTs,
      seqStart: params.envelope.seq,
      seqEnd: params.envelope.seq,
      messageIds: [],
      meta: {},
    });
  };

  const updateLifecycleSpan = (params: {
    envelope: SpanEnvelopeCore;
    kind: SpanKind;
    fallbackName: string;
    fallbackStatus: SpanStatus;
    defaultParentSpanId: string | null;
    startTs: string;
    endTs: string | null;
  }): Span | undefined => {
    const spanId = params.envelope.spanId?.trim();
    if (!spanId) {
      return undefined;
    }

    const payload = isRecord(params.envelope.payload) ? params.envelope.payload : {};
    const status = normalizeStatus(payload.status, params.fallbackStatus);
    const name = getString(payload, 'name')
      ?? getString(payload, 'toolName')
      ?? params.fallbackName;
    const parentSpanId = getString(payload, 'parentSpanId') ?? params.defaultParentSpanId;

    const target = ensureSpan({
      envelope: params.envelope,
      kind: params.kind,
      parentSpanId,
      name,
      status,
      startTs: params.startTs,
      endTs: params.endTs,
    });

    if (!target) {
      return undefined;
    }

    return updateSpan(spanId, (span) => {
      span.parentSpanId = parentSpanId;
      span.name = name;
      span.status = status;
      if (!span.startTs) {
        span.startTs = params.startTs;
      }
      span.endTs = params.endTs;
      span.seqEnd = params.envelope.seq;
    });
  };

  const clearLegacyState = (): void => {
    legacyState.runSpanId = null;
    legacyState.textSpanId = null;
    legacyState.stepIndex = 0;
    legacyState.toolIndex = 0;
    legacyState.textIndex = 0;
    clearRecord(legacyState.pendingToolSpanIdsByName as Record<string, unknown>);
  };

  const getLegacyRunScope = (): string => {
    return snapshot.value.runId?.trim() || 'legacy-run';
  };

  const ensureLegacyRunSpanId = (): string => {
    if (legacyState.runSpanId) {
      return legacyState.runSpanId;
    }

    legacyState.runSpanId = snapshot.value.rootSpanIds[0] ?? `${getLegacyRunScope()}:run`;
    return legacyState.runSpanId;
  };

  const getPendingToolQueueKey = (toolName: string | undefined): string => {
    const normalized = toolName?.trim();
    return normalized && normalized.length > 0 ? normalized : '__unknown_tool__';
  };

  const pushPendingLegacyToolSpanId = (toolName: string | undefined, spanId: string): void => {
    const key = getPendingToolQueueKey(toolName);
    const queue = legacyState.pendingToolSpanIdsByName[key] ?? [];
    queue.push(spanId);
    legacyState.pendingToolSpanIdsByName[key] = queue;
  };

  const takePendingLegacyToolSpanId = (toolName: string | undefined): string | undefined => {
    const key = getPendingToolQueueKey(toolName);
    const queue = legacyState.pendingToolSpanIdsByName[key];
    if (!queue || queue.length === 0) {
      return undefined;
    }

    const spanId = queue.pop();
    if (!spanId || queue.length === 0) {
      delete legacyState.pendingToolSpanIdsByName[key];
    }

    return spanId;
  };

  const getDefaultLegacyParentSpanId = (): string | null => {
    const activeStepSpan = listActiveSpans()
      .filter((span) => span.kind === 'step')
      .at(-1);

    return activeStepSpan?.spanId ?? legacyState.runSpanId ?? snapshot.value.rootSpanIds[0] ?? null;
  };

  const normalizeEnvelope = (envelope: SpanStoreEnvelope<TType>): NormalizedSpanEnvelope => {
    const payload = isRecord(envelope.payload) ? { ...envelope.payload } : {};
    const existingSpanId = envelope.spanId?.trim();
    let spanId = existingSpanId;
    const normalizedType = normalizeEventType(envelope.type);

    const setParentSpanIdIfMissing = (parentSpanId: string | null) => {
      if (!parentSpanId || getString(payload, 'parentSpanId')) {
        return;
      }

      payload.parentSpanId = parentSpanId;
    };

    switch (normalizedType) {
      case 'start':
      case 'route_decision':
      case 'done':
      case 'error':
      case 'canceled':
        spanId = spanId || ensureLegacyRunSpanId();
        break;
      case 'agent.step.started':
      case 'agent.step.finished':
        spanId = spanId || `${ensureLegacyRunSpanId()}:step:legacy:${++legacyState.stepIndex}`;
        setParentSpanIdIfMissing(ensureLegacyRunSpanId());
        break;
      case 'tool.call.started': {
        const toolName = getString(payload, 'toolName') ?? 'tool';
        if (!spanId) {
          spanId = `${ensureLegacyRunSpanId()}:tool:legacy:${++legacyState.toolIndex}:${toolName}`;
          pushPendingLegacyToolSpanId(toolName, spanId);
        }
        setParentSpanIdIfMissing(getDefaultLegacyParentSpanId());
        break;
      }
      case 'tool.call.finished': {
        const toolName = getString(payload, 'toolName') ?? 'tool';
        spanId = spanId || takePendingLegacyToolSpanId(toolName) || `${ensureLegacyRunSpanId()}:tool:legacy:${++legacyState.toolIndex}:${toolName}`;
        setParentSpanIdIfMissing(getDefaultLegacyParentSpanId());
        break;
      }
      case 'assistant_chunk':
      case 'assistant_done':
        if (!spanId) {
          legacyState.textSpanId = legacyState.textSpanId ?? `${ensureLegacyRunSpanId()}:text:legacy:${++legacyState.textIndex}`;
          spanId = legacyState.textSpanId;
        }
        setParentSpanIdIfMissing(getDefaultLegacyParentSpanId());
        break;
      case 'checkpoint':
        spanId = spanId
          || getString(payload, 'checkpointId')
          || `${ensureLegacyRunSpanId()}:checkpoint:${envelope.seq}`;
        setParentSpanIdIfMissing(getString(payload, 'parentSpanId') ?? getDefaultLegacyParentSpanId());
        break;
      default:
        break;
    }

    return {
      id: envelope.id,
      seq: envelope.seq,
      runId: envelope.runId,
      spanId,
      type: normalizedType,
      sourceType: envelope.type,
      ts: envelope.ts,
      payload,
    };
  };

  const ingestNormalizedEnvelope = (
    normalizedEnvelope: NormalizedSpanEnvelope,
    eventStatus: SpanEvent['status'],
  ): void => {
    appendEvent(normalizedEnvelope, eventStatus);

    if (!snapshot.value.runId && normalizedEnvelope.runId) {
      snapshot.value.runId = normalizedEnvelope.runId;
    }

    const payload = normalizedEnvelope.payload;

    switch (normalizedEnvelope.type) {
      case 'progress':
      case 'chunk':
        break;
      case 'start': {
        const span = ensureSpan({
          envelope: normalizedEnvelope,
          kind: 'run',
          parentSpanId: null,
          name: getString(payload, 'requestId') ?? normalizedEnvelope.runId ?? 'run',
          status: 'running',
          startTs: normalizedEnvelope.ts,
          endTs: null,
        });

        if (span) {
          updateSpan(span.spanId, (target) => {
            target.status = 'running';
            target.seqEnd = normalizedEnvelope.seq;
            target.endTs = null;
            setMetaField(target.meta, 'requestId', getString(payload, 'requestId'));
            setMetaField(target.meta, 'routeDecisionStarted', payload.routeDecisionStarted);
            setContextPackMeta(target.meta, payload);
          });
        }
        break;
      }
      case 'route_decision': {
        if (normalizedEnvelope.spanId) {
          const span = updateLifecycleSpan({
            envelope: normalizedEnvelope,
            kind: 'run',
            fallbackName: normalizedEnvelope.runId || 'run',
            fallbackStatus: 'running',
            defaultParentSpanId: null,
            startTs: normalizedEnvelope.ts,
            endTs: null,
          });
          const routeDecision = isRecord(payload.routeDecision) ? payload.routeDecision : null;
          if (span) {
            updateSpan(normalizedEnvelope.spanId, (target) => {
              setMetaField(target.meta, 'routeDecision', routeDecision);
              setMetaField(target.meta, 'intent', routeDecision ? getString(routeDecision, 'intent') : undefined);
              setMetaField(target.meta, 'selectedAgent', routeDecision ? getString(routeDecision, 'selectedAgent') : undefined);
              setContextPackMeta(target.meta, payload);
              target.seqEnd = normalizedEnvelope.seq;
            });
          }
        }
        break;
      }
      case 'agent.step.started': {
        const span = updateLifecycleSpan({
          envelope: normalizedEnvelope,
          kind: 'step',
          fallbackName: 'step',
          fallbackStatus: 'running',
          defaultParentSpanId: null,
          startTs: getString(payload, 'startedAt') ?? normalizedEnvelope.ts,
          endTs: null,
        });

        if (span) {
          updateSpan(span.spanId, (target) => {
            setMetaField(target.meta, 'agentRunId', getString(payload, 'agentRunId'));
            setMetaField(target.meta, 'stepIndex', getPositiveInteger(payload, 'stepIndex') ?? extractStepIndex(target.spanId, ++legacyState.stepIndex));
            setMetaField(target.meta, 'promptPreview', getString(payload, 'promptPreview'));
            setContextPackMeta(target.meta, payload);
            appendMessageIds(target, payload);
          });
        }
        break;
      }
      case 'agent.step.finished': {
        const span = updateLifecycleSpan({
          envelope: normalizedEnvelope,
          kind: 'step',
          fallbackName: 'step',
          fallbackStatus: getString(payload, 'errorCode') ? 'failed' : 'succeeded',
          defaultParentSpanId: null,
          startTs: getString(payload, 'startedAt') ?? normalizedEnvelope.ts,
          endTs: getString(payload, 'finishedAt') ?? normalizedEnvelope.ts,
        });

        if (span) {
          updateSpan(span.spanId, (target) => {
            setMetaField(target.meta, 'agentRunId', getString(payload, 'agentRunId'));
            setMetaField(target.meta, 'stepIndex', getPositiveInteger(payload, 'stepIndex') ?? extractStepIndex(target.spanId, legacyState.stepIndex || 1));
            setMetaField(target.meta, 'promptPreview', getString(payload, 'promptPreview'));
            setMetaField(target.meta, 'errorCode', getString(payload, 'errorCode'));
            setMetaField(target.meta, 'errorMessage', getString(payload, 'errorMessage'));
            setContextPackMeta(target.meta, payload);
            appendMessageIds(target, payload);
          });
        }
        break;
      }
      case 'tool.call.started': {
        const span = updateLifecycleSpan({
          envelope: normalizedEnvelope,
          kind: 'tool',
          fallbackName: getString(payload, 'toolName') ?? 'tool',
          fallbackStatus: 'running',
          defaultParentSpanId: null,
          startTs: getString(payload, 'startedAt') ?? normalizedEnvelope.ts,
          endTs: null,
        });

        if (span) {
          updateSpan(span.spanId, (target) => {
            setMetaField(target.meta, 'agentRunId', getString(payload, 'agentRunId'));
            setMetaField(target.meta, 'toolName', getString(payload, 'toolName'));
            appendMessageIds(target, payload);
          });
        }
        break;
      }
      case 'tool.call.finished': {
        const span = updateLifecycleSpan({
          envelope: normalizedEnvelope,
          kind: 'tool',
          fallbackName: getString(payload, 'toolName') ?? 'tool',
          fallbackStatus: payload.success === false ? 'failed' : 'succeeded',
          defaultParentSpanId: null,
          startTs: getString(payload, 'startedAt') ?? normalizedEnvelope.ts,
          endTs: getString(payload, 'finishedAt') ?? normalizedEnvelope.ts,
        });

        if (span) {
          updateSpan(span.spanId, (target) => {
            setMetaField(target.meta, 'agentRunId', getString(payload, 'agentRunId'));
            setMetaField(target.meta, 'toolName', getString(payload, 'toolName'));
            setMetaField(target.meta, 'success', payload.success);
            setMetaField(target.meta, 'latencyMs', getNumber(payload, 'latencyMs'));
            setMetaField(target.meta, 'errorCode', getString(payload, 'errorCode'));
            setMetaField(target.meta, 'errorMessage', getString(payload, 'errorMessage'));
            appendMessageIds(target, payload);
          });
        }
        break;
      }
      case 'assistant_chunk': {
        const spanId = normalizedEnvelope.spanId?.trim();
        if (!spanId) {
          break;
        }

        const chunkText = typeof payload.text === 'string' ? payload.text : '';
        const existing = getSpan(spanId);
        if (!existing) {
          const created = addSpan({
            spanId,
            parentSpanId: getString(payload, 'parentSpanId') ?? null,
            runId: normalizedEnvelope.runId,
            kind: 'text',
            name: getString(payload, 'name') ?? 'assistant',
            status: 'running',
            startTs: normalizedEnvelope.ts,
            endTs: null,
            seqStart: normalizedEnvelope.seq,
            seqEnd: normalizedEnvelope.seq,
            messageIds: [],
            meta: {},
          });

          updateSpan(created.spanId, (target) => {
            setMetaField(target.meta, 'chunkCount', chunkText.length > 0 ? 1 : 0);
            setMetaField(target.meta, 'totalChars', chunkText.length);
            appendMessageIds(target, payload);
          });
          break;
        }

        updateSpan(spanId, (target) => {
          const currentChunkCount = typeof target.meta.chunkCount === 'number' ? target.meta.chunkCount : 0;
          const currentTotalChars = typeof target.meta.totalChars === 'number' ? target.meta.totalChars : 0;
          target.seqEnd = normalizedEnvelope.seq;
          setMetaField(target.meta, 'chunkCount', currentChunkCount + (chunkText.length > 0 ? 1 : 0));
          setMetaField(target.meta, 'totalChars', currentTotalChars + chunkText.length);
          appendMessageIds(target, payload);
        });
        break;
      }
      case 'assistant_done': {
        const span = updateLifecycleSpan({
          envelope: normalizedEnvelope,
          kind: 'text',
          fallbackName: 'assistant',
          fallbackStatus: 'succeeded',
          defaultParentSpanId: getString(payload, 'parentSpanId') ?? null,
          startTs: normalizedEnvelope.ts,
          endTs: normalizedEnvelope.ts,
        });

        if (span) {
          updateSpan(span.spanId, (target) => {
            const content = typeof payload.content === 'string' ? payload.content : '';
            const currentChunkCount = typeof target.meta.chunkCount === 'number' ? target.meta.chunkCount : 0;
            const currentTotalChars = typeof target.meta.totalChars === 'number' ? target.meta.totalChars : 0;
            setMetaField(target.meta, 'content', payload.content);
            setMetaField(target.meta, 'routeDecision', payload.routeDecision);
            setMetaField(target.meta, 'displayPreferences', payload.displayPreferences);
            setMetaField(target.meta, 'toolCalls', payload.toolCalls);
            setMetaField(target.meta, 'chunkCount', currentChunkCount);
            setMetaField(target.meta, 'totalChars', Math.max(currentTotalChars, content.length));
            appendMessageIds(target, payload);
          });
        }
        break;
      }
      case 'checkpoint': {
        const span = ensureSpan({
          envelope: normalizedEnvelope,
          kind: 'checkpoint',
          parentSpanId: getString(payload, 'parentSpanId') ?? null,
          name: getString(payload, 'name') ?? 'checkpoint',
          status: normalizeCheckpointStatus(payload.status),
          startTs: normalizedEnvelope.ts,
          endTs: normalizedEnvelope.ts,
        });

        const keyValues: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(payload)) {
          if (key === 'name' || key === 'status' || key === 'parentSpanId' || key === 'checkpointId') {
            continue;
          }
          keyValues[key] = value;
        }

        if (span) {
          updateSpan(span.spanId, (target) => {
            target.status = normalizeCheckpointStatus(payload.status);
            target.endTs = normalizedEnvelope.ts;
            target.seqEnd = normalizedEnvelope.seq;
            setMetaField(target.meta, 'label', getString(payload, 'name') ?? 'checkpoint');
            setMetaField(target.meta, 'keyValues', keyValues);
            appendMessageIds(target, payload);
          });
        }

        upsertCheckpoint({
          checkpointId: getString(payload, 'checkpointId') ?? normalizedEnvelope.spanId?.trim() ?? `checkpoint:${normalizedEnvelope.id}`,
          runId: normalizedEnvelope.runId,
          spanId: normalizedEnvelope.spanId?.trim() || null,
          seq: normalizedEnvelope.seq,
          label: getString(payload, 'name') ?? 'checkpoint',
          keyValues,
          createdAt: normalizedEnvelope.ts,
        });
        break;
      }
      case 'done': {
        const targetSpanId = normalizedEnvelope.spanId?.trim() || snapshot.value.rootSpanIds[0];
        if (targetSpanId) {
          const span = ensureSpan({
            envelope: {
              ...normalizedEnvelope,
              spanId: targetSpanId,
            },
            kind: 'run',
            parentSpanId: null,
            name: normalizedEnvelope.runId || 'run',
            status: 'succeeded',
            startTs: normalizedEnvelope.ts,
            endTs: normalizedEnvelope.ts,
          });

          if (span) {
            updateSpan(span.spanId, (target) => {
              target.status = 'succeeded';
              target.endTs = normalizedEnvelope.ts;
              target.seqEnd = normalizedEnvelope.seq;
              setMetaField(target.meta, 'conversationId', getString(payload, 'conversationId'));
              setMetaField(target.meta, 'agentRunId', getString(payload, 'agentRunId'));
              setMetaField(target.meta, 'createdConversation', payload.createdConversation);
              setMetaField(target.meta, 'routeDecision', payload.routeDecision);
              setMetaField(target.meta, 'displayPreferences', payload.displayPreferences);
              setContextPackMeta(target.meta, payload);
            });
          }
        }
        break;
      }
      case 'error': {
        const targetSpanId = normalizedEnvelope.spanId?.trim() || snapshot.value.rootSpanIds[0];
        if (!targetSpanId) {
          break;
        }

        const span = ensureSpan({
          envelope: {
            ...normalizedEnvelope,
            spanId: targetSpanId,
          },
          kind: targetSpanId === snapshot.value.rootSpanIds[0] ? 'run' : 'step',
          parentSpanId: null,
          name: normalizedEnvelope.runId || 'run',
          status: 'failed',
          startTs: normalizedEnvelope.ts,
          endTs: normalizedEnvelope.ts,
        });

        if (span) {
          updateSpan(span.spanId, (target) => {
            target.status = 'failed';
            target.endTs = normalizedEnvelope.ts;
            target.seqEnd = normalizedEnvelope.seq;
            setMetaField(target.meta, 'code', getString(payload, 'code'));
            setMetaField(target.meta, 'message', getString(payload, 'message'));
            setMetaField(target.meta, 'requestId', getString(payload, 'requestId'));
          });
        }
        break;
      }
      case 'canceled': {
        const targetSpanId = normalizedEnvelope.spanId?.trim() || snapshot.value.rootSpanIds[0];
        if (!targetSpanId) {
          break;
        }

        const span = ensureSpan({
          envelope: {
            ...normalizedEnvelope,
            spanId: targetSpanId,
          },
          kind: 'run',
          parentSpanId: null,
          name: normalizedEnvelope.runId || 'run',
          status: 'canceled',
          startTs: normalizedEnvelope.ts,
          endTs: normalizedEnvelope.ts,
        });

        if (span) {
          updateSpan(span.spanId, (target) => {
            target.status = 'canceled';
            target.endTs = normalizedEnvelope.ts;
            target.seqEnd = normalizedEnvelope.seq;
            setMetaField(target.meta, 'reason', getString(payload, 'reason'));
          });
        }
        break;
      }
      default:
        break;
    }
  };

  const ingestEnvelope = (envelope: SpanStoreEnvelope<TType>): void => {
    if (envelope.seq <= snapshot.value.lastSeq) {
      return;
    }

    snapshot.value.lastSeq = envelope.seq;
    if (!snapshot.value.runId && envelope.runId) {
      snapshot.value.runId = envelope.runId;
    }
    ingestNormalizedEnvelope(normalizeEnvelope(envelope), 'normal');
  };

  const ingestEnvelopes = (envelopes: readonly SpanStoreEnvelope<TType>[]): void => {
    for (const envelope of envelopes) {
      ingestEnvelope(envelope);
    }
  };

  const reset = (runId?: string): void => {
    snapshot.value.runId = runId ?? null;
    snapshot.value.lastSeq = 0;
    clearArray(snapshot.value.rootSpanIds);
    clearArray(snapshot.value.activeSpanIds);
    clearRecord(snapshot.value.spansById as Record<string, unknown>);
    clearArray(snapshot.value.eventIds);
    clearRecord(snapshot.value.eventsById as Record<string, unknown>);
    clearArray(snapshot.value.checkpointIds);
    clearRecord(snapshot.value.checkpointsById as Record<string, unknown>);
    clearLegacyState();
  };

  const replay = (envelopes: readonly SpanStoreEnvelope<TType>[]): void => {
    reset(envelopes[0]?.runId);
    for (const envelope of envelopes) {
      if (envelope.seq <= snapshot.value.lastSeq) {
        continue;
      }

      snapshot.value.lastSeq = envelope.seq;
      if (!snapshot.value.runId && envelope.runId) {
        snapshot.value.runId = envelope.runId;
      }
      ingestNormalizedEnvelope(normalizeEnvelope(envelope), 'replay');
    }
  };

  const listAllEvents = (): SpanEvent[] => {
    return snapshot.value.eventIds
      .map((eventId) => getEvent(eventId))
      .filter((event): event is SpanEvent => !!event)
      .sort(compareSpanEventOrder);
  };

  const listAllSpans = (): Span[] => {
    return Object.values(snapshot.value.spansById).sort(compareSpanOrder);
  };

  const listEvents = (spanId: string | null = null): SpanEvent[] => {
    return listAllEvents()
      .filter((event) => event.spanId === spanId)
      .sort(compareSpanEventOrder);
  };

  /**
   * 按事件、span 和异常维度筛选事件，供实时观测 UI 复用。
   *
   * @param filter 事件筛选条件；为空时返回当前 run 的全部事件。
   * @returns 按 seq 升序排列的事件列表。
   */
  const listFilteredEvents = (filter: SpanEventFilter = {}): SpanEvent[] => {
    const eventTypeSet = createStringSet(filter.eventTypes);
    const sourceTypeSet = createStringSet(filter.sourceTypes);
    const eventStatusSet = createEventStatusSet(filter.eventStatuses);
    const spanIdSet = createNullableStringSet(filter.spanIds);
    const spanKindSet = createSpanKindSet(filter.spanKinds);
    const spanStatusSet = createSpanStatusSet(filter.spanStatuses);
    const activeSpanIdSet = new Set(snapshot.value.activeSpanIds);

    return listAllEvents().filter((event) => {
      const span = event.spanId ? getSpan(event.spanId) : undefined;

      if (eventTypeSet && !eventTypeSet.has(event.type)) {
        return false;
      }

      if (sourceTypeSet && !sourceTypeSet.has(event.sourceType)) {
        return false;
      }

      if (eventStatusSet && !eventStatusSet.has(event.status)) {
        return false;
      }

      if (spanIdSet && !spanIdSet.has(event.spanId)) {
        return false;
      }

      if (spanKindSet && (!span || !spanKindSet.has(span.kind))) {
        return false;
      }

      if (spanStatusSet && (!span || !spanStatusSet.has(span.status))) {
        return false;
      }

      if (typeof filter.seqGte === 'number' && event.seq < filter.seqGte) {
        return false;
      }

      if (typeof filter.seqLte === 'number' && event.seq > filter.seqLte) {
        return false;
      }

      if (filter.onlyActive && (!event.spanId || !activeSpanIdSet.has(event.spanId))) {
        return false;
      }

      if (filter.onlyErrors && !isErrorLikeEvent(event) && (!span || !isErrorLikeSpan(span))) {
        return false;
      }

      if (filter.onlyCheckpoints && event.type !== 'checkpoint' && span?.kind !== 'checkpoint') {
        return false;
      }

      return true;
    });
  };

  const listCheckpoints = (spanId: string | null = null): SpanCheckpoint[] => {
    return snapshot.value.checkpointIds
      .map((checkpointId) => getCheckpoint(checkpointId))
      .filter((checkpoint): checkpoint is SpanCheckpoint => !!checkpoint)
      .filter((checkpoint) => checkpoint.spanId === spanId)
      .sort(compareCheckpointOrder);
  };

  const listChildren = (parentSpanId: string | null = null): Span[] => {
    return Object.values(snapshot.value.spansById)
      .filter((span) => span.parentSpanId === parentSpanId)
      .sort(compareSpanOrder);
  };

  const listRootSpans = (): Span[] => {
    return snapshot.value.rootSpanIds
      .map((spanId) => getSpan(spanId))
      .filter((span): span is Span => !!span)
      .sort(compareSpanOrder);
  };

  const listActiveSpans = (): Span[] => {
    return snapshot.value.activeSpanIds
      .map((spanId) => getSpan(spanId))
      .filter((span): span is Span => !!span)
      .sort(compareSpanOrder);
  };

  /**
   * 按类型、状态、事件和异常维度筛选 span，供树视图和时间线共享。
   *
   * @param filter Span 筛选条件；为空时返回当前 run 的全部 span。
   * @returns 按 seqStart 升序排列的 span 列表。
   */
  const listFilteredSpans = (filter: SpanFilter = {}): Span[] => {
    const spanIdSet = createStringSet(filter.spanIds);
    const parentSpanIdSet = createNullableStringSet(filter.parentSpanIds);
    const spanKindSet = createSpanKindSet(filter.spanKinds);
    const spanStatusSet = createSpanStatusSet(filter.statuses);
    const eventTypeSet = createStringSet(filter.eventTypes);
    const activeSpanIdSet = new Set(snapshot.value.activeSpanIds);

    return listAllSpans().filter((span) => {
      if (spanIdSet && !spanIdSet.has(span.spanId)) {
        return false;
      }

      if (parentSpanIdSet && !parentSpanIdSet.has(span.parentSpanId)) {
        return false;
      }

      if (spanKindSet && !spanKindSet.has(span.kind)) {
        return false;
      }

      if (spanStatusSet && !spanStatusSet.has(span.status)) {
        return false;
      }

      if (filter.onlyActive && !activeSpanIdSet.has(span.spanId)) {
        return false;
      }

      if (filter.onlyErrors && !isErrorLikeSpan(span)) {
        return false;
      }

      if (filter.onlyCheckpoints && span.kind !== 'checkpoint') {
        return false;
      }

      if (eventTypeSet) {
        const hasMatchingEvent = listAllEvents().some((event) => {
          return event.spanId === span.spanId && eventTypeSet.has(event.type);
        });

        if (!hasMatchingEvent) {
          return false;
        }
      }

      return true;
    });
  };

  const listDescendants = (spanId: string): Span[] => {
    const collected: Span[] = [];
    const queue = listChildren(spanId);

    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) {
        continue;
      }

      collected.push(next);
      queue.push(...listChildren(next.spanId));
    }

    return dedupeSpanList(collected);
  };

  const listSpanPath = (spanId: string): Span[] => {
    const path: Span[] = [];
    const visited = new Set<string>();
    let cursor = getSpan(spanId);

    while (cursor && !visited.has(cursor.spanId)) {
      path.push(cursor);
      visited.add(cursor.spanId);
      cursor = cursor.parentSpanId ? getSpan(cursor.parentSpanId) : undefined;
    }

    path.reverse();
    return path;
  };

  const buildSpanTree = (parentSpanId: string | null = null): SpanTreeNode[] => {
    const activeSpanIdSet = new Set(snapshot.value.activeSpanIds);
    const building = new Set<string>();

    const buildNode = (span: Span, depth: number): SpanTreeNode => {
      if (building.has(span.spanId)) {
        return {
          span,
          depth,
          isActive: activeSpanIdSet.has(span.spanId),
          children: [],
        };
      }

      building.add(span.spanId);
      const children = listChildren(span.spanId).map((child) => buildNode(child, depth + 1));
      building.delete(span.spanId);

      return {
        span,
        depth,
        isActive: activeSpanIdSet.has(span.spanId),
        children,
      };
    };

    const baseSpans = parentSpanId === null
      ? dedupeSpanList([
          ...listRootSpans(),
          ...Object.values(snapshot.value.spansById).filter((span) => {
            return !!span.parentSpanId && !getSpan(span.parentSpanId);
          }),
        ])
      : listChildren(parentSpanId);

    return baseSpans.map((span) => buildNode(span, 0));
  };

  /**
   * 汇总当前 run 的 span、事件和耗时统计，供实时观测头部展示。
   *
   * @returns 当前 snapshot 派生出的统计结果。
   */
  const getStats = (): SpanStoreStats => {
    const spans = listAllSpans();
    const events = listAllEvents();
    const spanKindCounts = createSpanKindCountMap();
    const spanStatusCounts = createSpanStatusCountMap();
    const eventTypeCounts: Record<string, number> = {};
    let startedAt: string | null = null;
    let endedAt: string | null = null;

    for (const span of spans) {
      spanKindCounts[span.kind] += 1;
      spanStatusCounts[span.status] += 1;
      startedAt = getEarliestDate(startedAt, span.startTs);
      endedAt = getLatestDate(endedAt, span.endTs);
    }

    for (const event of events) {
      eventTypeCounts[event.type] = (eventTypeCounts[event.type] ?? 0) + 1;
      startedAt = getEarliestDate(startedAt, event.ts);
      endedAt = getLatestDate(endedAt, event.ts);
    }

    const firstEvent = events[0];
    const lastEvent = events.at(-1);

    return {
      runId: snapshot.value.runId,
      totalSpans: spans.length,
      totalEvents: events.length,
      rootSpanCount: snapshot.value.rootSpanIds.length,
      activeSpanCount: snapshot.value.activeSpanIds.length,
      runningSpanCount: spanStatusCounts.running,
      failedSpanCount: spanStatusCounts.failed,
      canceledSpanCount: spanStatusCounts.canceled,
      checkpointCount: snapshot.value.checkpointIds.length,
      toolSpanCount: spanKindCounts.tool,
      failedToolSpanCount: spans.filter((span) => span.kind === 'tool' && isErrorLikeSpan(span))
        .length,
      textSpanCount: spanKindCounts.text,
      assistantChunkEventCount: events.filter((event) => event.type === 'assistant_chunk').length,
      errorEventCount: events.filter((event) => event.type === 'error').length,
      checkpointEventCount: events.filter((event) => event.type === 'checkpoint').length,
      firstSeq: firstEvent?.seq ?? null,
      lastSeq: snapshot.value.lastSeq,
      startedAt,
      endedAt,
      lastEventAt: lastEvent?.ts ?? null,
      durationMs: getDurationMs(startedAt, endedAt),
      spanKindCounts,
      spanStatusCounts,
      eventTypeCounts,
    };
  };

  /**
   * 从当前 snapshot 派生轻量异常提示，帮助实时 UI 在规则引擎返回前先标红关键风险。
   *
   * @param options 超时阈值、当前时间和上下文要求。
   * @returns 按严重级别和 seq 排序的异常提示列表。
   */
  const listAnomalies = (options: SpanDerivedAnomalyOptions = {}): SpanDerivedAnomaly[] => {
    const anomalies: SpanDerivedAnomaly[] = [];
    const spans = listAllSpans();
    const events = listAllEvents();
    const terminalEvent = events.find((event) => {
      return event.type === 'done' || event.type === 'error' || event.type === 'canceled';
    });
    const hasRouteDecision = events.some((event) => event.type === 'route_decision');
    const hasAgentWork = events.some((event) => {
      return event.type.startsWith('agent.step.') || event.type.startsWith('tool.call.');
    });
    const hasAssistantChunk = events.some((event) => event.type === 'assistant_chunk');
    const hasAssistantDone = events.some((event) => event.type === 'assistant_done');
    const requiresContext = options.requireContext === true
      || events.some((event) => event.payload.contextRequired === true);
    const hasContext = spans.some((span) => hasContextPackMeta(span));
    const nowTime = getDateTime(options.now);

    const pushAnomaly = (anomaly: SpanDerivedAnomaly): void => {
      if (anomalies.some((item) => item.anomalyId === anomaly.anomalyId)) {
        return;
      }

      anomalies.push(anomaly);
    };

    for (const event of events) {
      if (!isErrorLikeEvent(event)) {
        continue;
      }

      pushAnomaly({
        anomalyId: event.type === 'error'
          ? `${snapshot.value.runId ?? event.runId}:event:${event.eventId}`
          : `${snapshot.value.runId ?? event.runId}:tool_failure:${event.spanId ?? event.eventId}`,
        kind: event.type === 'error' ? 'error_event' : 'tool_failure',
        severity: event.type === 'error' ? 'critical' : 'warning',
        title: event.type === 'error' ? '运行错误事件' : '工具事件异常',
        reason: getString(event.payload, 'errorMessage')
          ?? getString(event.payload, 'errorCode')
          ?? '事件 payload 标记了失败或错误字段。',
        spanId: event.spanId,
        eventId: event.eventId,
        seq: event.seq,
      });
    }

    for (const span of spans) {
      if (span.kind === 'tool' && isErrorLikeSpan(span)) {
        pushAnomaly({
          anomalyId: `${span.runId}:tool_failure:${span.spanId}`,
          kind: 'tool_failure',
          severity: 'warning',
          title: '工具调用失败',
          reason: getString(span.meta, 'errorMessage')
            ?? getString(span.meta, 'errorCode')
            ?? '工具 span 处于失败状态或标记 success=false。',
          spanId: span.spanId,
          eventId: null,
          seq: span.seqEnd ?? span.seqStart,
        });
        continue;
      }

      if (span.kind !== 'run' && span.status === 'failed') {
        pushAnomaly({
          anomalyId: `${span.runId}:span_failed:${span.spanId}`,
          kind: 'span_failed',
          severity: 'warning',
          title: 'Span 执行失败',
          reason: getString(span.meta, 'errorMessage')
            ?? getString(span.meta, 'errorCode')
            ?? 'Span 状态为 failed。',
          spanId: span.spanId,
          eventId: null,
          seq: span.seqEnd ?? span.seqStart,
        });
      }

      if (
        span.kind === 'tool'
        && span.status === 'running'
        && typeof options.toolTimeoutMs === 'number'
        && nowTime !== null
      ) {
        const startTime = getDateTime(span.startTs);
        if (startTime !== null && nowTime - startTime >= options.toolTimeoutMs) {
          pushAnomaly({
            anomalyId: `${span.runId}:tool_timeout:${span.spanId}`,
            kind: 'tool_timeout',
            severity: 'critical',
            title: '工具调用超时',
            reason: `工具 span 已运行超过 ${options.toolTimeoutMs}ms，尚未收到完成事件。`,
            spanId: span.spanId,
            eventId: null,
            seq: span.seqEnd ?? span.seqStart,
          });
        }
      }
    }

    if (!hasRouteDecision && hasAgentWork) {
      const evidence = events.find((event) => {
        return event.type.startsWith('agent.step.') || event.type.startsWith('tool.call.');
      });
      pushAnomaly({
        anomalyId: `${snapshot.value.runId ?? 'run'}:route_misjudgment:missing`,
        kind: 'route_misjudgment',
        severity: 'warning',
        title: '路由决策缺失',
        reason: '已进入 agent 或工具执行阶段，但没有收到 route_decision 事件。',
        spanId: evidence?.spanId ?? null,
        eventId: evidence?.eventId ?? null,
        seq: evidence?.seq ?? null,
      });
    }

    if (requiresContext && !hasContext) {
      const evidence = events.find((event) => event.type === 'start') ?? events[0];
      pushAnomaly({
        anomalyId: `${snapshot.value.runId ?? 'run'}:context_missing`,
        kind: 'context_missing',
        severity: 'warning',
        title: '上下文注入缺失',
        reason: '当前 run 被标记为需要上下文，但 span meta 中没有 contextPackId 或 summaryBlocks。',
        spanId: evidence?.spanId ?? null,
        eventId: evidence?.eventId ?? null,
        seq: evidence?.seq ?? null,
      });
    }

    if (
      hasAssistantChunk
      && !hasAssistantDone
      && (terminalEvent?.type === 'error' || terminalEvent?.type === 'canceled')
    ) {
      const evidence = events.find((event) => event.type === 'assistant_chunk');
      pushAnomaly({
        anomalyId: `${snapshot.value.runId ?? 'run'}:stream_interrupt`,
        kind: 'stream_interrupt',
        severity: 'critical',
        title: '文本流中断',
        reason: '已收到 assistant_chunk，但运行异常结束前没有收到 assistant_done。',
        spanId: evidence?.spanId ?? null,
        eventId: evidence?.eventId ?? null,
        seq: evidence?.seq ?? null,
      });
    }

    if (!terminalEvent && typeof options.streamIdleMs === 'number' && nowTime !== null) {
      const lastEvent = events.at(-1);
      const lastEventTime = getDateTime(lastEvent?.ts);
      if (lastEventTime !== null && nowTime - lastEventTime >= options.streamIdleMs) {
        pushAnomaly({
          anomalyId: `${snapshot.value.runId ?? 'run'}:stream_incomplete`,
          kind: 'stream_incomplete',
          severity: 'critical',
          title: '运行终态缺失',
          reason: `最后一个事件已超过 ${options.streamIdleMs}ms 未更新，且没有 done/error/canceled 终态事件。`,
          spanId: lastEvent?.spanId ?? null,
          eventId: lastEvent?.eventId ?? null,
          seq: lastEvent?.seq ?? null,
        });
      }
    }

    const severityRank: Record<SpanDerivedAnomalySeverity, number> = {
      critical: 0,
      warning: 1,
      info: 2,
    };

    return anomalies.sort((left, right) => {
      if (severityRank[left.severity] !== severityRank[right.severity]) {
        return severityRank[left.severity] - severityRank[right.severity];
      }

      return (left.seq ?? Number.MAX_SAFE_INTEGER) - (right.seq ?? Number.MAX_SAFE_INTEGER);
    });
  };

  return {
    snapshot: snapshot as Readonly<Ref<SpanStoreSnapshot>>,
    ingestEnvelope,
    ingestEnvelopes,
    replay,
    reset,
    getSpan,
    getEvent,
    listEvents,
    listFilteredEvents,
    getCheckpoint,
    listCheckpoints,
    listChildren,
    listRootSpans,
    listActiveSpans,
    listFilteredSpans,
    listDescendants,
    listSpanPath,
    buildSpanTree,
    getStats,
    listAnomalies,
  };
}
