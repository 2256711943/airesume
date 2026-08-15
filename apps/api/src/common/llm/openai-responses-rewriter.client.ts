import { Logger } from '@nestjs/common';
import { REWRITE_JD_TOOL_NAME } from '../../resume/jd-parser/jd-parse-tool.schema';
import type {
  JdLlmRewriteInput,
  JdLlmRewriterClient,
} from './llm-client.interface';
import type { OpenAiAgentClient } from './openai-agent.client';
import type { ToolRegistry } from './tool-registry';

const REWRITE_JD_INSTRUCTIONS = [
  'You are a job description quality optimization engine.',
  'You receive a parsed JD (JSON), a list of low-scoring dimensions to improve, and the original JD text.',
  'Your task: improve ONLY the dimensions listed in IMPROVEMENT_TARGETS.',
  'Rules:',
  '1) Keep fields not related to the improvement targets unchanged.',
  '2) Do not fabricate metrics, requirements, or responsibilities not supported by the original JD text.',
  '3) Preserve evidenceSpan traceability to the original JD text.',
  '4) Output via the rewrite_jd tool with the same schema as the input parsed JD (without quality field).',
].join(' ');

/**
 * 基于 OpenAiAgentClient + ToolRegistry 的 JD 定向重写薄适配器。
 *
 * 与 `OpenAIJdLlmParserClient` 对称设计：
 * - 与 `parse_jd` 共用同一份 zod schema（由 ToolRegistry 统一管理），因为重写的
 *   输出结构就是已解析的 JD（不含 quality）；
 * - tool name 独立为 `rewrite_jd`，让模型区分"解析"与"定向重写"两种任务；
 * - 以 `tool_choice: 'auto'` + `stopOnToolCall` 发起请求，模型自主决定是否调用工具。
 *
 * 说明:
 * - 定向重写策略（哪些维度算低分、改善方向 hint）由 `JdRewriterService` 构造为
 *   `JdRewriteImprovementTarget[]` 传入，client 不内嵌业务阈值。
 * - 模型未产生 tool call、arguments 为空、非法 JSON 或 schema 校验失败时抛错，
 *   由 `JdRewriterService` 回退到规则版重写。
 */
export class OpenAIJdLlmRewriterClient implements JdLlmRewriterClient {
  private readonly logger = new Logger(OpenAIJdLlmRewriterClient.name);

  constructor(
    private readonly agent: OpenAiAgentClient,
    private readonly registry: ToolRegistry,
  ) {}

  async rewriteJd(input: JdLlmRewriteInput): Promise<unknown> {
    if (!input.targets || input.targets.length === 0) {
      throw new Error('rewrite_targets_empty');
    }

    const startedAt = Date.now();
    try {
      const result = await this.agent.runWithTools({
        instructions: REWRITE_JD_INSTRUCTIONS,
        input: this.buildPromptInput(input),
        tools: this.registry.toOpenAiTools({ strict: this.agent.strictSchema }),
        stopOnToolCall: true,
        signal: input.signal,
      });
      const call = result.toolTrace.find(
        (trace) => trace.name === REWRITE_JD_TOOL_NAME,
      );
      if (!call) {
        throw new Error('openai_no_tool_call');
      }
      const parsed = this.registry.validateArguments(
        REWRITE_JD_TOOL_NAME,
        call.arguments,
      );
      this.logger.log(
        `jd rewrite ok: tool=${REWRITE_JD_TOOL_NAME} targets=${input.targets.length} latency_ms=${Date.now() - startedAt}`,
      );
      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      this.logger.warn(
        `jd rewrite failed: ${message} latency_ms=${Date.now() - startedAt}`,
      );
      throw error;
    }
  }

  private buildPromptInput(input: JdLlmRewriteInput): string {
    const targetLines = input.targets.map(
      (target) =>
        `- ${target.dimension}: current=${target.currentScore}, threshold=${target.threshold}. ${target.hint}`,
    );

    return [
      'CURRENT_PARSED_JD:',
      JSON.stringify(input.parsedJd),
      '',
      'IMPROVEMENT_TARGETS:',
      ...targetLines,
      '',
      'ORIGINAL_JD_TEXT:',
      input.rawJdText,
    ].join('\n');
  }
}
