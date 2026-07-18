/**
 * 前端消费的 SSE envelope 结构，与服务端信封协议保持一致。
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

interface ParsedSseFrame {
  event?: string;
  data: string;
}

/**
 * 表示服务端在未发送终态事件前就提前断开了连接。
 */
export class SseStreamDisconnectedError extends Error {
  constructor(message = 'SSE stream disconnected before a terminal event was received.') {
    super(message);
    this.name = 'SseStreamDisconnectedError';
  }
}

function isSseEventEnvelope(value: unknown): value is SseEventEnvelope {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.seq === 'number' &&
    typeof candidate.runId === 'string' &&
    typeof candidate.type === 'string' &&
    typeof candidate.ts === 'string' &&
    !!candidate.payload &&
    typeof candidate.payload === 'object'
  );
}

function parseSseFrame(frame: string): ParsedSseFrame | null {
  const lines = frame.split('\n');
  let eventName: string | undefined;
  const dataParts: string[] = [];

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      continue;
    }

    if (line.startsWith('data:')) {
      dataParts.push(line.slice(5).trim());
    }
  }

  if (dataParts.length === 0) {
    return null;
  }

  return {
    event: eventName,
    data: dataParts.join('\n'),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

/**
 * 读取并消费 SSE 文本流，按 seq 去重后回调增量事件。
 */
export async function consumeSseEventEnvelopeStream<TType extends string>(
  body: ReadableStream<Uint8Array>,
  options: {
    onEvent: (envelope: SseEventEnvelope<TType>) => void;
    isTerminalEvent: (type: TType) => boolean;
    lastSeq?: number;
    requireTerminalEvent?: boolean;
  },
): Promise<{ lastSeq: number; sawTerminalEvent: boolean }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastSeq = options.lastSeq ?? 0;
  let sawTerminalEvent = false;

  const consumeFrame = (frame: string) => {
    const parsed = parseSseFrame(frame);
    if (!parsed) {
      return;
    }

    try {
      const payload = JSON.parse(parsed.data) as unknown;
      let envelope: SseEventEnvelope<TType> | null = null;

      if (isSseEventEnvelope(payload)) {
        envelope = payload as SseEventEnvelope<TType>;
      } else if (parsed.event) {
        const record = isPlainObject(payload) ? payload : { value: payload };
        envelope = {
          id: typeof record.id === 'string' ? record.id : `${parsed.event}-${lastSeq + 1}`,
          seq: typeof record.seq === 'number' ? record.seq : lastSeq + 1,
          runId: typeof record.runId === 'string' ? record.runId : '',
          spanId: typeof record.spanId === 'string' ? record.spanId : undefined,
          type: parsed.event as TType,
          ts: typeof record.ts === 'string' ? record.ts : new Date().toISOString(),
          payload: record,
        };
      } else {
        return;
      }

      if (parsed.event && parsed.event !== envelope.type) {
        return;
      }

      if (envelope.seq <= lastSeq) {
        return;
      }

      lastSeq = envelope.seq;
      options.onEvent(envelope);

      if (options.isTerminalEvent(envelope.type)) {
        sawTerminalEvent = true;
      }
    } catch {
      // Ignore malformed frames and continue consuming the stream.
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      consumeFrame(frame);
    }
  }

  if (buffer.trim().length > 0) {
    consumeFrame(buffer);
  }

  if (options.requireTerminalEvent !== false && !sawTerminalEvent) {
    throw new SseStreamDisconnectedError();
  }

  return {
    lastSeq,
    sawTerminalEvent,
  };
}
