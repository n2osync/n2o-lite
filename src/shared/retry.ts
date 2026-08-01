/**
 * Generic retry utility with exponential backoff.
 */

import { classifyErrorRetryability } from './errors';
import { createLogger } from './logger';

const log = createLogger('Retry');

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

/**
 * Retry a function with exponential backoff.
 * Only retries on transient errors (rate limits, 5xx).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isRetryable(error)) {
        throw error;
      }

      if (attempt === opts.maxAttempts) {
        break;
      }

      // Jitter is applied AFTER the cap, not before. Folding it inside the
      // Math.min meant that once the exponential base reached maxDelay the min
      // discarded the jitter and every retrier converged on exactly maxDelay
      // against a recovering server (#1565).
      const capped = Math.min(
        opts.baseDelayMs * Math.pow(2, attempt - 1),
        opts.maxDelayMs ?? 30000,
      );
      const delay = capped + Math.random() * 500;

      log.warn(`Attempt ${attempt}/${opts.maxAttempts} failed, retrying in ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Check if an error is retryable (transient).
 * Uses unified error classification - don't retry rate limits here
 * (RateLimiter handles 429s with its own 5-retry backoff).
 */
function isRetryable(error: unknown): boolean {
  const r = classifyErrorRetryability(error);
  return r === 'transient';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
