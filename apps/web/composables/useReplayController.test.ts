import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useApiFetch } from "./useApiFetch";
import { useReplayController } from "./useReplayController";
import {
  useReplaySpanStore,
  type ObservabilityRunReplayResponse,
  type PersistedObservabilityEvent,
} from "./useReplaySpanStore";

function createEvent(
  overrides: Partial<PersistedObservabilityEvent> & {
    eventId: string;
    seq: number;
  },
): PersistedObservabilityEvent {
  return {
    runId: "run-1",
    conversationId: null,
    userId: null,
    agentRunId: null,
    spanId: null,
    type: "chunk",
    status: "normal",
    ts: new Date(2026, 0, 1, 0, 0, overrides.seq).toISOString(),
    createdAt: new Date(2026, 0, 1, 0, 0, overrides.seq).toISOString(),
    payload: {},
    ...overrides,
  };
}

function buildReplayPackage(): ObservabilityRunReplayResponse {
  const events: PersistedObservabilityEvent[] = [
    createEvent({ eventId: "evt-1", seq: 1, type: "start", spanId: "run-1" }),
    createEvent({
      eventId: "evt-2",
      seq: 2,
      type: "route_decision",
      spanId: "run-1",
      payload: { routeDecision: { selectedAgent: "resume_workbench" } },
    }),
    createEvent({
      eventId: "evt-3",
      seq: 3,
      type: "tool.call.started",
      spanId: "run-1:tool:1",
      payload: { toolName: "web_search" },
    }),
    createEvent({
      eventId: "evt-4",
      seq: 4,
      type: "tool.call.finished",
      spanId: "run-1:tool:1",
      payload: { toolName: "web_search", success: true },
    }),
    createEvent({
      eventId: "evt-5",
      seq: 5,
      type: "assistant_chunk",
      spanId: "run-1:text:1",
      payload: { text: "hello" },
    }),
    createEvent({
      eventId: "evt-6",
      seq: 6,
      type: "assistant_done",
      spanId: "run-1:text:1",
      payload: { content: "hello" },
    }),
    createEvent({ eventId: "evt-7", seq: 7, type: "done", spanId: "run-1" }),
  ];

  return {
    runId: "run-1",
    summary: {
      runId: "run-1",
      conversationId: null,
      status: "succeeded",
      startedAt: events[0]!.ts,
      endedAt: events[6]!.ts,
      eventCount: events.length,
      firstSeq: 1,
      lastSeq: 7,
      agentRunId: null,
      contextPackId: null,
      routeDecision: null,
    },
    events,
    checkpoints: [
      {
        checkpointId: "cp-1",
        runId: "run-1",
        spanId: "run-1",
        seq: 3,
        label: "tool started",
        keyValues: {},
        createdAt: events[2]!.ts,
      },
    ],
    diagnostics: [],
  };
}

interface ControllerHarness {
  store: ReturnType<typeof useReplaySpanStore>;
  controller: ReturnType<typeof useReplayController>;
  apiFetch: ReturnType<typeof vi.fn>;
}

function createHarness(): ControllerHarness {
  const store = useReplaySpanStore();
  const apiFetch = vi.fn();
  const controller = useReplayController(store, {
    apiFetch: apiFetch as unknown as typeof useApiFetch,
  });
  return { store, controller, apiFetch };
}

describe("useReplayController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loadConversationRuns fetches and stores the run list", async () => {
    const { controller, apiFetch } = createHarness();
    apiFetch.mockResolvedValue({
      conversationId: "conv-1",
      count: 1,
      runs: [
        {
          runId: "run-1",
          conversationId: "conv-1",
          status: "succeeded",
          startedAt: "2026-01-01T00:00:01.000Z",
          endedAt: "2026-01-01T00:00:07.000Z",
          eventCount: 7,
          lastSeq: 7,
          agentRunId: null,
        },
      ],
    });

    await controller.loadConversationRuns("conv-1");

    expect(apiFetch).toHaveBeenCalledWith(
      "/observability/conversations/conv-1/runs",
    );
    expect(controller.runs.value).toHaveLength(1);
    expect(controller.runsLoading.value).toBe(false);
    expect(controller.runError.value).toBeNull();
  });

  it("loadRun loads the replay package and parks at the first event in paused mode", async () => {
    const { store, controller, apiFetch } = createHarness();
    apiFetch.mockResolvedValue(buildReplayPackage());

    await controller.loadRun("run-1");

    expect(apiFetch).toHaveBeenCalledWith("/observability/runs/run-1/replay");
    expect(store.runId.value).toBe("run-1");
    expect(controller.mode.value).toBe("paused");
    expect(controller.cursorSeq.value).toBe(1);
    expect(controller.hasPrev.value).toBe(false);
    expect(controller.hasNext.value).toBe(true);
  });

  it("play advances the cursor on the configured interval and completes at the end", async () => {
    const { store, controller, apiFetch } = createHarness();
    apiFetch.mockResolvedValue(buildReplayPackage());
    await controller.loadRun("run-1");

    controller.play();
    expect(controller.mode.value).toBe("playing");

    vi.advanceTimersByTime(500); // speed=2 → 500ms 每步
    expect(store.activeSeq.value).toBe(2);
    expect(controller.cursorSeq.value).toBe(2);

    vi.advanceTimersByTime(500 * 6); // 剩余 5 步 + 1 次终态判定
    expect(controller.mode.value).toBe("completed");
    expect(store.activeSeq.value).toBe(7);
  });

  it("pause stops automatic advancement", async () => {
    const { controller, apiFetch } = createHarness();
    apiFetch.mockResolvedValue(buildReplayPackage());
    await controller.loadRun("run-1");

    controller.play();
    vi.advanceTimersByTime(500);
    controller.pause();
    expect(controller.mode.value).toBe("paused");

    vi.advanceTimersByTime(500 * 10);
    expect(controller.cursorSeq.value).toBe(2);
  });

  it("stepForward / stepBackward move one event and exit completed state", async () => {
    const { controller, apiFetch } = createHarness();
    apiFetch.mockResolvedValue(buildReplayPackage());
    await controller.loadRun("run-1");

    controller.stepForward();
    expect(controller.cursorSeq.value).toBe(2);

    controller.stepBackward();
    expect(controller.cursorSeq.value).toBe(1);
  });

  it("fastForward jumps to the end and marks completed", async () => {
    const { controller, apiFetch } = createHarness();
    apiFetch.mockResolvedValue(buildReplayPackage());
    await controller.loadRun("run-1");

    controller.fastForward();

    expect(controller.cursorSeq.value).toBe(7);
    expect(controller.mode.value).toBe("completed");
  });

  it("jumpToCheckpoint seeks to the checkpoint seq and records selection", async () => {
    const { controller, apiFetch } = createHarness();
    apiFetch.mockResolvedValue(buildReplayPackage());
    await controller.loadRun("run-1");

    controller.jumpToCheckpoint("cp-1");

    expect(controller.cursorSeq.value).toBe(3);
    expect(controller.selectedCheckpointId.value).toBe("cp-1");
    expect(controller.mode.value).toBe("paused");
  });

  it("jumpToSeq clamps out-of-range seq and resets to paused", async () => {
    const { controller, apiFetch } = createHarness();
    apiFetch.mockResolvedValue(buildReplayPackage());
    await controller.loadRun("run-1");

    controller.jumpToSeq(999);
    expect(controller.cursorSeq.value).toBe(7);
    expect(controller.mode.value).toBe("paused");
  });

  it("reset returns to the first event and clears checkpoint selection", async () => {
    const { controller, apiFetch } = createHarness();
    apiFetch.mockResolvedValue(buildReplayPackage());
    await controller.loadRun("run-1");
    controller.jumpToCheckpoint("cp-1");

    controller.reset();

    expect(controller.cursorSeq.value).toBe(1);
    expect(controller.selectedCheckpointId.value).toBeNull();
    expect(controller.mode.value).toBe("paused");
  });

  it("setSpeed updates speed and restarts the timer when playing", async () => {
    const { store, controller, apiFetch } = createHarness();
    apiFetch.mockResolvedValue(buildReplayPackage());
    await controller.loadRun("run-1");

    controller.setSpeed(10);
    expect(controller.speed.value).toBe(10);

    controller.play();
    vi.advanceTimersByTime(100); // 1000/10 = 100ms 每步
    expect(store.activeSeq.value).toBe(2);
  });

  it("propagates load errors to runError and resets to idle", async () => {
    const { controller, apiFetch } = createHarness();
    apiFetch.mockRejectedValue(new Error("network down"));

    await controller.loadRun("run-1");

    expect(controller.mode.value).toBe("idle");
    expect(controller.runError.value).toBe("network down");
  });
});
