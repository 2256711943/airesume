import { Injectable } from '@nestjs/common';
import type {
  ObservabilityCheckpoint,
  ObservabilityEventType,
  ObservabilityRunStatus,
  PersistedObservabilityEvent,
} from '../observability.types';
import { ObservabilityEventStore } from '../observability.store';
import { ObservabilityDiagnosticService } from '../diagnostics/observability-diagnostic.service';
import {
  getPayloadRecord,
  getPayloadString,
} from '../diagnostics/observability-diagnostic-rule';
import type { ObservabilityRunEventsQueryDto } from './dto/observability-run-events-query.dto';
import type {
  ObservabilityRunListItem,
  ObservabilityRunReplayResponse,
  ObservabilityRunSummary,
} from './dto/observability-run-replay-response.dto';

/**
 * Replay 查询服务：为历史 run 复盘提供事件、checkpoint、诊断与摘要。
 *
 * 原则：
 * - 只读事件 store 与诊断服务，不写库、不消费实时 SSE 流；
 * - run 摘要全部由事件序列反推（无 run 级别落库表）；
 * - 与实时态解耦，前端 replay store 基于返回的完整包驱动。
 */
@Injectable()
export class ObservabilityReplayService {
  constructor(
    private readonly eventStore: ObservabilityEventStore,
    private readonly diagnosticService: ObservabilityDiagnosticService,
  ) {}

  /**
   * 查询指定 run 的事件列表（按 seq 升序）。
   */
  async listRunEvents(
    runId: string,
    query: ObservabilityRunEventsQueryDto = {},
  ): Promise<PersistedObservabilityEvent[]> {
    return this.eventStore.list({
      runId,
      types: query.types,
      seqGt: query.seqGt,
      seqGte: query.seqGte,
      seqLte: query.seqLte,
      limit: query.limit,
      orderBy: { field: 'seq', direction: 'asc' },
    });
  }

  /**
   * 组装一次历史 run 的 replay 完整包：摘要 + 事件 + checkpoint + 诊断。
   */
  async getRunReplay(runId: string): Promise<ObservabilityRunReplayResponse> {
    const [events, checkpoints, diagnostics] = await Promise.all([
      this.listRunEvents(runId),
      this.listRunCheckpoints(runId),
      this.diagnosticService.diagnoseRun(runId),
    ]);

    return {
      runId,
      summary: this.buildRunSummary(runId, events),
      events,
      checkpoints,
      diagnostics,
    };
  }

  /**
   * 返回同一会话下可 replay 的 run 列表（按开始时间倒序，最新在前）。
   */
  async listConversationRuns(
    conversationId: string,
  ): Promise<ObservabilityRunListItem[]> {
    const events = await this.eventStore.list({
      conversationId,
      orderBy: { field: 'seq', direction: 'asc' },
    });

    const eventsByRun = new Map<string, PersistedObservabilityEvent[]>();
    for (const event of events) {
      const runEvents = eventsByRun.get(event.runId) ?? [];
      runEvents.push(event);
      eventsByRun.set(event.runId, runEvents);
    }

    const runs: ObservabilityRunListItem[] = [];
    for (const [runId, runEvents] of eventsByRun) {
      const summary = this.buildRunSummary(runId, runEvents);
      runs.push({
        runId,
        conversationId: summary.conversationId,
        status: summary.status,
        startedAt: summary.startedAt,
        endedAt: summary.endedAt,
        eventCount: summary.eventCount,
        lastSeq: summary.lastSeq,
        agentRunId: summary.agentRunId,
      });
    }

    return runs.sort((a, b) =>
      (b.startedAt ?? '').localeCompare(a.startedAt ?? ''),
    );
  }

  /**
   * 提取 run 的 checkpoint 事件并映射为恢复锚点结构。
   */
  private async listRunCheckpoints(
    runId: string,
  ): Promise<ObservabilityCheckpoint[]> {
    const events = await this.eventStore.list({
      runId,
      types: ['checkpoint'],
      orderBy: { field: 'seq', direction: 'asc' },
    });

    return events.map((event) => {
      const keyValues = getPayloadRecord(event.payload, 'keyValues') ?? {};
      return {
        checkpointId: event.eventId,
        runId: event.runId,
        spanId: event.spanId,
        seq: event.seq,
        label: getPayloadString(event.payload, 'label') ?? event.type,
        keyValues,
        createdAt: event.ts,
      };
    });
  }

  /**
   * 由有序事件序列反推 run 摘要。
   * 空事件输入返回 pending 状态的空摘要（不抛错）。
   */
  private buildRunSummary(
    runId: string,
    events: PersistedObservabilityEvent[],
  ): ObservabilityRunSummary {
    if (!Array.isArray(events) || events.length === 0) {
      return {
        runId,
        conversationId: null,
        status: 'pending',
        startedAt: null,
        endedAt: null,
        eventCount: 0,
        firstSeq: null,
        lastSeq: null,
        agentRunId: null,
        contextPackId: null,
        routeDecision: null,
      };
    }

    const first = events[0];
    const last = events[events.length - 1];
    const terminalEvent = this.findTerminalEvent(events);

    let agentRunId: string | null = null;
    for (const event of events) {
      if (event.agentRunId) {
        agentRunId = event.agentRunId;
        break;
      }
    }

    return {
      runId,
      conversationId: first.conversationId,
      status: this.deriveRunStatus(events),
      startedAt: first.ts.toISOString(),
      endedAt: terminalEvent ? terminalEvent.ts.toISOString() : null,
      eventCount: events.length,
      firstSeq: first.seq,
      lastSeq: last.seq,
      agentRunId,
      contextPackId: this.extractContextPackId(events),
      routeDecision: this.extractRouteDecision(events),
    };
  }

  /**
   * 按优先级判定 run 终态：done → succeeded；error → failed；canceled → canceled；否则 running。
   */
  private deriveRunStatus(
    events: PersistedObservabilityEvent[],
  ): ObservabilityRunStatus {
    if (this.hasEventType(events, 'done')) {
      return 'succeeded';
    }
    if (this.hasEventType(events, 'error')) {
      return 'failed';
    }
    if (this.hasEventType(events, 'canceled')) {
      return 'canceled';
    }
    return 'running';
  }

  /** 取第一个终态事件（done/error/canceled），用于推导 endedAt。 */
  private findTerminalEvent(
    events: PersistedObservabilityEvent[],
  ): PersistedObservabilityEvent | null {
    for (const event of events) {
      if (
        event.type === 'done' ||
        event.type === 'error' ||
        event.type === 'canceled'
      ) {
        return event;
      }
    }
    return null;
  }

  private hasEventType(
    events: PersistedObservabilityEvent[],
    type: ObservabilityEventType,
  ): boolean {
    return events.some((event) => event.type === type);
  }

  /** 从 start/route_decision 事件 payload 提取 contextPackId。 */
  private extractContextPackId(
    events: PersistedObservabilityEvent[],
  ): string | null {
    for (const event of events) {
      if (event.type === 'start' || event.type === 'route_decision') {
        const contextPackId = getPayloadString(event.payload, 'contextPackId');
        if (contextPackId) {
          return contextPackId;
        }
      }
    }
    return null;
  }

  /** 从 route_decision 事件 payload.routeDecision 提取可对比摘要字段。 */
  private extractRouteDecision(
    events: PersistedObservabilityEvent[],
  ): ObservabilityRunSummary['routeDecision'] {
    const event = events.find((item) => item.type === 'route_decision');
    if (!event) {
      return null;
    }

    const record = getPayloadRecord(event.payload, 'routeDecision');
    if (!record) {
      return null;
    }

    return {
      intent: typeof record.intent === 'string' ? record.intent : undefined,
      selectedAgent:
        typeof record.selectedAgent === 'string'
          ? record.selectedAgent
          : undefined,
      confidence:
        typeof record.confidence === 'number' ? record.confidence : undefined,
    };
  }
}
