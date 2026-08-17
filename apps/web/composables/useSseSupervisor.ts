import {
  useSseMachine,
  type SseMachine,
  type SseMachineStateChangeHandler,
  type SseMachineStateSnapshot,
} from './useSseMachine';

/**
 * SSE 连接监督器（useSseSupervisor）
 *
 * 在 SseMachine 状态机之上封装「连接 + 指数退避重连」逻辑：
 * - 由调用方通过 createRequest 构造 fetch 请求（携带 attempt 与 signal）；
 * - 连接失败时依据 shouldRetry / maxRetries / getRetryDelayMs 决定是否重试；
 * - 支持 cancel / reset / pause / resume，与底层状态机保持一致。
 */

/**
 * 每次重连时传给 createRequest 的上下文：
 * - attempt: 当前尝试次数（0 表示首次连接）
 * - signal: 本轮的 AbortSignal，用于中断请求或流消费
 */
interface SseSupervisorRequestContext {
  attempt: number;
  signal: AbortSignal;
}

interface SseSupervisorOptions {
  /** 消费已建立的 SSE 响应流。 */
  consumeResponse: (response: Response, signal: AbortSignal) => Promise<void>;
  /** 判定某个错误是否可重试（默认一律不重试）。 */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** 计算第 attempt 次重试前的等待时长（默认指数退避 + 随机抖动）。 */
  getRetryDelayMs?: (attempt: number) => number;
  /** 最大重试次数（默认 0，即不重试）。 */
  maxRetries?: number;
  /** 状态迁移回调，透传给底层状态机。 */
  onStateChange?: SseMachineStateChangeHandler;
  /** 自定义中止错误判定，透传给底层状态机。 */
  isAbortError?: (error: unknown) => boolean;
}

/** 默认退避策略：指数增长并封顶 30s，同时叠加随机抖动以错峰重连。 */
function defaultRetryDelayMs(attempt: number): number {
  const baseMs = 1000;
  const maxMs = 30_000;
  const exponent = Math.min(attempt - 1, 5);
  const cap = Math.min(maxMs, baseMs * (2 ** exponent));
  return Math.random() * cap;
}

/**
 * 负责管理 SSE 连接状态机，并在可重试错误上执行退避重连。
 */
export class SseSupervisor {
  private readonly machine: SseMachine;
  private readonly shouldRetry: NonNullable<SseSupervisorOptions['shouldRetry']>;
  private readonly getRetryDelayMs: NonNullable<SseSupervisorOptions['getRetryDelayMs']>;
  private readonly maxRetries: number;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryResolver: (() => void) | null = null;

  constructor(options: SseSupervisorOptions) {
    this.machine = useSseMachine({
      consumeResponse: options.consumeResponse,
      onStateChange: options.onStateChange,
      isAbortError: options.isAbortError,
    });
    this.shouldRetry = options.shouldRetry ?? (() => false);
    this.getRetryDelayMs = options.getRetryDelayMs ?? defaultRetryDelayMs;
    this.maxRetries = options.maxRetries ?? 0;
  }

  /** 当前状态机快照。 */
  get state(): SseMachineStateSnapshot {
    return this.machine.state;
  }

  /** 当前连接对应的 AbortSignal。 */
  get signal(): AbortSignal {
    return this.machine.signal;
  }

  /** 状态变更回调（读）。 */
  get onStateChange(): SseMachineStateChangeHandler | undefined {
    return this.machine.onStateChange;
  }

  /** 状态变更回调（写）。 */
  set onStateChange(handler: SseMachineStateChangeHandler | undefined) {
    this.machine.onStateChange = handler;
  }

  /**
   * 建立 SSE 连接，并在满足策略时自动重试。
   * - 每次失败后按 shouldRetry 判断是否重试、按 getRetryDelayMs 等待；
   * - 超过 maxRetries 或不可重试时，将错误重新抛出；
   * - 等待期间被 cancel 则直接静默返回。
   */
  async connect(
    createRequest: (context: SseSupervisorRequestContext) => Promise<Response>,
  ): Promise<void> {
    let attempt = 0;

    while (true) {
      // 重试前先让状态机进入 retrying（首次连接无需）
      if (attempt > 0) {
        this.machine.retry();
      }

      try {
        await this.machine.connect(
          createRequest({
            attempt,
            signal: this.machine.signal,
          }),
        );
        // 连接成功并完成消费，直接返回
        return;
      } catch (error) {
        // 已取消则停止重试流程
        if (this.machine.state.value === 'canceled') {
          return;
        }

        // 超出最大重试次数或该错误不可重试，向上抛出
        const nextAttempt = attempt + 1;
        if (nextAttempt > this.maxRetries || !this.shouldRetry(error, nextAttempt)) {
          throw error;
        }

        // 退避等待；期间若被取消则静默退出
        await this.wait(this.getRetryDelayMs(nextAttempt));
        if ((this.machine.state.value as string) === 'canceled') {
          return;
        }

        attempt = nextAttempt;
      }
    }
  }

  /**
   * 取消当前连接及等待中的重试。
   */
  cancel(): void {
    this.clearRetryTimer();
    this.machine.cancel();
  }

  /**
   * 重置 supervisor 到初始状态。
   */
  reset(): void {
    this.clearRetryTimer();
    this.machine.reset();
  }

  /**
   * 将状态机切换到暂停态。
   */
  pause(): void {
    this.machine.pause();
  }

  /**
   * 从暂停态恢复状态机。
   */
  resume(): void {
    this.machine.resume();
  }

  /**
   * 延时等待：注册 setTimeout 与 resolve 引用，便于 cancel 时提前唤醒。
   */
  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.retryResolver = resolve;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.retryResolver = null;
        resolve();
      }, ms);
    });
  }

  /** 清除退避定时器；若正在等待则立即唤醒等待方。 */
  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    if (this.retryResolver) {
      const resolve = this.retryResolver;
      this.retryResolver = null;
      resolve();
    }
  }
}

/**
 * 创建一个带重试能力的 SSE supervisor 实例。
 */
export function useSseSupervisor(options: SseSupervisorOptions) {
  return new SseSupervisor(options);
}
