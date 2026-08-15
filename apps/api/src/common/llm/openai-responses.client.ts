import { Logger } from '@nestjs/common';
import { PARSE_JD_TOOL_NAME } from '../../resume/jd-parser/jd-parse-tool.schema';
import type { JdLlmParserClient } from './llm-client.interface';
import type { OpenAiAgentClient } from './openai-agent.client';
import type { ToolRegistry } from './tool-registry';

const PARSE_JD_INSTRUCTIONS = [
  'You are a job description parsing engine.',
  'Extract structured fields from the JD text using the parse_jd tool.',
  'Keep field names exactly as the tool schema defines.',
  'Preserve important evidence snippets from the JD text.',
  'When a field is unknown, prefer empty string or empty array instead of guessing.',
].join(' ');

/**
 * 基于 OpenAiAgentClient + ToolRegistry 的 JD 解析薄适配器。
 *
 * - 工具定义（zod schema 单一来源）由 ToolRegistry 统一管理，本类不维护 JSON Schema；
 * - 以 `tool_choice: 'auto'` + `stopOnToolCall` 发起请求，模型自主决定是否调用 `parse_jd`；
 * - 模型未调用工具、arguments 为空/非法或 schema 校验失败时抛 `openai_*` 错误，
 *   由 `JdParserService` 走 fallback。
 */
export class OpenAIJdLlmParserClient implements JdLlmParserClient {
  private readonly logger = new Logger(OpenAIJdLlmParserClient.name);

  constructor(
    private readonly agent: OpenAiAgentClient,
    private readonly registry: ToolRegistry,
  ) {}

  async parseJd(input: {
    jdText: string;
    signal?: AbortSignal;
  }): Promise<unknown> {
    const startedAt = Date.now();
    try {
      const result = await this.agent.runWithTools({
        instructions: PARSE_JD_INSTRUCTIONS,
        input: input.jdText,
        tools: this.registry.toOpenAiTools({ strict: this.agent.strictSchema }),
        stopOnToolCall: true,
        signal: input.signal,
      });
      const call = result.toolTrace.find(
        (trace) => trace.name === PARSE_JD_TOOL_NAME,
      );
      if (!call) {
        throw new Error('openai_no_tool_call');
      }
      const parsed = this.registry.validateArguments(
        PARSE_JD_TOOL_NAME,
        call.arguments,
      );
      this.logger.log(
        `jd parse ok: tool=${PARSE_JD_TOOL_NAME} latency_ms=${Date.now() - startedAt}`,
      );
      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      this.logger.warn(
        `jd parse failed: ${message} latency_ms=${Date.now() - startedAt}`,
      );
      throw error;
    }
  }
}
