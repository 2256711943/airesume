import type { MessageEvent } from '@nestjs/common';

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

export class SseEnvelopeFactory<TType extends string = string> {
  private seq = 0;

  constructor(
    private readonly runId: string,
    private readonly spanId?: string,
  ) {}

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
