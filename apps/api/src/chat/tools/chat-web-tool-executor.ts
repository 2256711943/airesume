import { Inject, Injectable } from '@nestjs/common';
import type { AgentToolCall } from '../../common/llm/openai-agent.client';
import { ToolRegistry } from '../../common/llm/tool-registry';
import {
  WEB_SEARCH_TOOL,
  type WebSearchTool,
} from '../../resume/web-search-tool.interface';
import {
  WEB_SEARCH_TOOL_NAME,
  WEB_BROWSER_TOOL_NAME,
  type WebSearchToolInput,
  type WebBrowserToolInput,
} from './web-tools.schema';
import { WebBrowserToolService } from './web-browser-tool.service';

/**
 * Chat 联网工具执行器。
 *
 * 作为 `OpenAiAgentClient.runWithTools` 的 `execute` 回调入口：
 * - 通过 `ToolRegistry.validateArguments` 按 zod schema 校验参数（失败抛错，
 *   由客户端 `safeExecute` 回填 `{ ok:false, error }` 给模型，不中断 loop）；
 * - 按工具名路由到对应实现，返回结构化的工具输出。
 */
@Injectable()
export class ChatWebToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    @Inject(WEB_SEARCH_TOOL)
    private readonly webSearchTool: WebSearchTool,
    private readonly webBrowserToolService: WebBrowserToolService,
  ) {}

  async execute(call: AgentToolCall): Promise<unknown> {
    const validated = this.registry.validateArguments(
      call.name,
      call.arguments ?? {},
    );

    switch (call.name) {
      case WEB_SEARCH_TOOL_NAME: {
        const { query } = validated as WebSearchToolInput;
        const results = await this.webSearchTool.search(query);
        return { results };
      }
      case WEB_BROWSER_TOOL_NAME: {
        const { url } = validated as WebBrowserToolInput;
        return this.webBrowserToolService.fetch(url);
      }
      default:
        throw new Error(`tool_not_registered: ${call.name}`);
    }
  }
}
