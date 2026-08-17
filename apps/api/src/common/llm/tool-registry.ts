import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AgentToolDefinition } from './openai-agent.client';
import type { ToolDefinition, ToolExecutorFn } from './tool.definition';

/**
 * 通用工具注册表。
 *
 * 职责：
 * - 统一登记各业务模块的工具定义（重名直接抛错，避免静默覆盖）；
 * - 将 zod schema（单一来源）转换为 OpenAI Responses API function calling 的
 *   `tools` 参数，strict 模式的 `required` / `additionalProperties` 处理收敛于此；
 * - 提供按工具名的参数校验入口，供薄适配器复用，避免各 client 各自实现校验；
 * - 统一登记工具执行函数（`registerExecutor`），executor 按工具名查表分发，
 *   避免各 executor 内部手写 switch 路由。
 *
 * 依赖方向：业务模块 -> ToolRegistry，公共层不再反向依赖业务模块。
 */
@Injectable()
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly executors = new Map<string, ToolExecutorFn>();

  register(def: ToolDefinition): void {
    if (this.tools.has(def.name)) {
      throw new Error(`tool_already_registered: ${def.name}`);
    }
    this.tools.set(def.name, def);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /**
   * 注册工具执行函数（重名抛错，避免静默覆盖）。
   * 由各 executor 在构造时注册，执行侧只做查表分发。
   */
  registerExecutor(name: string, fn: ToolExecutorFn): void {
    if (this.executors.has(name)) {
      throw new Error(`executor_already_registered: ${name}`);
    }
    this.executors.set(name, fn);
  }

  /** 按工具名取执行函数；未注册返回 undefined，由调用方抛 `tool_not_registered`。 */
  getExecutor(name: string): ToolExecutorFn | undefined {
    return this.executors.get(name);
  }

  /**
   * 将全部已注册工具转换为 OpenAI function tool 定义。
   * strict 模式下所有字段必填且禁止额外字段（满足 OpenAI strict schema 要求）。
   * 传入 `names` 时仅转换指定工具，供调用方按业务范围裁剪工具集
   * （如 Chat Agent 只暴露联网工具，不暴露 JD 工具）。
   */
  toOpenAiTools(options: {
    strict: boolean;
    names?: string[];
  }): AgentToolDefinition[] {
    const selected = options.names
      ? this.list().filter((def) => options.names!.includes(def.name))
      : this.list();
    return selected.map((def) => ({
      type: 'function',
      name: def.name,
      description: def.description,
      strict: options.strict,
      parameters: this.toOpenAiParameters(def.inputSchema, options.strict),
    }));
  }

  /**
   * 按工具名对 arguments 做 zod 预校验，返回标准化后的值。
   * 未注册工具抛 `tool_not_registered`，校验失败抛 `openai_invalid_arguments`。
   */
  validateArguments(name: string, value: unknown): unknown {
    const def = this.tools.get(name);
    if (!def) {
      throw new Error(`tool_not_registered: ${name}`);
    }
    const result = def.inputSchema.safeParse(value);
    if (!result.success) {
      throw new Error('openai_invalid_arguments');
    }
    return result.data;
  }

  private toOpenAiParameters(
    schema: z.ZodTypeAny,
    strict: boolean,
  ): Record<string, unknown> {
    const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
    const base = this.stripJsonSchemaMeta(jsonSchema);
    return strict ? this.deepRequireAll(base) : base;
  }

  /** 移除 zod 生成的顶层 `$schema` 元信息，保持 tool parameters 精简。 */
  private stripJsonSchemaMeta(
    schema: Record<string, unknown>,
  ): Record<string, unknown> {
    const next = { ...schema };
    delete next.$schema;
    return next;
  }

  /**
   * 递归为 JSON Schema 中所有 object 节点补充 `required`（含全部属性）并禁止额外字段。
   * 仅用于 strict schema 模式。入参先深拷贝，避免原地改写共享的 base schema。
   */
  private deepRequireAll(
    node: Record<string, unknown>,
  ): Record<string, unknown> {
    const next: Record<string, unknown> = structuredClone(node);

    const properties = next.properties as Record<string, unknown> | undefined;
    if (properties && typeof properties === 'object') {
      next.required = Object.keys(properties);
      next.additionalProperties = false;
      for (const key of Object.keys(properties)) {
        const child = properties[key];
        if (child && typeof child === 'object' && !Array.isArray(child)) {
          properties[key] = this.deepRequireAll(
            child as Record<string, unknown>,
          );
        }
      }
    }

    const items = next.items as Record<string, unknown> | undefined;
    if (items && typeof items === 'object' && !Array.isArray(items)) {
      next.items = this.deepRequireAll(items);
    }

    return next;
  }
}
