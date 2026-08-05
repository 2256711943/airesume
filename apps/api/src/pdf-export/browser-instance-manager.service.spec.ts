import { BrowserInstanceManagerService } from './browser-instance-manager.service';
import { PdfBrowserLauncher } from './browser-launcher';
import type {
  PdfBrowserLaunchOptions,
  PdfBrowserManagerConfig,
  PdfBrowserProcess,
  PdfBrowserSession,
  PdfBrowserSessionRequest,
} from './pdf-export.types';

class FakeBrowserSession implements PdfBrowserSession {
  closed = false;

  constructor(public readonly id: string) {}

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeBrowserProcess implements PdfBrowserProcess {
  connected = true;
  closed = false;
  sessionCount = 0;
  readonly sessions: FakeBrowserSession[] = [];

  constructor(private readonly version: string) {}

  isConnected(): boolean {
    return this.connected;
  }

  getVersion(): Promise<string> {
    return Promise.resolve(this.version);
  }

  newSession(request: PdfBrowserSessionRequest): Promise<PdfBrowserSession> {
    void request;
    this.sessionCount += 1;
    const session = new FakeBrowserSession(
      `session-${this.version}-${this.sessionCount}`,
    );
    this.sessions.push(session);
    return Promise.resolve(session);
  }

  close(): Promise<void> {
    this.closed = true;
    this.connected = false;
    return Promise.resolve();
  }
}

class FakeBrowserLauncher extends PdfBrowserLauncher {
  launchCount = 0;
  readonly browsers: FakeBrowserProcess[] = [];

  launch(options: PdfBrowserLaunchOptions): Promise<PdfBrowserProcess> {
    void options;
    this.launchCount += 1;
    const browser = new FakeBrowserProcess(`v${this.launchCount}`);
    this.browsers.push(browser);
    return Promise.resolve(browser);
  }
}

function createConfig(
  overrides: Partial<PdfBrowserManagerConfig> = {},
): PdfBrowserManagerConfig {
  return {
    maxConcurrentSessions: 2,
    sessionAcquireTimeoutMs: 200,
    browserLaunchTimeoutMs: 200,
    browserCloseTimeoutMs: 200,
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

describe('BrowserInstanceManagerService', () => {
  it('reuses a shared browser process across sessions', async () => {
    const launcher = new FakeBrowserLauncher();
    const manager = new BrowserInstanceManagerService(createConfig(), launcher);

    await manager.withSession(
      { requestId: 'req-1', purpose: 'pdf-export' },
      () => Promise.resolve('first'),
    );
    await manager.withSession(
      { requestId: 'req-2', purpose: 'pdf-export' },
      () => Promise.resolve('second'),
    );

    expect(launcher.launchCount).toBe(1);
    expect(launcher.browsers[0].sessionCount).toBe(2);
    expect(
      launcher.browsers[0].sessions.every((session) => session.closed),
    ).toBe(true);

    await manager.onModuleDestroy();
    expect(launcher.browsers[0].closed).toBe(true);
  });

  it('queues session acquisition when the concurrency limit is reached', async () => {
    const launcher = new FakeBrowserLauncher();
    const manager = new BrowserInstanceManagerService(
      createConfig({
        maxConcurrentSessions: 1,
        sessionAcquireTimeoutMs: 500,
      }),
      launcher,
    );
    const firstEntered = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    let secondStarted = false;

    const firstTask = manager.withSession(
      { requestId: 'req-1', purpose: 'pdf-export' },
      async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
        return 'first';
      },
    );

    await firstEntered.promise;

    const secondTask = manager.withSession(
      { requestId: 'req-2', purpose: 'pdf-export' },
      () => {
        secondStarted = true;
        return Promise.resolve('second');
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(secondStarted).toBe(false);
    expect(manager.getSnapshot().queuedSessions).toBe(1);

    releaseFirst.resolve();

    await expect(firstTask).resolves.toBe('first');
    await expect(secondTask).resolves.toBe('second');
  });

  it('relaunches the browser after the shared instance disconnects', async () => {
    const launcher = new FakeBrowserLauncher();
    const manager = new BrowserInstanceManagerService(createConfig(), launcher);

    await manager.withSession(
      { requestId: 'req-1', purpose: 'pdf-export' },
      () => Promise.resolve('first'),
    );

    launcher.browsers[0].connected = false;

    await manager.withSession(
      { requestId: 'req-2', purpose: 'pdf-export' },
      () => Promise.resolve('second'),
    );

    expect(launcher.launchCount).toBe(2);
    expect(launcher.browsers[0].closed).toBe(true);
    expect(launcher.browsers[1].sessionCount).toBe(1);
  });
});
