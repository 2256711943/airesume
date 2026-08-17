/**
 * useReplayController —— 历史 run 回放控制器
 *
 * 职责：
 * - 驱动 ReplaySpanStore 的回放游标（play / pause / step / fast-forward / jump / reset）；
 * - 通过注入的 apiFetch 加载会话 run 列表与单个 run 的 replay 完整包；
 * - 维护回放模式（idle / playing / paused / completed）与播放速度（每秒事件数）。
 *
 * 状态隔离约定：控制器不直接改动 live store，只操作传入的 ReplaySpanStore 实例。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue';

import { useApiFetch } from './useApiFetch';
import type {
  ObservabilityRunListItem,
  ObservabilityRunListResponse,
  ObservabilityRunReplayResponse,
  ReplaySpanStore,
} from './useReplaySpanStore';

export type ReplayMode = 'idle' | 'playing' | 'paused' | 'completed';

export interface UseReplayControllerOptions {
  /** 可注入的 API 请求函数（默认 useApiFetch）。 */
  apiFetch?: typeof useApiFetch;
  /** 播放速度：每秒推进的事件数（默认 2）。 */
  speed?: number;
  /** 定时器实现注入，便于测试使用 fake timers。 */
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

export interface ReplayController {
  readonly mode: Readonly<Ref<ReplayMode>>;
  readonly speed: Readonly<Ref<number>>;
  readonly selectedCheckpointId: Readonly<Ref<string | null>>;
  /** 同一会话下可 replay 的 run 列表。 */
  readonly runs: Readonly<Ref<readonly ObservabilityRunListItem[]>>;
  readonly runsLoading: Readonly<Ref<boolean>>;
  readonly loadingRun: Readonly<Ref<boolean>>;
  readonly runError: Readonly<Ref<string | null>>;
  readonly cursorSeq: Readonly<ComputedRef<number>>;
  readonly firstSeq: Readonly<ComputedRef<number | null>>;
  readonly lastSeq: Readonly<ComputedRef<number | null>>;
  readonly progress: Readonly<ComputedRef<number>>;
  readonly hasPrev: Readonly<ComputedRef<boolean>>;
  readonly hasNext: Readonly<ComputedRef<boolean>>;

  loadConversationRuns: (conversationId: string) => Promise<void>;
  loadRun: (runId: string) => Promise<void>;
  play: () => void;
  pause: () => void;
  stepForward: () => void;
  stepBackward: () => void;
  fastForward: () => void;
  jumpToSeq: (seq: number) => void;
  jumpToCheckpoint: (checkpointId: string) => void;
  reset: () => void;
  setSpeed: (speed: number) => void;
  dispose: () => void;
}

/** 播放速度下限（事件/秒），避免定时器间隔过密。 */
const MIN_SPEED = 0.5;
/** 定时器最小间隔（毫秒），防止极端速度下频繁重建快照。 */
const MIN_TIMER_INTERVAL_MS = 50;

/**
 * 创建回放控制器。
 *
 * @param store 回放状态存储实例（由调用方创建，保证与 live store 隔离）。
 * @param options 依赖注入与默认参数。
 */
export function useReplayController(
  store: ReplaySpanStore,
  options: UseReplayControllerOptions = {},
): ReplayController {
  const apiFetch = options.apiFetch ?? useApiFetch;
  const setIntervalImpl =
    options.setInterval ?? globalThis.setInterval.bind(globalThis);
  const clearIntervalImpl =
    options.clearInterval ?? globalThis.clearInterval.bind(globalThis);

  const mode = ref<ReplayMode>('idle');
  const speed = ref(options.speed ?? 2);
  const selectedCheckpointId = ref<string | null>(null);
  const runs = ref<ObservabilityRunListItem[]>([]);
  const runsLoading = ref(false);
  const loadingRun = ref(false);
  const runError = ref<string | null>(null);

  let timer: ReturnType<typeof setInterval> | null = null;

  const cursorSeq = computed(() => store.activeSeq.value);
  const firstSeq = computed(() => store.firstSeq.value);
  const lastSeq = computed(() => store.lastSeq.value);
  const progress = computed(() => store.progress.value);
  const hasPrev = computed(() => store.hasPrev());
  const hasNext = computed(() => store.hasNext());

  const clearTimer = (): void => {
    if (timer !== null) {
      clearIntervalImpl(timer);
      timer = null;
    }
  };

  const complete = (): void => {
    clearTimer();
    mode.value = 'completed';
  };

  const stepForward = (): void => {
    const next = store.getNextSeq(store.activeSeq.value);
    if (next === null) {
      complete();
      return;
    }
    store.seekToSeq(next);
    if (mode.value === 'idle') {
      mode.value = 'paused';
    }
  };

  const restartTimer = (): void => {
    clearTimer();
    if (mode.value !== 'playing') {
      return;
    }
    const intervalMs = Math.max(
      MIN_TIMER_INTERVAL_MS,
      Math.round(1000 / Math.max(MIN_SPEED, speed.value)),
    );
    timer = setIntervalImpl(() => {
      if (!store.hasNext()) {
        complete();
        return;
      }
      stepForward();
    }, intervalMs);
  };

  const loadConversationRuns = async (conversationId: string): Promise<void> => {
    if (!conversationId) {
      return;
    }
    runsLoading.value = true;
    runError.value = null;
    try {
      const response = await apiFetch<ObservabilityRunListResponse>(
        `/observability/conversations/${encodeURIComponent(conversationId)}/runs`,
      );
      runs.value = Array.isArray(response?.runs) ? response.runs : [];
    } catch (error) {
      runError.value =
        error instanceof Error ? error.message : '加载可回放 run 列表失败';
    } finally {
      runsLoading.value = false;
    }
  };

  const loadRun = async (runId: string): Promise<void> => {
    if (!runId) {
      return;
    }
    clearTimer();
    loadingRun.value = true;
    runError.value = null;
    try {
      const replay = await apiFetch<ObservabilityRunReplayResponse>(
        `/observability/runs/${encodeURIComponent(runId)}/replay`,
      );
      store.loadReplayPackage(replay);
      selectedCheckpointId.value = null;
      store.seekToFirst();
      mode.value = 'paused';
    } catch (error) {
      runError.value =
        error instanceof Error ? error.message : '加载回放包失败';
      mode.value = 'idle';
    } finally {
      loadingRun.value = false;
    }
  };

  const play = (): void => {
    if (!store.hasRun.value) {
      return;
    }
    if (mode.value === 'completed' || !store.hasNext()) {
      store.seekToFirst();
    }
    mode.value = 'playing';
    restartTimer();
  };

  const pause = (): void => {
    clearTimer();
    if (mode.value === 'playing') {
      mode.value = 'paused';
    }
  };

  const stepBackward = (): void => {
    clearTimer();
    const prev = store.getPrevSeq(store.activeSeq.value);
    if (prev === null) {
      return;
    }
    store.seekToSeq(prev);
    if (mode.value === 'completed' || mode.value === 'playing') {
      mode.value = 'paused';
    }
  };

  const fastForward = (): void => {
    clearTimer();
    store.seekToEnd();
    mode.value = 'completed';
  };

  const jumpToSeq = (seq: number): void => {
    clearTimer();
    store.seekToSeq(seq);
    if (mode.value === 'completed' || mode.value === 'playing') {
      mode.value = 'paused';
    }
    if (mode.value === 'idle' && store.hasRun.value) {
      mode.value = 'paused';
    }
  };

  const jumpToCheckpoint = (checkpointId: string): void => {
    // checkpoint 列表来自 replay 完整包（store.checkpoints），
    // 而非内层 span store 从 checkpoint 事件反推的索引。
    const checkpoint = store.checkpoints.value.find(
      (item) => item.checkpointId === checkpointId,
    );
    if (!checkpoint) {
      return;
    }
    selectedCheckpointId.value = checkpoint.checkpointId;
    jumpToSeq(checkpoint.seq);
  };

  const reset = (): void => {
    clearTimer();
    store.seekToFirst();
    selectedCheckpointId.value = null;
    mode.value = 'paused';
  };

  const setSpeed = (nextSpeed: number): void => {
    speed.value = Math.max(MIN_SPEED, nextSpeed);
    restartTimer(); // 播放中立即按新速度重启定时器
  };

  const dispose = (): void => {
    clearTimer();
  };

  return {
    mode,
    speed,
    selectedCheckpointId,
    runs,
    runsLoading,
    loadingRun,
    runError,
    cursorSeq,
    firstSeq,
    lastSeq,
    progress,
    hasPrev,
    hasNext,
    loadConversationRuns,
    loadRun,
    play,
    pause,
    stepForward,
    stepBackward,
    fastForward,
    jumpToSeq,
    jumpToCheckpoint,
    reset,
    setSpeed,
    dispose,
  };
}
