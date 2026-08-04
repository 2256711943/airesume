import type {
  ObservabilityEventQuery,
  ObservabilityEventWriteInput,
  PersistedObservabilityEvent,
} from './observability.types';

/**
 * 事件日志持久化抽象，供服务层按统一契约读写观测事件。
 */
export abstract class ObservabilityEventStore {
  abstract get(eventId: string): Promise<PersistedObservabilityEvent | null>;

  abstract list(query: ObservabilityEventQuery): Promise<PersistedObservabilityEvent[]>;

  abstract save(
    input: ObservabilityEventWriteInput,
  ): Promise<PersistedObservabilityEvent>;

  abstract saveMany(
    inputs: ObservabilityEventWriteInput[],
  ): Promise<PersistedObservabilityEvent[]>;
}
