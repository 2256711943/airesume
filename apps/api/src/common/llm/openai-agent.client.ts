import { Logger } from '@nestjs/common';
import { APIError, OpenAI } from 'openai';
import type {
  Response,
  ResponseFunctionToolCall,
  ResponseInputItem,
} from 'openai/resources/responses/responses.js';
import { loadOpenAiLlmConfig, type OpenAiLlmConfig } from './llm-config';
import { mapOpenAiError } from './openai-error-mapper.util';

/** Responses API 的 function tool 定义（与 SDK `tools` 参数结构对齐）。 */
export interface AgentToolDefinition {
  type: 'function';
  name: string;
  description: string;
  /** SDK 要求该字段为 `boolean | null`（不允许缺省）。 */
  strict: boolean | null;
  parameters: Record<string, unknown>;
}

/** 一次工具调用的入参。 */
export interface AgentToolCall {
  callId: string;
  name: string;
  arguments: unknown;
}

/** 工具执行回调：抛出的异常会被捕获并回填给模型，不中断 loop。 */
export type AgentToolExecutor = (call: AgentToolCall) => Promise<unknown>;

export interface AgentRunOptions {
  instructions: string;
  input: string;
  tools: AgentToolDefinition[];
  /**
   * 工具执行回调。多轮 loop 模式下必填；`stopOnToolCall` 模式下不会被调用，
   * 因此可以省略。
   */
  execute?: AgentToolExecutor;
  maxSteps?: number;
  /**
   * 为 true 时，模型在本轮调用任意工具后立即返回（不执行工具、不续接模型），
   * 结果中携带该次 tool call 的 `name` / `arguments`。适用于"模型自主调用工具、
   * 业务只需工具输出"的单轮场景（如 JD 解析/重写）。默认 false 保持多轮 loop。
   */
  stopOnToolCall?: boolean;
  signal?: AbortSignal;
  /**
   * 工具开始执行回调（stopOnToolCall 模式下不会被调用）。
   * 供上层做 SSE 事件上报等观测用途。
   */
  onToolStart?: (call: AgentToolCall) => void;
  /** 工具执行完成回调（stopOnToolCall 模式下不会被调用），携带单步 trace。 */
  onToolDone?: (trace: AgentToolTraceEntry) => void;
}

/** 单步工具调用的观测记录。 */
export interface AgentToolTraceEntry {
  step: number;
  name: string;
  /** 解析后的 tool arguments（非法 JSON / 空参数时返回 null）。 */
  arguments: unknown;
  /** 工具执行结果（未执行或执行前返回时为 undefined）。 */
  result?: unknown;
  latencyMs: number;
}

export interface AgentRunResult {
  outputText: string;
  toolTrace: AgentToolTraceEntry[];
}

const DEFAULT_MAX_STEPS = 5;

/**
 * 基于 OpenAI Responses API 的通用 Agent tool loop 客户端（阶段 A）。
 *
 * 职责：
 * - 以 `tool_choice: 'auto'` 发起对话，让模型自主决定是否调用工具；
 * - 循环处理 `function_call`：执行 `execute` 回调，把 `function_call_output`
 *   通过 `previous_response_id` 续接回模型，直到模型不再请求工具或达到 maxSteps。
 *
 * 说明:
 * - 本类不依赖任何业务服务：工具定义与执行回调均由调用方注入，便于分层与单测。
 * - 工具执行失败不会中断 loop，错误以 `{ ok:false, error }` 回填，模型可自行修正。
 * - 错误消息沿用 `openai_*` 前缀约定；未配置 API key 时抛 `OPENAI_API_KEY is not configured`。
 */
export class OpenAiAgentClient {
  private readonly client: OpenAI;
  private readonly logger = new Logger(OpenAiAgentClient.name);

  constructor(
    private readonly config: OpenAiLlmConfig = loadOpenAiLlmConfig(),
  ) {
    this.client = new OpenAI({
      // apiKey 为空时先放占位符，真正的缺失检查放在 runWithTools 里，便于构造/单测。
      apiKey: config.apiKey || 'openai-api-key-not-set',
      baseURL: config.baseUrl,
      timeout: config.timeoutMs,
      maxRetries: 2,
    });
  }

  /** 当前配置的 strict schema 开关，供 ToolRegistry 转换工具参数时使用。 */
  get strictSchema(): boolean {
    return this.config.strictSchema;
  }

  /**
   * 执行一次完整的 agent tool loop，返回模型最终文本与工具调用观测记录。
   * 模型未请求任何工具时仅发起一次调用即返回。
   */
  async runWithTools(options: AgentRunOptions): Promise<AgentRunResult> {
    if (!this.config.apiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }

    const maxSteps =
      options.maxSteps && options.maxSteps >= 1
        ? Math.floor(options.maxSteps)
        : DEFAULT_MAX_STEPS;
    const startedAt = Date.now();
    const toolTrace: AgentToolTraceEntry[] = [];

    try {
      let response = await this.createResponse({
        instructions: options.instructions,
        input: options.input,
        tools: options.tools,
        signal: options.signal,
      });

      for (let step = 0; step < maxSteps; step += 1) {
        const calls = this.extractToolCalls(response.output);
        if (calls.length === 0) {
          this.logger.log(
            `agent done: tool_steps=${toolTrace.length} latency_ms=${Date.now() - startedAt}`,
          );
          return { outputText: response.output_text ?? '', toolTrace };
        }

        // 单轮模式：模型调用工具后立即返回（不执行工具、不续接模型）。
        if (options.stopOnToolCall) {
          for (const call of calls) {
            toolTrace.push({
              step,
              name: call.name,
              arguments: this.parseCallArguments(call.arguments, true),
              latencyMs: 0,
            });
          }
          this.logger.log(
            `agent done (stop on tool call): tool_steps=${toolTrace.length} latency_ms=${Date.now() - startedAt}`,
          );
          return { outputText: response.output_text ?? '', toolTrace };
        }

        const outputs: ResponseInputItem[] = [];
        // 先统一触发"工具开始"事件（保持调用顺序），再并行执行工具。
        for (const call of calls) {
          options.onToolStart?.({
            callId: call.call_id,
            name: call.name,
            arguments: this.parseCallArguments(call.arguments, false),
          });
        }

        // 同一轮的工具调用并行执行；Promise.all 结果保持输入顺序，
        // 因此 outputs / toolTrace 的先后顺序稳定，trace 只需按 step 区分轮次。
        const toolResults = await Promise.all(
          calls.map(async (call, index) => {
            const toolStartedAt = Date.now();
            const result = options.execute
              ? await this.safeExecute(options.execute, call)
              : { ok: true, data: null };
            return {
              index,
              call,
              result,
              traceEntry: {
                step,
                name: call.name,
                arguments: this.parseCallArguments(call.arguments, false),
                result,
                latencyMs: Date.now() - toolStartedAt,
              } satisfies AgentToolTraceEntry,
            };
          }),
        );

        for (const { index, call, result, traceEntry } of toolResults) {
          outputs.push({
            type: 'function_call_output',
            id: `tool_output_${step}_${index}`,
            call_id: call.call_id,
            output: JSON.stringify(result),
            status: 'completed',
          });
          toolTrace.push(traceEntry);
          options.onToolDone?.(traceEntry);
        }

        response = await this.createResponse({
          instructions: options.instructions,
          input: outputs,
          tools: options.tools,
          previousResponseId: response.id,
          signal: options.signal,
        });
      }

      throw new Error(`openai_agent_max_steps_${maxSteps}`);
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      if (error instanceof APIError) {
        // SDK 的 APIError 泛型参数在 instanceof 收窄后变为 any，此处显式断言回默认泛型。
        const mapped = mapOpenAiError(
          error as APIError<
            number | undefined,
            Headers | undefined,
            object | undefined
          >,
          this.config.timeoutMs,
        );
        this.logger.warn(
          `agent failed: ${mapped.message} latency_ms=${latencyMs}`,
        );
        throw mapped;
      }
      const message = error instanceof Error ? error.message : 'unknown_error';
      this.logger.warn(`agent failed: ${message} latency_ms=${latencyMs}`);
      throw error;
    }
  }

  private createResponse(params: {
    instructions: string;
    input: string | ResponseInputItem[];
    tools: AgentToolDefinition[];
    previousResponseId?: string;
    signal?: AbortSignal;
  }): Promise<Response> {
    return this.client.responses.create(
      {
        model: this.config.model,
        instructions: params.instructions,
        input: params.input,
        tools: params.tools,
        tool_choice: 'auto',
        ...(params.previousResponseId
          ? { previous_response_id: params.previousResponseId }
          : {}),
        ...(this.config.maxOutputTokens
          ? { max_output_tokens: this.config.maxOutputTokens }
          : {}),
      },
      {
        timeout: this.config.timeoutMs,
        signal: params.signal,
      },
    );
  }

  private extractToolCalls(
    output: Response['output'],
  ): Array<ResponseFunctionToolCall> {
    return output.filter(
      (item): item is ResponseFunctionToolCall => item.type === 'function_call',
    );
  }

  /**
   * 解析 tool arguments 字符串。
   * - `strict=true`（stopOnToolCall 模式）：空参数抛 `openai_empty_arguments`，
   *   非法 JSON 抛 `openai_invalid_arguments`（无回填路径，直接抛给调用方）；
   * - `strict=false`（多轮 loop 模式）：解析失败返回 null，由 `safeExecute`
   *   把错误回填给模型，不中断 loop。
   */
  private parseCallArguments(raw: string, strict: boolean): unknown {
    const trimmed = raw?.trim();
    if (!trimmed) {
      if (strict) {
        throw new Error('openai_empty_arguments');
      }
      return null;
    }
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      if (strict) {
        throw new Error('openai_invalid_arguments');
      }
      return null;
    }
  }

  /**
   * 执行工具并统一包装结果：成功 `{ ok:true, data }`，失败 `{ ok:false, error }`。
   * arguments 非法 JSON 时不调用 execute，直接回填解析错误。
   */
  private async safeExecute(
    execute: AgentToolExecutor,
    call: ResponseFunctionToolCall,
  ): Promise<unknown> {
    let args: unknown;
    try {
      args = JSON.parse(call.arguments ?? '{}') as unknown;
    } catch {
      return { ok: false, error: 'invalid_json_arguments' };
    }
    try {
      const data = await execute({
        callId: call.call_id,
        name: call.name,
        arguments: args,
      });
      return { ok: true, data };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'unknown_error',
      };
    }
  }
}
