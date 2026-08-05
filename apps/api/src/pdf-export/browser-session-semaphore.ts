/**
 * 浏览器会话信号量，用于限制 PDF 导出任务的并发会话数。
 *
 * 基于"许可（permit）"机制实现：获取许可后方可执行会话，
 * 许可耗尽时后续请求进入等待队列，可配置超时时间避免无限排队。
 * 释放许可时会优先将许可转交给队首等待者，实现公平的 FIFO 调度。
 */
export class BrowserSessionSemaphore {
  /** 最大许可数，即最大并发会话数 */
  private readonly maxPermits: number;
  /** 当前可用许可数 */
  private availablePermits: number;
  /**
   * 等待获取许可的请求队列（FIFO）。
   * 每个等待者携带 resolve/reject 回调以及可选的超时定时器。
   */
  private readonly waitQueue: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout | null;
  }> = [];

  /**
   * @param maxPermits 最大许可数，至少为 1，向下取整
   */
  constructor(maxPermits: number) {
    this.maxPermits = Math.max(1, Math.floor(maxPermits));
    this.availablePermits = this.maxPermits;
  }

  /** 当前已分配出去的许可数（即活跃会话数） */
  get activeCount(): number {
    return this.maxPermits - this.availablePermits;
  }

  /** 当前排队等待许可的请求数 */
  get queuedCount(): number {
    return this.waitQueue.length;
  }

  /**
   * 获取一个许可，返回用于释放该许可的函数。
   *
   * 若当前有可用许可则立即返回；否则进入等待队列，
   * 并在 `timeoutMs` 毫秒后仍未获得许可时抛出超时错误。
   *
   * @param timeoutMs 等待超时时间（毫秒），<= 0 表示永不超时
   * @returns 释放许可的幂等函数，调用后许可被归还或转交
   * @throws {Error} 超时未获得许可时抛出 `PDF_BROWSER_SESSION_QUEUE_TIMEOUT`
   */
  acquire(timeoutMs: number): Promise<() => void> {
    if (this.availablePermits > 0) {
      this.availablePermits -= 1;
      return Promise.resolve(this.createRelease());
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: null as NodeJS.Timeout | null,
      };

      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const queueIndex = this.waitQueue.indexOf(waiter);
          if (queueIndex >= 0) {
            this.waitQueue.splice(queueIndex, 1);
          }
          reject(new Error('PDF_BROWSER_SESSION_QUEUE_TIMEOUT'));
        }, timeoutMs);
      }

      this.waitQueue.push(waiter);
    });
  }

  /**
   * 创建一个幂等的许可释放函数。
   *
   * 释放时优先将许可直接转交给队首的等待者（不再归还给可用池），
   * 若无等待者则归还到可用池，且可用数不超过最大许可数。
   */
  private createRelease(): () => void {
    let released = false;

    return () => {
      if (released) {
        return;
      }
      released = true;

      const nextWaiter = this.waitQueue.shift();
      if (nextWaiter) {
        if (nextWaiter.timer) {
          clearTimeout(nextWaiter.timer);
        }
        nextWaiter.resolve(this.createRelease());
        return;
      }

      this.availablePermits = Math.min(
        this.maxPermits,
        this.availablePermits + 1,
      );
    };
  }
}
