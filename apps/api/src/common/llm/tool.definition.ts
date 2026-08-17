import type { z } from 'zod';
import type { AgentToolCall } from './openai-agent.client';

/**
 * 通用工具定义。
 *
 * `inputSchema` 使用 zod 作为唯一来源：既用于运行时参数校验，也通过
 * `ToolRegistry.toOpenAiTools()` 转换为 OpenAI function calling 的 `parameters`。
 *
 * 业务模块通过 NestJS DI 向 `ToolRegistry` 注册工具，公共层不反向依赖业务模块。
 */
export interface ToolDefinition {
  /** 工具名，需全局唯一（`ToolRegistry.register` 时校验重名）。 */
  name: string;
  /** 给 LLM 看的工具说明，帮助模型决定是否调用。 */
  description: string;
  /** 工具入参的 zod schema（单一来源）。 */
  inputSchema: z.ZodTypeAny;
}

/**
 * 工具执行函数：接收一次工具调用，返回结构化输出（抛错由客户端 `safeExecute`
 * 回填 `{ ok:false, error }` 给模型，不中断 loop）。
 * 通过 `ToolRegistry.registerExecutor` 注册，executor 按工具名查表分发。
 */
export type ToolExecutorFn = (call: AgentToolCall) => Promise<unknown>;
