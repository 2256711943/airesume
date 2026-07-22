import { describe, expect, it, vi } from 'vitest';

import {
  createTypewriterFrameSelector,
  splitTextIntoGraphemes,
  useSseRenderEngine,
} from './useSseRenderEngine';

interface QueuedAnimationFrame {
  id: number;
  callback: FrameRequestCallback;
}

interface AnimationFrameHarness {
  cancelAnimationFrame: ReturnType<typeof vi.fn>;
  flushNext: (timestamp: number) => Promise<void>;
  pendingCount: () => number;
  requestAnimationFrame: ReturnType<typeof vi.fn>;
}

interface SelectorTestItem {
  kind: 'text' | 'event';
  value: string;
  terminal?: boolean;
}

function createAnimationFrameHarness(): AnimationFrameHarness {
  let nextId = 1;
  const queuedFrames: QueuedAnimationFrame[] = [];

  const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    const id = nextId;
    nextId += 1;
    queuedFrames.push({ id, callback });
    return id;
  });

  const cancelAnimationFrame = vi.fn((handle: number) => {
    const index = queuedFrames.findIndex((entry) => entry.id === handle);
    if (index >= 0) {
      queuedFrames.splice(index, 1);
    }
  });

  const flushNext = async (timestamp: number) => {
    const nextFrame = queuedFrames.shift();
    if (!nextFrame) {
      return;
    }

    nextFrame.callback(timestamp);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  };

  return {
    cancelAnimationFrame,
    flushNext,
    pendingCount: () => queuedFrames.length,
    requestAnimationFrame,
  };
}

describe('useSseRenderEngine', () => {
  it('drains ingressBuffer atomically', async () => {
    const harness = createAnimationFrameHarness();
    const engine = useSseRenderEngine<number, number>({
      autoStart: false,
      transformIngress: async (value) => value,
      commitFrame: async () => undefined,
      requestAnimationFrame: harness.requestAnimationFrame,
      cancelAnimationFrame: harness.cancelAnimationFrame,
    });

    await engine.ingressBuffer.pushMany([1, 2, 3]);

    const drained = await engine.ingressBuffer.drain();

    expect(drained).toEqual([1, 2, 3]);
    expect(await engine.ingressBuffer.size()).toBe(0);
    expect(engine.pendingIngressCount.value).toBe(0);
  });

  it('uses requestAnimationFrame and keeps overflow events for the next frame', async () => {
    const harness = createAnimationFrameHarness();
    const committedFrames: string[][] = [];
    let virtualTime = 0;

    const engine = useSseRenderEngine<number, string>({
      autoStart: false,
      frameBudgetMs: 8,
      now: () => virtualTime,
      transformIngress: async (value) => {
        virtualTime += 4;
        return `frame-${value}`;
      },
      commitFrame: async (items) => {
        committedFrames.push([...items]);
      },
      requestAnimationFrame: harness.requestAnimationFrame,
      cancelAnimationFrame: harness.cancelAnimationFrame,
    });

    await engine.start();
    await engine.enqueueIngressBatch([1, 2, 3]);

    expect(harness.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(harness.pendingCount()).toBe(1);

    await harness.flushNext(16);

    expect(committedFrames).toEqual([['frame-1', 'frame-2']]);
    expect(engine.pendingIngressCount.value).toBe(1);
    expect(harness.requestAnimationFrame).toHaveBeenCalledTimes(2);
    expect(harness.pendingCount()).toBe(1);

    await harness.flushNext(32);

    expect(committedFrames).toEqual([['frame-1', 'frame-2'], ['frame-3']]);
    expect(engine.pendingIngressCount.value).toBe(0);
    expect(harness.pendingCount()).toBe(0);
  });

  it('splits graphemes without breaking emoji clusters', async () => {
    const graphemes = await splitTextIntoGraphemes('A👨‍👩‍👧‍👦B');

    expect(graphemes).toEqual(['A', '👨‍👩‍👧‍👦', 'B']);
  });

  it('typewriter selector defers remaining text but lets terminal events finish immediately', async () => {
    const selector = createTypewriterFrameSelector<SelectorTestItem>({
      charsPerSecond: 120,
      initialFrameDurationMs: 8,
      getText: async (item) => {
        return item.kind === 'text' ? item.value : null;
      },
      cloneWithText: async (item, text) => {
        return {
          ...item,
          value: text,
        };
      },
      isTerminalItem: async (item) => {
        return item.kind === 'event' && item.terminal === true;
      },
    });

    const selection = await selector.selectFrameItems(
      [
        { kind: 'text', value: 'abcd' },
        { kind: 'event', value: 'done', terminal: true },
      ],
      {
        frameTimestamp: 16,
        frameStartedAt: 0,
        previousFrameTimestamp: null,
        queuedFrameCount: 2,
        remainingIngressCount: 0,
      },
    );

    expect(selection.commitItems).toEqual([
      { kind: 'text', value: 'a' },
      { kind: 'event', value: 'done', terminal: true },
    ]);
    expect(selection.deferredItems ?? []).toEqual([]);
  });
});
