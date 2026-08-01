/**
 * Semaphore - Concurrency limiter for async operations.
 * Allows at most `capacity` operations to run simultaneously.
 */

export class Semaphore {
  private current = 0;
  private waiting: Array<() => void> = [];

  constructor(private capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('Semaphore capacity must be a positive integer');
    }
  }

  getCapacity(): number {
    return this.capacity;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.current < this.capacity) {
      this.current++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  private release(): void {
    if (this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (!next) return;
      // Don't decrement - the slot is handed directly to next waiter
      next();
    } else {
      this.current--;
    }
  }
}
