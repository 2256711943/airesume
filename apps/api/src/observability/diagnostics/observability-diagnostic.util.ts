import type {
  ObservabilityEvent,
  ObservabilityEventType,
} from '../observability.types';

/**
 * 规则引擎与规则共用的纯工具函数，独立成文件以避免 engine <-> rules 循环依赖。
 */

export const OBSERVABILITY_TERMINAL_EVENT_TYPES: ObservabilityEventType[] = [
  'done',
  'error',
  'canceled',
];

export function findLastEventByTypes(
  events: ObservabilityEvent[],
  types: ObservabilityEventType[],
): ObservabilityEvent | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (types.includes(events[i].type)) {
      return events[i];
    }
  }

  return null;
}

export function countEventsByType(
  events: ObservabilityEvent[],
  type: ObservabilityEventType,
): number {
  return events.reduce(
    (count, event) => (event.type === type ? count + 1 : count),
    0,
  );
}

export function hasEventType(
  events: ObservabilityEvent[],
  type: ObservabilityEventType,
): boolean {
  return events.some((event) => event.type === type);
}
