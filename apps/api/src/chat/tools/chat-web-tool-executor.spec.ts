import type { AgentToolCall } from '../../common/llm/openai-agent.client';
import { ToolRegistry } from '../../common/llm/tool-registry';
import type { WebSearchTool } from '../../resume/web-search-tool.interface';
import { ChatWebToolExecutor } from './chat-web-tool-executor';
import {
  WEB_SEARCH_TOOL_NAME,
  WEB_BROWSER_TOOL_NAME,
  registerChatWebTools,
} from './web-tools.schema';
import type { WebBrowserToolService } from './web-browser-tool.service';

const call = (
  name: string,
  args: unknown,
  callId = 'call_1',
): AgentToolCall => ({ callId, name, arguments: args });

describe('ChatWebToolExecutor', () => {
  let registry: ToolRegistry;
  let webSearchTool: jest.Mocked<WebSearchTool>;
  let webBrowserToolService: jest.Mocked<Pick<WebBrowserToolService, 'fetch'>>;
  let executor: ChatWebToolExecutor;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerChatWebTools(registry);
    webSearchTool = {
      search: jest
        .fn()
        .mockResolvedValue([
          { title: 't1', url: 'https://example.com/1', snippet: 's1' },
        ]),
    };
    webBrowserToolService = {
      fetch: jest.fn().mockResolvedValue({
        title: 'Page',
        content: 'body',
        truncated: false,
      }),
    };
    executor = new ChatWebToolExecutor(
      registry,
      webSearchTool,
      webBrowserToolService as unknown as WebBrowserToolService,
    );
  });

  it('routes web_search to the search tool', async () => {
    const output = await executor.execute(
      call(WEB_SEARCH_TOOL_NAME, { query: '面试技巧' }),
    );
    expect(output).toEqual({
      results: [{ title: 't1', url: 'https://example.com/1', snippet: 's1' }],
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(webSearchTool.search).toHaveBeenCalledWith('面试技巧');
  });

  it('routes web_browser to the browser service', async () => {
    const output = await executor.execute(
      call(WEB_BROWSER_TOOL_NAME, { url: 'https://example.com/' }),
    );
    expect(output).toEqual({
      title: 'Page',
      content: 'body',
      truncated: false,
    });
    expect(webBrowserToolService.fetch).toHaveBeenCalledWith(
      'https://example.com/',
    );
  });

  it('rejects invalid arguments with openai_invalid_arguments', async () => {
    await expect(
      executor.execute(call(WEB_BROWSER_TOOL_NAME, { url: '' })),
    ).rejects.toThrow('openai_invalid_arguments');
    expect(webBrowserToolService.fetch).not.toHaveBeenCalled();
  });

  it('throws tool_not_registered for unknown tools', async () => {
    await expect(executor.execute(call('unknown_tool', {}))).rejects.toThrow(
      'tool_not_registered: unknown_tool',
    );
  });
});
