import { Prisma } from '@prisma/client';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import type {
  ObservabilityEventQuery,
  ObservabilityEventType,
  ObservabilityEventWriteInput,
  ObservabilityJsonObject,
  PersistedObservabilityEvent,
} from './observability.types';
import {
  OBSERVABILITY_EVENT_STATUSES,
  OBSERVABILITY_EVENT_TYPES,
} from './observability.types';
import { ObservabilityEventStore } from './observability.store';

interface ObservabilityEventRow {
  id: string;
  run_id: string;
  conversation_id: string | null;
  user_id: string | null;
  agent_run_id: string | null;
  span_id: string | null;
  seq: number;
  type: string;
  status: string | null;
  ts: string | Date;
  payload: unknown;
  created_at: string | Date;
}

const observabilityEventTypeSchema = z.enum(OBSERVABILITY_EVENT_TYPES);
const observabilityEventStatusSchema = z.enum(OBSERVABILITY_EVENT_STATUSES);
const observabilityPayloadSchema = z.record(z.string(), z.unknown());
const OBSERVABILITY_EVENT_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS observability_events (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    conversation_id TEXT,
    user_id TEXT,
    agent_run_id TEXT,
    span_id TEXT,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    status TEXT,
    ts DATETIME NOT NULL,
    payload JSON NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS observability_events_run_id_seq_key
   ON observability_events(run_id, seq)`,
  `CREATE INDEX IF NOT EXISTS observability_events_run_id_seq_idx
   ON observability_events(run_id, seq)`,
  `CREATE INDEX IF NOT EXISTS observability_events_conversation_id_ts_idx
   ON observability_events(conversation_id, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS observability_events_agent_run_id_seq_idx
   ON observability_events(agent_run_id, seq)`,
  `CREATE INDEX IF NOT EXISTS observability_events_type_ts_idx
   ON observability_events(type, ts DESC)`,
] as const;

@Injectable()
export class PrismaObservabilityEventStore
  extends ObservabilityEventStore
  implements OnModuleInit
{
  private readonly logger = new Logger(PrismaObservabilityEventStore.name);
  private schemaReady: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  /**
   * 启动期补齐 observability 事件表，兼容已有 SQLite 库直接升级。
   */
  async onModuleInit(): Promise<void> {
    await this.ensureSchema();
  }

  async get(eventId: string): Promise<PersistedObservabilityEvent | null> {
    await this.ensureSchema();
    const rows = await this.prisma.$queryRaw<ObservabilityEventRow[]>(
      Prisma.sql`
        SELECT
          id,
          run_id,
          conversation_id,
          user_id,
          agent_run_id,
          span_id,
          seq,
          type,
          status,
          ts,
          payload,
          created_at
        FROM observability_events
        WHERE id = ${eventId}
        LIMIT 1
      `,
    );

    const record = rows[0];
    return record ? this.toPersistedEvent(record) : null;
  }

  async list(
    query: ObservabilityEventQuery,
  ): Promise<PersistedObservabilityEvent[]> {
    await this.ensureSchema();
    const whereSql = this.buildWhereSql(query);
    const orderBySql = this.buildOrderBySql(query.orderBy);
    const limitSql =
      typeof query.limit === 'number' &&
      Number.isFinite(query.limit) &&
      query.limit > 0
        ? Prisma.sql`LIMIT ${Math.floor(query.limit)}`
        : Prisma.empty;

    const rows = await this.prisma.$queryRaw<ObservabilityEventRow[]>(
      Prisma.sql`
        SELECT
          id,
          run_id,
          conversation_id,
          user_id,
          agent_run_id,
          span_id,
          seq,
          type,
          status,
          ts,
          payload,
          created_at
        FROM observability_events
        ${whereSql}
        ${orderBySql}
        ${limitSql}
      `,
    );

    return rows.map((row) => this.toPersistedEvent(row));
  }

  async save(
    input: ObservabilityEventWriteInput,
  ): Promise<PersistedObservabilityEvent> {
    await this.ensureSchema();
    const normalized = this.normalizeInput(input);

    await this.prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO observability_events (
          id,
          run_id,
          conversation_id,
          user_id,
          agent_run_id,
          span_id,
          seq,
          type,
          status,
          ts,
          payload
        ) VALUES (
          ${normalized.eventId},
          ${normalized.runId},
          ${normalized.conversationId},
          ${normalized.userId},
          ${normalized.agentRunId},
          ${normalized.spanId},
          ${normalized.seq},
          ${normalized.type},
          ${normalized.status},
          ${normalized.ts.toISOString()},
          ${JSON.stringify(normalized.payload)}
        )
        ON CONFLICT(id) DO UPDATE SET
          run_id = excluded.run_id,
          conversation_id = excluded.conversation_id,
          user_id = excluded.user_id,
          agent_run_id = excluded.agent_run_id,
          span_id = excluded.span_id,
          seq = excluded.seq,
          type = excluded.type,
          status = excluded.status,
          ts = excluded.ts,
          payload = excluded.payload
      `,
    );

    const saved = await this.get(normalized.eventId);
    if (!saved) {
      throw new Error(
        `Failed to reload observability event ${normalized.eventId}`,
      );
    }

    return saved;
  }

  async saveMany(
    inputs: ObservabilityEventWriteInput[],
  ): Promise<PersistedObservabilityEvent[]> {
    await this.ensureSchema();
    const saved: PersistedObservabilityEvent[] = [];

    for (const input of inputs) {
      saved.push(await this.save(input));
    }

    return saved;
  }

  /**
   * 懒初始化事件日志表，避免旧库因缺表导致整条观测链路静默失效。
   */
  private async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.createSchema();
    }

    await this.schemaReady;
  }

  private async createSchema(): Promise<void> {
    for (const statement of OBSERVABILITY_EVENT_SCHEMA_STATEMENTS) {
      await this.prisma.$executeRaw(Prisma.raw(statement));
    }
  }

  private normalizeInput(
    input: ObservabilityEventWriteInput,
  ): ObservabilityEventWriteInput {
    return {
      eventId: input.eventId.trim(),
      seq: Math.max(0, Math.floor(input.seq)),
      runId: input.runId.trim(),
      conversationId: input.conversationId?.trim() || null,
      userId: input.userId?.trim() || null,
      agentRunId: input.agentRunId?.trim() || null,
      spanId: input.spanId?.trim() || null,
      type: input.type,
      status: input.status ?? null,
      ts: new Date(input.ts),
      payload: this.clonePayload(input.payload),
    };
  }

  private buildWhereSql(query: ObservabilityEventQuery): Prisma.Sql {
    const conditions: Prisma.Sql[] = [];

    if (query.eventId) {
      conditions.push(Prisma.sql`id = ${query.eventId}`);
    }

    if (query.runId) {
      conditions.push(Prisma.sql`run_id = ${query.runId}`);
    }

    if (query.conversationId) {
      conditions.push(Prisma.sql`conversation_id = ${query.conversationId}`);
    }

    if (query.agentRunId) {
      conditions.push(Prisma.sql`agent_run_id = ${query.agentRunId}`);
    }

    if (typeof query.spanId === 'string') {
      conditions.push(Prisma.sql`span_id = ${query.spanId}`);
    } else if (query.spanId === null) {
      conditions.push(Prisma.sql`span_id IS NULL`);
    }

    if (query.types?.length) {
      conditions.push(
        Prisma.sql`type IN (${Prisma.join(query.types.map((type) => Prisma.sql`${type}`))})`,
      );
    }

    if (query.statuses?.length) {
      conditions.push(
        Prisma.sql`status IN (${Prisma.join(
          query.statuses.map((status) => Prisma.sql`${status}`),
        )})`,
      );
    }

    if (typeof query.seqGte === 'number') {
      conditions.push(Prisma.sql`seq >= ${Math.floor(query.seqGte)}`);
    }

    if (typeof query.seqGt === 'number') {
      conditions.push(Prisma.sql`seq > ${Math.floor(query.seqGt)}`);
    }

    if (typeof query.seqLte === 'number') {
      conditions.push(Prisma.sql`seq <= ${Math.floor(query.seqLte)}`);
    }

    if (typeof query.seqLt === 'number') {
      conditions.push(Prisma.sql`seq < ${Math.floor(query.seqLt)}`);
    }

    if (query.tsAfter) {
      conditions.push(Prisma.sql`ts > ${query.tsAfter.toISOString()}`);
    }

    if (query.tsBefore) {
      conditions.push(Prisma.sql`ts < ${query.tsBefore.toISOString()}`);
    }

    if (conditions.length === 0) {
      return Prisma.empty;
    }

    return Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;
  }

  private buildOrderBySql(
    orderBy?: ObservabilityEventQuery['orderBy'],
  ): Prisma.Sql {
    if (!orderBy) {
      return Prisma.sql`ORDER BY seq ASC, id ASC`;
    }

    const direction =
      orderBy.direction === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;

    switch (orderBy.field) {
      case 'ts':
        return Prisma.sql`ORDER BY ts ${direction}, id ASC`;
      case 'createdAt':
        return Prisma.sql`ORDER BY created_at ${direction}, id ASC`;
      case 'seq':
      default:
        return Prisma.sql`ORDER BY seq ${direction}, id ASC`;
    }
  }

  private toPersistedEvent(
    row: ObservabilityEventRow,
  ): PersistedObservabilityEvent {
    return {
      eventId: row.id,
      seq: row.seq,
      runId: row.run_id,
      conversationId: row.conversation_id,
      userId: row.user_id,
      agentRunId: row.agent_run_id,
      spanId: row.span_id,
      type: this.parseEventType(row.type, row.id),
      status: this.parseEventStatus(row.status, row.id),
      ts: this.toDate(row.ts),
      payload: this.parsePayload(row.payload, row.id),
      createdAt: this.toDate(row.created_at),
    };
  }

  private parseEventType(
    value: string,
    eventId: string,
  ): ObservabilityEventType {
    const result = observabilityEventTypeSchema.safeParse(value);
    if (result.success) {
      return result.data;
    }

    this.logger.warn(
      `Invalid event type "${value}" for observability event ${eventId}; defaulting to error.`,
    );
    return 'error';
  }

  private parseEventStatus(
    value: string | null,
    eventId: string,
  ): PersistedObservabilityEvent['status'] {
    if (value === null) {
      return null;
    }

    const result = observabilityEventStatusSchema.safeParse(value);
    if (result.success) {
      return result.data;
    }

    this.logger.warn(
      `Invalid event status "${value}" for observability event ${eventId}; defaulting to null.`,
    );
    return null;
  }

  private parsePayload(
    value: unknown,
    eventId: string,
  ): ObservabilityJsonObject {
    const parsed = this.parseRawJson(value);
    const result = observabilityPayloadSchema.safeParse(parsed);
    if (result.success) {
      return this.normalizeJsonObject(result.data);
    }

    this.logger.warn(
      `Invalid payload JSON for observability event ${eventId}; defaulting to empty object.`,
    );
    return {};
  }

  private parseRawJson(value: unknown): unknown {
    if (typeof value !== 'string') {
      return value;
    }

    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return {};
    }

    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
  }

  private toDate(value: string | Date): Date {
    return value instanceof Date ? value : new Date(value);
  }

  private normalizeJsonObject(
    value: Record<string, unknown>,
  ): ObservabilityJsonObject {
    const normalized: ObservabilityJsonObject = {};

    for (const [key, item] of Object.entries(value)) {
      normalized[key] = this.normalizeJsonValue(item);
    }

    return normalized;
  }

  private normalizeJsonValue(value: unknown): ObservabilityJsonObject[string] {
    if (value === null) {
      return null;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeJsonValue(item));
    }

    switch (typeof value) {
      case 'string':
        return value;
      case 'number':
        return Number.isFinite(value) ? value : null;
      case 'boolean':
        return value;
      case 'object':
        return this.normalizeJsonObject(value as Record<string, unknown>);
      default:
        return null;
    }
  }

  private clonePayload(
    payload: ObservabilityJsonObject,
  ): ObservabilityJsonObject {
    return JSON.parse(JSON.stringify(payload)) as ObservabilityJsonObject;
  }
}
