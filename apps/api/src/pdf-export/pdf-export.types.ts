/**
 * Configuration values for the shared PDF browser manager.
 */
export interface PdfBrowserManagerConfig {
  maxConcurrentSessions: number;
  sessionAcquireTimeoutMs: number;
  browserLaunchTimeoutMs: number;
  browserCloseTimeoutMs: number;
}

/**
 * A browser session request descriptor.
 */
export interface PdfBrowserSessionRequest {
  requestId: string;
  purpose: string;
  exportId?: string;
}

/**
 * Launch options passed to the browser launcher.
 */
export interface PdfBrowserLaunchOptions {
  requestId: string;
  timeoutMs: number;
}

/**
 * A single browser session used by one export task.
 */
export interface PdfBrowserSession {
  readonly id: string;
  readonly context?: unknown;
  readonly page?: unknown;
  close(): Promise<void>;
}

/**
 * The shared browser process abstraction.
 */
export interface PdfBrowserProcess {
  isConnected(): boolean;
  getVersion(): Promise<string>;
  newSession(request: PdfBrowserSessionRequest): Promise<PdfBrowserSession>;
  close(): Promise<void>;
}

/**
 * A session lease returned to higher-level render services.
 */
export interface PdfBrowserSessionLease {
  browserVersion: string | null;
  session: PdfBrowserSession;
}

/**
 * Lifecycle state for the shared browser manager.
 */
export type PdfBrowserManagerState = 'idle' | 'launching' | 'ready' | 'closing';

/**
 * Snapshot for diagnostics and health checks.
 */
export interface PdfBrowserManagerSnapshot {
  state: PdfBrowserManagerState;
  activeSessions: number;
  queuedSessions: number;
  browserVersion: string | null;
  lastLaunchAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
}
