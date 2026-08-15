import { Injectable } from '@nestjs/common';
import {
  WEB_SEARCH_TOOL,
  type WebSearchResult,
  type WebSearchTool,
} from '../../resume/web-search-tool.interface';

/**
 * `web_search` 的 Mock 实现（Phase 2 占位）。
 *
 * 目的：不依赖真实搜索服务商即可跑通「模型判断 → 调工具 → 结果回填 → 最终回复」
 * 全链路，验证 schema、事件与落库。
 * 接入真实服务商时替换 `WEB_SEARCH_TOOL` 的 provider 实现即可，上层无感知。
 *
 * 注意：Mock 结果不可作为真实依据，工具描述与 Agent 提示词需同步声明该限制。
 */
@Injectable()
export class MockWebSearchTool implements WebSearchTool {
  search(query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
    if (signal?.aborted) {
      return Promise.reject(new Error('aborted'));
    }

    const encoded = encodeURIComponent(query);
    return Promise.resolve([
      {
        title: `搜索结果示例：${query}`,
        url: `https://example.com/results?q=${encoded}`,
        snippet:
          '（Mock 搜索）当前为占位实现，尚未接入真实搜索服务商。该条结果仅用于验证工具调用链路。',
      },
      {
        title: 'Example Domain',
        url: 'https://example.com',
        snippet: '示例站点，可用于验证 web_browser 抓取能力。',
      },
    ]);
  }
}

export { WEB_SEARCH_TOOL };
