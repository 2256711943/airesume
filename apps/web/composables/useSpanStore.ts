import { ref, type Ref } from 'vue';

import type { SseEventEnvelope } from '../utils/sse';

export type SpanKind = 'run' | 'step' | 'tool' | 'text' | 'checkpoint';

export type SpanStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled';

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
  getCheckpoint: (checkpointId: string) => SpanCheckpoint | undefined;
  listCheckpoints: (spanId?: string | null) => SpanCheckpoint[];
  listChildren: (parentSpanId?: string | null) => Span[];
  listRootSpans: () => Span[];
  listActiveSpans: () => Span[];
  listDescendants: (spanId: string) => Span[];
  listSpanPath: (spanId: string) => Span[];
  buildSpanTree: (parentSpanId?: string | null) => SpanTreeNode[];
}

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

  const listEvents = (spanId: string | null = null): SpanEvent[] => {
    return snapshot.value.eventIds
      .map((eventId) => getEvent(eventId))
      .filter((event): event is SpanEvent => !!event)
      .filter((event) => event.spanId === spanId)
      .sort(compareSpanEventOrder);
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

  return {
    snapshot: snapshot as Readonly<Ref<SpanStoreSnapshot>>,
    ingestEnvelope,
    ingestEnvelopes,
    replay,
    reset,
    getSpan,
    getEvent,
    listEvents,
    getCheckpoint,
    listCheckpoints,
    listChildren,
    listRootSpans,
    listActiveSpans,
    listDescendants,
    listSpanPath,
    buildSpanTree,
  };
}
