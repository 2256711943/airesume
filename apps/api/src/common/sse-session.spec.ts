import {
  ReplayableSseSession,
  type SseStreamControlLevel,
} from './sse-session';

type TestEventType =
  | 'assistant_chunk'
  | 'progress'
  | 'done'
  | 'error'
  | 'canceled'
  | 'checkpoint';

describe('ReplayableSseSession control', () => {
  let nowSpy: jest.SpiedFunction<typeof Date.now>;

  beforeEach(() => {
    nowSpy = jest.spyOn(Date, 'now');
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  function createSession() {
    const session = new ReplayableSseSession<TestEventType>('stream-key', 'run-1');
    const events: Array<{ type: TestEventType; text?: string }> = [];
    session.subscribe(
      {
        next: (event) => {
          events.push({
            type: event.type,
            text: event.data.payload.text as string | undefined,
          });
        },
        complete: () => undefined,
      },
      0,
    );

    return { session, events };
  }

  it('merges text chunks until the target is met', () => {
    nowSpy.mockReturnValue(1_000);
    const { session, events } = createSession();

    session.setControlState({
      level: 'high' satisfies SseStreamControlLevel,
      expiresAt: 2_000,
      hints: { textChunkTargetChars: 4 },
    });

    expect(session.emit('assistant_chunk', { text: 'ab' })).toBeNull();
    expect(session.emit('assistant_chunk', { text: 'cd' })).not.toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'assistant_chunk', text: 'abcd' });
  });

  it('flushes buffered text when control is cleared', () => {
    nowSpy.mockReturnValue(1_000);
    const { session, events } = createSession();

    session.setControlState({
      level: 'critical',
      expiresAt: 2_000,
      hints: { textChunkTargetChars: 10 },
    });

    expect(session.emit('assistant_chunk', { text: 'ab' })).toBeNull();
    expect(session.emit('assistant_chunk', { text: 'cd' })).toBeNull();

    session.clearControlState();

    expect(events).toEqual([{ type: 'assistant_chunk', text: 'abcd' }]);
  });

  it('limits progress events by interval but always allows done', () => {
    const { session, events } = createSession();

    session.setControlState({
      level: 'high',
      expiresAt: 2_000,
      hints: { minProgressIntervalMs: 300, suppressTypes: ['assistant_chunk', 'done'] },
    });

    nowSpy.mockReturnValueOnce(1_000);
    expect(session.emit('progress', { value: 10 })).not.toBeNull();

    nowSpy.mockReturnValueOnce(1_100);
    expect(session.emit('progress', { value: 20 })).toBeNull();

    nowSpy.mockReturnValueOnce(1_400);
    expect(session.emit('progress', { value: 30 })).not.toBeNull();

    nowSpy.mockReturnValueOnce(1_450);
    expect(session.emit('done', { ok: true })).not.toBeNull();
    expect(events.map((event) => event.type)).toEqual(['progress', 'progress', 'done']);
  });

  it('does not flush buffered text on progress', () => {
    const { session, events } = createSession();

    session.setControlState({
      level: 'high',
      expiresAt: 2_000,
      hints: { minProgressIntervalMs: 300, textChunkTargetChars: 4 },
    });

    nowSpy.mockReturnValueOnce(1_000);
    expect(session.emit('assistant_chunk', { text: 'ab' })).toBeNull();

    nowSpy.mockReturnValueOnce(1_100);
    expect(session.emit('progress', { value: 10 })).not.toBeNull();
    expect(events).toEqual([{ type: 'progress', text: undefined }]);

    nowSpy.mockReturnValueOnce(1_200);
    expect(session.emit('assistant_chunk', { text: 'cd' })).not.toBeNull();
    expect(events).toEqual([
      { type: 'progress', text: undefined },
      { type: 'assistant_chunk', text: 'abcd' },
    ]);
  });

  it('falls back to full speed after ttl expiry', () => {
    const { session, events } = createSession();

    session.setControlState({
      level: 'critical',
      expiresAt: 500,
      hints: { textChunkTargetChars: 6 },
    });

    nowSpy.mockReturnValue(1_000);
    expect(session.emit('assistant_chunk', { text: 'ab' })).not.toBeNull();
    expect(events).toEqual([{ type: 'assistant_chunk', text: 'ab' }]);
  });
});
