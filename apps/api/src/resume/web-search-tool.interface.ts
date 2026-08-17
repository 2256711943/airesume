/**
 * 简历重写 Agent 的联网搜索工具接口（Phase 5 预留）。
 *
 * 当前仅定义契约与 DI token，不绑定具体搜索服务商。
 * 生产接入时提供实现并注册到 `WEB_SEARCH_TOOL` 即可，
 * `ResumeAgentLoopService` 会在每次重写前注入搜索结果摘要作为外部知识上下文。
 */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 用于获取最新技术知识的搜索能力。 */
export interface WebSearchTool {
  search(query: string, signal?: AbortSignal): Promise<WebSearchResult[]>;
}

/** NestJS DI token：注册/注入 `WebSearchTool` 实现。 */
export const WEB_SEARCH_TOOL = Symbol('WEB_SEARCH_TOOL');
