import { Injectable, Logger } from '@nestjs/common';
import { BrowserInstanceManagerService } from '../../pdf-export/browser-instance-manager.service';
import type { WebBrowserToolOutput } from './web-tools.schema';
import {
  WebUrlSecurity,
  type UrlSecurityResult,
} from './web-url-security.util';

/** 单页抓取整体超时（默认 10s，对应实施计划书 7.3）。 */
export const DEFAULT_WEB_BROWSER_TIMEOUT_MS = 10_000;
/** 正文提取后最大保留字符数（默认 16KB，超出截断并标记 truncated）。 */
export const DEFAULT_WEB_BROWSER_MAX_CONTENT_CHARS = 16 * 1024;

export interface WebBrowserToolOptions {
  timeoutMs?: number;
  maxContentChars?: number;
}

/**
 * 从浏览器会话中拿到的页面句柄的最小契约。
 * 与 pdf-export 的浏览器实现解耦：实际运行时由 Playwright Page 满足该结构。
 */
export interface WebBrowserPageHandle {
  goto(
    url: string,
    options: { waitUntil: 'domcontentloaded'; timeout: number },
  ): Promise<unknown>;
  title(): Promise<string>;
  url(): Promise<string>;
  evaluate<R>(fn: () => R): Promise<R>;
}

/**
 * `web_browser` 工具执行服务。
 *
 * 复用 pdf-export 的 `BrowserInstanceManagerService` 浏览器实例（含信号量与超时），
 * 在受管会话内完成：URL 安全校验 → 打开页面 → 重定向复检 → 提取标题与正文 → 截断。
 */
@Injectable()
export class WebBrowserToolService {
  private readonly logger = new Logger(WebBrowserToolService.name);

  private readonly timeoutMs: number;
  private readonly maxContentChars: number;

  constructor(
    private readonly browserInstanceManager: BrowserInstanceManagerService,
    private readonly urlSecurity: WebUrlSecurity,
    options: WebBrowserToolOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_WEB_BROWSER_TIMEOUT_MS;
    this.maxContentChars =
      options.maxContentChars ?? DEFAULT_WEB_BROWSER_MAX_CONTENT_CHARS;
  }

  /**
   * 抓取单个 URL，返回标题与截断后的正文。
   * 校验失败或抓取超时抛错，错误由上层 executor 回填给模型。
   */
  async fetch(
    rawUrl: string,
    signal?: AbortSignal,
  ): Promise<WebBrowserToolOutput> {
    const initial = await this.urlSecurity.assertFetchable(rawUrl);
    if (!initial.ok) {
      throw new Error(`web_browser_invalid_url:${initial.error}`);
    }

    try {
      return await this.browserInstanceManager.withSession(
        {
          requestId: `chat_web_browser_${Date.now()}`,
          purpose: 'chat_web_browser',
        },
        async (lease) => {
          const page = lease.session.page as WebBrowserPageHandle | null;
          if (!page) {
            throw new Error('web_browser_no_page');
          }

          await this.withTimeout(
            page.goto(initial.normalizedUrl, {
              waitUntil: 'domcontentloaded',
              timeout: this.timeoutMs,
            }),
            this.timeoutMs,
            'web_browser_timeout',
            signal,
          );

          // 重定向复检：最终 URL 与初始不一致时重新走安全校验
          const finalUrl = await this.withTimeout(
            page.url(),
            this.timeoutMs,
            'web_browser_timeout',
            signal,
          );
          if (finalUrl && finalUrl !== initial.normalizedUrl) {
            const recheck: UrlSecurityResult =
              await this.urlSecurity.assertFetchable(finalUrl);
            if (!recheck.ok) {
              throw new Error(`web_browser_redirect_blocked:${recheck.error}`);
            }
          }

          const title = await this.withTimeout(
            page.title(),
            this.timeoutMs,
            'web_browser_timeout',
            signal,
          );
          const text = await this.withTimeout(
            page.evaluate(() => (document.body ? document.body.innerText : '')),
            this.timeoutMs,
            'web_browser_timeout',
            signal,
          );

          return {
            title: title ?? '',
            content: text.slice(0, this.maxContentChars),
            truncated: text.length > this.maxContentChars,
          };
        },
      );
    } catch (error) {
      this.logger.warn(
        `web_browser fetch failed url=${rawUrl} error=${
          error instanceof Error ? error.message : 'unknown_error'
        }`,
      );
      throw error;
    }
  }

  /** 为异步操作附加超时与 AbortSignal 取消支持。 */
  private async withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    errorCode: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(errorCode));
      }, timeoutMs);

      const onAbort = (): void => {
        cleanup();
        reject(new Error('aborted'));
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };

      if (signal?.aborted) {
        cleanup();
        reject(new Error('aborted'));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      operation
        .then((value) => {
          cleanup();
          resolve(value);
        })
        .catch((error: unknown) => {
          cleanup();
          reject(error instanceof Error ? error : new Error('unknown_error'));
        });
    });
  }
}
