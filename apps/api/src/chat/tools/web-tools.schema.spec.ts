import { ToolRegistry } from '../../common/llm/tool-registry';
import {
  WEB_SEARCH_TOOL_NAME,
  WEB_BROWSER_TOOL_NAME,
  webSearchToolInputSchema,
  webBrowserToolInputSchema,
  registerChatWebTools,
} from './web-tools.schema';

describe('Chat web tool contracts', () => {
  describe('web_search schema', () => {
    it('accepts a valid query with optional maxResults', () => {
      const result = webSearchToolInputSchema.safeParse({
        query: 'NestJS best practices 2026',
        maxResults: 3,
      });
      expect(result.success).toBe(true);
    });

    it('accepts a query without maxResults', () => {
      const result = webSearchToolInputSchema.safeParse({
        query: '前端面试高频题',
      });
      expect(result.success).toBe(true);
    });

    it('rejects an empty query', () => {
      const result = webSearchToolInputSchema.safeParse({ query: '' });
      expect(result.success).toBe(false);
    });

    it('rejects maxResults outside the allowed range', () => {
      expect(
        webSearchToolInputSchema.safeParse({ query: 'x', maxResults: 0 })
          .success,
      ).toBe(false);
      expect(
        webSearchToolInputSchema.safeParse({ query: 'x', maxResults: 11 })
          .success,
      ).toBe(false);
    });

    it('rejects non-integer maxResults', () => {
      const result = webSearchToolInputSchema.safeParse({
        query: 'x',
        maxResults: 2.5,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('web_browser schema', () => {
    it('accepts a valid url', () => {
      const result = webBrowserToolInputSchema.safeParse({
        url: 'https://example.com/article',
      });
      expect(result.success).toBe(true);
    });

    it('rejects an empty url', () => {
      const result = webBrowserToolInputSchema.safeParse({ url: '' });
      expect(result.success).toBe(false);
    });
  });

  describe('ToolRegistry integration', () => {
    let registry: ToolRegistry;

    beforeEach(() => {
      registry = new ToolRegistry();
    });

    it('registers both tools and converts to OpenAI parameters (non-strict)', () => {
      registerChatWebTools(registry);
      const tools = registry.toOpenAiTools({ strict: false });

      expect(tools.map((tool) => tool.name)).toEqual([
        WEB_SEARCH_TOOL_NAME,
        WEB_BROWSER_TOOL_NAME,
      ]);

      for (const tool of tools) {
        expect(tool).toMatchObject({
          type: 'function',
          strict: false,
        });
        expect(typeof tool.description).toBe('string');
        expect(tool.parameters).not.toHaveProperty('$schema');
        expect(tool.parameters.type).toBe('object');
      }
    });

    it('converts to strict parameters with all-required and no additional props', () => {
      registerChatWebTools(registry);
      const tools = registry.toOpenAiTools({ strict: true });

      for (const tool of tools) {
        expect(tool.strict).toBe(true);
        const params = tool.parameters;
        expect(params.additionalProperties).toBe(false);
        expect(Array.isArray(params.required)).toBe(true);
        expect(params.required).toEqual(Object.keys(params.properties ?? {}));
      }

      const webSearch = tools.find(
        (tool) => tool.name === WEB_SEARCH_TOOL_NAME,
      );
      expect(webSearch?.parameters).toMatchObject({
        type: 'object',
        required: ['query', 'maxResults'],
        additionalProperties: false,
      });
    });

    it('validates arguments through the registry', () => {
      registerChatWebTools(registry);
      const value = registry.validateArguments(WEB_SEARCH_TOOL_NAME, {
        query: '面试技巧',
      });
      expect(value).toEqual({ query: '面试技巧' });
    });

    it('throws tool_not_registered for unknown tool names', () => {
      expect(() => registry.validateArguments('missing_tool', {})).toThrow(
        'tool_not_registered: missing_tool',
      );
    });

    it('throws on duplicate registration', () => {
      registerChatWebTools(registry);
      expect(() => registerChatWebTools(registry)).toThrow(
        `tool_already_registered: ${WEB_SEARCH_TOOL_NAME}`,
      );
    });
  });
});
