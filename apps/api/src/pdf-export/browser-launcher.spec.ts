import { ServiceUnavailableException } from '@nestjs/common';
import { PlaywrightPdfBrowserLauncher } from './browser-launcher';
import type { PdfBrowserLaunchOptions } from './pdf-export.types';

interface FakeLaunchOptions {
  headless: boolean;
  timeout: number;
  args: string[];
  executablePath?: string;
  channel?: string;
}

class FakePage {
  closed = false;

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeContext {
  closed = false;
  readonly pages: FakePage[] = [];

  newPage(): Promise<FakePage> {
    const page = new FakePage();
    this.pages.push(page);
    return Promise.resolve(page);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeBrowser {
  connected = true;
  closed = false;
  readonly contexts: FakeContext[] = [];

  isConnected(): boolean {
    return this.connected;
  }

  version(): string {
    return '1.2.3';
  }

  newContext(): Promise<FakeContext> {
    const context = new FakeContext();
    this.contexts.push(context);
    return Promise.resolve(context);
  }

  close(): Promise<void> {
    this.connected = false;
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeChromium {
  launchOptions: FakeLaunchOptions | null = null;

  constructor(private readonly browser: FakeBrowser) {}

  launch(options: FakeLaunchOptions): Promise<FakeBrowser> {
    this.launchOptions = options;
    return Promise.resolve(this.browser);
  }
}

class TestPlaywrightLauncher extends PlaywrightPdfBrowserLauncher {
  constructor(private readonly chromium: FakeChromium) {
    super();
  }

  protected loadPlaywrightModule() {
    return { chromium: this.chromium };
  }
}

describe('PlaywrightPdfBrowserLauncher', () => {
  let originalExecutablePath: string | undefined;
  let originalChannel: string | undefined;
  let originalHeadless: string | undefined;

  beforeEach(() => {
    originalExecutablePath = process.env.PDF_BROWSER_EXECUTABLE_PATH;
    originalChannel = process.env.PDF_BROWSER_CHANNEL;
    originalHeadless = process.env.PDF_BROWSER_HEADLESS;
  });

  afterEach(() => {
    process.env.PDF_BROWSER_EXECUTABLE_PATH = originalExecutablePath;
    process.env.PDF_BROWSER_CHANNEL = originalChannel;
    process.env.PDF_BROWSER_HEADLESS = originalHeadless;
  });

  it('launches Playwright with the configured browser options', async () => {
    process.env.PDF_BROWSER_EXECUTABLE_PATH = 'C:\\browser.exe';
    process.env.PDF_BROWSER_HEADLESS = 'false';

    const browser = new FakeBrowser();
    const chromium = new FakeChromium(browser);
    const launcher = new TestPlaywrightLauncher(chromium);
    const options: PdfBrowserLaunchOptions = {
      requestId: 'req-1',
      timeoutMs: 1_234,
    };

    const browserProcess = await launcher.launch(options);

    expect(chromium.launchOptions).toEqual({
      headless: false,
      timeout: 1_234,
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
      executablePath: 'C:\\browser.exe',
    });
    expect(browserProcess.isConnected()).toBe(true);
    expect(await browserProcess.getVersion()).toBe('1.2.3');

    const session = await browserProcess.newSession({
      requestId: 'req-1',
      purpose: 'pdf-export',
    });
    expect(session.context).toBeDefined();
    expect(session.page).toBeDefined();

    await session.close();
    expect(browser.contexts[0].closed).toBe(true);
    expect(browser.contexts[0].pages[0].closed).toBe(true);

    await browserProcess.close();
    expect(browser.closed).toBe(true);
  });

  it('maps runtime resolution failures to PDF_BROWSER_UNAVAILABLE', async () => {
    class BrokenLauncher extends PlaywrightPdfBrowserLauncher {
      protected loadPlaywrightModule(): never {
        throw new Error('missing');
      }
    }

    await expect(
      new BrokenLauncher().launch({
        requestId: 'req-2',
        timeoutMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
