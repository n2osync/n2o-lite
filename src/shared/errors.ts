/**
 * Custom error types for N2O.
 */

/** How an error should be retried. Single source of truth - replaces 3 separate classifiers. */
export type ErrorRetryability = 'none' | 'rate-limited' | 'transient' | 'unknown';

/** Error codes that should never be retried (client errors, permanent failures). */
const NON_RETRYABLE_CODES = new Set<N2OErrorCode>([
  'NOTION_AUTH_FAILED',
  'NOTION_NOT_FOUND',
  'PARSE_ERROR',
  'OVERWRITE_PROTECTION',
  'SYNC_CONFLICT',
  'SYNC_STATE_CORRUPT',
  'NOTION_CANCELLED',
]);

export class N2OError extends Error {
  constructor(
    message: string,
    public readonly code: N2OErrorCode,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'N2OError';
  }

  /** Classify retryability based on error code. Subclasses override for richer logic. */
  get retryability(): ErrorRetryability {
    if (NON_RETRYABLE_CODES.has(this.code)) return 'none';
    if (this.code === 'NOTION_RATE_LIMITED') return 'rate-limited';
    if (this.code === 'NOTION_API_ERROR') return 'transient';
    if (this.code === 'NOTION_NETWORK_ERROR') return 'transient';
    return 'unknown';
  }
}

export type N2OErrorCode =
  | 'NOTION_AUTH_FAILED'
  | 'NOTION_RATE_LIMITED'
  | 'NOTION_NOT_FOUND'
  | 'NOTION_API_ERROR'
  | 'NOTION_NETWORK_ERROR'
  | 'NOTION_CANCELLED'
  | 'SYNC_CONFLICT'
  | 'SYNC_STATE_CORRUPT'
  | 'PARSE_ERROR'
  | 'ATTACHMENT_ERROR'
  | 'DATABASE_INIT_FAILED'
  | 'DATABASE_CORRUPT'
  | 'DATABASE_WRITE_ERROR'
  | 'OVERWRITE_PROTECTION'
  | 'UNKNOWN';

export class NotionApiError extends N2OError {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly notionCode?: string,
  ) {
    super(message, statusCode === 401 ? 'NOTION_AUTH_FAILED' : 'NOTION_API_ERROR', {
      statusCode,
      notionCode,
    });
    this.name = 'NotionApiError';
  }

  override get retryability(): ErrorRetryability {
    if (this.statusCode === 429) return 'rate-limited';
    if (this.statusCode >= 500) return 'transient';
    return 'none'; // 4xx client errors
  }
}

export class NotionConflictError extends N2OError {
  constructor(message: string) {
    super(message, 'NOTION_API_ERROR', { statusCode: 409 });
    this.name = 'NotionConflictError';
  }

  override get retryability(): ErrorRetryability {
    return 'none'; // Conflicts are not transient
  }
}

export class NotionRateLimitError extends N2OError {
  constructor(public readonly retryAfter: number) {
    super(`Rate limited. Retry after ${retryAfter}ms`, 'NOTION_RATE_LIMITED', { retryAfter });
    this.name = 'NotionRateLimitError';
  }

  override get retryability(): ErrorRetryability {
    return 'rate-limited';
  }
}

/**
 * A queued Notion request was rejected before dispatch because the user
 * cancelled the operation (RateLimiter.abortPending). Never retried: the
 * whole point of the cancel is that the work stops.
 */
export class NotionCanceledError extends N2OError {
  constructor(message = 'Notion request cancelled') {
    super(message, 'NOTION_CANCELLED');
    this.name = 'NotionCanceledError';
  }
}

/** Extract a human-readable message from an unknown caught value. */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Classify retryability of any error (including non-N2O errors).
 * Use when the error may not be an N2OError instance.
 */
export function classifyErrorRetryability(error: unknown): ErrorRetryability {
  if (error instanceof N2OError) return error.retryability;

  // Generic error objects with N2O error codes (e.g. plain objects from tests)
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: string }).code;
    if (code === 'NOTION_RATE_LIMITED') return 'rate-limited';
    if (code === 'NOTION_NETWORK_ERROR') return 'transient';
    if (code === 'NOTION_CANCELLED') return 'none';
  }

  // Generic error objects with status codes
  if (error && typeof error === 'object') {
    const status =
      ('statusCode' in error ? (error as { statusCode: number }).statusCode : undefined) ??
      ('status' in error ? (error as { status: number }).status : undefined);
    if (typeof status === 'number') {
      if (status === 429) return 'rate-limited';
      if (status >= 500) return 'transient';
      return 'none';
    }
  }

  // Network errors (generic Error class)
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes('network') ||
      msg.includes('timeout') ||
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('fetch failed')
    ) {
      return 'transient';
    }
  }

  return 'unknown';
}

/**
 * Returns true for transient errors that should be queued for retry.
 * YES: network errors, 5xx. NO: rate-limited (handled by RateLimiter), auth errors, 404.
 */
export function isQueueableError(error: unknown): boolean {
  return classifyErrorRetryability(error) === 'transient';
}

export class SyncConflictError extends N2OError {
  constructor(
    public readonly itemId: string,
    public readonly notionVersion: string,
    public readonly obsidianVersion: string,
  ) {
    super(`Sync conflict for item ${itemId}`, 'SYNC_CONFLICT', {
      itemId,
      notionVersion,
      obsidianVersion,
    });
    this.name = 'SyncConflictError';
  }
}
