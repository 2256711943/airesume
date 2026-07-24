export class LlmSanitizer {
  static stripJsonFence(raw: string): string {
    return raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
  }

  static parseJsonObject<T extends object>(raw: string): T {
    const normalized = LlmSanitizer.stripJsonFence(raw);
    const parsed = JSON.parse(normalized) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('llm_output_is_not_json_object');
    }
    return parsed as T;
  }

  static toRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  static toText(value: unknown): string {
    if (typeof value === 'string') {
      return value.trim();
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value).trim();
    }

    return '';
  }

  static toOptionalText(value: unknown): string | undefined {
    const text = LlmSanitizer.toText(value);
    return text.length > 0 ? text : undefined;
  }

  static toOptionalNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return undefined;
  }

  static toStringArray(value: unknown, limit: number): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const normalized = value
      .map((item) => LlmSanitizer.toText(item))
      .filter((item) => item.length > 0)
      .slice(0, limit);

    return Array.from(new Set(normalized));
  }

  static toConfidence(value: unknown, fallback: number): number {
    const numberValue = LlmSanitizer.toOptionalNumber(value);
    if (numberValue === undefined) {
      return fallback;
    }

    if (numberValue < 0) {
      return 0;
    }
    if (numberValue > 1) {
      return 1;
    }
    return numberValue;
  }

  static toEnumValue<T extends string>(
    value: unknown,
    allowed: readonly T[],
    fallback: T,
    aliases?: Record<string, T>,
  ): T {
    const raw = LlmSanitizer.toText(value);
    if (allowed.includes(raw as T)) {
      return raw as T;
    }

    const aliasHit = aliases?.[raw.toLowerCase()];
    if (aliasHit) {
      return aliasHit;
    }

    return fallback;
  }
}
