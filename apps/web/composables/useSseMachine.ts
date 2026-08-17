/**
 * SSE 连接状态机（useSseMachine）
 *
 * 用有限状态机管理 Server-Sent Events（SSE）连接的生命周期，
 * 覆盖 idle / connecting / streaming / done / error / canceled / retrying / paused
 * 等状态，并通过 LEGAL_TRANSITIONS 约束状态间的合法迁移。
 * 单次连接的建立、消费、取消、失败都由本机负责；
 * 外层重试策略由 SseSupervisor 编排，两者职责分离。
 */

/**
 * 状态机的全部合法状态。
 * - idle: 初始空闲态
 * - connecting: 已发起 fetch，等待响应返回
 * - streaming: 响应已到达，正在消费事件流
 * - done: 流正常结束
 * - error: 发生不可重试（或未经重试处理）的错误
 * - canceled: 被主动取消
 * - retrying: 等待重试期间所处的过渡态
 * - paused: 暂停消费流
 */
export type SseMachineStateValue =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'done'
  | 'error'
  | 'canceled'
  | 'retrying'
  | 'paused';

/**
 * 状态机可接收的事件（对应外部动作或内部回调）。
 */
export type SseMachineEvent =
  | 'CONNECT'
  | 'CONNECTED'
  | 'TIMEOUT'
  | 'CANCEL'
  | 'ERROR'
  | 'COMPLETE'
  | 'RESET'
  | 'RETRY'
  | 'PAUSE'
  | 'RESUME';

/**
 * 状态机上下文：记录错误信息与已发生的重试次数。
 */
export interface SseMachineStateContext {
  error?: unknown;
  retryCount?: number;
}

/**
 * 状态快照：当前状态值 + 上下文，用于对外暴露和状态变更回调。
 */
export interface SseMachineStateSnapshot {
  value: SseMachineStateValue;
  context: SseMachineStateContext;
}

/**
 * 状态变更回调：参数为迁移前后的两个快照。
 */
export type SseMachineStateChangeHandler = (
  from: SseMachineStateSnapshot,
  to: SseMachineStateSnapshot,
) => void;

interface SseMachineOptions {
  /** 消费已建立的响应流；streaming 期间通过 signal 感知取消/中止。 */
  consumeResponse: (response: Response, signal: AbortSignal) => Promise<void>;
  /** 状态每次迁移后的通知回调（可选）。 */
  onStateChange?: SseMachineStateChangeHandler;
  /** 自定义“中止错误”的判定逻辑（默认按 AbortError 判断）。 */
  isAbortError?: (error: unknown) => boolean;
}

/**
 * 合法迁移表：记录每个状态下可接受的事件及迁移目标状态。
 * 状态机只允许发生表中定义的迁移，其余一律视为非法。
 */
const LEGAL_TRANSITIONS: Readonly<
  Record<SseMachineStateValue, Partial<Record<SseMachineEvent, SseMachineStateValue>>>
> = {
  idle: {
    CONNECT: 'connecting',
  },
  connecting: {
    CONNECTED: 'streaming',
    TIMEOUT: 'error',
    CANCEL: 'canceled',
    ERROR: 'error',
  },
  streaming: {
    COMPLETE: 'done',
    CANCEL: 'canceled',
    ERROR: 'error',
    PAUSE: 'paused',
  },
  done: {
    RESET: 'idle',
  },
  error: {
    RESET: 'idle',
    RETRY: 'retrying',
    CANCEL: 'canceled',
  },
  canceled: {
    RESET: 'idle',
  },
  retrying: {
    CONNECT: 'connecting',
    CANCEL: 'canceled',
  },
  paused: {
    RESUME: 'streaming',
    CANCEL: 'canceled',
  },
};

const GLOBAL_NODE_ENV =
  typeof globalThis === 'object' &&
  'process' in globalThis &&
  typeof (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.['NODE_ENV'] === 'string'
    ? (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.['NODE_ENV']
    : undefined;

// 非生产环境（开发模式）下，非法迁移直接抛错以尽早暴露问题
const DEV_MODE = GLOBAL_NODE_ENV !== 'production';

/**
 * SSE 连接状态机。
 *
 * 职责：
 * 1. 对外暴露当前状态快照与 AbortSignal；
 * 2. 驱动一次连接的完整生命周期（connecting -> streaming -> done/error/canceled）；
 * 3. 通过 activeRunId 防止旧连接的回调污染新连接（竞态保护）。
 */
export class SseMachine {
  /** 状态变更回调（可随时替换）。 */
  public onStateChange?: SseMachineStateChangeHandler;

  private currentState: SseMachineStateValue = 'idle';
  private context: SseMachineStateContext = {};
  private controller: AbortController | null = null;
  private activeRunId = 0;
  private readonly consumeResponse: SseMachineOptions['consumeResponse'];
  private readonly isAbortError: NonNullable<SseMachineOptions['isAbortError']>;

  constructor(options: SseMachineOptions) {
    this.consumeResponse = options.consumeResponse;
    this.onStateChange = options.onStateChange;
    this.isAbortError =
      options.isAbortError ??
      ((error) =>
        error instanceof DOMException
          ? error.name === 'AbortError'
          : error instanceof Error && error.name === 'AbortError');
  }

  /** 返回当前状态快照（上下文为拷贝，避免外部误改内部状态）。 */
  get state(): SseMachineStateSnapshot {
    return {
      value: this.currentState,
      context: { ...this.context },
    };
  }

  /** 返回当前连接对应的 AbortSignal，用于传递给 fetch 及流消费。 */
  get signal(): AbortSignal {
    return this.ensureController().signal;
  }

  /**
   * 发起一次连接并消费响应流。
   * - fetch 成功且未被取消后进入 streaming，并调用 consumeResponse；
   * - 流消费完成后进入 done；
   * - 主动取消 / AbortError 进入 canceled；
   * - 其余错误进入 error，并将错误重新抛出（交由上层决定是否重试）。
   */
  async connect(fetchPromise: Promise<Response>): Promise<void> {
    this.transition('CONNECT');
    // 每轮连接使用递增的 runId，用于忽略过期请求的后续回调
    const runId = ++this.activeRunId;
    const signal = this.ensureController().signal;

    try {
      const response = await fetchPromise;
      // 等待期间可能已被重置/取消，此时丢弃过期响应
      if (!this.isActiveRun(runId) || this.isCanceledState()) {
        return;
      }

      this.transition('CONNECTED');
      await this.consumeResponse(response, signal);

      // 消费结束后若仍处于当前运行且未被取消，则正常收尾
      if (!this.isActiveRun(runId) || this.isCanceledState()) {
        return;
      }

      this.transition('COMPLETE');
    } catch (error) {
      // 过期运行的错误一律忽略
      if (!this.isActiveRun(runId)) {
        return;
      }

      // 已取消状态下不重复处理错误
      if (this.isCanceledState()) {
        return;
      }

      // 中止错误：连接/流式阶段视为用户主动取消，不向上抛出
      if (this.isAbortError(error)) {
        if (this.currentState === 'connecting' || this.currentState === 'streaming') {
          this.transition('CANCEL');
        }
        return;
      }

      // 其他错误：迁移到 error 并抛出，交由上层决定是否重试
      this.transition('ERROR', { error });
      throw error;
    } finally {
      // 仅当前运行结束时释放 AbortController
      if (this.isActiveRun(runId)) {
        this.cleanupController();
      }
    }
  }

  /** 主动取消：迁移到 canceled 并中止底层请求。 */
  cancel(): void {
    if (this.isCanceledState()) {
      return;
    }

    this.transition('CANCEL');
    this.controller?.abort();
  }

  /** 重置到初始 idle 状态（废弃旧运行的 controller 并作废其 runId）。 */
  reset(): void {
    this.activeRunId += 1;
    this.cleanupController();
    this.transition('RESET');
  }

  /** 进入 retrying 状态（由 SseSupervisor 在重试前调用）。 */
  retry(): void {
    this.transition('RETRY');
  }

  /** 暂停流消费（streaming -> paused）。 */
  pause(): void {
    this.transition('PAUSE');
  }

  /** 从暂停态恢复流消费（paused -> streaming）。 */
  resume(): void {
    this.transition('RESUME');
  }

  /** 连接超时：迁移到 error，可携带超时原因。 */
  timeout(error?: unknown): void {
    this.transition('TIMEOUT', error === undefined ? undefined : { error });
  }

  /** 执行一次状态迁移；非法迁移在开发模式下抛错，生产环境仅告警。 */
  private transition(event: SseMachineEvent, contextPatch?: Partial<SseMachineStateContext>): void {
    const nextState = LEGAL_TRANSITIONS[this.currentState][event];
    if (!nextState) {
      this.handleIllegalTransition(event);
      return;
    }

    const previousSnapshot = this.state;
    this.currentState = nextState;
    this.context = this.buildNextContext(event, contextPatch);

    this.onStateChange?.(previousSnapshot, this.state);
  }

  /** 依据事件类型计算迁移后的上下文（retryCount 递增、error 回填等）。 */
  private buildNextContext(
    event: SseMachineEvent,
    contextPatch?: Partial<SseMachineStateContext>,
  ): SseMachineStateContext {
    const retryCount = this.context.retryCount ?? 0;

    switch (event) {
      case 'CONNECT':
      case 'CONNECTED':
      case 'COMPLETE':
      case 'CANCEL':
      case 'PAUSE':
      case 'RESUME':
        return {
          retryCount,
        };
      case 'ERROR':
      case 'TIMEOUT':
        return {
          retryCount,
          error: contextPatch?.error,
        };
      case 'RESET':
        return {};
      case 'RETRY':
        return {
          retryCount: retryCount + 1,
        };
      default:
        return { ...this.context };
    }
  }

  /** 惰性创建并缓存 AbortController，保证整轮连接共用同一个 signal。 */
  private ensureController(): AbortController {
    if (!this.controller) {
      this.controller = new AbortController();
    }

    return this.controller;
  }

  /** 释放当前 AbortController 引用（reset/连接结束后调用）。 */
  private cleanupController(): void {
    this.controller = null;
  }

  /** 处理非法迁移：开发模式抛错暴露问题，生产环境降级为告警。 */
  private handleIllegalTransition(event: SseMachineEvent): void {
    const message = `[SseMachine] Illegal transition: ${this.currentState} -> ${event}`;
    if (DEV_MODE) {
      throw new Error(message);
    }

    console.warn(message);
  }

  /** 判断指定 runId 是否仍属于当前运行（用于忽略过期回调）。 */
  private isActiveRun(runId: number): boolean {
    return runId === this.activeRunId;
  }

  /** 当前是否已处于 canceled 状态。 */
  private isCanceledState(): boolean {
    return this.currentState === 'canceled';
  }
}

/** 创建 SSE 状态机实例（组合式函数入口）。 */
export function useSseMachine(options: SseMachineOptions) {
  return new SseMachine(options);
}
