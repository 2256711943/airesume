import { describe, expect, it } from 'vitest';

import type { SseEventEnvelope } from '../utils/sse';
import { useSpanStore, type SpanStoreEnvelope } from './useSpanStore';

type TestEventName =
  | 'start'
  | 'route_decision'
  | 'tool_start'
  | 'tool_done'
  | 'agent.step.started'
  | 'agent.step.finished'
  | 'tool.call.started'
  | 'tool.call.finished'
  | 'assistant_chunk'
  | 'assistant_done'
  | 'done'
  | 'error'
  | 'checkpoint'
  | 'canceled'
  | 'chunk'
  | 'progress';

function createEnvelope(
  seq: number,
  type: TestEventName,
  options: {
    spanId?: string;
    runId?: string;
    ts?: string;
    payload?: Record<string, unknown>;
  } = {},
): SseEventEnvelope<TestEventName> {
  return {
    id: `evt-${seq}`,
    seq,
    runId: options.runId ?? 'run-1',
    spanId: options.spanId,
    type,
    ts: options.ts ?? `2026-07-25T00:00:0${seq}.000Z`,
    payload: options.payload ?? {},
  };
}

describe('useSpanStore', () => {
  it('dedupes by seq and keeps assistant_chunk to a single span instance', () => {
    const store = useSpanStore<TestEventName>();

    store.ingestEnvelope(createEnvelope(1, 'start', {
      spanId: 'run-span-1',
      payload: {
        requestId: 'req-1',
      },
    }));
    store.ingestEnvelope(createEnvelope(1, 'route_decision', {
      spanId: 'run-span-1',
      payload: {
        routeDecision: {
          selectedAgent: 'planner',
        },
      },
    }));

    expect(store.snapshot.value.lastSeq).toBe(1);
    expect(store.snapshot.value.rootSpanIds).toEqual(['run-span-1']);

    store.ingestEnvelope(createEnvelope(2, 'assistant_chunk', {
      spanId: 'text-span-1',
      payload: {
        parentSpanId: 'run-span-1',
        text: 'hi',
      },
    }));

    const textSpan = store.getSpan('text-span-1');
    expect(textSpan).toBeDefined();
    expect(textSpan?.seqStart).toBe(2);
    expect(textSpan?.seqEnd).toBe(2);
    expect(textSpan?.meta.totalChars).toBe(2);
    expect(textSpan?.meta.chunkCount).toBe(1);

    store.ingestEnvelope(createEnvelope(3, 'assistant_chunk', {
      spanId: 'text-span-1',
      payload: {
        parentSpanId: 'run-span-1',
        text: ' there',
      },
    }));

    expect(store.getSpan('text-span-1')).toBe(textSpan);
    expect(textSpan?.seqEnd).toBe(3);
    expect(textSpan?.meta.totalChars).toBe(8);
    expect(textSpan?.meta.chunkCount).toBe(2);
    expect(Object.keys(store.snapshot.value.eventsById)).toHaveLength(3);
  });

  it('does not duplicate root spans when the same spanId is seen again', () => {
    const store = useSpanStore<TestEventName>();

    store.ingestEnvelope(createEnvelope(1, 'start', {
      spanId: 'run-span-1',
      payload: {
        requestId: 'req-1',
      },
    }));
    store.ingestEnvelope(createEnvelope(2, 'route_decision', {
      spanId: 'run-span-1',
      payload: {
        routeDecision: {
          selectedAgent: 'planner',
        },
      },
    }));
    store.ingestEnvelope(createEnvelope(3, 'done', {
      spanId: 'run-span-1',
      payload: {
        conversationId: 'conv-1',
      },
    }));

    expect(store.snapshot.value.rootSpanIds).toEqual(['run-span-1']);
    expect(store.listRootSpans()).toHaveLength(1);
    expect(store.getSpan('run-span-1')?.status).toBe('succeeded');
    expect(store.snapshot.value.activeSpanIds).toEqual([]);
  });

  it('stores checkpoint spans as terminal immediately and excludes them from activeSpanIds', () => {
    const store = useSpanStore<TestEventName>();

    store.ingestEnvelope(createEnvelope(1, 'start', {
      spanId: 'run-span-1',
    }));
    store.ingestEnvelope(createEnvelope(2, 'checkpoint', {
      payload: {
        checkpointId: 'checkpoint-1',
        parentSpanId: 'run-span-1',
        name: 'route committed',
        status: 'running',
        stepIndex: 1,
      },
    }));

    const checkpoint = store.getSpan('checkpoint-1');
    expect(checkpoint?.kind).toBe('checkpoint');
    expect(checkpoint?.status).toBe('succeeded');
    expect(checkpoint?.endTs).toBe('2026-07-25T00:00:02.000Z');
    expect(checkpoint?.meta.label).toBe('route committed');
    expect(checkpoint?.meta.keyValues).toMatchObject({
      stepIndex: 1,
    });
    expect(store.listCheckpoints('checkpoint-1')).toEqual([
      expect.objectContaining({
        checkpointId: 'checkpoint-1',
        label: 'route committed',
        seq: 2,
      }),
    ]);
    expect(store.snapshot.value.activeSpanIds).toEqual(['run-span-1']);
  });

  it('replay resets existing state before re-ingesting envelopes', () => {
    const store = useSpanStore<TestEventName>();

    store.ingestEnvelope(createEnvelope(1, 'start', {
      spanId: 'old-run',
      runId: 'run-old',
    }));
    store.ingestEnvelope(createEnvelope(2, 'assistant_chunk', {
      spanId: 'old-text',
      runId: 'run-old',
      payload: {
        parentSpanId: 'old-run',
        text: 'old',
      },
    }));

    const replayEnvelopes: SpanStoreEnvelope<TestEventName>[] = [
      createEnvelope(1, 'start', {
        spanId: 'new-run',
        runId: 'run-new',
      }),
      createEnvelope(2, 'agent.step.started', {
        spanId: 'step-1',
        runId: 'run-new',
        payload: {
          parentSpanId: 'new-run',
          name: 'planner',
          agentRunId: 'agent-1',
          startedAt: '2026-07-25T00:00:02.000Z',
          status: 'running',
        },
      }),
    ];

    store.replay(replayEnvelopes);

    expect(store.snapshot.value.runId).toBe('run-new');
    expect(store.snapshot.value.lastSeq).toBe(2);
    expect(store.getSpan('old-run')).toBeUndefined();
    expect(store.getSpan('old-text')).toBeUndefined();
    expect(store.snapshot.value.rootSpanIds).toEqual(['new-run']);
    expect(store.snapshot.value.activeSpanIds).toEqual(['new-run', 'step-1']);
    expect(Object.values(store.snapshot.value.eventsById).every((event) => event.status === 'replay')).toBe(true);
  });

  it('handles terminal tool events even when the started event was not seen', () => {
    const store = useSpanStore<TestEventName>();

    expect(() => {
      store.ingestEnvelope(createEnvelope(1, 'tool.call.finished', {
        spanId: 'tool-1',
        payload: {
          parentSpanId: 'step-1',
          toolName: 'search_docs',
          success: false,
          errorCode: 'TOOL_FAIL',
          finishedAt: '2026-07-25T00:00:01.000Z',
        },
      }));
    }).not.toThrow();

    const toolSpan = store.getSpan('tool-1');
    expect(toolSpan?.kind).toBe('tool');
    expect(toolSpan?.status).toBe('failed');
    expect(toolSpan?.seqEnd).toBe(1);
    expect(store.getEvent('evt-1')).toMatchObject({
      type: 'tool.call.finished',
      sourceType: 'tool.call.finished',
    });
  });

  it('synthesizes run, tool, and text spans for legacy events without explicit span ids', () => {
    const store = useSpanStore<TestEventName>();

    store.ingestEnvelopes([
      createEnvelope(1, 'start'),
      createEnvelope(2, 'tool_start', {
        payload: {
          toolName: 'search_docs',
          startedAt: '2026-07-25T00:00:02.000Z',
        },
      }),
      createEnvelope(3, 'tool_done', {
        payload: {
          toolName: 'search_docs',
          success: true,
          latencyMs: 15,
          startedAt: '2026-07-25T00:00:02.000Z',
          finishedAt: '2026-07-25T00:00:03.000Z',
        },
      }),
      createEnvelope(4, 'assistant_done', {
        payload: {
          content: 'done',
        },
      }),
      createEnvelope(5, 'done', {
        payload: {
          conversationId: 'conv-1',
        },
      }),
    ]);

    const runSpan = store.listRootSpans()[0];
    expect(runSpan?.kind).toBe('run');
    expect(runSpan?.status).toBe('succeeded');

    const descendants = runSpan ? store.listDescendants(runSpan.spanId) : [];
    const toolSpan = descendants.find((span) => span.kind === 'tool');
    const textSpan = descendants.find((span) => span.kind === 'text');

    expect(toolSpan).toMatchObject({
      name: 'search_docs',
      status: 'succeeded',
      parentSpanId: runSpan?.spanId,
      startTs: '2026-07-25T00:00:02.000Z',
      endTs: '2026-07-25T00:00:03.000Z',
    });
    expect(toolSpan?.meta.latencyMs).toBe(15);
    expect(textSpan).toMatchObject({
      name: 'assistant',
      status: 'succeeded',
      parentSpanId: runSpan?.spanId,
    });
    expect(textSpan?.meta.totalChars).toBe(4);
    expect(textSpan?.meta.chunkCount).toBe(0);

    expect(toolSpan ? store.listEvents(toolSpan.spanId) : []).toEqual([
      expect.objectContaining({
        type: 'tool.call.started',
        sourceType: 'tool_start',
      }),
      expect.objectContaining({
        type: 'tool.call.finished',
        sourceType: 'tool_done',
      }),
    ]);
  });

  it('derives tree, path, descendants and active spans from the current snapshot', () => {
    const store = useSpanStore<TestEventName>();

    store.ingestEnvelopes([
      createEnvelope(1, 'start', {
        spanId: 'run-span-1',
        payload: {
          requestId: 'req-1',
        },
      }),
      createEnvelope(2, 'agent.step.started', {
        spanId: 'step-1',
        payload: {
          parentSpanId: 'run-span-1',
          agentRunId: 'agent-1',
          name: 'planner',
          startedAt: '2026-07-25T00:00:02.000Z',
          status: 'running',
        },
      }),
      createEnvelope(3, 'tool.call.finished', {
        spanId: 'tool-1',
        payload: {
          parentSpanId: 'step-1',
          agentRunId: 'agent-1',
          toolName: 'search_docs',
          success: true,
          latencyMs: 15,
          startedAt: '2026-07-25T00:00:03.000Z',
          finishedAt: '2026-07-25T00:00:03.015Z',
        },
      }),
      createEnvelope(4, 'assistant_chunk', {
        spanId: 'text-1',
        payload: {
          parentSpanId: 'step-1',
          text: 'hello',
        },
      }),
      createEnvelope(5, 'checkpoint', {
        spanId: 'checkpoint-1',
        payload: {
          parentSpanId: 'step-1',
          name: 'step snapshot',
          status: 'running',
        },
      }),
    ]);

    expect(store.listActiveSpans().map((span) => span.spanId)).toEqual(['run-span-1', 'step-1', 'text-1']);
    expect(store.listDescendants('run-span-1').map((span) => span.spanId)).toEqual([
      'step-1',
      'tool-1',
      'text-1',
      'checkpoint-1',
    ]);
    expect(store.listSpanPath('tool-1').map((span) => span.spanId)).toEqual(['run-span-1', 'step-1', 'tool-1']);

    const tree = store.buildSpanTree();
    expect(tree.map((node) => node.span.spanId)).toEqual(['run-span-1']);
    expect(tree[0]?.children.map((node) => node.span.spanId)).toEqual(['step-1']);
    expect(tree[0]?.children[0]?.children.map((node) => node.span.spanId)).toEqual([
      'tool-1',
      'text-1',
      'checkpoint-1',
    ]);
    expect(tree[0]?.children[0]?.children[2]?.isActive).toBe(false);
    expect(store.listCheckpoints('checkpoint-1')[0]).toMatchObject({
      checkpointId: 'checkpoint-1',
      label: 'step snapshot',
    });
  });

  it('derives filtered events, filtered spans and run-level stats', () => {
    const store = useSpanStore<TestEventName>();

    store.ingestEnvelopes([
      createEnvelope(1, 'start', {
        spanId: 'run-span-1',
      }),
      createEnvelope(2, 'route_decision', {
        spanId: 'run-span-1',
        payload: {
          routeDecision: {
            selectedAgent: 'planner',
          },
        },
      }),
      createEnvelope(3, 'agent.step.started', {
        spanId: 'step-1',
        payload: {
          parentSpanId: 'run-span-1',
          name: 'planner',
          startedAt: '2026-07-25T00:00:03.000Z',
        },
      }),
      createEnvelope(4, 'tool.call.started', {
        spanId: 'tool-1',
        payload: {
          parentSpanId: 'step-1',
          toolName: 'search_docs',
          startedAt: '2026-07-25T00:00:04.000Z',
        },
      }),
      createEnvelope(5, 'tool.call.finished', {
        spanId: 'tool-1',
        payload: {
          parentSpanId: 'step-1',
          toolName: 'search_docs',
          success: false,
          errorCode: 'TOOL_FAIL',
          errorMessage: 'Search failed',
          startedAt: '2026-07-25T00:00:04.000Z',
          finishedAt: '2026-07-25T00:00:05.000Z',
        },
      }),
      createEnvelope(6, 'assistant_chunk', {
        spanId: 'text-1',
        payload: {
          parentSpanId: 'step-1',
          text: 'partial',
        },
      }),
      createEnvelope(7, 'checkpoint', {
        spanId: 'checkpoint-1',
        payload: {
          parentSpanId: 'step-1',
          name: 'after tool',
        },
      }),
    ]);

    expect(store.listFilteredEvents({
      eventTypes: ['tool.call.finished'],
      onlyErrors: true,
    }).map((event) => event.eventId)).toEqual(['evt-5']);
    expect(store.listFilteredEvents({
      spanKinds: ['tool'],
    }).map((event) => event.eventId)).toEqual(['evt-4', 'evt-5']);
    expect(store.listFilteredEvents({
      onlyCheckpoints: true,
    }).map((event) => event.eventId)).toEqual(['evt-7']);
    expect(store.listFilteredSpans({
      spanKinds: ['tool'],
      statuses: ['failed'],
      onlyErrors: true,
    }).map((span) => span.spanId)).toEqual(['tool-1']);
    expect(store.listFilteredSpans({
      eventTypes: ['assistant_chunk'],
    }).map((span) => span.spanId)).toEqual(['text-1']);

    const stats = store.getStats();
    expect(stats).toMatchObject({
      runId: 'run-1',
      totalEvents: 7,
      activeSpanCount: 3,
      failedSpanCount: 1,
      checkpointCount: 1,
      toolSpanCount: 1,
      failedToolSpanCount: 1,
      textSpanCount: 1,
      assistantChunkEventCount: 1,
      checkpointEventCount: 1,
      firstSeq: 1,
      lastSeq: 7,
      startedAt: '2026-07-25T00:00:01.000Z',
      endedAt: '2026-07-25T00:00:07.000Z',
      lastEventAt: '2026-07-25T00:00:07.000Z',
      durationMs: 6000,
    });
    expect(stats.spanKindCounts).toMatchObject({
      run: 1,
      step: 1,
      tool: 1,
      text: 1,
      checkpoint: 1,
    });
    expect(stats.eventTypeCounts['tool.call.finished']).toBe(1);
  });

  it('derives lightweight anomalies for realtime observability hints', () => {
    const store = useSpanStore<TestEventName>();

    store.ingestEnvelopes([
      createEnvelope(1, 'start', {
        spanId: 'run-span-1',
        payload: {
          contextRequired: true,
        },
      }),
      createEnvelope(2, 'agent.step.started', {
        spanId: 'step-1',
        payload: {
          parentSpanId: 'run-span-1',
          name: 'planner',
          startedAt: '2026-07-25T00:00:02.000Z',
        },
      }),
      createEnvelope(3, 'tool.call.finished', {
        spanId: 'tool-1',
        payload: {
          parentSpanId: 'step-1',
          toolName: 'search_docs',
          success: false,
          errorCode: 'TOOL_FAIL',
          errorMessage: 'Search failed',
          startedAt: '2026-07-25T00:00:03.000Z',
          finishedAt: '2026-07-25T00:00:04.000Z',
        },
      }),
      createEnvelope(4, 'assistant_chunk', {
        spanId: 'text-1',
        payload: {
          parentSpanId: 'step-1',
          text: 'partial',
        },
      }),
      createEnvelope(5, 'error', {
        spanId: 'run-span-1',
        payload: {
          code: 'STREAM_ABORTED',
          message: 'stream interrupted',
        },
      }),
    ]);

    const anomalies = store.listAnomalies({
      requireContext: true,
    });

    expect(anomalies.map((anomaly) => anomaly.kind)).toEqual([
      'stream_interrupt',
      'error_event',
      'context_missing',
      'route_misjudgment',
      'tool_failure',
    ]);
    expect(anomalies.find((anomaly) => anomaly.kind === 'tool_failure')).toMatchObject({
      spanId: 'tool-1',
      seq: 3,
      reason: 'Search failed',
    });
    expect(anomalies.find((anomaly) => anomaly.kind === 'context_missing')).toMatchObject({
      eventId: 'evt-1',
      severity: 'warning',
    });
  });

  it('derives timeout and incomplete stream anomalies only after configured idle windows', () => {
    const store = useSpanStore<TestEventName>();

    store.ingestEnvelopes([
      createEnvelope(1, 'start', {
        spanId: 'run-span-1',
        ts: '2026-07-25T00:00:01.000Z',
      }),
      createEnvelope(2, 'tool.call.started', {
        spanId: 'tool-1',
        ts: '2026-07-25T00:00:02.000Z',
        payload: {
          parentSpanId: 'run-span-1',
          toolName: 'search_docs',
          startedAt: '2026-07-25T00:00:02.000Z',
        },
      }),
    ]);

    expect(store.listAnomalies()).toEqual([
      expect.objectContaining({
        kind: 'route_misjudgment',
      }),
    ]);

    const anomalies = store.listAnomalies({
      now: '2026-07-25T00:00:08.000Z',
      toolTimeoutMs: 5000,
      streamIdleMs: 5000,
    });

    expect(anomalies.map((anomaly) => anomaly.kind)).toEqual([
      'tool_timeout',
      'stream_incomplete',
      'route_misjudgment',
    ]);
  });

  it('records non-span progress events and handles canceled runs', () => {
    const store = useSpanStore<TestEventName>();

    store.ingestEnvelopes([
      createEnvelope(1, 'start', {
        spanId: 'run-span-1',
      }),
      createEnvelope(2, 'progress', {
        payload: {
          progress: 20,
        },
      }),
      createEnvelope(3, 'chunk', {
        payload: {
          text: 'partial',
        },
      }),
      createEnvelope(4, 'canceled', {
        payload: {
          reason: 'user_abort',
        },
      }),
    ]);

    expect(store.listRootSpans()).toHaveLength(1);
    expect(store.getSpan('run-span-1')?.status).toBe('canceled');
    expect(store.listDescendants('run-span-1')).toEqual([]);
    expect(store.getEvent('evt-2')).toMatchObject({
      type: 'progress',
      spanId: null,
    });
    expect(store.getEvent('evt-3')).toMatchObject({
      type: 'chunk',
      spanId: null,
    });
    expect(store.getEvent('evt-4')).toMatchObject({
      type: 'canceled',
      spanId: 'run-span-1',
    });
  });

  it('projects context pack fields onto run and step span meta', () => {
    const store = useSpanStore<TestEventName>();
    const summaryBlocks = [
      {
        blockId: 'block-1',
        type: 'memory',
        layer: 'resume',
        position: 1,
        title: 'Resume Context',
        content: '- Built observability',
        memoryIds: ['mem-1'],
        tokenEstimate: 42,
        truncated: false,
        metadata: {
          memoryCount: 1,
        },
      },
    ];

    store.ingestEnvelopes([
      createEnvelope(1, 'start', {
        spanId: 'run-span-1',
        payload: {
          requestId: 'req-1',
          contextPackId: 'pack-1',
          selectedMemoryIds: ['mem-1', 'mem-2'],
          droppedMemoryIds: ['mem-3'],
          summaryBlocks,
          finalPromptPreview: '## Resume Context',
        },
      }),
      createEnvelope(2, 'agent.step.started', {
        spanId: 'step-1',
        payload: {
          parentSpanId: 'run-span-1',
          agentRunId: 'agent-1',
          name: 'planner',
          startedAt: '2026-07-25T00:00:02.000Z',
          status: 'running',
          promptPreview: '## Resume Context',
          contextPackId: 'pack-1',
          selectedMemoryIds: ['mem-1', 'mem-2'],
          droppedMemoryIds: ['mem-3'],
          summaryBlocks,
          finalPromptPreview: '## Resume Context',
        },
      }),
      createEnvelope(3, 'done', {
        spanId: 'run-span-1',
        payload: {
          conversationId: 'conv-1',
          contextPackId: 'pack-1',
          selectedMemoryIds: ['mem-1', 'mem-2'],
          droppedMemoryIds: ['mem-3'],
          summaryBlocks,
          finalPromptPreview: '## Resume Context',
        },
      }),
    ]);

    expect(store.getSpan('run-span-1')?.meta).toMatchObject({
      contextPackId: 'pack-1',
      selectedMemoryIds: ['mem-1', 'mem-2'],
      droppedMemoryIds: ['mem-3'],
      finalPromptPreview: '## Resume Context',
      summaryBlocks: [
        expect.objectContaining({
          blockId: 'block-1',
          memoryIds: ['mem-1'],
        }),
      ],
    });
    expect(store.getSpan('step-1')?.meta).toMatchObject({
      contextPackId: 'pack-1',
      selectedMemoryIds: ['mem-1', 'mem-2'],
      droppedMemoryIds: ['mem-3'],
      promptPreview: '## Resume Context',
      finalPromptPreview: '## Resume Context',
      summaryBlocks: [
        expect.objectContaining({
          blockId: 'block-1',
          title: 'Resume Context',
        }),
      ],
    });
  });
});
