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
type Awaitable<T> = T | Promise<T>;

export type SseRenderPhase = 'critical' | 'state' | 'bulk' | 'decorative' | 'unknown';
export type SseRenderPressureLevel = 'idle' | 'normal' | 'busy' | 'high' | 'critical';

const SSE_RENDER_PHASES: readonly SseRenderPhase[] = ['critical', 'state', 'bulk', 'decorative', 'unknown'];
const PRESSURE_EWMA_ALPHA = 0.25;

interface TrackedBufferItem<TItem> {
  value: TItem;
  phase: SseRenderPhase;
  enqueuedAt: number;
}

/**
 * 内部数组缓冲接口
 * 提供一种基于数组的异步队列操作，并在队列大小变化时触发回调通知
 */
interface SseArrayBuffer<TItem> {
  push: (item: TItem) => Promise<void>;
  pushMany: (items: readonly TItem[]) => Promise<void>;
  prepend: (items: readonly TItem[]) => Promise<void>;
  replaceLast: (item: TItem) => Promise<void>;
  drain: () => Promise<TItem[]>;
  size: () => Promise<number>;
  clear: () => Promise<void>;
  snapshot: () => Promise<readonly TItem[]>;
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
  /** 当前压力等级，供帧选择器做降级决策 */
  pressureLevel: SseRenderPressureLevel;
}

/** 帧选择结果 —— 决定哪些帧项立即提交、哪些延后到后续帧 */
export interface SseRenderFrameSelection<TFrameItem> {
  /** 本帧提交的帧项 */
  commitItems: readonly TFrameItem[];
  /** 延后到后续帧处理的帧项 */
  deferredItems?: readonly TFrameItem[];
}

export interface SseRenderFrameMergeContext {
  previousPhase: SseRenderPhase;
  nextPhase: SseRenderPhase;
  pressureLevel: SseRenderPressureLevel;
}

/** 分阶段统计计数 —— 按渲染优先级对各阶段队列项数量进行汇总 */
export interface SseRenderPhaseCounts {
  /** 关键阶段（错误、系统事件等必须立即渲染的内容） */
  critical: number;
  /** 状态阶段（渲染状态更新） */
  state: number;
  /** 批量阶段（大批量内容输出） */
  bulk: number;
  /** 装饰阶段（辅助性、非关键内容） */
  decorative: number;
  /** 未知阶段（无法归类的兜底项） */
  unknown: number;
  /** 所有阶段的总计数 */
  total: number;
}

/** 积压快照 —— 反映入口队列和帧队列中各阶段的积压情况 */
export interface SseRenderBacklogSnapshot {
  /** 入口队列的分阶段统计 */
  ingress: SseRenderPhaseCounts;
  /** 帧队列的分阶段统计 */
  frame: SseRenderPhaseCounts;
  /** 入口 + 帧的合并统计 */
  total: SseRenderPhaseCounts;
}

/** 监控快照 —— 引擎运行时状态的完整视图，用于外部监控和压力感知 */
export interface SseRenderMonitoringSnapshot {
  /** 快照生成时间戳 */
  updatedAt: number;
  /** 当前使用的帧预算（毫秒） */
  frameBudgetMs: number;
  /** 累计已处理的帧数 */
  frameCount: number;
  /** 上一帧的 rAF 时间戳，首帧为 null */
  lastFrameTimestamp: number | null;
  /** 上一帧开始处理的高精度时刻 */
  lastFrameStartedAt: number | null;
  /** 上一帧的处理耗时（毫秒） */
  lastFrameDurationMs: number;
  /** 帧耗时 EWMA（指数加权移动平均），平滑反映近期帧处理负载 */
  frameCostEwmaMs: number;
  /** 上一帧提交的数据项数量 */
  lastCommittedItemCount: number;
  /** 累计已提交的数据项总数 */
  totalCommittedItemCount: number;
  /** 入口队列中待处理的数据项数量 */
  pendingIngressCount: number;
  /** 帧队列中待提交的数据项数量 */
  pendingFrameCount: number;
  /** 最老待处理项的停留时长（毫秒），反映数据在管道中的延迟 */
  oldestPendingAgeMs: number;
  /** 连续"有积压但未提交完"的帧数，用于侦测持续积压 */
  commitLagFrames: number;
  /** 压力评分（0-100），综合队列深度、等待时长、帧耗时等因素 */
  pressureScore: number;
  /** 压力等级：idle（空闲）→ normal → busy → high → critical */
  pressureLevel: SseRenderPressureLevel;
  /** 分阶段积压详情 */
  backlog: SseRenderBacklogSnapshot;
}

/** 打字机帧选择器配置选项 */
export interface CreateTypewriterFrameSelectorOptions<TFrameItem> {
  /** 每秒输出的字符数（<= 0 表示一次性全部输出） */
  charsPerSecond: number;
  /** 压力等级变化时的降级回调，返回新的 charsPerSecond，undefined 表示不调整 */
  onDegrade?: (pressureLevel: SseRenderPressureLevel, currentCharsPerSecond: number) => number | undefined;
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
  mergeFrameItems?: (
    previous: TFrameItem,
    next: TFrameItem,
    context: SseRenderFrameMergeContext,
  ) => Promise<TFrameItem | undefined>;
  classifyIngressPhase?: (item: TIngressItem) => Awaitable<SseRenderPhase | null | undefined>;
  classifyFramePhase?: (
    item: TFrameItem,
    context: { ingressItem: TIngressItem },
  ) => Awaitable<SseRenderPhase | null | undefined>;
  onPressureChange?: (
    currentLevel: SseRenderPressureLevel,
    previousLevel: SseRenderPressureLevel,
    metrics: {
      pressureScore: number;
      oldestPendingAgeMs: number;
      totalPendingCount: number;
    },
  ) => void;
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
  /** 压力监控快照 */
  monitoring: Readonly<Ref<SseRenderMonitoringSnapshot>>;
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
function createArrayBuffer<TItem>(onSizeChange: (size: number) => Awaitable<void>): SseArrayBuffer<TItem> {
  let queue: TItem[] = [];

  const updateSize = async () => {
    await onSizeChange(queue.length);
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
    replaceLast: async (item) => {
      if (queue.length === 0) {
        return;
      }

      queue[queue.length - 1] = item;
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
    snapshot: async () => {
      return [...queue];
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

  return [value as TFrameItem];
}

function isSseRenderPhase(value: unknown): value is SseRenderPhase {
  return typeof value === 'string' && SSE_RENDER_PHASES.includes(value as SseRenderPhase);
}

function normalizeSseRenderPhase(value: unknown): SseRenderPhase {
  return isSseRenderPhase(value) ? value : 'unknown';
}

/** 创建各阶段计数全为 0 的初始统计对象 */
function createEmptyPhaseCounts(): SseRenderPhaseCounts {
  return {
    critical: 0,
    state: 0,
    bulk: 0,
    decorative: 0,
    unknown: 0,
    total: 0,
  };
}

/** 统计一批 TrackedBufferItem 中各 phase 的分布情况 */
function countTrackedPhaseItems<TItem>(
  items: readonly TrackedBufferItem<TItem>[],
): SseRenderPhaseCounts {
  const counts = createEmptyPhaseCounts();

  for (const item of items) {
    counts[item.phase] += 1;
    counts.total += 1;
  }

  return counts;
}

/** 合并两个 phase 计数对象，对应字段相加 */
function mergePhaseCounts(left: SseRenderPhaseCounts, right: SseRenderPhaseCounts): SseRenderPhaseCounts {
  return {
    critical: left.critical + right.critical,
    state: left.state + right.state,
    bulk: left.bulk + right.bulk,
    decorative: left.decorative + right.decorative,
    unknown: left.unknown + right.unknown,
    total: left.total + right.total,
  };
}

/**
 * 计算一批 TrackedBufferItem 中最老元素的滞留时长
 * 通过 enqueuedAt（入队时间戳）与当前时间 nowMs 的差值来确定
 */
function pickOldestAgeMs<TItem>(
  items: readonly TrackedBufferItem<TItem>[],
  nowMs: number,
): number {
  if (items.length === 0) {
    return 0;
  }

  const oldest = items.reduce((candidate, item) => Math.min(candidate, item.enqueuedAt), Number.POSITIVE_INFINITY);
  return Number.isFinite(oldest) ? Math.max(0, nowMs - oldest) : 0;
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
      const effectiveCharsPerSecond = options.onDegrade
        ? options.onDegrade(context.pressureLevel, options.charsPerSecond) ?? options.charsPerSecond
        : options.charsPerSecond;

      if (effectiveCharsPerSecond <= 0) {
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
      characterCarry += (effectiveCharsPerSecond * frameDurationMs) / 1000;
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
  const monitoring = ref<SseRenderMonitoringSnapshot>({
    updatedAt: now(),
    frameBudgetMs,
    frameCount: 0,
    lastFrameTimestamp: null,
    lastFrameStartedAt: null,
    lastFrameDurationMs: 0,
    frameCostEwmaMs: 0,
    lastCommittedItemCount: 0,
    totalCommittedItemCount: 0,
    pendingIngressCount: 0,
    pendingFrameCount: 0,
    oldestPendingAgeMs: 0,
    commitLagFrames: 0,
    pressureScore: 0,
    pressureLevel: 'idle',
    backlog: {
      ingress: createEmptyPhaseCounts(),
      frame: createEmptyPhaseCounts(),
      total: createEmptyPhaseCounts(),
    },
  });

  // ---- 内部可变状态 ----
  /** 当前帧正在处理的入口数据（从 ingressQueue 取出后暂存于此） */
  let pendingIngress: TIngressItem[] = [];
  /** 入口队列待处理项的追踪元数据（与 ingressQueue 元素一一对应） */
  let queuedIngressMeta: TrackedBufferItem<TIngressItem>[] = [];
  /** 当前帧正在处理的入口项的追踪元数据 */
  let pendingIngressMeta: TrackedBufferItem<TIngressItem>[] = [];
  /** 帧队列待处理项的追踪元数据（与 frameQueue 元素一一对应） */
  let queuedFrameMeta: TrackedBufferItem<TFrameItem>[] = [];
  /** 当前帧待提交的帧项追踪元数据 */
  let pendingFrameMeta: TrackedBufferItem<TFrameItem>[] = [];
  /** 已调度的 requestAnimationFrame 句柄 */
  let scheduledFrameHandle: number | null = null;
  /** 上一帧的时间戳 */
  let previousFrameTimestamp: number | null = null;
  /** 上一帧开始处理的高精度时刻 */
  let lastFrameStartedAt: number | null = null;
  /** 累计已处理的帧数 */
  let frameCount = 0;
  /** 累计已提交的数据项总数 */
  let totalCommittedItemCount = 0;
  /** 上一帧提交的数据项数量 */
  let lastCommittedItemCount = 0;
  /** 帧耗时 EWMA（指数加权移动平均），平滑反映近期帧处理负载 */
  let frameCostEwmaMs = 0;
  /** 连续"有积压但未提交完"的帧数，用于侦测持续积压 */
  let commitLagFrames = 0;
  let previousPressureLevel: SseRenderPressureLevel = 'idle';

  /**
   * 生成压力监控快照
   *
   * 收集引擎运行时各项指标，计算压力评分和压力等级。
   * 压力评分（0-100）由四个维度加权计算：
   *   - 队列深度（最多占 45 分）：总待处理项数 × 5
   *   - 等待时长（最多占 25 分）：最老待处理项滞留时长 / 60ms
   *   - 帧耗时超标（最多占 20 分）：(EWMA 帧耗时 - 帧预算) × 2
   *   - 连续积压帧（最多占 10 分）：连续积压帧数 × 2
   * 压力等级映射：0 → idle, 1-34 → normal, 35-64 → busy, 65-84 → high, 85-100 → critical
   */
  const updateMonitoringSnapshot = async () => {
    const currentNow = now();
    const ingressPendingMeta = [...queuedIngressMeta, ...pendingIngressMeta];
    const framePendingMeta = [...queuedFrameMeta, ...pendingFrameMeta];
    const ingressCounts = countTrackedPhaseItems(ingressPendingMeta);
    const frameCounts = countTrackedPhaseItems(framePendingMeta);
    const totalCounts = mergePhaseCounts(ingressCounts, frameCounts);
    const totalPendingCount = totalCounts.total;
    const oldestPendingAgeMs = Math.max(
      pickOldestAgeMs(ingressPendingMeta, currentNow),
      pickOldestAgeMs(framePendingMeta, currentNow),
    );

    // 压力评分：综合队列深度、等待时长、帧耗时超标、连续积压四个维度
    const pressureScore = Math.min(100, Math.round(
      Math.min(45, totalPendingCount * 5) +
      Math.min(25, oldestPendingAgeMs / 60) +
      Math.min(20, Math.max(0, frameCostEwmaMs - frameBudgetMs) * 2) +
      Math.min(10, commitLagFrames * 2),
    ));

    // 压力等级：idle（队列为空）→ normal → busy → high → critical
    let pressureLevel: SseRenderPressureLevel = 'normal';
    if (totalPendingCount === 0) {
      pressureLevel = 'idle';
    } else if (pressureScore >= 85) {
      pressureLevel = 'critical';
    } else if (pressureScore >= 65) {
      pressureLevel = 'high';
    } else if (pressureScore >= 35) {
      pressureLevel = 'busy';
    }

    pendingIngressCount.value = ingressCounts.total;
    pendingFrameCount.value = frameCounts.total;

    monitoring.value = {
      updatedAt: currentNow,
      frameBudgetMs,
      frameCount,
      lastFrameTimestamp: previousFrameTimestamp,
      lastFrameStartedAt,
      lastFrameDurationMs: lastFrameDurationMs.value,
      frameCostEwmaMs,
      lastCommittedItemCount,
      totalCommittedItemCount,
      pendingIngressCount: ingressCounts.total,
      pendingFrameCount: frameCounts.total,
      oldestPendingAgeMs,
      commitLagFrames,
      pressureScore,
      pressureLevel,
      backlog: {
        ingress: ingressCounts,
        frame: frameCounts,
        total: totalCounts,
      },
    };

    const previousLevel = previousPressureLevel;
    if (pressureLevel !== previousLevel) {
      previousPressureLevel = pressureLevel;
      try {
        options.onPressureChange?.(pressureLevel, previousLevel, {
          pressureScore,
          oldestPendingAgeMs,
          totalPendingCount,
        });
      } catch (error) {
        console.error('[useSseRenderEngine] pressure change callback failed', error);
      }
      return;
    }

    previousPressureLevel = pressureLevel;
  };

  /**
   * 创建入口项的追踪元数据
   * 通过 classifyIngressPhase 确定 phase，并记录入队时间戳
   */
  const createTrackedIngressItem = async (item: TIngressItem): Promise<TrackedBufferItem<TIngressItem>> => {
    const phase = normalizeSseRenderPhase(options.classifyIngressPhase ? await options.classifyIngressPhase(item) : null);
    return {
      value: item,
      phase,
      enqueuedAt: now(),
    };
  };

  /**
   * 创建帧项的追踪元数据
   * 优先使用 classifyFramePhase 确定 phase，否则继承对应入口项的 phase；
   * enqueuedAt 也继承自入口项，确保延迟统计的连续性
   */
  const createTrackedFrameItem = async (
    item: TFrameItem,
    ingressItem: TrackedBufferItem<TIngressItem>,
  ): Promise<TrackedBufferItem<TFrameItem>> => {
    const phase = normalizeSseRenderPhase(
      options.classifyFramePhase
        ? await options.classifyFramePhase(item, { ingressItem: ingressItem.value })
        : ingressItem.phase,
    );

    return {
      value: item,
      phase,
      enqueuedAt: ingressItem.enqueuedAt,
    };
  };

  /** 将入口数据批量入队，同时创建追踪元数据并更新监控快照 */
  const pushIngressTrackedItems = async (items: readonly TIngressItem[]) => {
    const trackedItems = await Promise.all(items.map((item) => createTrackedIngressItem(item)));
    queuedIngressMeta.push(...trackedItems);
    await ingressQueue.pushMany(items);
    await updateMonitoringSnapshot();
  };

  const appendTrackedFrameItems = async (
    trackedItems: readonly TrackedBufferItem<TFrameItem>[],
    pressureLevel: SseRenderPressureLevel,
  ) => {
    if (trackedItems.length === 0) {
      return;
    }

    const mergeFrameItems = options.mergeFrameItems;
    if (!mergeFrameItems || (pressureLevel !== 'high' && pressureLevel !== 'critical')) {
      queuedFrameMeta.push(...trackedItems);
      await frameQueue.pushMany(trackedItems.map((item) => item.value));
      await updateMonitoringSnapshot();
      return;
    }

    const pendingTrackedItems: TrackedBufferItem<TFrameItem>[] = [];
    const pendingItems: TFrameItem[] = [];

    for (const trackedItem of trackedItems) {
      const previousTrackedItem =
        pendingTrackedItems.length > 0
          ? pendingTrackedItems[pendingTrackedItems.length - 1]
          : queuedFrameMeta[queuedFrameMeta.length - 1];

      if (previousTrackedItem && previousTrackedItem.phase === trackedItem.phase) {
        const mergedItem = await mergeFrameItems(previousTrackedItem.value, trackedItem.value, {
          previousPhase: previousTrackedItem.phase,
          nextPhase: trackedItem.phase,
          pressureLevel,
        });

        if (mergedItem !== undefined) {
          const mergedTrackedItem = {
            ...previousTrackedItem,
            value: mergedItem,
            enqueuedAt: Math.min(previousTrackedItem.enqueuedAt, trackedItem.enqueuedAt),
          } satisfies TrackedBufferItem<TFrameItem>;

          if (pendingTrackedItems.length > 0) {
            pendingTrackedItems[pendingTrackedItems.length - 1] = mergedTrackedItem;
            pendingItems[pendingItems.length - 1] = mergedItem;
          } else {
            queuedFrameMeta[queuedFrameMeta.length - 1] = mergedTrackedItem;
            await frameQueue.replaceLast(mergedItem);
          }

          continue;
        }
      }

      pendingTrackedItems.push(trackedItem);
      pendingItems.push(trackedItem.value);
    }

    if (pendingItems.length > 0) {
      queuedFrameMeta.push(...pendingTrackedItems);
      await frameQueue.pushMany(pendingItems);
    }

    await updateMonitoringSnapshot();
  };

  /**
   * 将转换后的帧项推入帧队列，继承入口项的追踪元数据
   * phase 和 enqueuedAt 从对应 ingressItem 衍生，确保监控数据连续性
   */
  const pushFrameTrackedItems = async (
    items: readonly TFrameItem[],
    ingressItem: TrackedBufferItem<TIngressItem>,
    pressureLevel: SseRenderPressureLevel,
  ) => {
    if (items.length === 0) {
      return;
    }

    const trackedItems = await Promise.all(items.map((item) => createTrackedFrameItem(item, ingressItem)));
    await appendTrackedFrameItems(trackedItems, pressureLevel);
  };

  /**
   * 将延迟帧项重新放回队列头部，同时将对应的追踪元数据前置
   * 用于帧选择器 deferredItems 的回退，保证元数据与数据项始终对齐
   */
  const prependDeferredFrameItems = async (
    items: readonly TFrameItem[],
    trackedItems: readonly TrackedBufferItem<TFrameItem>[],
  ) => {
    if (items.length === 0) {
      return;
    }

    queuedFrameMeta = [...trackedItems, ...queuedFrameMeta];
    await frameQueue.prepend(items);
    await updateMonitoringSnapshot();
  };

  // ---- 内部缓冲队列 ----
  /** 入口数据缓冲队列 */
  const ingressQueue = createArrayBuffer<TIngressItem>(async () => undefined);
  /** 帧数据缓冲队列 */
  const frameQueue = createArrayBuffer<TFrameItem>(async () => undefined);

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
    const drainedFrameMeta = queuedFrameMeta;
    queuedFrameMeta = [];
    pendingFrameMeta = drainedFrameMeta;
    await updateMonitoringSnapshot();

    if (frameItems.length === 0) {
      return;
    }

    const pressureLevel = monitoring.value.pressureLevel;
    const selectFrameItems = options.selectFrameItems;
    let selection: SseRenderFrameSelection<TFrameItem>;
    if (typeof selectFrameItems === 'function') {
      const selectionHandler: NonNullable<typeof selectFrameItems> = selectFrameItems;
      selection = await selectionHandler(frameItems, {
        frameTimestamp,
        frameStartedAt,
        previousFrameTimestamp,
        queuedFrameCount: frameItems.length,
        remainingIngressCount: pendingIngress.length + (await ingressQueue.size()),
        pressureLevel,
      });
    } else {
      selection = {
        commitItems: frameItems,
        deferredItems: [],
      };
    }
    const commitItems = [...selection.commitItems];
    const deferredItems = [...(selection.deferredItems ?? [])];
    const effectiveCommitItems =
      pressureLevel === 'high' || pressureLevel === 'critical'
        ? commitItems.filter((item, index) => drainedFrameMeta[index]?.phase !== 'decorative')
        : commitItems;
    const deferredTrackedItems = deferredItems.map((item, index) => {
      const source = drainedFrameMeta[Math.min(index, Math.max(0, drainedFrameMeta.length - 1))];
      return {
        value: item,
        phase: source?.phase ?? 'unknown',
        enqueuedAt: source?.enqueuedAt ?? now(),
      } satisfies TrackedBufferItem<TFrameItem>;
    });

    if (effectiveCommitItems.length === 0) {
      // 本帧无提交项，将延迟项放回队列头部
      if (deferredItems.length > 0) {
        await prependDeferredFrameItems(deferredItems, deferredTrackedItems);
      }

      pendingFrameMeta = [];
      previousFrameTimestamp = frameTimestamp;
      return;
    }

    try {
      await options.commitFrame(effectiveCommitItems, {
        frameTimestamp,
        frameStartedAt,
        frameDurationMs: now() - frameStartedAt,
        committedItemCount: effectiveCommitItems.length,
        remainingIngressCount: pendingIngress.length + (await ingressQueue.size()),
      });

      // 提交成功后，将延迟项重新放回队列头部供后续帧处理
      if (deferredItems.length > 0) {
        await prependDeferredFrameItems(deferredItems, deferredTrackedItems);
      }

      lastCommittedItemCount = effectiveCommitItems.length;
      totalCommittedItemCount += effectiveCommitItems.length;
      pendingFrameMeta = [];
      previousFrameTimestamp = frameTimestamp;
    } catch (error) {
      // 提交失败时恢复所有帧项到队列头部，保证数据不丢失
      await prependDeferredFrameItems(frameItems, drainedFrameMeta);
      pendingFrameMeta = [];
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
    lastFrameStartedAt = frameStartedAt;
    frameCount += 1;
    const pressureLevel = monitoring.value.pressureLevel;
    const effectiveBudgetMs = (() => {
      if (pressureLevel === 'critical') return Math.min(frameBudgetMs, 1);
      if (pressureLevel === 'high') return Math.min(frameBudgetMs, 3);
      if (pressureLevel === 'busy') return Math.min(frameBudgetMs, 6);
      return frameBudgetMs;
    })();

    try {
      // ---- Ingress 处理阶段：在预算时间内转换入口数据到帧数据 ----
      while (true) {
        const elapsedMs = now() - frameStartedAt;
        if (elapsedMs >= effectiveBudgetMs) {
          break;
        }

        if (pendingIngress.length === 0) {
          const drainedIngress = await ingressQueue.drain();
          const drainedIngressMeta = queuedIngressMeta;
          queuedIngressMeta = [];
          if (drainedIngress.length === 0) {
            break;
          }

          pendingIngress.push(...drainedIngress);
          pendingIngressMeta.push(...drainedIngressMeta);
          await updateMonitoringSnapshot();
        }

        const nextItem = pendingIngress.shift();
        const nextTrackedIngress = pendingIngressMeta.shift();
        await updateMonitoringSnapshot();

        if (nextItem === undefined) {
          continue;
        }

        const frameItems = await normalizeFrameItems(await options.transformIngress(nextItem));
        if (frameItems.length > 0) {
          if (nextTrackedIngress) {
            await pushFrameTrackedItems(frameItems, nextTrackedIngress, pressureLevel);
          } else {
            await appendTrackedFrameItems(frameItems.map((item) => ({
              value: item,
              phase: 'unknown' as SseRenderPhase,
              enqueuedAt: now(),
            })), pressureLevel);
          }
        }
      }

      // ---- 帧提交阶段：将帧缓冲中的数据提交渲染 ----
      await commitBufferedFrame(frameTimestamp, frameStartedAt);
      lastFrameDurationMs.value = now() - frameStartedAt;
      // EWMA（指数加权移动平均）平滑帧耗时波动，α = 0.25 使近期帧权重较高
      frameCostEwmaMs = frameCostEwmaMs === 0
        ? lastFrameDurationMs.value
        : (frameCostEwmaMs * (1 - PRESSURE_EWMA_ALPHA)) + (lastFrameDurationMs.value * PRESSURE_EWMA_ALPHA);
      // 连续积压帧计数：仍有待处理工作时递增，否则清零
      commitLagFrames = (await hasPendingWork()) ? commitLagFrames + 1 : 0;
      await updateMonitoringSnapshot();
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
    await updateMonitoringSnapshot();
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

    await updateMonitoringSnapshot();
  };

  /** 入队一条入口数据，并尝试调度处理 */
  const enqueueIngress = async (item: TIngressItem) => {
    await pushIngressTrackedItems([item]);
    await scheduleNextFrame();
  };

  /** 批量入队入口数据，并尝试调度处理 */
  const enqueueIngressBatch = async (items: readonly TIngressItem[]) => {
    await pushIngressTrackedItems(items);
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
    queuedIngressMeta = [];
    pendingIngressMeta = [];
    queuedFrameMeta = [];
    pendingFrameMeta = [];
    previousFrameTimestamp = null;
    lastFrameStartedAt = null;
    frameCount = 0;
    totalCommittedItemCount = 0;
    lastCommittedItemCount = 0;
    frameCostEwmaMs = 0;
    commitLagFrames = 0;
    await ingressQueue.clear();
    await frameQueue.clear();
    lastFrameDurationMs.value = 0;
    await updateMonitoringSnapshot();
  };

  // ---- 对外暴露的缓冲接口 ----
  /** 入口缓冲区（外部可访问） */
  const ingressBuffer: SseIngressBuffer<TIngressItem> = {
    push: async (item) => {
      await pushIngressTrackedItems([item]);
      await scheduleNextFrame();
    },
    pushMany: async (items) => {
      await pushIngressTrackedItems(items);
      await scheduleNextFrame();
    },
    drain: async () => {
      const drained = await ingressQueue.drain();
      queuedIngressMeta = [];
      await updateMonitoringSnapshot();
      return drained;
    },
    size: async () => {
      return ingressQueue.size();
    },
    clear: async () => {
      await ingressQueue.clear();
      queuedIngressMeta = [];
      await updateMonitoringSnapshot();
    },
  };

  /** 帧缓冲区（外部可访问） */
  const frameBuffer: SseFrameBuffer<TFrameItem> = {
    push: async (item) => {
      await appendTrackedFrameItems([{
        value: item,
        phase: 'unknown',
        enqueuedAt: now(),
      }], monitoring.value.pressureLevel);
      await scheduleNextFrame();
    },
    pushMany: async (items) => {
      await appendTrackedFrameItems(items.map((item) => ({
        value: item,
        phase: 'unknown' as SseRenderPhase,
        enqueuedAt: now(),
      })), monitoring.value.pressureLevel);
      await scheduleNextFrame();
    },
    drain: async () => {
      const drained = await frameQueue.drain();
      queuedFrameMeta = [];
      await updateMonitoringSnapshot();
      return drained;
    },
    size: async () => {
      return frameQueue.size();
    },
    clear: async () => {
      await frameQueue.clear();
      queuedFrameMeta = [];
      await updateMonitoringSnapshot();
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
    monitoring: readonly(monitoring),
    start,
    stop,
    enqueueIngress,
    enqueueIngressBatch,
    flush,
    dispose,
  };
}
