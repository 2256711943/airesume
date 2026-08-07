import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import type {
  PdfBrowserLaunchOptions,
  PdfBrowserProcess,
  PdfBrowserSession,
  PdfBrowserSessionRequest,
} from './pdf-export.types';

/**
 * PDF browser launcher abstraction.
 */
export abstract class PdfBrowserLauncher {
  /**
   * Launches a browser process for PDF export.
   *
   * @param options Launch parameters from the browser manager.
   * @returns An initialized browser process adapter.
   */
  abstract launch(options: PdfBrowserLaunchOptions): Promise<PdfBrowserProcess>;
}

interface PlaywrightModuleNamespace {
  chromium: {
    launch(options: PlaywrightLaunchOptions): Promise<PlaywrightBrowserHandle>;
  };
}

interface PlaywrightLaunchOptions {
  headless: boolean;
  timeout: number;
  args: string[];
  executablePath?: string;
  channel?: string;
}

interface PlaywrightBrowserHandle {
  isConnected(): boolean;
  version(): string;
  newContext(
    options?: Record<string, unknown>,
  ): Promise<PlaywrightContextHandle>;
  close(): Promise<void>;
}

interface PlaywrightContextHandle {
  newPage(): Promise<PlaywrightPageHandle>;
  close(): Promise<void>;
}

interface PlaywrightPageHandle {
  close(): Promise<void>;
}

/**
 * Playwright-backed PDF browser launcher.
 */
@Injectable()
export class PlaywrightPdfBrowserLauncher extends PdfBrowserLauncher {
  private readonly logger = new Logger(PlaywrightPdfBrowserLauncher.name);

  /**
   * Launches a shared Chromium browser via Playwright.
   *
   * @param options Launch parameters from the manager.
   * @returns A browser process adapter.
   */
  async launch(options: PdfBrowserLaunchOptions): Promise<PdfBrowserProcess> {
    const context = {
      requestId: options.requestId,
      executablePath: this.readExecutablePath(),
      channel: this.readChannel(),
      headless: this.readHeadlessFlag(),
    };
    this.logger.debug(`Launching PDF browser ${JSON.stringify(context)}`);

    try {
      const playwright = this.loadPlaywrightModule();
      const executablePath = this.readExecutablePath();
      const channel = executablePath ? null : this.readChannel();
      const browser = await playwright.chromium.launch({
        headless: this.readHeadlessFlag(),
        timeout: options.timeoutMs,
        args: this.readLaunchArgs(),
        ...(executablePath ? { executablePath } : {}),
        ...(channel ? { channel } : {}),
      });

      if (!browser.isConnected()) {
        await browser.close().catch(() => undefined);
        throw new ServiceUnavailableException('PDF_BROWSER_UNAVAILABLE');
      }

      return new PlaywrightBrowserProcessAdapter(browser);
    } catch (error) {
      this.logger.error(
        `Failed to launch PDF browser requestId=${options.requestId}: ${this.toErrorMessage(error)}`,
        this.toErrorStack(error),
      );
      throw new ServiceUnavailableException('PDF_BROWSER_UNAVAILABLE');
    }
  }

  /**
   * Loads Playwright lazily and normalizes missing-dependency failures.
   *
   * @returns The Playwright module namespace.
   */
  protected loadPlaywrightModule(): PlaywrightModuleNamespace {
    try {
      const require = createRequire(__filename);
      return require('playwright') as PlaywrightModuleNamespace;
    } catch {
      throw new ServiceUnavailableException('PDF_BROWSER_UNAVAILABLE');
    }
  }

  /**
   * Reads the executable path override from the environment.
   *
   * @returns A trimmed executable path or null.
   */
  protected readExecutablePath(): string | null {
    const value = process.env.PDF_BROWSER_EXECUTABLE_PATH?.trim();
    return value && value.length > 0 ? value : null;
  }

  /**
   * Reads the browser channel override from the environment.
   *
   * @returns A trimmed Playwright channel name or null.
   */
  protected readChannel(): string | null {
    const value = process.env.PDF_BROWSER_CHANNEL?.trim();
    return value && value.length > 0 ? value : null;
  }

  /**
   * Reads the headless flag from the environment.
   *
   * @returns True when the browser should run headless.
   */
  protected readHeadlessFlag(): boolean {
    return process.env.PDF_BROWSER_HEADLESS?.trim().toLowerCase() !== 'false';
  }

  /**
   * Builds the default Chromium args used for PDF rendering.
   *
   * @returns A stable set of launch args.
   */
  protected readLaunchArgs(): string[] {
    return ['--disable-dev-shm-usage', '--no-sandbox'];
  }

  /**
   * 将任意未知错误转换为可读消息。
   *
   * @param error 原始错误，可能是 Error、字符串或其它类型
   * @returns 错误消息文本
   */
  protected toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    if (typeof error === 'string') {
      return error;
    }

    return 'UNKNOWN_ERROR';
  }

  /**
   * 提取错误的调用堆栈，便于日志定位根因。
   *
   * @param error 原始错误
   * @returns 堆栈文本；不可用时返回空字符串
   */
  protected toErrorStack(error: unknown): string | undefined {
    return error instanceof Error ? error.stack : undefined;
  }
}

class PlaywrightBrowserProcessAdapter implements PdfBrowserProcess {
  constructor(private readonly browser: PlaywrightBrowserHandle) {}

  isConnected(): boolean {
    return this.browser.isConnected();
  }

  getVersion(): Promise<string> {
    return Promise.resolve(this.browser.version());
  }

  async newSession(
    request: PdfBrowserSessionRequest,
  ): Promise<PdfBrowserSession> {
    const context = await this.browser.newContext({ viewport: null });
    const page = await context.newPage();
    const sessionId = `pdf_session_${request.requestId}_${randomUUID()}`;

    return new PlaywrightBrowserSessionAdapter(sessionId, context, page);
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}

class PlaywrightBrowserSessionAdapter implements PdfBrowserSession {
  private closed = false;

  constructor(
    public readonly id: string,
    public readonly context: PlaywrightContextHandle,
    public readonly page: PlaywrightPageHandle,
  ) {}

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    await this.page.close().catch(() => undefined);
    await this.context.close().catch(() => undefined);
  }
}
