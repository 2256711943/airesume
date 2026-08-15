/**
 * OpenAI LLM 配置。
 *
 * 环境变量:
 * - OPENAI_API_KEY: API key，必填
 * - OPENAI_MODEL: 模型名，默认 gpt-4o-mini
 * - OPENAI_BASE_URL: 兼容端点 / 中转地址，可选
 * - OPENAI_TIMEOUT_MS: 单次请求超时（毫秒），默认 20000
 * - OPENAI_STRICT_SCHEMA: 是否启用 strict schema（1/true/yes/on），默认关闭
 * - OPENAI_MAX_OUTPUT_TOKENS: 输出 token 上限，可选
 */
export interface OpenAiLlmConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs: number;
  strictSchema: boolean;
  maxOutputTokens?: number;
}

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 20_000;

export function loadOpenAiLlmConfig(
  env: NodeJS.ProcessEnv = process.env,
): OpenAiLlmConfig {
  const rawTimeout = Number(env.OPENAI_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  return {
    apiKey: env.OPENAI_API_KEY?.trim() ?? '',
    model: env.OPENAI_MODEL?.trim() || DEFAULT_MODEL,
    baseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
    timeoutMs:
      Number.isFinite(rawTimeout) && rawTimeout > 0
        ? rawTimeout
        : DEFAULT_TIMEOUT_MS,
    strictSchema: /^(1|true|yes|on)$/i.test(
      (env.OPENAI_STRICT_SCHEMA ?? '').trim(),
    ),
    maxOutputTokens: toOptionalPositiveInt(env.OPENAI_MAX_OUTPUT_TOKENS),
  };
}

function toOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}
