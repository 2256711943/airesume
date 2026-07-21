import { readonly, ref, type Ref } from 'vue';

/** 默认帧预算（毫秒），单帧处理事件的时间上限。超过此限制的剩余事件延迟到下一帧处理。 */
const DEFAULT_FRAME_BUDGET_MS = 8;

/** requestAnimationFrame 的调度器类型，可通过依赖注入替换（如测试环境 mock）。 */
type AnimationFrameScheduler = (callback: FrameRequestCallback) => number;

/** cancelAnimationFrame 的取消器类型，与上层调度器配对使用。 */
type AnimationFrameCanceler = (handle: number) => void;

/**
 * 内部通用的异步数组缓冲接口。
 * 提供 push / drain 等原子操作，每次数据变更时触发 onSizeChange 回调以同步响应式状态。
 */
interface SseArrayBuffer<TItem> {
  /** 追加单个元素到队列尾部 */
  push: (item: TItem) => Promise<void>;
  /** 批量追加多个元素到队列尾部 */
  pushMany: (items: readonly TItem[]) => Promise<void>;
  /** 将指定元素插入队列头部（用于失败重试时的回退） */
  prepend: (items: readonly TItem[]) => Promise<void>;
  /** 取出队列中的所有元素并清空队列，返回一次性快照 */
  drain: () => Promise<TItem[]>;
  /** 获取当前队列长度 */
  size: () => Promise<number>;
  /** 清空队列中的所有元素 */
  clear: () => Promise<void>;
}

/**
 * 入站缓冲（ingressBuffer）对外暴露的接口。
 * 网络层收到事件后调用 push / pushMany 存入，调度层通过 drain 消费。
 * 不暴露 prepend 方法，避免外部直接操作入站缓冲的内部结构。
 */
export interface SseIngressBuffer<TItem> {
  /** 追加单个事件到入站队列 */
  push: (item: TItem) => Promise<void>;
  /** 批量追加多个事件到入站队列 */
  pushMany: (items: readonly TItem[]) => Promise<void>;
  /** 取出所有待处理事件，返回一次性快照并清空队列 */
  drain: () => Promise<TItem[]>;
  /** 获取当前入站队列长度 */
  size: () => Promise<number>;
  /** 清空入站队列 */
  clear: () => Promise<void>;
}

/**
 * 帧缓冲（frameBuffer）对外暴露的接口。
 * 存放本帧内经过 transformIngress 转换后、准备提交给 commitFrame 的帧数据。
 */
export interface SseFrameBuffer<TItem> {
  /** 追加单个帧项到帧队列 */
  push: (item: TItem) => Promise<void>;
  /** 批量追加多个帧项到帧队列 */
  pushMany: (items: readonly TItem[]) => Promise<void>;
  /** 取出所有待提交帧项，返回一次性快照并清空队列 */
  drain: () => Promise<TItem[]>;
  /** 获取当前帧队列长度 */
  size: () => Promise<number>;
  /** 清空帧队列 */
  clear: () => Promise<void>;
}

/** 每一帧提交给 commitFrame 的性能度量信息，用于监控和调试渲染引擎状态。 */
export interface SseRenderFrameMetrics {
  /** 当前帧的 requestAnimationFrame 时间戳 */
  frameTimestamp: number;
  /** 当前帧开始处理事件的时间（调用 now() 获取） */
  frameStartedAt: number;
  /** 当前帧实际耗时（毫秒） */
  frameDurationMs: number;
  /** 本帧提交的帧项数量 */
  committedItemCount: number;
  /** 帧处理完成后，ingress 队列中剩余的待处理事件数 */
  remainingIngressCount: number;
}

/**
 * useSseRenderEngine 的配置选项。
 * TIngressItem 为入站事件类型（来自 SSE 流），TFrameItem 为转换后的帧项类型。
 */
export interface UseSseRenderEngineOptions<TIngressItem, TFrameItem> {
  /** 每帧的处理预算（毫秒），默认 8ms。超时的剩余事件留到下一帧处理 */
  frameBudgetMs?: number;
  /** 是否在创建后自动启动渲染循环，默认为 true */
  autoStart?: boolean;
  /** 将入站事件转换为帧项。返回 null/undefined 表示丢弃，返回数组展开为多个帧项 */
  transformIngress: (
    item: TIngressItem,
  ) => Promise<TFrameItem | readonly TFrameItem[] | null | undefined>;
  /** 提交一帧内的所有帧项到 UI（通常用于更新 Vue 响应式状态） */
  commitFrame: (
    items: readonly TFrameItem[],
    metrics: SseRenderFrameMetrics,
  ) => Promise<void>;
  /** 获取当前时间戳的函数，默认 Date.now。可注入以方便测试 */
  now?: () => number;
  /** requestAnimationFrame 实现，默认取 globalThis.requestAnimationFrame */
  requestAnimationFrame?: AnimationFrameScheduler;
  /** cancelAnimationFrame 实现，默认取 globalThis.cancelAnimationFrame */
  cancelAnimationFrame?: AnimationFrameCanceler;
  /** 帧处理过程中发生错误时的回调。未设置时默认 console.error 输出 */
  onError?: (error: unknown) => Promise<void>;
}

/**
 * useSseRenderEngine 的返回值，包含双缓冲的引用帧、控制方法和状态信号。
 * TIngressItem 为入站事件类型，TFrameItem 为转换后的帧项类型。
 */
export interface UseSseRenderEngineReturn<TIngressItem, TFrameItem> {
  /** 入站缓冲：网络层将事件推入此缓冲 */
  ingressBuffer: SseIngressBuffer<TIngressItem>;
  /** 帧缓冲：经过 transformIngress 转换后、本帧准备提交的数据 */
  frameBuffer: SseFrameBuffer<TFrameItem>;
  /** 渲染引擎是否正在运行 */
  isRunning: Readonly<Ref<boolean>>;
  /** 是否已请求下一帧 rAF（调度中状态） */
  isScheduled: Readonly<Ref<boolean>>;
  /** 是否正在执行帧处理（防止重入） */
  isFlushing: Readonly<Ref<boolean>>;
  /** ingress 队列中待处理的入站事件数（响应式信号） */
  pendingIngressCount: Readonly<Ref<number>>;
  /** frame 队列中待提交的帧项数（响应式信号） */
  pendingFrameCount: Readonly<Ref<number>>;
  /** 最近一帧的处理耗时（毫秒） */
  lastFrameDurationMs: Readonly<Ref<number>>;
  /** 启动渲染循环 */
  start: () => Promise<void>;
  /** 停止渲染循环 */
  stop: () => Promise<void>;
  /** 将单个入站事件加入 ingress 队列并触发下一帧调度 */
  enqueueIngress: (item: TIngressItem) => Promise<void>;
  /** 将一批入站事件加入 ingress 队列并触发下一帧调度 */
  enqueueIngressBatch: (items: readonly TIngressItem[]) => Promise<void>;
  /** 立即执行一帧处理（不等待下一帧 rAF），用于最终收尾 */
  flush: () => Promise<void>;
  /** 销毁引擎：停止循环、清空所有缓冲、重置状态 */
  dispose: () => Promise<void>;
}

/**
 * 创建一个内部异步队列缓冲，操作均返回 Promise，支持原子 drain 和批量操作。
 * onSizeChange 在每次数据变更时被调用，用于同步响应式计数。
 */
function createArrayBuffer<TItem>(onSizeChange: (size: number) => void): SseArrayBuffer<TItem> {
  let queue: TItem[] = [];

  /** 通知外部队列长度变化 */
  const updateSize = async () => {
    onSizeChange(queue.length);
  };

  return {
    /** 追加单个元素到队列尾部 */
    push: async (item) => {
      queue.push(item);
      await updateSize();
    },
    /** 批量追加多个元素到队列尾部 */
    pushMany: async (items) => {
      if (items.length === 0) {
        return;
      }

      queue.push(...items);
      await updateSize();
    },
    /** 将元素插入队列头部（用于 commitFrame 失败后回退还原） */
    prepend: async (items) => {
      if (items.length === 0) {
        return;
      }

      queue = [...items, ...queue];
      await updateSize();
    },
    /** 原子取出所有元素并清空队列，返回一次性快照 */
    drain: async () => {
      if (queue.length === 0) {
        return [];
      }

      // 通过交换引用的方式实现原子的 drain，避免在遍历过程中被外部修改
      const drained = queue;
      queue = [];
      await updateSize();
      return drained;
    },
    /** 获取当前队列长度 */
    size: async () => {
      return queue.length;
    },
    /** 清空队列 */
    clear: async () => {
      if (queue.length === 0) {
        return;
      }

      queue = [];
      await updateSize();
    },
  };
}

/**
 * 将 transformIngress 的返回值归一化为 TFrameItem[]。
 * 处理三种情况：null/undefined 返回空数组，数组直接复制，单个元素包装为数组。
 */
async function normalizeFrameItems<TFrameItem>(
  value: TFrameItem | readonly TFrameItem[] | null | undefined,
): Promise<TFrameItem[]> {
  if (value == null) {
    return [];
  }

  if (Array.isArray(value)) {
    return [...value];
  }

  return [value];
}

/**
 * 基于 requestAnimationFrame 的双缓冲 SSE 渲染引擎。
 *
 * 架构链路：
 *   SSE 事件流 → enqueueIngress → ingressBuffer（入站缓冲）
 *                                  ↓（rAF 回调内 drain + transform）
 *                               frameBuffer（帧缓冲）
 *                                  ↓（commitFrame 提交）
 *                               UI 更新（Vue 响应式）
 *
 * @param options 配置选项，详见 UseSseRenderEngineOptions
 * @returns 渲染引擎的控制接口和状态信号，详见 UseSseRenderEngineReturn
 */
export function useSseRenderEngine<TIngressItem, TFrameItem>(
  options: UseSseRenderEngineOptions<TIngressItem, TFrameItem>,
): UseSseRenderEngineReturn<TIngressItem, TFrameItem> {
  const frameBudgetMs = options.frameBudgetMs ?? DEFAULT_FRAME_BUDGET_MS;
  const now = options.now ?? (() => Date.now());
  const requestAnimationFrameImpl =
    options.requestAnimationFrame ??
    (typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : null);
  const cancelAnimationFrameImpl =
    options.cancelAnimationFrame ??
    (typeof globalThis.cancelAnimationFrame === 'function'
      ? globalThis.cancelAnimationFrame.bind(globalThis)
      : null);

  /** 渲染引擎是否正在运行 */
  const isRunning = ref(false);
  /** 是否已请求了下一帧 rAF（调度中） */
  const isScheduled = ref(false);
  /** 是否正在执行帧处理（防止 rAF 重入） */
  const isFlushing = ref(false);
  /** ingress 队列待处理事件数（响应式） */
  const pendingIngressCount = ref(0);
  /** frame 队列待提交帧项数（响应式） */
  const pendingFrameCount = ref(0);
  /** 最近一帧的处理耗时（响应式） */
  const lastFrameDurationMs = ref(0);

  /** 当前帧正在处理但尚未完成转换的入站事件（从 ingressQueue 取出但还在处理中） */
  let pendingIngress: TIngressItem[] = [];
  /** 已调度但未执行的 rAF 句柄 */
  let scheduledFrameHandle: number | null = null;

  /**
   * 同步 pendingIngressCount 响应式信号。
   * bufferedCount 可选，传入时跳过读取 ingressQueue.size() 以减少一次异步调用。
   */
  const syncIngressCount = async (bufferedCount?: number) => {
    const queuedCount = bufferedCount ?? (await ingressQueue.size());
    pendingIngressCount.value = queuedCount + pendingIngress.length;
  };

  /** 底层入站事件队列 */
  const ingressQueue = createArrayBuffer<TIngressItem>((size) => {
    void syncIngressCount(size);
  });
  /** 底层帧项队列 */
  const frameQueue = createArrayBuffer<TFrameItem>((size) => {
    pendingFrameCount.value = size;
  });

  /** 处理帧处理过程中抛出的异常 */
  const handleError = async (error: unknown) => {
    if (options.onError) {
      await options.onError(error);
      return;
    }

    console.error('[useSseRenderEngine] frame processing failed', error);
  };

  /** 检查 ingress 或 frame 队列中是否还有待处理的工作 */
  const hasPendingWork = async () => {
    if (pendingIngress.length > 0) {
      return true;
    }

    if ((await ingressQueue.size()) > 0) {
      return true;
    }

    return (await frameQueue.size()) > 0;
  };

  /** 检查运行环境是否支持 rAF，不支持则抛出异常 */
  const ensureAnimationFrameSupport = async () => {
    if (!requestAnimationFrameImpl || !cancelAnimationFrameImpl) {
      throw new Error('requestAnimationFrame is not available in the current environment.');
    }
  };

  /**
   * 调度下一帧处理。
   * 仅在引擎运行中、尚未调度、且有待处理工作时才请求新的 rAF。
   */
  const scheduleNextFrame = async () => {
    if (!isRunning.value || isScheduled.value) {
      return;
    }

    if (!(await hasPendingWork())) {
      return;
    }

    await ensureAnimationFrameSupport();

    scheduledFrameHandle = requestAnimationFrameImpl((frameTimestamp) => {
      void runFrame(frameTimestamp);
    });
    isScheduled.value = true;
  };

  /**
   * 将 frame 队列中累积的帧项一次性提交给 commitFrame 回调。
   * 如果 commitFrame 抛出异常，会将所有帧项重新放回 frame 队列头部以支持重试。
   */
  const commitBufferedFrame = async (frameTimestamp: number, frameStartedAt: number) => {
    const frameItems = await frameQueue.drain();
    if (frameItems.length === 0) {
      return;
    }

    try {
      await options.commitFrame(frameItems, {
        frameTimestamp,
        frameStartedAt,
        frameDurationMs: now() - frameStartedAt,
        committedItemCount: frameItems.length,
        remainingIngressCount: pendingIngress.length + (await ingressQueue.size()),
      });
    } catch (error) {
      // commit 失败时将帧项回退，允许下一帧重试
      await frameQueue.prepend(frameItems);
      throw error;
    }
  };

  /**
   * 执行一帧处理。
   * 在预算时间（frameBudgetMs）内循环消费 ingress 事件，经 transformIngress 转换后放入 frame 队列，
   * 最后将本帧累积的 frame 项通过 commitBufferedFrame 提交给 UI。
   */
  const runFrame = async (frameTimestamp: number, force = false) => {
    scheduledFrameHandle = null;
    isScheduled.value = false;

    if ((!isRunning.value && !force) || isFlushing.value) {
      return;
    }

    isFlushing.value = true;
    const frameStartedAt = now();

    try {
      // 在帧预算内循环消费 ingress 事件
      while (true) {
        const elapsedMs = now() - frameStartedAt;
        if (elapsedMs >= frameBudgetMs) {
          break;
        }

        // 从 ingressQueue 取一批事件到 pendingIngress 中处理
        if (pendingIngress.length === 0) {
          const drainedIngress = await ingressQueue.drain();
          if (drainedIngress.length === 0) {
            break;
          }

          pendingIngress.push(...drainedIngress);
          await syncIngressCount(0);
        }

        const nextItem = pendingIngress.shift();
        await syncIngressCount();

        if (nextItem === undefined) {
          continue;
        }

        // 转换并放入帧队列
        const frameItems = await normalizeFrameItems(await options.transformIngress(nextItem));
        if (frameItems.length > 0) {
          await frameQueue.pushMany(frameItems);
        }
      }

      // 提交本帧累积的帧项
      await commitBufferedFrame(frameTimestamp, frameStartedAt);
      lastFrameDurationMs.value = now() - frameStartedAt;
    } catch (error) {
      await handleError(error);
    } finally {
      isFlushing.value = false;

      // 如果引擎仍在运行，调度下一帧
      if (isRunning.value) {
        await scheduleNextFrame();
      }
    }
  };

  /** 启动渲染循环。如果已经运行则跳过。 */
  const start = async () => {
    if (!requestAnimationFrameImpl || !cancelAnimationFrameImpl) {
      return;
    }

    if (isRunning.value) {
      return;
    }

    isRunning.value = true;
    await scheduleNextFrame();
  };

  /** 停止渲染循环，取消待执行的 rAF。 */
  const stop = async () => {
    if (!isRunning.value) {
      return;
    }

    isRunning.value = false;
    isScheduled.value = false;

    if (scheduledFrameHandle !== null && cancelAnimationFrameImpl) {
      cancelAnimationFrameImpl(scheduledFrameHandle);
      scheduledFrameHandle = null;
    }
  };

  /** 将单个入站事件加入 ingress 队列并触发下一帧调度 */
  const enqueueIngress = async (item: TIngressItem) => {
    await ingressQueue.push(item);
    await scheduleNextFrame();
  };

  /** 将一批入站事件加入 ingress 队列并触发下一帧调度 */
  const enqueueIngressBatch = async (items: readonly TIngressItem[]) => {
    await ingressQueue.pushMany(items);
    await scheduleNextFrame();
  };

  /** 跳过 rAF 调度，立即执行一帧处理，适用于流结束时的最终收尾 */
  const flush = async () => {
    while (await hasPendingWork()) {
      await runFrame(now(), true);
    }
  };

  /** 销毁引擎：停止渲染循环、清空所有缓冲、重置响应式状态 */
  const dispose = async () => {
    await stop();
    pendingIngress = [];
    await ingressQueue.clear();
    await frameQueue.clear();
    await syncIngressCount(0);
    lastFrameDurationMs.value = 0;
  };

  /** 对外暴露的 ingressBuffer 接口（只暴露 push/drain/size/clear） */
  const ingressBuffer: SseIngressBuffer<TIngressItem> = {
    push: async (item) => {
      await ingressQueue.push(item);
      await scheduleNextFrame();
    },
    pushMany: async (items) => {
      await ingressQueue.pushMany(items);
      await scheduleNextFrame();
    },
    drain: async () => {
      return ingressQueue.drain();
    },
    size: async () => {
      return ingressQueue.size();
    },
    clear: async () => {
      await ingressQueue.clear();
    },
  };

  /** 对外暴露的 frameBuffer 接口 */
  const frameBuffer: SseFrameBuffer<TFrameItem> = {
    push: async (item) => {
      await frameQueue.push(item);
      await scheduleNextFrame();
    },
    pushMany: async (items) => {
      await frameQueue.pushMany(items);
      await scheduleNextFrame();
    },
    drain: async () => {
      return frameQueue.drain();
    },
    size: async () => {
      return frameQueue.size();
    },
    clear: async () => {
      await frameQueue.clear();
    },
  };

  /** autoStart 默认为 true，检测到 rAF 可用时自动启动 */
  if ((options.autoStart ?? true) && requestAnimationFrameImpl && cancelAnimationFrameImpl) {
    void start();
  }

  return {
    ingressBuffer,
    frameBuffer,
    isRunning: readonly(isRunning),
    isScheduled: readonly(isScheduled),
    isFlushing: readonly(isFlushing),
    pendingIngressCount: readonly(pendingIngressCount),
    pendingFrameCount: readonly(pendingFrameCount),
    lastFrameDurationMs: readonly(lastFrameDurationMs),
    start,
    stop,
    enqueueIngress,
    enqueueIngressBatch,
    flush,
    dispose,
  };
}
