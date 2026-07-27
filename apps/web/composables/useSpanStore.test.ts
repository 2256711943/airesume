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
  | 'tool.call.finished'
  | 'assistant_chunk'
  | 'assistant_done'
  | 'done'
  | 'error'
  | 'checkpoint';

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
    expect(textSpan?.meta.textLength).toBe(2);

    store.ingestEnvelope(createEnvelope(3, 'assistant_chunk', {
      spanId: 'text-span-1',
      payload: {
        parentSpanId: 'run-span-1',
        text: ' there',
      },
    }));

    expect(store.getSpan('text-span-1')).toBe(textSpan);
    expect(textSpan?.seqEnd).toBe(3);
    expect(textSpan?.meta.textLength).toBe(2);
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
      spanId: 'checkpoint-1',
      payload: {
        parentSpanId: 'run-span-1',
        name: 'route committed',
        status: 'running',
      },
    }));

    const checkpoint = store.getSpan('checkpoint-1');
    expect(checkpoint?.kind).toBe('checkpoint');
    expect(checkpoint?.status).toBe('succeeded');
    expect(checkpoint?.endTs).toBe('2026-07-25T00:00:02.000Z');
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
  });
});
