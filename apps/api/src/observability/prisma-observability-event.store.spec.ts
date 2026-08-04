import { Logger } from '@nestjs/common';
import { PrismaObservabilityEventStore } from './prisma-observability-event.store';
import type {
  ObservabilityEventType,
  ObservabilityEventWriteInput,
} from './observability.types';

describe('PrismaObservabilityEventStore', () => {
  const prisma = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
  };
  let store: PrismaObservabilityEventStore;

  function createEventInput(
    overrides: Partial<ObservabilityEventWriteInput> = {},
  ): ObservabilityEventWriteInput {
    return {
      eventId: 'run-1:1',
      seq: 1,
      runId: 'run-1',
      conversationId: 'conversation-1',
      userId: 'user-1',
      agentRunId: 'agent-run-1',
      spanId: 'span-1',
      type: 'start',
      status: 'normal',
      ts: new Date('2026-08-04T09:00:00.000Z'),
      payload: {
        requestId: 'req-1',
        routeDecisionStarted: false,
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    prisma.$executeRaw.mockResolvedValue(1);
    store = new PrismaObservabilityEventStore(prisma as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('saves and reloads a persisted observability event', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'run-1:1',
        run_id: 'run-1',
        conversation_id: 'conversation-1',
        user_id: 'user-1',
        agent_run_id: 'agent-run-1',
        span_id: 'span-1',
        seq: 1,
        type: 'start',
        status: 'normal',
        ts: '2026-08-04T09:00:00.000Z',
        payload: '{"requestId":"req-1","routeDecisionStarted":false}',
        created_at: '2026-08-04T09:00:01.000Z',
      },
    ]);

    const saved = await store.save(createEventInput());

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(7);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(saved).toMatchObject({
      eventId: 'run-1:1',
      runId: 'run-1',
      type: 'start',
      status: 'normal',
      conversationId: 'conversation-1',
    });
  });

  it('lists events by run scope and seq ordering', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'run-1:1',
        run_id: 'run-1',
        conversation_id: 'conversation-1',
        user_id: 'user-1',
        agent_run_id: 'agent-run-1',
        span_id: 'span-1',
        seq: 1,
        type: 'start',
        status: 'normal',
        ts: '2026-08-04T09:00:00.000Z',
        payload: '{}',
        created_at: '2026-08-04T09:00:01.000Z',
      },
      {
        id: 'run-1:2',
        run_id: 'run-1',
        conversation_id: 'conversation-1',
        user_id: 'user-1',
        agent_run_id: 'agent-run-1',
        span_id: 'span-1',
        seq: 2,
        type: 'route_decision',
        status: 'normal',
        ts: '2026-08-04T09:00:02.000Z',
        payload: '{}',
        created_at: '2026-08-04T09:00:03.000Z',
      },
    ]);

    const events = await store.list({
      runId: 'run-1',
      seqGte: 1,
      types: ['start', 'route_decision'] satisfies ObservabilityEventType[],
    });

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(6);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.eventId)).toEqual([
      'run-1:1',
      'run-1:2',
    ]);
  });

  it('falls back when persisted type, status, or payload is malformed', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'run-bad:1',
        run_id: 'run-bad',
        conversation_id: null,
        user_id: null,
        agent_run_id: null,
        span_id: null,
        seq: 1,
        type: 'not-real',
        status: 'bad-status',
        ts: '2026-08-04T09:00:00.000Z',
        payload: '["bad-payload"]',
        created_at: '2026-08-04T09:00:01.000Z',
      },
    ]);

    const loaded = await store.get('run-bad:1');

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(6);
    expect(loaded).toMatchObject({
      eventId: 'run-bad:1',
      type: 'error',
      status: null,
      payload: {},
    });
  });

  it('initializes observability schema only once per store instance', async () => {
    await store.onModuleInit();
    await store.onModuleInit();

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(6);
  });
});
