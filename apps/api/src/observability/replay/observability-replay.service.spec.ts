import type {
  ObservabilityEventQuery,
  ObservabilityEventWriteInput,
  PersistedObservabilityEvent,
} from '../observability.types';
import { ObservabilityEventStore } from '../observability.store';
import { ObservabilityReplayService } from './observability-replay.service';

/** 测试用内存版事件 store：支持 run/会话/类型/seq 范围过滤与 seq 排序。 */
class InMemoryObservabilityEventStore extends ObservabilityEventStore {
  constructor(private readonly events: PersistedObservabilityEvent[]) {
    super();
  }

  get(eventId: string): Promise<PersistedObservabilityEvent | null> {
    return Promise.resolve(
      this.events.find((event) => event.eventId === eventId) ?? null,
    );
  }

  list(query: ObservabilityEventQuery): Promise<PersistedObservabilityEvent[]> {
    const filtered = this.events.filter((event) => {
      if (query.runId && event.runId !== query.runId) {
        return false;
      }
      if (
        query.conversationId &&
        event.conversationId !== query.conversationId
      ) {
        return false;
      }
      if (query.types?.length && !query.types.includes(event.type)) {
        return false;
      }
      if (typeof query.seqGt === 'number' && event.seq <= query.seqGt) {
        return false;
      }
      if (typeof query.seqGte === 'number' && event.seq < query.seqGte) {
        return false;
      }
      if (typeof query.seqLte === 'number' && event.seq > query.seqLte) {
        return false;
      }
      return true;
    });

    const sorted = [...filtered].sort(
      (a, b) => a.seq - b.seq || a.eventId.localeCompare(b.eventId),
    );
    return Promise.resolve(
      typeof query.limit === 'number' ? sorted.slice(0, query.limit) : sorted,
    );
  }

  save(
    _input: ObservabilityEventWriteInput,
  ): Promise<PersistedObservabilityEvent> {
    void _input;
    return Promise.reject(new Error('save is not implemented in test store'));
  }

  saveMany(
    _inputs: ObservabilityEventWriteInput[],
  ): Promise<PersistedObservabilityEvent[]> {
    void _inputs;
    return Promise.reject(
      new Error('saveMany is not implemented in test store'),
    );
  }
}

function createEvent(
  overrides: Partial<PersistedObservabilityEvent> = {},
): PersistedObservabilityEvent {
  return {
    eventId: 'e1',
    seq: 1,
    runId: 'run-1',
    conversationId: 'conv-1',
    userId: null,
    agentRunId: 'agent-run-1',
    spanId: 'span-1',
    type: 'start',
    status: 'normal',
    ts: new Date('2026-08-04T09:00:00.000Z'),
    payload: {},
    createdAt: new Date('2026-08-04T09:00:00.000Z'),
    ...overrides,
  };
}

describe('ObservabilityReplayService', () => {
  let diagnosticService: { diagnoseRun: jest.Mock };
  let service: ObservabilityReplayService;

  function createService(events: PersistedObservabilityEvent[]) {
    const store = new InMemoryObservabilityEventStore(events);
    diagnosticService = {
      diagnoseRun: jest.fn().mockResolvedValue([]),
    };
    service = new ObservabilityReplayService(store, diagnosticService as never);
  }

  it('maps events query DTO to store query and returns seq-asc events', async () => {
    createService([
      createEvent({ eventId: 'e1', seq: 1, type: 'start' }),
      createEvent({ eventId: 'e2', seq: 2, type: 'tool.call.started' }),
      createEvent({ eventId: 'e3', seq: 3, type: 'tool.call.finished' }),
      createEvent({ eventId: 'e4', seq: 4, type: 'done' }),
    ]);

    const events = await service.listRunEvents('run-1', {
      seqGte: 2,
      types: ['tool.call.started', 'tool.call.finished'],
      limit: 10,
    });

    expect(events.map((event) => event.eventId)).toEqual(['e2', 'e3']);
  });

  it('builds a replay package with summary, checkpoints and diagnostics', async () => {
    createService([
      createEvent({
        eventId: 's1',
        seq: 1,
        type: 'start',
        payload: { contextPackId: 'pack-1' },
      }),
      createEvent({
        eventId: 'r1',
        seq: 2,
        type: 'route_decision',
        payload: {
          routeDecision: { intent: 'interview', selectedAgent: 'coachAgent' },
        },
      }),
      createEvent({
        eventId: 'c1',
        seq: 3,
        type: 'checkpoint',
        payload: { label: 'context-ready', keyValues: { tokens: 120 } },
      }),
      createEvent({ eventId: 'd1', seq: 4, type: 'done' }),
    ]);
    diagnosticService.diagnoseRun.mockResolvedValue([{ issueId: 'diag-1' }]);

    const replay = await service.getRunReplay('run-1');

    expect(replay.runId).toBe('run-1');
    expect(replay.summary.status).toBe('succeeded');
    expect(replay.summary.eventCount).toBe(4);
    expect(replay.summary.firstSeq).toBe(1);
    expect(replay.summary.lastSeq).toBe(4);
    expect(replay.summary.agentRunId).toBe('agent-run-1');
    expect(replay.summary.contextPackId).toBe('pack-1');
    expect(replay.summary.routeDecision).toEqual({
      intent: 'interview',
      selectedAgent: 'coachAgent',
    });
    expect(replay.checkpoints).toEqual([
      {
        checkpointId: 'c1',
        runId: 'run-1',
        spanId: 'span-1',
        seq: 3,
        label: 'context-ready',
        keyValues: { tokens: 120 },
        createdAt: expect.any(Date) as Date,
      },
    ]);
    expect(replay.diagnostics).toEqual([{ issueId: 'diag-1' }]);
    expect(diagnosticService.diagnoseRun).toHaveBeenCalledWith('run-1');
  });

  it('derives failed status from an error terminal event', async () => {
    createService([
      createEvent({ eventId: 's1', seq: 1, type: 'start' }),
      createEvent({ eventId: 'e1', seq: 2, type: 'error' }),
    ]);

    const replay = await service.getRunReplay('run-1');

    expect(replay.summary.status).toBe('failed');
    expect(replay.summary.endedAt).toBe(
      new Date('2026-08-04T09:00:00.000Z').toISOString(),
    );
  });

  it('returns a pending summary when no events exist', async () => {
    createService([]);

    const replay = await service.getRunReplay('run-1');

    expect(replay.summary.status).toBe('pending');
    expect(replay.summary.eventCount).toBe(0);
    expect(replay.events).toEqual([]);
    expect(replay.checkpoints).toEqual([]);
  });

  it('groups conversation runs by runId and sorts latest first', async () => {
    createService([
      createEvent({
        eventId: 'r1s',
        seq: 1,
        runId: 'run-1',
        ts: new Date('2026-08-04T09:00:00.000Z'),
        type: 'start',
      }),
      createEvent({
        eventId: 'r1d',
        seq: 2,
        runId: 'run-1',
        ts: new Date('2026-08-04T09:00:05.000Z'),
        type: 'done',
      }),
      createEvent({
        eventId: 'r2s',
        seq: 1,
        runId: 'run-2',
        conversationId: 'conv-1',
        ts: new Date('2026-08-04T10:00:00.000Z'),
        type: 'start',
      }),
      createEvent({
        eventId: 'r2e',
        seq: 2,
        runId: 'run-2',
        conversationId: 'conv-1',
        ts: new Date('2026-08-04T10:00:10.000Z'),
        type: 'error',
      }),
    ]);

    const runs = await service.listConversationRuns('conv-1');

    expect(runs.map((run) => run.runId)).toEqual(['run-2', 'run-1']);
    expect(runs[0]).toMatchObject({
      runId: 'run-2',
      status: 'failed',
      eventCount: 2,
      lastSeq: 2,
    });
    expect(runs[1]).toMatchObject({
      runId: 'run-1',
      status: 'succeeded',
      eventCount: 2,
    });
  });
});
