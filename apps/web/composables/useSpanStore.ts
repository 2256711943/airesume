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

export interface SpanStoreSnapshot {
  runId: string | null;
  spansById: Record<string, Span>;
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

function getStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
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

export function useSpanStore<TType extends string = string>(): SpanStore<TType> {
  const snapshot = ref<SpanStoreSnapshot>(createSnapshot());

  const getSpan = (spanId: string): Span | undefined => {
    return snapshot.value.spansById[spanId];
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
    envelope: SpanStoreEnvelope<TType>;
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
    envelope: SpanStoreEnvelope<TType>;
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

  const ingestEnvelope = (envelope: SpanStoreEnvelope<TType>): void => {
    if (envelope.seq <= snapshot.value.lastSeq) {
      return;
    }

    snapshot.value.lastSeq = envelope.seq;
    if (!snapshot.value.runId && envelope.runId) {
      snapshot.value.runId = envelope.runId;
    }

    const payload = isRecord(envelope.payload) ? envelope.payload : {};

    switch (envelope.type) {
      case 'start': {
        const span = ensureSpan({
          envelope,
          kind: 'run',
          parentSpanId: null,
          name: getString(payload, 'requestId') ?? envelope.runId ?? 'run',
          status: 'running',
          startTs: envelope.ts,
          endTs: null,
        });

        if (span) {
          updateSpan(span.spanId, (target) => {
            target.status = 'running';
            target.seqEnd = envelope.seq;
            target.endTs = null;
            setMetaField(target.meta, 'requestId', getString(payload, 'requestId'));
            setMetaField(target.meta, 'routeDecisionStarted', payload.routeDecisionStarted);
          });
        }
        break;
      }
      case 'route_decision': {
        if (envelope.spanId) {
          updateLifecycleSpan({
            envelope,
            kind: 'run',
            fallbackName: envelope.runId || 'run',
            fallbackStatus: 'running',
            defaultParentSpanId: null,
            startTs: envelope.ts,
            endTs: null,
          });
          updateSpan(envelope.spanId, (target) => {
            setMetaField(target.meta, 'routeDecision', payload.routeDecision);
            target.seqEnd = envelope.seq;
          });
        }
        break;
      }
      case 'agent.step.started': {
        const span = updateLifecycleSpan({
          envelope,
          kind: 'step',
          fallbackName: 'step',
          fallbackStatus: 'running',
          defaultParentSpanId: null,
          startTs: getString(payload, 'startedAt') ?? envelope.ts,
          endTs: null,
        });

        if (span) {
          updateSpan(span.spanId, (target) => {
            setMetaField(target.meta, 'agentRunId', getString(payload, 'agentRunId'));
            appendMessageIds(target, payload);
          });
        }
        break;
      }
      case 'agent.step.finished': {
        const span = updateLifecycleSpan({
          envelope,
          kind: 'step',
          fallbackName: 'step',
          fallbackStatus: getString(payload, 'errorCode') ? 'failed' : 'succeeded',
          defaultParentSpanId: null,
          startTs: getString(payload, 'startedAt') ?? envelope.ts,
          endTs: getString(payload, 'finishedAt') ?? envelope.ts,
        });

        if (span) {
          updateSpan(span.spanId, (target) => {
            setMetaField(target.meta, 'agentRunId', getString(payload, 'agentRunId'));
            setMetaField(target.meta, 'errorCode', getString(payload, 'errorCode'));
            setMetaField(target.meta, 'errorMessage', getString(payload, 'errorMessage'));
            appendMessageIds(target, payload);
          });
        }
        break;
      }
      case 'tool_start':
      case 'tool.call.started': {
        const span = updateLifecycleSpan({
          envelope,
          kind: 'tool',
          fallbackName: getString(payload, 'toolName') ?? 'tool',
          fallbackStatus: 'running',
          defaultParentSpanId: null,
          startTs: getString(payload, 'startedAt') ?? envelope.ts,
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
      case 'tool_done':
      case 'tool.call.finished': {
        const span = updateLifecycleSpan({
          envelope,
          kind: 'tool',
          fallbackName: getString(payload, 'toolName') ?? 'tool',
          fallbackStatus: payload.success === false ? 'failed' : 'succeeded',
          defaultParentSpanId: null,
          startTs: getString(payload, 'startedAt') ?? envelope.ts,
          endTs: getString(payload, 'finishedAt') ?? envelope.ts,
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
        const spanId = envelope.spanId?.trim();
        if (!spanId) {
          break;
        }

        const existing = getSpan(spanId);
        if (!existing) {
          const created = addSpan({
            spanId,
            parentSpanId: getString(payload, 'parentSpanId') ?? null,
            runId: envelope.runId,
            kind: 'text',
            name: getString(payload, 'name') ?? 'assistant',
            status: 'running',
            startTs: envelope.ts,
            endTs: null,
            seqStart: envelope.seq,
            seqEnd: envelope.seq,
            messageIds: [],
            meta: {},
          });

          updateSpan(created.spanId, (target) => {
            setMetaField(target.meta, 'chunkCount', 1);
            setMetaField(target.meta, 'textLength', typeof payload.text === 'string' ? payload.text.length : 0);
            appendMessageIds(target, payload);
          });
          break;
        }

        updateSpan(spanId, (target) => {
          target.seqEnd = envelope.seq;
        });
        break;
      }
      case 'assistant_done': {
        const span = updateLifecycleSpan({
          envelope,
          kind: 'text',
          fallbackName: 'assistant',
          fallbackStatus: 'succeeded',
          defaultParentSpanId: getString(payload, 'parentSpanId') ?? null,
          startTs: envelope.ts,
          endTs: envelope.ts,
        });

        if (span) {
          updateSpan(span.spanId, (target) => {
            setMetaField(target.meta, 'content', payload.content);
            setMetaField(target.meta, 'routeDecision', payload.routeDecision);
            setMetaField(target.meta, 'toolCalls', payload.toolCalls);
            appendMessageIds(target, payload);
          });
        }
        break;
      }
      case 'checkpoint': {
        const span = ensureSpan({
          envelope,
          kind: 'checkpoint',
          parentSpanId: getString(payload, 'parentSpanId') ?? null,
          name: getString(payload, 'name') ?? 'checkpoint',
          status: normalizeCheckpointStatus(payload.status),
          startTs: envelope.ts,
          endTs: envelope.ts,
        });

        if (span) {
          updateSpan(span.spanId, (target) => {
            target.status = normalizeCheckpointStatus(payload.status);
            target.endTs = envelope.ts;
            target.seqEnd = envelope.seq;
            appendMessageIds(target, payload);
            for (const [key, value] of Object.entries(payload)) {
              if (key === 'name' || key === 'status' || key === 'parentSpanId') {
                continue;
              }
              setMetaField(target.meta, key, value);
            }
          });
        }
        break;
      }
      case 'done': {
        const targetSpanId = envelope.spanId?.trim() || snapshot.value.rootSpanIds[0];
        if (targetSpanId) {
          const span = ensureSpan({
            envelope: {
              ...envelope,
              spanId: targetSpanId,
            },
            kind: 'run',
            parentSpanId: null,
            name: envelope.runId || 'run',
            status: 'succeeded',
            startTs: envelope.ts,
            endTs: envelope.ts,
          });

          if (span) {
            updateSpan(span.spanId, (target) => {
              target.status = 'succeeded';
              target.endTs = envelope.ts;
              target.seqEnd = envelope.seq;
              setMetaField(target.meta, 'conversationId', getString(payload, 'conversationId'));
              setMetaField(target.meta, 'agentRunId', getString(payload, 'agentRunId'));
              setMetaField(target.meta, 'createdConversation', payload.createdConversation);
              setMetaField(target.meta, 'routeDecision', payload.routeDecision);
            });
          }
        }
        break;
      }
      case 'error': {
        const targetSpanId = envelope.spanId?.trim() || snapshot.value.rootSpanIds[0];
        if (!targetSpanId) {
          break;
        }

        const span = ensureSpan({
          envelope: {
            ...envelope,
            spanId: targetSpanId,
          },
          kind: targetSpanId === snapshot.value.rootSpanIds[0] ? 'run' : 'step',
          parentSpanId: null,
          name: envelope.runId || 'run',
          status: 'failed',
          startTs: envelope.ts,
          endTs: envelope.ts,
        });

        if (span) {
          updateSpan(span.spanId, (target) => {
            target.status = 'failed';
            target.endTs = envelope.ts;
            target.seqEnd = envelope.seq;
            setMetaField(target.meta, 'code', getString(payload, 'code'));
            setMetaField(target.meta, 'message', getString(payload, 'message'));
            setMetaField(target.meta, 'requestId', getString(payload, 'requestId'));
          });
        }
        break;
      }
    }
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
  };

  const replay = (envelopes: readonly SpanStoreEnvelope<TType>[]): void => {
    reset(envelopes[0]?.runId);
    ingestEnvelopes(envelopes);
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
    listChildren,
    listRootSpans,
    listActiveSpans,
    listDescendants,
    listSpanPath,
    buildSpanTree,
  };
}
