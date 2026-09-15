import type {
  ObservabilityDiagnosticCategory,
  ObservabilityJsonObject,
  ObservabilityJsonValue,
} from '../observability.types';
import type {
  ObservabilityDiagnosticCandidate,
  ObservabilityDiagnosticContext,
} from './observability-diagnostic.types';

/**
 * 确定性诊断规则接口。
 *
 * 约束：
 * - 不写数据库、不调用外部 LLM、不产生副作用；
 * - 对缺字段 payload 必须容错，返回空数组而不是抛错；
 * - 一次 evaluate 可返回多条候选（同 span 多条证据），由引擎负责聚合。
 */
export interface ObservabilityDiagnosticRule {
  ruleId: string;
  category: ObservabilityDiagnosticCategory;
  evaluate(
    ctx: ObservabilityDiagnosticContext,
  ): ObservabilityDiagnosticCandidate[];
}

/* ------------------------------------------------------------------ */
/* 规则内部共用的安全取值工具（防御式，避免非法 payload 导致崩溃）      */
/* ------------------------------------------------------------------ */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asJsonObject(value: unknown): ObservabilityJsonObject | null {
  return isRecord(value) ? (value as ObservabilityJsonObject) : null;
}

/**
 * 从事件 payload 中读取任意键，缺失或类型不符时返回 fallback。
 */
export function getPayloadValue(
  payload: ObservabilityJsonObject,
  key: string,
): ObservabilityJsonValue | undefined {
  return payload[key];
}

export function getPayloadString(
  payload: ObservabilityJsonObject,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function getPayloadBoolean(
  payload: ObservabilityJsonObject,
  key: string,
  fallback = false,
): boolean {
  const value = payload[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function getPayloadNumber(
  payload: ObservabilityJsonObject,
  key: string,
): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function getPayloadStringArray(
  payload: ObservabilityJsonObject,
  key: string,
): string[] {
  const value = payload[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is string =>
      typeof item === 'string' && item.trim().length > 0,
  );
}

export function getPayloadRecord(
  payload: ObservabilityJsonObject,
  key: string,
): ObservabilityJsonObject | null {
  const value = payload[key];
  return asJsonObject(value);
}

/**
 * 统计字符串数组内部的重复比例：去重后减少的数量 / 原始数量。
 * 空数组返回 0，保证阈值判断安全。
 */
export function calcDuplicateRatio(ids: string[]): number {
  if (ids.length === 0) {
    return 0;
  }

  const uniqueCount = new Set(ids).size;
  return (ids.length - uniqueCount) / ids.length;
}
