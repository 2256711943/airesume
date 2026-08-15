import type { z } from 'zod';

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
