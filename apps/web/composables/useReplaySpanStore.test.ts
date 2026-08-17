import { describe, expect, it } from 'vitest';

import {
  useReplaySpanStore,
  type ObservabilityRunReplayResponse,
  type PersistedObservabilityEvent,
} from './useReplaySpanStore';

function createEvent(
  overrides: Partial<PersistedObservabilityEvent> & {
    eventId: string;
    seq: number;
  },
): PersistedObservabilityEvent {
  return {
    runId: 'run-1',
    conversationId: null,
    userId: null,
    agentRunId: null,
    spanId: null,
    type: 'chunk',
    status: 'normal',
    ts: new Date(2026, 0, 1, 0, 0, overrides.seq).toISOString(),
    createdAt: new Date(2026, 0, 1, 0, 0, overrides.seq).toISOString(),
    payload: {},
    ...overrides,
  };
}

function buildReplayPackage(): ObservabilityRunReplayResponse {
  const events: PersistedObservabilityEvent[] = [
    createEvent({
      eventId: 'evt-1',
      seq: 1,
      type: 'start',
      spanId: 'run-1',
      payload: { requestId: 'req-1' },
    }),
    createEvent({
      eventId: 'evt-2',
      seq: 2,
      type: 'route_decision',
      spanId: 'run-1',
      payload: {
        routeDecision: { intent: 'resume_generation', selectedAgent: 'resume_workbench' },
      },
    }),
    createEvent({
      eventId: 'evt-3',
      seq: 3,
      type: 'tool.call.started',
      spanId: 'run-1:tool:1',
      payload: { toolName: 'web_search' },
    }),
    createEvent({
      eventId: 'evt-4',
      seq: 4,
      type: 'tool.call.finished',
      spanId: 'run-1:tool:1',
      payload: { toolName: 'web_search', success: true, latencyMs: 12 },
    }),
    createEvent({
      eventId: 'evt-5',
      seq: 5,
      type: 'assistant_chunk',
      spanId: 'run-1:text:1',
      payload: { text: 'hello' },
    }),
    createEvent({
      eventId: 'evt-6',
      seq: 6,
      type: 'assistant_done',
      spanId: 'run-1:text:1',
      payload: { content: 'hello' },
    }),
    createEvent({
      eventId: 'evt-7',
      seq: 7,
      type: 'done',
      spanId: 'run-1',
      payload: { conversationId: 'conv-1' },
    }),
  ];

  return {
    runId: 'run-1',
    summary: {
      runId: 'run-1',
      conversationId: 'conv-1',
      status: 'succeeded',
      startedAt: events[0].ts,
      endedAt: events[6].ts,
      eventCount: events.length,
      firstSeq: 1,
      lastSeq: 7,
      agentRunId: null,
      contextPackId: null,
      routeDecision: {
        intent: 'resume_generation',
        selectedAgent: 'resume_workbench',
      },
    },
    events,
    checkpoints: [
      {
        checkpointId: 'cp-1',
        runId: 'run-1',
        spanId: 'run-1',
        seq: 3,
        label: 'tool started',
        keyValues: {},
        createdAt: events[2].ts,
      },
    ],
    diagnostics: [
      {
        issueId: 'issue-1',
        runId: 'run-1',
        spanId: null,
        category: 'other',
        severity: 'info',
        title: '提示',
        reason: '原因',
        evidence: [],
        suggestion: null,
        createdAt: events[6].ts,
      },
    ],
  };
}

describe('useReplaySpanStore', () => {
  it('loads a replay package and rebuilds the full snapshot at the end', () => {
    const store = useReplaySpanStore();
    store.loadReplayPackage(buildReplayPackage());

    expect(store.runId.value).toBe('run-1');
    expect(store.activeSeq.value).toBe(7);
    expect(store.firstSeq.value).toBe(1);
    expect(store.lastSeq.value).toBe(7);
    expect(store.hasRun.value).toBe(true);
    expect(store.progress.value).toBe(100);
    expect(store.events.value).toHaveLength(7);
    expect(store.checkpoints.value).toHaveLength(1);
    expect(store.diagnostics.value).toHaveLength(1);
    expect(store.summary.value?.status).toBe('succeeded');

    const stats = store.getStats();
    expect(stats.totalEvents).toBe(7);
    expect(stats.totalSpans).toBe(3); // run + tool + text
    const root = store.buildSpanTree()[0]?.span;
    expect(root?.kind).toBe('run');
    expect(root?.status).toBe('succeeded');
  });

  it('seekToSeq rebuilds the snapshot up to the target seq', () => {
    const store = useReplaySpanStore();
    store.loadReplayPackage(buildReplayPackage());

    store.seekToSeq(4);

    expect(store.activeSeq.value).toBe(4);
    expect(store.snapshot.value.lastSeq).toBe(4);
    expect(store.listFilteredEvents()).toHaveLength(4);
    expect(store.getStats().totalSpans).toBe(2); // run + tool
    expect(store.hasNext()).toBe(true);
    expect(store.hasPrev()).toBe(true);
  });

  it('seekToSeq clamps out-of-range targets to first/last seq', () => {
    const store = useReplaySpanStore();
    store.loadReplayPackage(buildReplayPackage());

    store.seekToSeq(999);
    expect(store.activeSeq.value).toBe(7);

    store.seekToSeq(-1);
    expect(store.activeSeq.value).toBe(1);
  });

  it('getNextSeq / getPrevSeq traverse event boundaries correctly', () => {
    const store = useReplaySpanStore();
    store.loadReplayPackage(buildReplayPackage());

    expect(store.getNextSeq(4)).toBe(5);
    expect(store.getNextSeq(7)).toBeNull();
    expect(store.getPrevSeq(4)).toBe(3);
    expect(store.getPrevSeq(1)).toBeNull();
  });

  it('seekToFirst / seekToEnd move to boundaries and update hasPrev/hasNext', () => {
    const store = useReplaySpanStore();
    store.loadReplayPackage(buildReplayPackage());

    store.seekToFirst();
    expect(store.activeSeq.value).toBe(1);
    expect(store.hasPrev()).toBe(false);
    expect(store.hasNext()).toBe(true);
    expect(store.progress.value).toBe(0);

    store.seekToEnd();
    expect(store.activeSeq.value).toBe(7);
    expect(store.hasPrev()).toBe(true);
    expect(store.hasNext()).toBe(false);
  });

  it('reset clears all replay state', () => {
    const store = useReplaySpanStore();
    store.loadReplayPackage(buildReplayPackage());
    store.seekToFirst();

    store.reset();

    expect(store.runId.value).toBeNull();
    expect(store.hasRun.value).toBe(false);
    expect(store.events.value).toHaveLength(0);
    expect(store.activeSeq.value).toBe(0);
    expect(store.buildSpanTree()).toHaveLength(0);
  });

  it('handles an empty replay package without throwing', () => {
    const store = useReplaySpanStore();
    store.loadReplayPackage({
      runId: 'empty-run',
      summary: {
        runId: 'empty-run',
        conversationId: null,
        status: 'pending',
        startedAt: null,
        endedAt: null,
        eventCount: 0,
        firstSeq: null,
        lastSeq: null,
        agentRunId: null,
        contextPackId: null,
        routeDecision: null,
      },
      events: [],
      checkpoints: [],
      diagnostics: [],
    });

    expect(store.hasRun.value).toBe(false);
    expect(store.activeSeq.value).toBe(0);
    expect(store.progress.value).toBe(0);
    expect(store.listFilteredEvents()).toHaveLength(0);
  });

  it('keeps events sorted by seq regardless of input order', () => {
    const store = useReplaySpanStore();
    const pkg = buildReplayPackage();
    pkg.events = [...pkg.events].reverse();

    store.loadReplayPackage(pkg);

    expect(store.events.value.map((event) => event.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(store.listFilteredEvents().map((event) => event.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });
});
