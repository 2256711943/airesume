import type { SseEnvelopeMessageEvent } from './sse';
import { SseEnvelopeFactory } from './sse';

interface SessionSubscriber<TType extends string> {
  next: (event: SseEnvelopeMessageEvent<TType>) => void;
  complete: () => void;
}

interface ReplayableSseSessionOptions {
  idleAbortMs?: number;
  retainMs?: number;
  onIdleAbort?: () => void;
  onCleanup?: () => void;
}

export type SseStreamControlLevel = 'high' | 'critical';

export interface SseStreamControlHints {
  minProgressIntervalMs?: number;
  textChunkTargetChars?: number;
  suppressTypes?: string[];
}

export interface SseStreamControlState {
  level: SseStreamControlLevel;
  expiresAt: number;
  hints: SseStreamControlHints;
}

interface BufferedTextEvent<TType extends string> {
  type: TType;
  payload: Record<string, unknown>;
  text: string;
}

const ALWAYS_ALLOWED_EVENT_TYPES = new Set(['done', 'error', 'canceled', 'checkpoint']);
const GLOBAL_SESSIONS = new Map<string, ReplayableSseSession<string>>();

export function getReplayableSseSession<TType extends string = string>(
  key: string,
): ReplayableSseSession<TType> | undefined {
  return GLOBAL_SESSIONS.get(key) as ReplayableSseSession<TType> | undefined;
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
  private controlState: SseStreamControlState | null = null;
  private pendingTextEvent: BufferedTextEvent<TType> | null = null;
  private lastProgressAt: number | null = null;

  constructor(
    readonly key: string,
    runId: string,
    options: ReplayableSseSessionOptions = {},
  ) {
    this.envelope = new SseEnvelopeFactory<TType>(runId);
    this.idleAbortMs = options.idleAbortMs ?? 10_000;
    this.retainMs = options.retainMs ?? 60_000;
    this.onIdleAbort = options.onIdleAbort;
    this.onCleanup = options.onCleanup;
    GLOBAL_SESSIONS.set(this.key, this as ReplayableSseSession<string>);
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

    const nowMs = Date.now();
    const activeControl = this.getActiveControlState(nowMs);

    if (!activeControl) {
      this.flushPendingTextEvent();
      return this.publishEvent(type, payload);
    }

    if (ALWAYS_ALLOWED_EVENT_TYPES.has(type)) {
      this.flushPendingTextEvent();
      return this.publishEvent(type, payload);
    }

    if (this.shouldSuppressType(type, activeControl)) {
      return null;
    }

    if (type === 'progress') {
      const minProgressIntervalMs = this.normalizePositiveInt(
        activeControl.hints.minProgressIntervalMs,
      );
      if (
        minProgressIntervalMs !== null &&
        this.lastProgressAt !== null &&
        nowMs - this.lastProgressAt < minProgressIntervalMs
      ) {
        return null;
      }

      this.lastProgressAt = nowMs;
      return this.publishEvent(type, payload);
    }

    const text = this.extractText(payload);
    const textChunkTargetChars = this.normalizePositiveInt(
      activeControl.hints.textChunkTargetChars,
    );
    if (text !== null && textChunkTargetChars !== null) {
      return this.handleTextChunkEvent(type, payload, text, textChunkTargetChars);
    }

    this.flushPendingTextEvent();
    return this.publishEvent(type, payload);
  }

  /**
   * 按 sinceSeq 回放缺失事件，并在会话未结束时继续订阅后续增量。
   */
  subscribe(subscriber: SessionSubscriber<TType>, sinceSeq = 0): () => void {
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

    this.flushPendingTextEvent();
    this.terminal = true;
    this.clearIdleAbortTimer();
    this.clearCleanupTimer();
    this.controlState = null;

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

  setControlState(state: SseStreamControlState | null): void {
    if (state === null) {
      this.clearControlState();
      return;
    }

    this.controlState = state;
    this.lastProgressAt = null;
  }

  clearControlState(): void {
    this.controlState = null;
    this.lastProgressAt = null;
    this.flushPendingTextEvent();
  }

  getControlState(): SseStreamControlState | null {
    return this.controlState;
  }

  private publishEvent<TPayload extends Record<string, unknown>>(
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

  private flushPendingTextEvent(): SseEnvelopeMessageEvent<TType> | null {
    const buffered = this.pendingTextEvent;
    if (!buffered) {
      return null;
    }

    this.pendingTextEvent = null;
    return this.publishEvent(buffered.type, {
      ...buffered.payload,
      text: buffered.text,
    });
  }

  private handleTextChunkEvent<TPayload extends Record<string, unknown>>(
    type: TType,
    payload: TPayload,
    text: string,
    textChunkTargetChars: number,
  ): SseEnvelopeMessageEvent<TType, TPayload> | null {
    if (text.length === 0) {
      this.flushPendingTextEvent();
      return this.publishEvent(type, payload);
    }

    const buffered = this.pendingTextEvent;
    if (buffered && buffered.type !== type) {
      this.flushPendingTextEvent();
    }

    if (this.pendingTextEvent) {
      const mergedText = `${this.pendingTextEvent.text}${text}`;
      this.pendingTextEvent = {
        type,
        payload: {
          ...this.pendingTextEvent.payload,
          ...payload,
          text: mergedText,
        },
        text: mergedText,
      };
    } else {
      this.pendingTextEvent = {
        type,
        payload: {
          ...payload,
        },
        text,
      };
    }

    if (this.pendingTextEvent.text.length < textChunkTargetChars) {
      return null;
    }

    return this.flushPendingTextEvent() as SseEnvelopeMessageEvent<TType, TPayload> | null;
  }

  private getActiveControlState(nowMs: number): SseStreamControlState | null {
    if (this.controlState && nowMs >= this.controlState.expiresAt) {
      this.controlState = null;
      this.lastProgressAt = null;
    }

    return this.controlState;
  }

  private shouldSuppressType(
    type: string,
    controlState: SseStreamControlState,
  ): boolean {
    const suppressTypes = controlState.hints.suppressTypes ?? [];
    return suppressTypes.includes(type) && !ALWAYS_ALLOWED_EVENT_TYPES.has(type);
  }

  private extractText(payload: Record<string, unknown>): string | null {
    const text = payload.text;
    return typeof text === 'string' && text.length > 0 ? text : null;
  }

  private normalizePositiveInt(value: number | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }

    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : null;
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
    options: Omit<ReplayableSseSessionOptions, 'onCleanup'> = {},
  ): ReplayableSseSession<TType> {
    const session = new ReplayableSseSession<TType>(key, runId, {
      ...options,
      onCleanup: () => {
        this.sessions.delete(key);
        if (GLOBAL_SESSIONS.get(key) === session) {
          GLOBAL_SESSIONS.delete(key);
        }
      },
    });

    this.sessions.set(key, session);
    return session;
  }
}
