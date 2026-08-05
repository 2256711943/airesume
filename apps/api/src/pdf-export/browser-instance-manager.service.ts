import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PdfBrowserLauncher } from './browser-launcher';
import { BrowserSessionSemaphore } from './browser-session-semaphore';
import { PDF_BROWSER_MANAGER_CONFIG } from './pdf-export.constants';
import type {
  PdfBrowserManagerConfig,
  PdfBrowserManagerSnapshot,
  PdfBrowserProcess,
  PdfBrowserSession,
  PdfBrowserSessionLease,
  PdfBrowserSessionRequest,
} from './pdf-export.types';

/**
 * 浏览器操作超时错误。
 *
 * 用于区分"操作本身失败"与"操作超过约定时限"，内部仅供超时逻辑抛出。
 */
class PdfBrowserTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfBrowserTimeoutError';
  }
}

/**
 * 浏览器实例管理器服务。
 *
 * 负责 PDF 浏览器进程的整个生命周期管理：
 * - 懒启动：首次使用时才启动浏览器进程，并缓存启动 Promise 防止并发重复启动
 * - 会话复用：单个浏览器进程内可创建多个会话，通过信号量限制并发数
 * - 超时保护：启动、关闭、会话获取均有超时控制
 * - 故障恢复：检测到浏览器断连时自动失效并清理，等待下次使用时重建
 * - 生命周期：模块销毁（`onModuleDestroy`）时优雅关闭浏览器
 *
 * 对外提供 `withSession` 作为核心入口：业务方传入请求描述与处理回调，
 * 服务保证会话被正确获取、使用与释放。
 */
@Injectable()
export class BrowserInstanceManagerService implements OnModuleDestroy {
  /** 本服务的日志记录器 */
  private readonly logger = new Logger(BrowserInstanceManagerService.name);
  /** 会话信号量，限制最大并发会话数 */
  private readonly sessionSemaphore: BrowserSessionSemaphore;
  /** 当前浏览器进程，null 表示尚未启动 */
  private browser: PdfBrowserProcess | null = null;
  /** 当前浏览器版本号 */
  private browserVersion: string | null = null;
  /** 进行中的启动 Promise，用于合并并发启动请求 */
  private launchPromise: Promise<PdfBrowserProcess> | null = null;
  /** 当前运行状态 */
  private state: PdfBrowserManagerSnapshot['state'] = 'idle';
  /** 最近一次成功启动时间（ISO 8601） */
  private lastLaunchAt: string | null = null;
  /** 最近一次失败时间（ISO 8601） */
  private lastFailureAt: string | null = null;
  /** 最近一次失败原因 */
  private lastFailureReason: string | null = null;

  /**
   * @param config 浏览器管理器配置（由工厂函数从环境变量构建）
   * @param launcher 浏览器启动器实现
   */
  constructor(
    @Inject(PDF_BROWSER_MANAGER_CONFIG)
    private readonly config: PdfBrowserManagerConfig,
    private readonly launcher: PdfBrowserLauncher,
  ) {
    this.sessionSemaphore = new BrowserSessionSemaphore(
      this.config.maxConcurrentSessions,
    );
  }

  /**
   * 在一个受管理的浏览器会话中执行业务处理函数。
   *
   * 流程：获取会话许可 → 确保浏览器就绪 → 创建会话 → 执行回调 →
   * 无论成败都关闭会话并释放许可；若期间浏览器断连则将其失效。
   *
   * @param request 会话申请描述（请求 ID、用途等）
   * @param handler 业务处理回调，接收包含会话与版本的租约
   * @returns 业务回调的返回值
   * @throws 会话池耗尽时抛出 `ServiceUnavailableException`
   */
  async withSession<T>(
    request: PdfBrowserSessionRequest,
    handler: (lease: PdfBrowserSessionLease) => Promise<T>,
  ): Promise<T> {
    const releaseSlot = await this.acquireSlot(request);
    let session: PdfBrowserSession | null = null;

    try {
      const browser = await this.ensureBrowser(request.requestId);
      session = await browser.newSession(request);

      return await handler({
        browserVersion: this.browserVersion,
        session,
      });
    } catch (error) {
      if (this.browser && !this.browser.isConnected()) {
        await this.invalidateBrowser('browser_disconnected_during_session');
      }
      throw error;
    } finally {
      await this.closeSession(session, request);
      releaseSlot();
    }
  }

  /**
   * 获取当前浏览器实例管理器的运行快照，用于监控与健康检查。
   */
  getSnapshot(): PdfBrowserManagerSnapshot {
    return {
      state: this.state,
      activeSessions: this.sessionSemaphore.activeCount,
      queuedSessions: this.sessionSemaphore.queuedCount,
      browserVersion: this.browserVersion,
      lastLaunchAt: this.lastLaunchAt,
      lastFailureAt: this.lastFailureAt,
      lastFailureReason: this.lastFailureReason,
    };
  }

  /**
   * 主动使当前浏览器实例失效并关闭。
   *
   * 记录失败时间与原因后关闭浏览器，用于外部检测到故障时触发重建。
   *
   * @param reason 失效原因描述
   */
  async invalidateBrowser(reason: string): Promise<void> {
    this.lastFailureAt = new Date().toISOString();
    this.lastFailureReason = reason;
    await this.closeCurrentBrowser(reason);
  }

  /**
   * 模块销毁时的钩子，优雅关闭浏览器进程，避免进程残留。
   */
  async onModuleDestroy(): Promise<void> {
    await this.closeCurrentBrowser('module_destroy');
  }

  /**
   * 从信号量获取一个会话许可，失败时记录并抛出池耗尽异常。
   *
   * @param request 会话申请描述，用于异常信息定位
   * @returns 释放许可的幂等函数
   * @throws {ServiceUnavailableException} 等待超时（池耗尽）时抛出
   */
  private async acquireSlot(
    request: PdfBrowserSessionRequest,
  ): Promise<() => void> {
    try {
      return await this.sessionSemaphore.acquire(
        this.config.sessionAcquireTimeoutMs,
      );
    } catch {
      this.lastFailureAt = new Date().toISOString();
      this.lastFailureReason = 'session_pool_exhausted';
      throw new ServiceUnavailableException(
        `PDF_BROWSER_SESSION_POOL_EXHAUSTED:${request.requestId}`,
      );
    }
  }

  /**
   * 确保浏览器进程可用，必要时触发启动。
   *
   * - 已连接：直接复用当前浏览器
   * - 断连残留：先清理再重建
   * - 启动中：复用进行中的启动 Promise，避免重复启动
   * - 启动成功：校验连接、记录版本与快照信息并切换为 `ready`
   * - 启动失败：清理状态、记录失败原因并重新抛出
   *
   * @param requestId 发起请求的 ID，用于日志与超时提示
   * @returns 可用的浏览器进程
   */
  private async ensureBrowser(requestId: string): Promise<PdfBrowserProcess> {
    if (this.browser?.isConnected()) {
      return this.browser;
    }

    if (this.browser && !this.browser.isConnected()) {
      await this.closeCurrentBrowser('browser_disconnected_before_launch');
    }

    if (this.launchPromise) {
      return this.launchPromise;
    }

    this.state = 'launching';
    this.launchPromise = this.withTimeout(
      this.launcher.launch({
        requestId,
        timeoutMs: this.config.browserLaunchTimeoutMs,
      }),
      this.config.browserLaunchTimeoutMs,
      'PDF_BROWSER_LAUNCH_TIMEOUT',
    )
      .then(async (browser) => {
        if (!browser.isConnected()) {
          throw new ServiceUnavailableException(
            'PDF_BROWSER_DISCONNECTED_AFTER_LAUNCH',
          );
        }

        this.browserVersion = await browser.getVersion();
        this.browser = browser;
        this.lastLaunchAt = new Date().toISOString();
        this.lastFailureReason = null;
        this.state = 'ready';
        this.logger.log(
          `Initialized PDF browser instance (version=${this.browserVersion})`,
        );
        return browser;
      })
      .catch((error: unknown) => {
        this.browser = null;
        this.browserVersion = null;
        this.state = 'idle';
        this.lastFailureAt = new Date().toISOString();
        this.lastFailureReason = this.toErrorMessage(error);
        throw error;
      })
      .finally(() => {
        this.launchPromise = null;
      });

    return this.launchPromise;
  }

  /**
   * 关闭单个会话，关闭失败仅记录警告，不影响主流程。
   *
   * @param session 待关闭的会话，可能为 null
   * @param request 会话申请描述，用于日志定位
   */
  private async closeSession(
    session: PdfBrowserSession | null,
    request: PdfBrowserSessionRequest,
  ): Promise<void> {
    if (!session) {
      return;
    }

    try {
      await session.close();
    } catch (error) {
      this.logger.warn(
        `Failed to close PDF browser session ${session.id} for ${request.requestId}: ${this.toErrorMessage(error)}`,
      );
    }
  }

  /**
   * 关闭当前浏览器进程并重置相关状态。
   *
   * 带超时保护，关闭过程不阻塞等待；无论成败最终都回到 `idle` 状态。
   *
   * @param reason 关闭原因描述，用于日志
   */
  private async closeCurrentBrowser(reason: string): Promise<void> {
    if (!this.browser) {
      this.state = 'idle';
      return;
    }

    const browser = this.browser;
    this.browser = null;
    this.browserVersion = null;
    this.state = 'closing';

    try {
      await this.withTimeout(
        browser.close(),
        this.config.browserCloseTimeoutMs,
        'PDF_BROWSER_CLOSE_TIMEOUT',
      );
      this.logger.log(`Closed PDF browser instance (${reason})`);
    } catch (error) {
      this.logger.warn(
        `Failed to close PDF browser instance (${reason}): ${this.toErrorMessage(error)}`,
      );
    } finally {
      this.state = 'idle';
    }
  }

  /**
   * 为异步操作附加超时控制。
   *
   * 超时则拒绝并抛出 `PdfBrowserTimeoutError`（携带错误码），
   * 操作提前完成时清除定时器避免内存泄漏。
   *
   * @param operation 目标异步操作
   * @param timeoutMs 超时时间（毫秒）
   * @param errorCode 超时时携带的错误码
   * @returns 操作的返回值
   */
  private async withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    errorCode: string,
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new PdfBrowserTimeoutError(errorCode));
      }, timeoutMs);

      operation
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(
            error instanceof Error
              ? error
              : new Error(this.toErrorMessage(error)),
          );
        });
    });
  }

  /**
   * 将任意未知类型的错误转换为可读的错误消息。
   *
   * @param error 原始错误，可能是 Error、字符串或其它类型
   * @returns 错误消息文本，无法识别时返回 `UNKNOWN_ERROR`
   */
  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    if (typeof error === 'string') {
      return error;
    }

    return 'UNKNOWN_ERROR';
  }
}
