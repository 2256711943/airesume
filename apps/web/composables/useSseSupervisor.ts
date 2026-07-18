import {
  useSseMachine,
  type SseMachine,
  type SseMachineStateChangeHandler,
  type SseMachineStateSnapshot,
} from './useSseMachine';

interface SseSupervisorRequestContext {
  attempt: number;
  signal: AbortSignal;
}

interface SseSupervisorOptions {
  consumeResponse: (response: Response, signal: AbortSignal) => Promise<void>;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  getRetryDelayMs?: (attempt: number) => number;
  maxRetries?: number;
  onStateChange?: SseMachineStateChangeHandler;
  isAbortError?: (error: unknown) => boolean;
}

function defaultRetryDelayMs(attempt: number): number {
  return 300 * (2 ** Math.min(Math.max(attempt, 1) - 1, 4));
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

  get state(): SseMachineStateSnapshot {
    return this.machine.state;
  }

  get signal(): AbortSignal {
    return this.machine.signal;
  }

  get onStateChange(): SseMachineStateChangeHandler | undefined {
    return this.machine.onStateChange;
  }

  set onStateChange(handler: SseMachineStateChangeHandler | undefined) {
    this.machine.onStateChange = handler;
  }

  /**
   * 建立 SSE 连接，并在满足策略时自动重试。
   */
  async connect(
    createRequest: (context: SseSupervisorRequestContext) => Promise<Response>,
  ): Promise<void> {
    let attempt = 0;

    while (true) {
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
        return;
      } catch (error) {
        if (this.machine.state.value === 'canceled') {
          return;
        }

        const nextAttempt = attempt + 1;
        if (nextAttempt > this.maxRetries || !this.shouldRetry(error, nextAttempt)) {
          throw error;
        }

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
