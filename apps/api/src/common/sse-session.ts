import type { SseEnvelopeMessageEvent } from './sse';
import { SseEnvelopeFactory } from './sse';

interface SessionSubscriber<TType extends string> {
  next: (event: SseEnvelopeMessageEvent<TType>) => void;
  complete: () => void;
}

interface ReplayableSseSessionOptions<TType extends string> {
  idleAbortMs?: number;
  retainMs?: number;
  onIdleAbort?: () => void;
  onCleanup?: () => void;
}

/**
 * 可回放的 SSE 会话，负责缓存事件并支持断线后的增量补发。
 */
export class ReplayableSseSession<TType extends string> {
  private readonly envelope: SseEnvelopeFactory<TType>;
  private readonly events: Array<SseEnvelopeMessageEvent<TType>> = [];
  private readonly subscribers = new Set<SessionSubscriber<TType>>();
  private readonly idleAbortMs: number;
  private readonly retainMs: number;
  private readonly onIdleAbort?: () => void;
  private readonly onCleanup?: () => void;
  private idleAbortTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private terminal = false;

  constructor(
    readonly key: string,
    runId: string,
    options: ReplayableSseSessionOptions<TType> = {},
  ) {
    this.envelope = new SseEnvelopeFactory<TType>(runId);
    this.idleAbortMs = options.idleAbortMs ?? 10_000;
    this.retainMs = options.retainMs ?? 60_000;
    this.onIdleAbort = options.onIdleAbort;
    this.onCleanup = options.onCleanup;
  }

  /**
   * 追加一条新事件，并同步推送给当前在线订阅者。
   */
  emit<TPayload extends Record<string, unknown>>(
    type: TType,
    payload: TPayload,
  ): SseEnvelopeMessageEvent<TType, TPayload> | null {
    if (this.terminal) {
      return null;
    }

    const event = this.envelope.create(type, payload);
    this.events.push(event);

    for (const subscriber of this.subscribers) {
      subscriber.next(event);
    }

    return event;
  }

  /**
   * 按 sinceSeq 回放缺失事件，并在会话未结束时继续订阅后续增量。
   */
  subscribe(
    subscriber: SessionSubscriber<TType>,
    sinceSeq = 0,
  ): () => void {
    this.clearIdleAbortTimer();
    this.clearCleanupTimer();

    for (const event of this.events) {
      if (event.data.seq > sinceSeq) {
        subscriber.next(event);
      }
    }

    if (this.terminal) {
      subscriber.complete();
      this.scheduleCleanup();
      return () => undefined;
    }

    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
      if (this.subscribers.size === 0 && !this.terminal) {
        this.scheduleIdleAbort();
      }
    };
  }

  /**
   * 标记会话结束，并通知所有订阅者完成。
   */
  complete(): void {
    if (this.terminal) {
      return;
    }

    this.terminal = true;
    this.clearIdleAbortTimer();

    for (const subscriber of this.subscribers) {
      subscriber.complete();
    }

    this.subscribers.clear();
    this.scheduleCleanup();
  }

  /**
   * 暴露当前会话是否已经结束。
   */
  get isTerminal(): boolean {
    return this.terminal;
  }

  private scheduleIdleAbort(): void {
    this.clearIdleAbortTimer();
    this.idleAbortTimer = setTimeout(() => {
      this.idleAbortTimer = null;
      this.onIdleAbort?.();
    }, this.idleAbortMs);
    this.unrefTimer(this.idleAbortTimer);
  }

  private scheduleCleanup(): void {
    this.clearCleanupTimer();
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = null;
      this.onCleanup?.();
    }, this.retainMs);
    this.unrefTimer(this.cleanupTimer);
  }

  private clearIdleAbortTimer(): void {
    if (!this.idleAbortTimer) {
      return;
    }

    clearTimeout(this.idleAbortTimer);
    this.idleAbortTimer = null;
  }

  private clearCleanupTimer(): void {
    if (!this.cleanupTimer) {
      return;
    }

    clearTimeout(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  private unrefTimer(timer: ReturnType<typeof setTimeout> | null): void {
    const candidate = timer as { unref?: () => void } | null;
    candidate?.unref?.();
  }
}

/**
 * 维护进程内 SSE 会话表，按 streamKey 复用同一条流式任务。
 */
export class ReplayableSseSessionStore<TType extends string> {
  private readonly sessions = new Map<string, ReplayableSseSession<TType>>();

  /**
   * 读取指定 streamKey 对应的会话。
   */
  get(key: string): ReplayableSseSession<TType> | undefined {
    return this.sessions.get(key);
  }

  /**
   * 创建并注册一个新的可回放会话。
   */
  create(
    key: string,
    runId: string,
    options: Omit<ReplayableSseSessionOptions<TType>, 'onCleanup'> = {},
  ): ReplayableSseSession<TType> {
    const session = new ReplayableSseSession<TType>(key, runId, {
      ...options,
      onCleanup: () => {
        this.sessions.delete(key);
      },
    });

    this.sessions.set(key, session);
    return session;
  }
}
