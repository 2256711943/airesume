import { z } from 'zod';
import type { ToolRegistry } from '../../common/llm/tool-registry';

/**
 * Chat 联网工具契约（Phase 1）。
 *
 * 定义 `web_search` 与 `web_browser` 两个工具的入参 zod schema、输出类型与
 * 工具描述，作为单一来源：
 * - zod schema 供 `ToolRegistry.validateArguments` 做运行时参数校验；
 * - 转换为 OpenAI Responses API function calling 的 `parameters` 由
 *   `ToolRegistry.toOpenAiTools` 统一完成。
 *
 * 边界说明：
 * - 协议白名单、SSRF 防护、内容截断与抓取超时等安全边界不在 schema 层，
 *   由 Phase 2 的 executor 实现（见实施计划书第 7 节）。
 */

/** `web_search`：按关键词搜索网络，返回结构化结果列表。 */
export const WEB_SEARCH_TOOL_NAME = 'web_search';

/** `web_browser`：按 URL 抓取单页，返回页面标题与截断后的正文文本。 */
export const WEB_BROWSER_TOOL_NAME = 'web_browser';

export const webSearchToolInputSchema = z.object({
  query: z.string().min(1).max(500),
  maxResults: z.number().int().min(1).max(10).optional(),
});

export const webBrowserToolInputSchema = z.object({
  url: z.string().min(1).max(2048),
});

export type WebSearchToolInput = z.infer<typeof webSearchToolInputSchema>;
export type WebBrowserToolInput = z.infer<typeof webBrowserToolInputSchema>;

/** 单条搜索结果，结构与 `WebSearchResult`（resume 契约）保持一致。 */
export interface WebSearchToolResultItem {
  title: string;
  url: string;
  snippet: string;
}

/** `web_search` 工具输出。 */
export interface WebSearchToolOutput {
  results: WebSearchToolResultItem[];
}

/** `web_browser` 工具输出。`truncated` 为 true 表示正文已超上限被截断。 */
export interface WebBrowserToolOutput {
  title: string;
  content: string;
  truncated: boolean;
}

/**
 * `web_search` 工具描述（触发边界）：
 * 仅当问题需要对话上下文之外的最新资讯、行业动态或外部事实时调用。
 */
export const WEB_SEARCH_TOOL_DESCRIPTION =
  'Search the web for the latest information, industry news, or external facts. Use this tool when the answer requires up-to-date or external knowledge that is not available in the conversation context. Returns a list of results with title, url and snippet.';

/**
 * `web_browser` 工具描述（触发边界）：
 * 仅当需要阅读某个具体网页（如 `web_search` 返回的文章/文档）的完整正文时调用，
 * 通用问题不要使用。
 */
export const WEB_BROWSER_TOOL_DESCRIPTION =
  'Fetch and read the full content of a specific web page by URL. Use this only when you need to read the body of a concrete page (for example an article or document found via web_search); do not use it for general questions. Returns the page title and the extracted text content.';

/**
 * 将 Chat 联网工具注册进 ToolRegistry（zod schema 单一来源）。
 * 由 `ChatModule` 初始化时调用一次，避免各 client 自行注册造成重复。
 */
export function registerChatWebTools(registry: ToolRegistry): void {
  registry.register({
    name: WEB_SEARCH_TOOL_NAME,
    description: WEB_SEARCH_TOOL_DESCRIPTION,
    inputSchema: webSearchToolInputSchema,
  });
  registry.register({
    name: WEB_BROWSER_TOOL_NAME,
    description: WEB_BROWSER_TOOL_DESCRIPTION,
    inputSchema: webBrowserToolInputSchema,
  });
}
