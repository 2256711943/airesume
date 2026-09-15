/**
 * Dashscope（通义千问）Chat Completions 客户端，走 OpenAI 兼容模式。
 *
 * 记忆中台与简历评分子系统此前各自复制了一份「读环境变量 + 超时 + 鉴权 + 错误包装」
 * 的实现，细节容易漂移。这里统一收敛为非流式调用，供各方复用。
 *
 * 环境变量:
 * - DASHSCOPE_API_KEY: API key，必填
 * - DASHSCOPE_MODEL: 模型名，默认 qwen-plus
 * - DASHSCOPE_BASE_URL: 兼容端点，可选
 * - DASHSCOPE_TIMEOUT_MS: 单次请求超时（毫秒），默认 20000
 */

/** Dashscope 默认模型，仅在环境变量未配置 DASHSCOPE_MODEL 时使用。 */
export const DEFAULT_DASHSCOPE_MODEL = 'qwen-plus';

/** Dashscope OpenAI 兼容接口的默认地址。 */
export const DEFAULT_DASHSCOPE_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';

/** 单次请求默认超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 20_000;

/** 发送给 Dashscope 的对话消息结构。 */
export interface DashscopeChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Dashscope Chat Completions 响应（只声明用到的字段）。 */
export interface DashscopeChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

/** 判断 Dashscope 是否已配置（API key 与模型均存在）。 */
export function hasDashscopeChatConfig(): boolean {
  return Boolean(process.env.DASHSCOPE_API_KEY && process.env.DASHSCOPE_MODEL);
}

/**
 * 调用 Dashscope Chat Completions（非流式），带超时控制。
 *
 * 超时或 HTTP 错误均抛错，由调用方决定是否降级。
 */
export async function requestDashscopeChat(
  messages: DashscopeChatMessage[],
): Promise<DashscopeChatResponse> {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const model = process.env.DASHSCOPE_MODEL ?? DEFAULT_DASHSCOPE_MODEL;
  const timeoutMs = Number(
    process.env.DASHSCOPE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
  );
  const baseUrl = process.env.DASHSCOPE_BASE_URL ?? DEFAULT_DASHSCOPE_BASE_URL;

  if (!apiKey) {
    throw new Error('DASHSCOPE_API_KEY is not configured');
  }

  // AbortController + setTimeout 实现请求超时中断。
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `${baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, messages, stream: false }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const message = await response.text();
      throw new Error(
        `DashScope request failed: ${response.status} ${message}`,
      );
    }

    return (await response.json()) as DashscopeChatResponse;
  } finally {
    // 请求结束后必须清理定时器，避免资源泄漏。
    clearTimeout(timeout);
  }
}
