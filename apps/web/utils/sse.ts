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
 * 将已切分的 SSE 帧解析为结构化 envelope。
 * 仅负责解析与校验：JSON 非法或结构不符视为坏帧，返回 null 交由调用方跳过。
 */
function parseEnvelopeFrame<TType extends string>(
  parsed: ParsedSseFrame,
  lastSeq: number,
): SseEventEnvelope<TType> | null {
  try {
    const payload = JSON.parse(parsed.data) as unknown;

    if (isSseEventEnvelope(payload)) {
      return payload as SseEventEnvelope<TType>;
    }

    if (!parsed.event) {
      return null;
    }

    const record = isPlainObject(payload) ? payload : { value: payload };
    return {
      id: typeof record.id === 'string' ? record.id : `${parsed.event}-${lastSeq + 1}`,
      seq: typeof record.seq === 'number' ? record.seq : lastSeq + 1,
      runId: typeof record.runId === 'string' ? record.runId : '',
      spanId: typeof record.spanId === 'string' ? record.spanId : undefined,
      type: parsed.event as TType,
      ts: typeof record.ts === 'string' ? record.ts : new Date().toISOString(),
      payload: record,
    };
  } catch {
    // 坏帧（JSON 非法）：跳过该帧，继续消费
    return null;
  }
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

    const envelope = parseEnvelopeFrame<TType>(parsed, lastSeq);
    if (!envelope) {
      return; // 坏帧或结构不符：跳过该帧，继续消费
    }

    if (parsed.event && parsed.event !== envelope.type) {
      return;
    }

    if (envelope.seq <= lastSeq) {
      return;
    }

    lastSeq = envelope.seq;
    // onEvent 为业务回调：其异常必须冒泡（由上层 supervisor 决定重试或报错），
    // 不能当作坏帧吞掉，否则会掩盖真实错误。
    options.onEvent(envelope);

    if (options.isTerminalEvent(envelope.type)) {
      sawTerminalEvent = true;
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
