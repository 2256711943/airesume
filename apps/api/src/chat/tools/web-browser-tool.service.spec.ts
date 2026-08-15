import type { BrowserInstanceManagerService } from '../../pdf-export/browser-instance-manager.service';
import {
  WebBrowserToolService,
  type WebBrowserPageHandle,
} from './web-browser-tool.service';
import { WebUrlSecurity } from './web-url-security.util';

const MAX_CHARS = 100;
const TIMEOUT_MS = 100;

function createPage(overrides: Partial<WebBrowserPageHandle> = {}) {
  return {
    goto: jest.fn().mockResolvedValue(undefined),
    title: jest.fn().mockResolvedValue('Page Title'),
    url: jest.fn().mockResolvedValue('https://example.com/'),
    evaluate: jest.fn().mockResolvedValue('some body text'),
    ...overrides,
  };
}

function createManager(page: WebBrowserPageHandle) {
  return {
    withSession: jest.fn(
      async (
        _request: unknown,
        handler: (lease: unknown) => Promise<unknown>,
      ) => handler({ session: { page } }),
    ),
  } as unknown as BrowserInstanceManagerService;
}

function createSecurity(results: {
  [url: string]:
    | { ok: true; normalizedUrl: string }
    | { ok: false; error: string };
}) {
  return {
    assertFetchable: jest.fn((url: string) =>
      Promise.resolve(results[url] ?? { ok: false, error: 'blocked_ip' }),
    ),
  } as unknown as WebUrlSecurity;
}

describe('WebBrowserToolService', () => {
  it('rejects an invalid initial url without opening a browser session', async () => {
    const page = createPage();
    const manager = createManager(page);
    const security = createSecurity({
      'http://127.0.0.1/': { ok: false, error: 'blocked_ip' },
    });
    const service = new WebBrowserToolService(manager, security, {
      timeoutMs: TIMEOUT_MS,
      maxContentChars: MAX_CHARS,
    });

    await expect(service.fetch('http://127.0.0.1/')).rejects.toThrow(
      'web_browser_invalid_url:blocked_ip',
    );
    expect(manager.withSession).not.toHaveBeenCalled();
  });

  it('fetches title and content on success', async () => {
    const page = createPage({
      title: jest.fn().mockResolvedValue('Article Title'),
      evaluate: jest.fn().mockResolvedValue('article body content'),
    });
    const manager = createManager(page);
    const security = createSecurity({
      'https://example.com/': {
        ok: true,
        normalizedUrl: 'https://example.com/',
      },
    });
    const service = new WebBrowserToolService(manager, security, {
      timeoutMs: TIMEOUT_MS,
      maxContentChars: MAX_CHARS,
    });

    const output = await service.fetch('https://example.com/');
    expect(output).toEqual({
      title: 'Article Title',
      content: 'article body content',
      truncated: false,
    });
    expect(page.goto).toHaveBeenCalledWith('https://example.com/', {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT_MS,
    });
  });

  it('truncates oversized content and marks truncated', async () => {
    const longText = 'x'.repeat(MAX_CHARS + 50);
    const page = createPage({
      evaluate: jest.fn().mockResolvedValue(longText),
    });
    const manager = createManager(page);
    const security = createSecurity({
      'https://example.com/': {
        ok: true,
        normalizedUrl: 'https://example.com/',
      },
    });
    const service = new WebBrowserToolService(manager, security, {
      timeoutMs: TIMEOUT_MS,
      maxContentChars: MAX_CHARS,
    });

    const output = await service.fetch('https://example.com/');
    expect(output.content).toHaveLength(MAX_CHARS);
    expect(output.truncated).toBe(true);
  });

  it('blocks a redirect to a private address', async () => {
    const page = createPage({
      url: jest.fn().mockResolvedValue('http://127.0.0.1/admin'),
    });
    const manager = createManager(page);
    const security = createSecurity({
      'https://example.com/': {
        ok: true,
        normalizedUrl: 'https://example.com/',
      },
      'http://127.0.0.1/admin': { ok: false, error: 'blocked_ip' },
    });
    const service = new WebBrowserToolService(manager, security, {
      timeoutMs: TIMEOUT_MS,
      maxContentChars: MAX_CHARS,
    });

    await expect(service.fetch('https://example.com/')).rejects.toThrow(
      'web_browser_redirect_blocked:blocked_ip',
    );
  });

  it('allows a redirect to a public address', async () => {
    const page = createPage({
      url: jest.fn().mockResolvedValue('https://redirected.example.com/'),
    });
    const manager = createManager(page);
    const security = createSecurity({
      'https://example.com/': {
        ok: true,
        normalizedUrl: 'https://example.com/',
      },
      'https://redirected.example.com/': {
        ok: true,
        normalizedUrl: 'https://redirected.example.com/',
      },
    });
    const service = new WebBrowserToolService(manager, security, {
      timeoutMs: TIMEOUT_MS,
      maxContentChars: MAX_CHARS,
    });

    const output = await service.fetch('https://example.com/');
    expect(output.title).toBe('Page Title');
  });

  it('times out when goto never resolves', async () => {
    const page = createPage({
      goto: jest.fn(() => new Promise<never>(() => {})),
    });
    const manager = createManager(page);
    const security = createSecurity({
      'https://example.com/': {
        ok: true,
        normalizedUrl: 'https://example.com/',
      },
    });
    const service = new WebBrowserToolService(manager, security, {
      timeoutMs: 30,
      maxContentChars: MAX_CHARS,
    });

    await expect(service.fetch('https://example.com/')).rejects.toThrow(
      'web_browser_timeout',
    );
  });
});
