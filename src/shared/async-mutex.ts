/**
 * AsyncMutex - Guarantees exclusive execution with automatic release.
 * Replaces manual flag management (set/clear across try/catch/finally).
 */

/**
 * Outcome of `AsyncMutex.run`. `ran: false` means the mutex was already held and
 * `fn` never executed - distinct from `fn` running and returning `undefined`
 * (#1550). Callers that need to react to contention (notify, log, retry) branch
 * on `ran`; callers that don't can ignore the result.
 */
export type MutexResult<T> = { ran: true; value: T } | { ran: false };

export class AsyncMutex {
  private locked = false;

  /** Whether the mutex is currently held. */
  get isLocked(): boolean {
    return this.locked;
  }

  /**
   * Execute `fn` exclusively. If the mutex is already locked, `fn` does NOT run
   * and the result is `{ ran: false }`. Otherwise `fn` runs and the result is
   * `{ ran: true, value }`. The lock is always released when `fn` settles.
   */
  async run<T>(fn: () => Promise<T>): Promise<MutexResult<T>> {
    if (this.locked) return { ran: false };
    this.locked = true;
    try {
      return { ran: true, value: await fn() };
    } finally {
      this.locked = false;
    }
  }
}
