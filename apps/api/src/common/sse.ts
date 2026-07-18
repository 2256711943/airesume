import type { MessageEvent } from '@nestjs/common';

/**
 * 统一描述单条 SSE 事件的信封结构，便于前后端按 seq 做续传与去重。
 */
export interface SseEventEnvelope<
  TType extends string = string,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  id: string;
  seq: number;
  runId: string;
  spanId?: string;
  type: TType;
  ts: string;
  payload: TPayload;
}

export type SseEnvelopeMessageEvent<
  TType extends string = string,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> = MessageEvent & {
  event: TType;
  id: string;
  type: TType;
  data: SseEventEnvelope<TType, TPayload>;
};

/**
 * 为同一条流生成带递增 seq 的 SSE 事件。
 */
export class SseEnvelopeFactory<TType extends string = string> {
  private seq = 0;

  constructor(
    private readonly runId: string,
    private readonly spanId?: string,
  ) {}

  /**
   * 生成一条带 envelope 元数据的 SSE 消息。
   */
  create<TPayload extends Record<string, unknown>>(
    type: TType,
    payload: TPayload,
  ): SseEnvelopeMessageEvent<TType, TPayload> {
    const seq = ++this.seq;
    const id = `${this.runId}:${seq}`;

    return {
      event: type,
      id,
      type,
      data: {
        id,
        seq,
        runId: this.runId,
        spanId: this.spanId,
        type,
        ts: new Date().toISOString(),
        payload,
        ...payload,
      },
    };
  }
}
