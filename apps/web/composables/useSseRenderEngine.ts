import { readonly, ref, type Ref } from 'vue';

/**
 * SSE 渲染引擎
 *
 * 本模块提供基于 requestAnimationFrame 的帧渲染管线，用于流式数据的分帧处理与展示。
 * 核心流程：数据入口 (Ingress) → 转换 → 帧缓冲 (FrameBuffer) → 逐帧提交渲染。
 * 支持打字机效果（逐字输出）的自定义帧选择器。
 */

/** 每帧预算时间（毫秒），用于控制每帧处理 ingrss 的时间上限 */
const DEFAULT_FRAME_BUDGET_MS = 8;
/** 初始帧时长默认值（约 16.67ms），用于首帧字符量计算 */
const DEFAULT_INITIAL_FRAME_DURATION_MS = 1000 / 60;

/** requestAnimationFrame 调度器类型 */
type AnimationFrameScheduler = (callback: FrameRequestCallback) => number;
/** requestAnimationFrame 取消器类型 */
type AnimationFrameCanceler = (handle: number) => void;

/**
 * 内部数组缓冲接口
 * 提供一种基于数组的异步队列操作，并在队列大小变化时触发回调通知
 */
interface SseArrayBuffer<TItem> {
  push: (item: TItem) => Promise<void>;
  pushMany: (items: readonly TItem[]) => Promise<void>;
  prepend: (items: readonly TItem[]) => Promise<void>;
  drain: () => Promise<TItem[]>;
  size: () => Promise<number>;
  clear: () => Promise<void>;
}

/** 入口数据缓冲接口 —— 用于从外部向引擎注入待处理数据 */
export interface SseIngressBuffer<TItem> {
  push: (item: TItem) => Promise<void>;
  pushMany: (items: readonly TItem[]) => Promise<void>;
  drain: () => Promise<TItem[]>;
  size: () => Promise<number>;
  clear: () => Promise<void>;
}

/** 帧数据缓冲接口 —— 存储经过转换后等待提交渲染的帧项 */
export interface SseFrameBuffer<TItem> {
  push: (item: TItem) => Promise<void>;
  pushMany: (items: readonly TItem[]) => Promise<void>;
  drain: () => Promise<TItem[]>;
  size: () => Promise<number>;
  clear: () => Promise<void>;
}

/** 帧渲染度量指标 —— 描述单帧提交的统计信息 */
export interface SseRenderFrameMetrics {
  /** requestAnimationFrame 回调的时间戳 */
  frameTimestamp: number;
  /** 帧开始处理的时刻（高精度时间） */
  frameStartedAt: number;
  /** 帧处理的耗时（毫秒） */
  frameDurationMs: number;
  /** 本帧提交渲染的数据项数量 */
  committedItemCount: number;
  /** 尚未处理的入口数据项数量 */
  remainingIngressCount: number;
}

/** 帧选择上下文 —— 帧选择器可以获取的决策信息 */
export interface SseRenderFrameSelectionContext {
  frameTimestamp: number;
  frameStartedAt: number;
  /** 上一帧的时间戳，便于计算帧间隔 */
  previousFrameTimestamp: number | null;
  /** 当前排队等待提交的帧项数量 */
  queuedFrameCount: number;
  remainingIngressCount: number;
}

/** 帧选择结果 —— 决定哪些帧项立即提交、哪些延后到后续帧 */
export interface SseRenderFrameSelection<TFrameItem> {
  /** 本帧提交的帧项 */
  commitItems: readonly TFrameItem[];
  /** 延后到后续帧处理的帧项 */
  deferredItems?: readonly TFrameItem[];
}

/** 打字机帧选择器配置选项 */
export interface CreateTypewriterFrameSelectorOptions<TFrameItem> {
  /** 每秒输出的字符数（<= 0 表示一次性全部输出） */
  charsPerSecond: number;
  /** 从帧项中提取文本 */
  getText: (item: TFrameItem) => Promise<string | null | undefined>;
  /** 克隆帧项并替换为指定文本 */
  cloneWithText: (item: TFrameItem, text: string) => Promise<TFrameItem>;
  /** 判断帧项是否为终止项（遇到终止项则立即提交所有未决帧项） */
  isTerminalItem: (item: TFrameItem) => Promise<boolean>;
  /** 首帧时长（毫秒），默认约 16.67ms */
  initialFrameDurationMs?: number;
}

/** 打字机帧选择器接口 */
export interface SseTypewriterFrameSelector<TFrameItem> {
  reset: () => Promise<void>;
  selectFrameItems: (
    items: readonly TFrameItem[],
    context: SseRenderFrameSelectionContext,
  ) => Promise<SseRenderFrameSelection<TFrameItem>>;
}

/** useSseRenderEngine 配置选项 */
export interface UseSseRenderEngineOptions<TIngressItem, TFrameItem> {
  /** 每帧预算时间（毫秒），控制每帧处理 ingress 的最大耗时 */
  frameBudgetMs?: number;
  /** 是否自动启动引擎，默认为 true */
  autoStart?: boolean;
  /** 将入口数据项转换为帧项（支持一对多转换或过滤） */
  transformIngress: (
    item: TIngressItem,
  ) => Promise<TFrameItem | readonly TFrameItem[] | null | undefined>;
  /** 提交帧项进行渲染 */
  commitFrame: (
    items: readonly TFrameItem[],
    metrics: SseRenderFrameMetrics,
  ) => Promise<void>;
  /** 自定义帧选择器（若未提供则一次性提交所有帧项） */
  selectFrameItems?: (
    items: readonly TFrameItem[],
    context: SseRenderFrameSelectionContext,
  ) => Promise<SseRenderFrameSelection<TFrameItem>>;
  /** 获取当前时间的函数，默认使用 Date.now */
  now?: () => number;
  requestAnimationFrame?: AnimationFrameScheduler;
  cancelAnimationFrame?: AnimationFrameCanceler;
  /** 错误处理回调 */
  onError?: (error: unknown) => Promise<void>;
}

/** useSseRenderEngine 返回值 */
export interface UseSseRenderEngineReturn<TIngressItem, TFrameItem> {
  ingressBuffer: SseIngressBuffer<TIngressItem>;
  frameBuffer: SseFrameBuffer<TFrameItem>;
  /** 引擎是否正在运行 */
  isRunning: Readonly<Ref<boolean>>;
  /** 是否已调度下一帧（防止重复调度） */
  isScheduled: Readonly<Ref<boolean>>;
  /** 是否正在刷新处理中 */
  isFlushing: Readonly<Ref<boolean>>;
  /** 待处理的入口数据项数量（排队中 + 缓冲区） */
  pendingIngressCount: Readonly<Ref<number>>;
  /** 待提交的帧项数量 */
  pendingFrameCount: Readonly<Ref<number>>;
  /** 上一帧的处理耗时（毫秒） */
  lastFrameDurationMs: Readonly<Ref<number>>;
  /** 启动引擎 */
  start: () => Promise<void>;
  /** 停止引擎 */
  stop: () => Promise<void>;
  /** 入队一条入口数据 */
  enqueueIngress: (item: TIngressItem) => Promise<void>;
  /** 批量入队入口数据 */
  enqueueIngressBatch: (items: readonly TIngressItem[]) => Promise<void>;
  /** 强制刷新所有待处理数据 */
  flush: () => Promise<void>;
  /** 销毁引擎，清理所有状态 */
  dispose: () => Promise<void>;
}

/**
 * 创建内部数组缓冲
 * 基于普通数组实现异步队列，每次队列大小变化时调用 onSizeChange 回调
 */
function createArrayBuffer<TItem>(onSizeChange: (size: number) => void): SseArrayBuffer<TItem> {
  let queue: TItem[] = [];

  const updateSize = async () => {
    onSizeChange(queue.length);
  };

  return {
    /** 追加单个元素到队尾 */
    push: async (item) => {
      queue.push(item);
      await updateSize();
    },
    /** 批量追加多个元素到队尾 */
    pushMany: async (items) => {
      if (items.length === 0) {
        return;
      }

      queue.push(...items);
      await updateSize();
    },
    /** 将多个元素前置插入到队首 */
    prepend: async (items) => {
      if (items.length === 0) {
        return;
      }

      queue = [...items, ...queue];
      await updateSize();
    },
    /** 取出并清空所有元素 */
    drain: async () => {
      if (queue.length === 0) {
        return [];
      }

      const drained = queue;
      queue = [];
      await updateSize();
      return drained;
    },
    /** 获取当前队列大小 */
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
 * 标准化帧项
 * 将单个帧项、帧项数组或 null/undefined 统一转换为数组形式
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
 * 将文本拆分为字素簇（用户感知的"字符"）
 * 优先使用 Intl.Segmenter API，降级使用 Array.from
 */
export async function splitTextIntoGraphemes(text: string): Promise<string[]> {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: 'grapheme',
    });

    return Array.from(segmenter.segment(text), (item) => item.segment);
  }

  return Array.from(text);
}

/**
 * 创建打字机帧选择器
 * 根据每秒字符数(charsPerSecond)计算每帧应输出的字符量，
 * 将帧项文本按字素簇粒度分配到 commitItems（本帧输出）和 deferredItems（后续帧输出）中。
 * - 遇到终止项(terminalItem)时立即提交所有累积的帧项
 * - charsPerSecond <= 0 表示不限制，一次性提交
 */
export function createTypewriterFrameSelector<TFrameItem>(
  options: CreateTypewriterFrameSelectorOptions<TFrameItem>,
): SseTypewriterFrameSelector<TFrameItem> {
  let previousFrameTimestamp: number | null = null;
  let characterCarry = 0;
  const initialFrameDurationMs = options.initialFrameDurationMs ?? DEFAULT_INITIAL_FRAME_DURATION_MS;

  return {
    /** 重置选择器状态（清除上一帧时间戳和字符累积） */
    reset: async () => {
      previousFrameTimestamp = null;
      characterCarry = 0;
    },
    /**
     * 选择本帧要提交的帧项
     * 计算逻辑：
     * 1. 根据帧间隔时长计算本帧可输出的字符配额
     * 2. 按字素簇粒度分配字符到 commitItems / deferredItems
     * 3. 多余字符累积到 characterCarry 用于后续帧
     */
    selectFrameItems: async (items, context) => {
      if (options.charsPerSecond <= 0) {
        return {
          commitItems: [...items],
        };
      }

      const commitItems: TFrameItem[] = [];
      const deferredItems: TFrameItem[] = [];
      // 计算帧间隔时长：首帧使用初始值，后续帧使用实际时间差
      const frameDurationMs =
        previousFrameTimestamp === null
          ? initialFrameDurationMs
          : Math.max(0, context.frameTimestamp - previousFrameTimestamp);

      previousFrameTimestamp = context.frameTimestamp;
      // 累积本帧可输出的字符数（含之前未用完的余量）
      characterCarry += (options.charsPerSecond * frameDurationMs) / 1000;
      let remainingCharacters = Math.floor(characterCarry);
      characterCarry -= remainingCharacters;

      for (const item of items) {
        const text = await options.getText(item);

        if (typeof text === 'string' && text.length > 0) {
          // 确保每帧至少输出一个字符，避免卡住
          if (remainingCharacters < 1) {
            remainingCharacters = 1;
            characterCarry = 0;
          }

          const graphemes = await splitTextIntoGraphemes(text);
          const committedGraphemeCount = Math.min(graphemes.length, remainingCharacters);
          const committedText = graphemes.slice(0, committedGraphemeCount).join('');
          const deferredText = graphemes.slice(remainingCharacters).join('');

          if (committedText.length > 0) {
            commitItems.push(await options.cloneWithText(item, committedText));
            remainingCharacters -= committedGraphemeCount;
          }

          if (deferredText.length > 0) {
            deferredItems.push(await options.cloneWithText(item, deferredText));
          }

          continue;
        }

        // 遇到终止项（如换行符）则立即提交所有累积帧项
        if (await options.isTerminalItem(item)) {
          return {
            commitItems: [...commitItems, item],
            deferredItems: [],
          };
        }

        // 无文本的非终止项直接提交
        commitItems.push(item);
      }

      return {
        commitItems,
        deferredItems,
      };
    },
  };
}

/**
 * 创建 SSE 渲染引擎
 * 基于 requestAnimationFrame 实现分帧渲染管线，用于流式数据的高效处理与展示。
 *
 * @param options - 引擎配置选项
 * @returns 引擎控制接口与状态
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

  // ---- 响应式状态 ----
  const isRunning = ref(false);
  const isScheduled = ref(false);
  const isFlushing = ref(false);
  const pendingIngressCount = ref(0);
  const pendingFrameCount = ref(0);
  const lastFrameDurationMs = ref(0);

  // ---- 内部可变状态 ----
  /** 当前帧正在处理的入口数据（从 ingressQueue 取出后暂存于此） */
  let pendingIngress: TIngressItem[] = [];
  /** 已调度的 requestAnimationFrame 句柄 */
  let scheduledFrameHandle: number | null = null;
  /** 上一帧的时间戳 */
  let previousFrameTimestamp: number | null = null;

  /** 同步入口数据计数到响应式状态 */
  const syncIngressCount = async (bufferedCount?: number) => {
    const queuedCount = bufferedCount ?? (await ingressQueue.size());
    pendingIngressCount.value = queuedCount + pendingIngress.length;
  };

  // ---- 内部缓冲队列 ----
  /** 入口数据缓冲队列 */
  const ingressQueue = createArrayBuffer<TIngressItem>((size) => {
    void syncIngressCount(size);
  });
  /** 帧数据缓冲队列 */
  const frameQueue = createArrayBuffer<TFrameItem>((size) => {
    pendingFrameCount.value = size;
  });

  /** 处理帧处理过程中的错误 */
  const handleError = async (error: unknown) => {
    if (options.onError) {
      await options.onError(error);
      return;
    }

    console.error('[useSseRenderEngine] frame processing failed', error);
  };

  /** 检查是否还有待处理的工作（ingress 或 frame） */
  const hasPendingWork = async () => {
    if (pendingIngress.length > 0) {
      return true;
    }

    if ((await ingressQueue.size()) > 0) {
      return true;
    }

    return (await frameQueue.size()) > 0;
  };

  /** 确保运行环境支持 requestAnimationFrame */
  const ensureAnimationFrameSupport = async () => {
    if (!requestAnimationFrameImpl || !cancelAnimationFrameImpl) {
      throw new Error('requestAnimationFrame is not available in the current environment.');
    }
  };

  /**
   * 调度下一帧处理
   * 仅在引擎运行中、未调度、且有待处理工作时才调度新的 rAF
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
   * 提交缓冲区的帧项到渲染层
   * 根据 selectFrameItems 决定哪些帧项提交、哪些延后
   * 若提交过程中抛出异常，将帧项重新放回队列头部
   */
  const commitBufferedFrame = async (frameTimestamp: number, frameStartedAt: number) => {
    const frameItems = await frameQueue.drain();
    if (frameItems.length === 0) {
      return;
    }

    const selection = options.selectFrameItems
      ? await options.selectFrameItems(frameItems, {
        frameTimestamp,
        frameStartedAt,
        previousFrameTimestamp,
        queuedFrameCount: frameItems.length,
        remainingIngressCount: pendingIngress.length + (await ingressQueue.size()),
      })
      : {
        commitItems: frameItems,
        deferredItems: [],
      };
    const commitItems = [...selection.commitItems];
    const deferredItems = [...(selection.deferredItems ?? [])];

    if (commitItems.length === 0) {
      // 本帧无提交项，将延迟项放回队列头部
      if (deferredItems.length > 0) {
        await frameQueue.prepend(deferredItems);
      }

      previousFrameTimestamp = frameTimestamp;
      return;
    }

    try {
      await options.commitFrame(commitItems, {
        frameTimestamp,
        frameStartedAt,
        frameDurationMs: now() - frameStartedAt,
        committedItemCount: commitItems.length,
        remainingIngressCount: pendingIngress.length + (await ingressQueue.size()),
      });

      // 提交成功后，将延迟项重新放回队列头部供后续帧处理
      if (deferredItems.length > 0) {
        await frameQueue.prepend(deferredItems);
      }

      previousFrameTimestamp = frameTimestamp;
    } catch (error) {
      // 提交失败时恢复所有帧项到队列头部，保证数据不丢失
      await frameQueue.prepend(frameItems);
      throw error;
    }
  };

  /**
   * 执行单帧处理
   *
   * - 从 ingressQueue 取出数据，在 frameBudgetMs 预算内进行转换
   * - 转换后的帧项推入 frameQueue
   * - 然后调用 commitBufferedFrame 提交本帧
   *
   * @param force - 强制运行（即使引擎未启动），用于 flush 操作
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
      // ---- Ingress 处理阶段：在预算时间内转换入口数据到帧数据 ----
      while (true) {
        const elapsedMs = now() - frameStartedAt;
        if (elapsedMs >= frameBudgetMs) {
          break;
        }

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

        const frameItems = await normalizeFrameItems(await options.transformIngress(nextItem));
        if (frameItems.length > 0) {
          await frameQueue.pushMany(frameItems);
        }
      }

      // ---- 帧提交阶段：将帧缓冲中的数据提交渲染 ----
      await commitBufferedFrame(frameTimestamp, frameStartedAt);
      lastFrameDurationMs.value = now() - frameStartedAt;
    } catch (error) {
      await handleError(error);
    } finally {
      isFlushing.value = false;

      if (isRunning.value) {
        await scheduleNextFrame();
      }
    }
  };

  /** 启动引擎 */
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

  /** 停止引擎 */
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

  /** 入队一条入口数据，并尝试调度处理 */
  const enqueueIngress = async (item: TIngressItem) => {
    await ingressQueue.push(item);
    await scheduleNextFrame();
  };

  /** 批量入队入口数据，并尝试调度处理 */
  const enqueueIngressBatch = async (items: readonly TIngressItem[]) => {
    await ingressQueue.pushMany(items);
    await scheduleNextFrame();
  };

  /** 强制刷新所有待处理数据（同步模式，忽略帧预算） */
  const flush = async () => {
    while (await hasPendingWork()) {
      await runFrame(now(), true);
    }
  };

  /** 销毁引擎，停止运行并清理所有状态 */
  const dispose = async () => {
    await stop();
    pendingIngress = [];
    previousFrameTimestamp = null;
    await ingressQueue.clear();
    await frameQueue.clear();
    await syncIngressCount(0);
    lastFrameDurationMs.value = 0;
  };

  // ---- 对外暴露的缓冲接口 ----
  /** 入口缓冲区（外部可访问） */
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

  /** 帧缓冲区（外部可访问） */
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

  // 自动启动（默认启用）
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
