import { Global, Module } from '@nestjs/common';
import { OpenAiAgentClient } from './openai-agent.client';
import { ToolRegistry } from './tool-registry';

/**
 * LLM 基础设施共享模块（全局）。
 *
 * 提供并导出：
 * - `ToolRegistry`：通用工具注册表，统一登记各业务模块的工具定义（zod schema 单一来源）、
 *   转换为 OpenAI function calling 的 `tools` 参数并提供参数校验入口；
 * - `OpenAiAgentClient`：基于 Responses API 的通用 Agent tool loop 客户端，
 *   已支持多轮 loop 与 `stopOnToolCall` 单轮两种模式。
 *
 * 业务模块（Resume、Chat 等）各自在模块初始化时向 `ToolRegistry` 注册自己的工具
 * （如 `registerJdTools`），公共层不反向依赖业务模块。
 *
 * 说明：`OpenAiAgentClient` 的构造参数（LLM 配置）来自默认的 `loadOpenAiLlmConfig()`，
 * 不属于 DI 依赖，因此这里用 useFactory 显式构造，避免依赖裸 class 被 Nest 隐式实例化，
 * 也避免未来加 `@Injectable()` 后构造函数默认参数被当作 DI 依赖解析而失败。
 */
@Global()
@Module({
  providers: [
    ToolRegistry,
    {
      provide: OpenAiAgentClient,
      useFactory: (): OpenAiAgentClient => new OpenAiAgentClient(),
    },
  ],
  exports: [ToolRegistry, OpenAiAgentClient],
})
export class LlmModule {}
