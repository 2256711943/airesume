import { describe, expect, it, vi, type Mock } from 'vitest';

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
  cancelAnimationFrame: Mock<(handle: number) => void>;
  flushNext: (timestamp: number) => Promise<void>;
  pendingCount: () => number;
  requestAnimationFrame: Mock<(callback: FrameRequestCallback) => number>;
}

interface SelectorTestItem {
  kind: 'text' | 'event';
  value: string;
  terminal?: boolean;
}

function createAnimationFrameHarness(): AnimationFrameHarness {
  let nextId = 1;
  const queuedFrames: QueuedAnimationFrame[] = [];

  const requestAnimationFrame = vi.fn<(callback: FrameRequestCallback) => number>((callback) => {
    const id = nextId;
    nextId += 1;
    queuedFrames.push({ id, callback });
    return id;
  });

  const cancelAnimationFrame = vi.fn<(handle: number) => void>((handle) => {
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

  it('shrinks ingress budget when monitoring pressure is high', async () => {
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

    await engine.enqueueIngressBatch(Array.from({ length: 13 }, (_, index) => index + 1));
    virtualTime = 2000;
    await engine.enqueueIngress(14);

    expect(engine.monitoring.value.pressureLevel).toBe('high');

    await engine.start();
    await harness.flushNext(16);

    expect(committedFrames).toEqual([['frame-1']]);
    expect(engine.pendingIngressCount.value).toBe(13);
  });

  it('does not merge frame items before pressure reaches high', async () => {
    const harness = createAnimationFrameHarness();
    const committedFrames: string[][] = [];
    const mergeFrameItems = vi.fn(async (previous: string, next: string) => `${previous}|${next}`);

    const engine = useSseRenderEngine<number, string>({
      autoStart: false,
      mergeFrameItems,
      classifyIngressPhase: async () => 'bulk',
      transformIngress: async (value) => `frame-${value}`,
      commitFrame: async (items) => {
        committedFrames.push([...items]);
      },
      requestAnimationFrame: harness.requestAnimationFrame,
      cancelAnimationFrame: harness.cancelAnimationFrame,
    });

    await engine.enqueueIngressBatch(Array.from({ length: 10 }, (_, index) => index + 1));

    expect(engine.monitoring.value.pressureLevel).toBe('busy');

    await engine.start();
    await harness.flushNext(16);

    expect(mergeFrameItems).not.toHaveBeenCalled();
    expect(committedFrames).toEqual([[
      'frame-1',
      'frame-2',
      'frame-3',
      'frame-4',
      'frame-5',
      'frame-6',
      'frame-7',
      'frame-8',
      'frame-9',
      'frame-10',
    ]]);
  });

  it('merges frame items when pressure reaches high', async () => {
    const harness = createAnimationFrameHarness();
    const committedFrames: string[][] = [];
    let virtualTime = 0;
    const mergeFrameItems = vi.fn(async (previous: string, next: string) => `${previous}|${next}`);

    const engine = useSseRenderEngine<number, string>({
      autoStart: false,
      now: () => virtualTime,
      mergeFrameItems,
      classifyIngressPhase: async () => 'bulk',
      transformIngress: async (value) => `frame-${value}`,
      commitFrame: async (items) => {
        committedFrames.push([...items]);
      },
      requestAnimationFrame: harness.requestAnimationFrame,
      cancelAnimationFrame: harness.cancelAnimationFrame,
    });

    await engine.enqueueIngressBatch(Array.from({ length: 13 }, (_, index) => index + 1));
    virtualTime = 2000;
    await engine.enqueueIngress(14);

    expect(engine.monitoring.value.pressureLevel).toBe('high');

    await engine.start();
    await harness.flushNext(16);

    expect(mergeFrameItems).toHaveBeenCalledTimes(13);
    expect(committedFrames).toEqual([[
      'frame-1|frame-2|frame-3|frame-4|frame-5|frame-6|frame-7|frame-8|frame-9|frame-10|frame-11|frame-12|frame-13|frame-14',
    ]]);
  });

  it('tracks monitoring snapshots for phase backlog and committed frames', async () => {
    const harness = createAnimationFrameHarness();
    const committedFrames: string[][] = [];
    let virtualTime = 0;

    const engine = useSseRenderEngine<number, string>({
      autoStart: false,
      frameBudgetMs: 8,
      now: () => virtualTime,
      classifyIngressPhase: async (value) => (value === 1 ? 'state' : 'bulk'),
      transformIngress: async (value) => {
        virtualTime += 1;
        return `frame-${value}`;
      },
      commitFrame: async (items) => {
        committedFrames.push([...items]);
      },
      requestAnimationFrame: harness.requestAnimationFrame,
      cancelAnimationFrame: harness.cancelAnimationFrame,
    });

    await engine.enqueueIngressBatch([1, 2]);

    expect(engine.monitoring.value.pendingIngressCount).toBe(2);
    expect(engine.monitoring.value.backlog.ingress.state).toBe(1);
    expect(engine.monitoring.value.backlog.ingress.bulk).toBe(1);
    expect(engine.monitoring.value.pressureLevel).not.toBe('idle');

    await engine.start();
    await harness.flushNext(16);

    expect(committedFrames).toEqual([['frame-1', 'frame-2']]);
    expect(engine.monitoring.value.frameCount).toBe(1);
    expect(engine.monitoring.value.totalCommittedItemCount).toBe(2);
    expect(engine.monitoring.value.lastCommittedItemCount).toBe(2);
    expect(engine.monitoring.value.pendingIngressCount).toBe(0);
    expect(engine.monitoring.value.pendingFrameCount).toBe(0);
    expect(engine.monitoring.value.backlog.total.total).toBe(0);
    expect(engine.monitoring.value.pressureLevel).toBe('idle');
  });

  it('drops decorative frame items before commit when pressure stays high', async () => {
    const harness = createAnimationFrameHarness();
    const committedFrames: string[][] = [];
    let virtualTime = 0;

    const engine = useSseRenderEngine<number, string>({
      autoStart: false,
      frameBudgetMs: 8,
      now: () => virtualTime,
      classifyIngressPhase: async (value) => (value === 21 ? 'state' : 'decorative'),
      transformIngress: async (value) => `frame-${value}`,
      commitFrame: async (items) => {
        committedFrames.push([...items]);
      },
      requestAnimationFrame: harness.requestAnimationFrame,
      cancelAnimationFrame: harness.cancelAnimationFrame,
    });

    await engine.enqueueIngressBatch(Array.from({ length: 20 }, (_, index) => index + 1));
    virtualTime = 2000;
    await engine.enqueueIngress(21);

    expect(engine.monitoring.value.pressureLevel).toBe('high');

    await engine.start();
    await harness.flushNext(16);

    expect(committedFrames).toEqual([['frame-21']]);
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
        pressureLevel: 'normal',
      },
    );

    expect(selection.commitItems).toEqual([
      { kind: 'text', value: 'a' },
      { kind: 'event', value: 'done', terminal: true },
    ]);
    expect(selection.deferredItems ?? []).toEqual([]);
  });

  it('typewriter selector supports pressure-aware degradation through onDegrade', async () => {
    const onDegrade = vi.fn((pressureLevel: string, currentCharsPerSecond: number) => {
      if (pressureLevel === 'busy') return currentCharsPerSecond * 0.7;
      if (pressureLevel === 'high') return currentCharsPerSecond * 0.4;
      if (pressureLevel === 'critical') return currentCharsPerSecond * 0.15;
      return currentCharsPerSecond;
    });
    const selector = createTypewriterFrameSelector<SelectorTestItem>({
      charsPerSecond: 100,
      initialFrameDurationMs: 1000,
      onDegrade,
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
        { kind: 'text', value: 'abcdefghijklmnopqrst' },
      ],
      {
        frameTimestamp: 1000,
        frameStartedAt: 0,
        previousFrameTimestamp: null,
        queuedFrameCount: 1,
        remainingIngressCount: 0,
        pressureLevel: 'critical',
      },
    );

    expect(onDegrade).toHaveBeenCalledWith('critical', 100);
    expect(selection.commitItems).toEqual([
      { kind: 'text', value: 'abcdefghijklmno' },
    ]);
    expect(selection.deferredItems ?? []).toEqual([
      { kind: 'text', value: 'pqrst' },
    ]);
  });
});
