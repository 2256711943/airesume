export type SseMachineStateValue =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'done'
  | 'error'
  | 'canceled'
  | 'retrying'
  | 'paused';

export type SseMachineEvent =
  | 'CONNECT'
  | 'CONNECTED'
  | 'TIMEOUT'
  | 'CANCEL'
  | 'ERROR'
  | 'COMPLETE'
  | 'RESET'
  | 'RETRY'
  | 'PAUSE'
  | 'RESUME';

export interface SseMachineStateContext {
  error?: unknown;
  retryCount?: number;
}

export interface SseMachineStateSnapshot {
  value: SseMachineStateValue;
  context: SseMachineStateContext;
}

export type SseMachineStateChangeHandler = (
  from: SseMachineStateSnapshot,
  to: SseMachineStateSnapshot,
) => void;

interface SseMachineOptions {
  consumeResponse: (response: Response, signal: AbortSignal) => Promise<void>;
  onStateChange?: SseMachineStateChangeHandler;
  isAbortError?: (error: unknown) => boolean;
}

const LEGAL_TRANSITIONS: Readonly<
  Record<SseMachineStateValue, Partial<Record<SseMachineEvent, SseMachineStateValue>>>
> = {
  idle: {
    CONNECT: 'connecting',
  },
  connecting: {
    CONNECTED: 'streaming',
    TIMEOUT: 'error',
    CANCEL: 'canceled',
    ERROR: 'error',
  },
  streaming: {
    COMPLETE: 'done',
    CANCEL: 'canceled',
    ERROR: 'error',
    PAUSE: 'paused',
  },
  done: {
    RESET: 'idle',
  },
  error: {
    RESET: 'idle',
    RETRY: 'retrying',
  },
  canceled: {
    RESET: 'idle',
  },
  retrying: {
    CONNECT: 'connecting',
  },
  paused: {
    RESUME: 'streaming',
  },
};

const GLOBAL_NODE_ENV =
  typeof globalThis === 'object' &&
  'process' in globalThis &&
  typeof (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV === 'string'
    ? (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV
    : undefined;

const DEV_MODE =
  (typeof import.meta !== 'undefined' && Boolean(import.meta.dev)) ||
  GLOBAL_NODE_ENV !== 'production';

export class SseMachine {
  public onStateChange?: SseMachineStateChangeHandler;

  private currentState: SseMachineStateValue = 'idle';
  private context: SseMachineStateContext = {};
  private controller: AbortController | null = null;
  private activeRunId = 0;
  private readonly consumeResponse: SseMachineOptions['consumeResponse'];
  private readonly isAbortError: NonNullable<SseMachineOptions['isAbortError']>;

  constructor(options: SseMachineOptions) {
    this.consumeResponse = options.consumeResponse;
    this.onStateChange = options.onStateChange;
    this.isAbortError =
      options.isAbortError ??
      ((error) =>
        error instanceof DOMException
          ? error.name === 'AbortError'
          : error instanceof Error && error.name === 'AbortError');
  }

  get state(): SseMachineStateSnapshot {
    return {
      value: this.currentState,
      context: { ...this.context },
    };
  }

  get signal(): AbortSignal {
    return this.ensureController().signal;
  }

  async connect(fetchPromise: Promise<Response>): Promise<void> {
    this.transition('CONNECT');
    const runId = ++this.activeRunId;
    const signal = this.ensureController().signal;

    try {
      const response = await fetchPromise;
      if (!this.isActiveRun(runId) || this.isCanceledState()) {
        return;
      }

      this.transition('CONNECTED');
      await this.consumeResponse(response, signal);

      if (!this.isActiveRun(runId) || this.isCanceledState()) {
        return;
      }

      this.transition('COMPLETE');
    } catch (error) {
      if (!this.isActiveRun(runId)) {
        return;
      }

      const canceled = this.isCanceledState() || this.isAbortError(error);
      if (canceled) {
        if (this.currentState === 'connecting' || this.currentState === 'streaming') {
          this.transition('CANCEL');
        }
        return;
      }

      this.transition('ERROR', { error });
      throw error;
    } finally {
      if (this.isActiveRun(runId)) {
        this.cleanupController();
      }
    }
  }

  cancel(): void {
    this.transition('CANCEL');
    this.controller?.abort();
  }

  reset(): void {
    this.activeRunId += 1;
    this.cleanupController();
    this.transition('RESET');
  }

  retry(): void {
    this.transition('RETRY');
  }

  pause(): void {
    this.transition('PAUSE');
  }

  resume(): void {
    this.transition('RESUME');
  }

  timeout(error?: unknown): void {
    this.transition('TIMEOUT', error === undefined ? undefined : { error });
  }

  private transition(event: SseMachineEvent, contextPatch?: Partial<SseMachineStateContext>): void {
    const nextState = LEGAL_TRANSITIONS[this.currentState][event];
    if (!nextState) {
      this.handleIllegalTransition(event);
      return;
    }

    const previousSnapshot = this.state;
    this.currentState = nextState;
    this.context = this.buildNextContext(event, contextPatch);

    this.onStateChange?.(previousSnapshot, this.state);
  }

  private buildNextContext(
    event: SseMachineEvent,
    contextPatch?: Partial<SseMachineStateContext>,
  ): SseMachineStateContext {
    const retryCount = this.context.retryCount ?? 0;

    switch (event) {
      case 'CONNECT':
      case 'CONNECTED':
      case 'COMPLETE':
      case 'CANCEL':
      case 'PAUSE':
      case 'RESUME':
        return {
          retryCount,
        };
      case 'ERROR':
      case 'TIMEOUT':
        return {
          retryCount,
          error: contextPatch?.error,
        };
      case 'RESET':
        return {};
      case 'RETRY':
        return {
          retryCount: retryCount + 1,
        };
      default:
        return { ...this.context };
    }
  }

  private ensureController(): AbortController {
    if (!this.controller) {
      this.controller = new AbortController();
    }

    return this.controller;
  }

  private cleanupController(): void {
    this.controller = null;
  }

  private handleIllegalTransition(event: SseMachineEvent): void {
    const message = `[SseMachine] Illegal transition: ${this.currentState} -> ${event}`;
    if (DEV_MODE) {
      throw new Error(message);
    }

    console.warn(message);
  }

  private isActiveRun(runId: number): boolean {
    return runId === this.activeRunId;
  }

  private isCanceledState(): boolean {
    return this.currentState === 'canceled';
  }
}

export function useSseMachine(options: SseMachineOptions) {
  return new SseMachine(options);
}
