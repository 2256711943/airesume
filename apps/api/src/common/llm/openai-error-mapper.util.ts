import {
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  AuthenticationError,
  RateLimitError,
} from 'openai';

/**
 * 将 OpenAI SDK 抛出的 `APIError` 映射为统一的 `openai_*` 前缀错误。
 *
 * 共享给 parse / rewrite 等 Responses API 客户端，保证上层 fallback / strict 分支
 * 可以用同一套错误码判断（与 legacy dashscope 风格对齐）。
 *
 * 非 `APIError` 的抛出由调用方自行处理（透传原 error）。
 *
 * @param error SDK 抛出的错误，需为 `APIError` 子类
 * @param timeoutMs 当前 client 配置的超时阈值，用于构造 `openai_timeout_<n>ms` 消息
 */
export function mapOpenAiError(error: APIError, timeoutMs: number): Error {
  if (error instanceof APIUserAbortError) {
    return new Error('openai_aborted_by_caller');
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new Error(`openai_timeout_${timeoutMs}ms`);
  }
  if (error instanceof RateLimitError) {
    return new Error(`openai_http_${error.status ?? 429}: rate_limit`);
  }
  if (error instanceof AuthenticationError) {
    return new Error(`openai_http_${error.status ?? 401}: authentication`);
  }
  if (error instanceof APIConnectionError) {
    return new Error('openai_connection_failed');
  }
  return new Error(
    `openai_http_${error.status ?? 'unknown'}: ${error.message}`,
  );
}
