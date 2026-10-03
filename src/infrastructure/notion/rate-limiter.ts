/**
 * RateLimiter - Sliding window token bucket for Notion API requests.
 *
 * Allows burst of `burst` requests instantly, then refills at `requestsPerSecond`.
 * Better throughput for bursty workloads (page + blocks = 2 rapid calls).
 * Falls back to exponential backoff on 429s.
 *
 * Supports concurrent dispatch: up to `maxConcurrent` requests in-flight simultaneously
 * (default 3, matching Notion's 3 req/s limit). This is 2.5-3x faster than serial.
 */

import { createLogger } from '../../shared/logger';
import { N2OError, NotionCanceledError, classifyErrorRetryability } from '../../shared/errors';

const log = createLogger('RateLimiter');

export class RateLimiter {
  private static readonly MAX_RETRIES = 5;
  /**
   * Reject new requests when queue exceeds this size. Lowered from 2000
   * to 500 in F-009 - at 3 req/s a full-queue worst-case wait is
   * ~170s instead of ~11 min. Callers see a clear "queue full" error
   * and can retry, rather than silently stalling.
   */
  private static readonly MAX_QUEUE_SIZE = 500;
  /** Warn when queue reaches this percentage of MAX_QUEUE_SIZE. */
  private static readonly QUEUE_WARN_THRESHOLD = 0.8;
  /**
   * Discard queued calls older than this. Prevents the "my click
   * hung for 10 minutes" experience when the queue is deep - * the caller has long since given up, so dropping the call is
   * harmless. F-009.
   *
   * Instance-overridable via `_staleMs` for tests.
   */
  private static readonly STALE_MS = 60_000;

  private queue: Array<{
    fn: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
    retries: number;
    /** Epoch ms when this item was enqueued. For stale-call expiration. F-009. */
    enqueuedAt: number;
    /**
     * Epoch ms before which this item must NOT be dispatched. Set when a 429
     * re-queues the item with a Retry-After backoff. Without it, a sibling
     * request completing would call processQueue() and dispatch the re-queued
     * item immediately, bypassing the server's Retry-After.
     */
    notBefore?: number;
  }> = [];
  /** Index pointer into queue - avoids O(n) shift() on every dequeue. */
  private queueHead = 0;

  // Concurrency state
  private inFlight = 0;
  private maxConcurrent: number;

  // Token bucket state
  private tokens: number;
  private maxTokens: number;
  private refillRate: number; // tokens per ms
  private lastRefill: number;

  /** Stale-call threshold. Defaults to STALE_MS; tests override for speed. F-009. */
  private _staleMs: number = RateLimiter.STALE_MS;

  /**
   * True between abortPending() and resetAbort(). While set, every enqueue
   * is rejected immediately and processQueue dispatches nothing, so the
   * cancelled operation's still-unwinding code can't refill the queue.
   * In-flight requests are unaffected - requestUrl cannot abort mid-flight,
   * so a cancel drains the queued tail instead.
   */
  private aborted = false;

  constructor(requestsPerSecond: number, burst: number = 2, maxConcurrent: number = 3) {
    this.maxTokens = burst;
    this.tokens = burst;
    this.refillRate = requestsPerSecond / 1000;
    this.lastRefill = Date.now();
    this.maxConcurrent = maxConcurrent;
  }

  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.aborted) {
      throw new NotionCanceledError('Request rejected: operation cancelled by user.');
    }
    const pending = this.queue.length - this.queueHead;
    if (pending >= RateLimiter.MAX_QUEUE_SIZE) {
      throw new N2OError(
        `Rate limiter queue full (${RateLimiter.MAX_QUEUE_SIZE} pending). Aborting request.`,
        'NOTION_RATE_LIMITED',
      );
    }
    const warnAt = Math.floor(RateLimiter.MAX_QUEUE_SIZE * RateLimiter.QUEUE_WARN_THRESHOLD);
    if (pending >= warnAt && pending % 100 === 0) {
      log.warn(
        `Rate limiter queue at ${Math.round(RateLimiter.QUEUE_WARN_THRESHOLD * 100)}% capacity (${pending}/${RateLimiter.MAX_QUEUE_SIZE})`,
      );
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn: fn,
        resolve: resolve as (value: unknown) => void,
        reject,
        retries: 0,
        enqueuedAt: Date.now(),
      });
      this.processQueue();
    });
  }

  /**
   * Dispatch queued requests concurrently (fire-and-forget).
   * Loops while there are tokens, queue items, and room under maxConcurrent.
   * Each dispatched request resolves/rejects its own promise independently.
   */
  private processQueue(): void {
    if (this.aborted) return;
    while (this.queueHead < this.queue.length && this.inFlight < this.maxConcurrent) {
      // Re-check per iteration: an abort can land while this loop is
      // rescheduled via setTimeout, and nothing may dispatch after it.
      if (this.aborted) return;
      this.refillTokens();

      // Front item is a 429 retry still inside its Retry-After window. A 429
      // means the whole integration is being throttled, so hold the entire
      // queue until the backoff elapses - never let a sibling's completion
      // dispatch it early. Reschedule for when it becomes due and stop here.
      const front = this.queue[this.queueHead];
      if (front?.notBefore && Date.now() < front.notBefore) {
        window.setTimeout(() => this.processQueue(), front.notBefore - Date.now());
        return;
      }

      if (this.tokens < 1) {
        // No tokens available - schedule retry after enough time for 1 token
        const waitMs = Math.max(Math.ceil((1 - this.tokens) / this.refillRate), 10);
        window.setTimeout(() => this.processQueue(), waitMs);
        return;
      }

      const item = this.queue[this.queueHead];
      this.queueHead++;
      // Reclaim memory when the consumed prefix exceeds half the array
      if (this.queueHead > 1000 && this.queueHead > this.queue.length / 2) {
        this.queue = this.queue.slice(this.queueHead);
        this.queueHead = 0;
      }
      if (!item) break;

      /* F-009 stale-call expiration: if the caller enqueued this so
       * long ago that they've almost certainly given up, reject the
       * item and move on. The token hasn't been consumed yet, so the
       * next fresh item drains normally.
       *
       * Exempt items that have already been 429-requeued (#1585): they keep
       * their original enqueuedAt, so a request held through a Retry-After
       * backoff could otherwise cross the stale cutoff and be rejected even
       * though it is actively being retried, not abandoned. */
      if (item.retries === 0 && Date.now() - item.enqueuedAt > this._staleMs) {
        item.reject(
          new N2OError(
            `Rate limiter discarded stale call (>${Math.round(this._staleMs / 1000)}s in queue).`,
            'NOTION_RATE_LIMITED',
          ),
        );
        continue;
      }

      // Consume a token and dispatch
      this.tokens--;
      this.inFlight++;

      let requeued = false;

      item
        .fn()
        .then((result) => {
          item.resolve(result);
        })
        .catch((error) => {
          // An in-flight request that 429s AFTER an abort must not re-queue
          // itself into the drained queue - it would fire again in the next
          // run. Reject it like the queued tail was rejected. Non-429 errors
          // below still surface as themselves.
          if (this.aborted && this.isRateLimitError(error)) {
            item.reject(new NotionCanceledError('Request rejected: operation cancelled by user.'));
            return;
          }
          if (this.isRateLimitError(error)) {
            item.retries++;
            if (item.retries > RateLimiter.MAX_RETRIES) {
              log.error(`Rate limit retries exhausted (${RateLimiter.MAX_RETRIES})`);
              item.reject(error);
            } else {
              // Use retryAfter from error if available
              const retryAfter = this.extractRetryAfter(error);
              const delay = retryAfter > 0 ? retryAfter : 1000 + Math.random() * 1000;
              log.warn(
                `Rate limited, retry ${item.retries}/${RateLimiter.MAX_RETRIES}, backing off ${Math.round(delay)}ms...`,
              );
              // Refund the token since the request was rate-limited
              this.tokens = Math.min(this.tokens + 1, this.maxTokens);
              // Release concurrency slot before re-queuing - prevents .finally() from
              // calling processQueue() and immediately double-dispatching the re-queued item
              this.inFlight--;
              requeued = true;
              // Hold the item until the Retry-After elapses. processQueue honors
              // notBefore, so a sibling completing early cannot skip the backoff.
              item.notBefore = Date.now() + delay;
              // Re-queue at front (before the head pointer) for priority retry
              if (this.queueHead > 0) {
                this.queueHead--;
                this.queue[this.queueHead] = item;
              } else {
                this.queue.unshift(item);
              }
              window.setTimeout(() => this.processQueue(), delay);
            }
          } else {
            item.reject(error);
          }
        })
        .finally(() => {
          if (!requeued) {
            this.inFlight--;
            // Try to dispatch more items now that a slot opened
            this.processQueue();
          }
        });
    }
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.lastRefill = now;
    this.tokens = Math.min(this.tokens + elapsed * this.refillRate, this.maxTokens);
  }

  private isRateLimitError(error: unknown): boolean {
    return classifyErrorRetryability(error) === 'rate-limited';
  }

  private extractRetryAfter(error: unknown): number {
    if (error && typeof error === 'object' && 'retryAfter' in error) {
      const retryAfter = (error as { retryAfter: number }).retryAfter;
      if (typeof retryAfter === 'number' && retryAfter > 0) return retryAfter;
    }
    return 0;
  }

  /**
   * Reject every queued (not yet dispatched) item with a NotionCanceledError
   * and refuse all new work until resetAbort(). Called on user cancel so the
   * queued tail dies instantly instead of trickling out at 2.5 req/s.
   * In-flight requests settle on their own (requestUrl cannot abort them).
   */
  abortPending(reason: string): void {
    this.aborted = true;
    const pending = this.queue.slice(this.queueHead);
    this.queue = [];
    this.queueHead = 0;
    for (const item of pending) {
      item.reject(new NotionCanceledError(reason));
    }
    if (pending.length > 0) {
      log.info(`Aborted ${pending.length} queued Notion request(s): ${reason}`);
    }
  }

  /**
   * Clear the abort flag so the next run starts with a working limiter.
   * Every fresh operation entry point must call this (via
   * NotionClient.resetCancel), or a past cancel poisons all future requests.
   */
  resetAbort(): void {
    this.aborted = false;
  }

  get queueSize(): number {
    return this.queue.length - this.queueHead;
  }
}
