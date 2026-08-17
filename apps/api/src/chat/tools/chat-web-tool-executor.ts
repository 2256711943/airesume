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
 * - 构造时把 `web_search` / `web_browser` 的执行函数注册进 `ToolRegistry`
 *   （每个执行函数先 `validateArguments` 按 zod schema 校验，失败抛错由客户端
 *   `safeExecute` 回填 `{ ok:false, error }` 给模型，不中断 loop）；
 * - `execute` 只做查表分发，不维护工具路由分支。
 */
@Injectable()
export class ChatWebToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    @Inject(WEB_SEARCH_TOOL)
    private readonly webSearchTool: WebSearchTool,
    private readonly webBrowserToolService: WebBrowserToolService,
  ) {
    this.registerExecutors();
  }

  private registerExecutors(): void {
    this.registry.registerExecutor(WEB_SEARCH_TOOL_NAME, async (call) => {
      const { query } = this.registry.validateArguments(
        call.name,
        call.arguments ?? {},
      ) as WebSearchToolInput;
      const results = await this.webSearchTool.search(query);
      return { results };
    });

    this.registry.registerExecutor(WEB_BROWSER_TOOL_NAME, async (call) => {
      const { url } = this.registry.validateArguments(
        call.name,
        call.arguments ?? {},
      ) as WebBrowserToolInput;
      return this.webBrowserToolService.fetch(url);
    });
  }

  async execute(call: AgentToolCall): Promise<unknown> {
    const executor = this.registry.getExecutor(call.name);
    if (!executor) {
      throw new Error(`tool_not_registered: ${call.name}`);
    }
    return executor(call);
  }
}
