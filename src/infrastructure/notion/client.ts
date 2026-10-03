/**
 * NotionClient - Rate-limited Notion API client.
 *
 * HTTP layer is injected (NotionHttpFetch) so the Notion adapter stays
 * independent from Obsidian's requestUrl. main.ts wires
 * the real requestUrl; tests pass a stub.
 */

import {
  NotionApiError,
  NotionConflictError,
  NotionRateLimitError,
  getErrorMessage,
} from '../../shared/errors';
import { createLogger } from '../../shared/logger';
import { RateLimiter } from './rate-limiter';
import type {
  NotionBlock,
  NotionBotUserResponse,
  NotionDatabase,
  NotionPage,
  NotionPaginatedResponse,
  NotionSearchResponse,
  NotionViewStub,
  NotionViewDetail,
} from '../../domain/models/notion-api-types';
import type { NotionHttpFetch, NotionHttpResponse } from './http-client';

const log = createLogger('NotionClient');

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2025-09-03';
/** Timeout for individual API requests (ms). Prevents indefinite hangs. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Max OAuth-refresh retries per request. One refresh, one retry - a token that still 401s after refresh fails fast instead of looping. */
const MAX_AUTH_RETRIES = 1;
/** Timeout for file upload requests - longer than normal since uploads can be large. */
const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * Notion's single_part upload mode caps at 20 MiB. Anything larger must be
 * uploaded via mode='multi_part' with N × /send calls (each carrying a
 * part_number) followed by POST /complete.
 *
 * See https://developers.notion.com/reference/create-a-file-upload.
 */
const SINGLE_PART_LIMIT = 20 * 1024 * 1024;

/**
 * Chunk size for multi_part uploads. Notion requires each part (except the
 * last) to be 5-20 MiB. 10 MiB keeps us well inside that window and yields
 * ≤ 100 parts for a 1 GB file (cap is 1,000 per Notion's send endpoint spec).
 */
const MULTI_PART_CHUNK_SIZE = 10 * 1024 * 1024;

/** Shape of the error object thrown by Obsidian's requestUrl on non-2xx responses. */
interface RequestUrlError {
  status: number;
  headers?: Record<string, string>;
  json?: { message?: string; code?: string };
  text?: string;
}

/** Type guard: check if an unknown error is a requestUrl HTTP error. */
function isRequestUrlError(error: unknown): error is RequestUrlError {
  return error !== null && typeof error === 'object' && 'status' in error;
}

/**
 * Parse the Retry-After header from a 429 response and throw NotionRateLimitError.
 * Shared by request(), createFileUpload(), and sendFileUpload().
 */
function extractRateLimitError(err: RequestUrlError): NotionRateLimitError {
  let retryAfter = 1000; // Default 1 second
  if (err.headers?.['retry-after']) {
    const parsed = Number(err.headers['retry-after']);
    if (!isNaN(parsed) && parsed > 0) {
      retryAfter = Math.ceil(parsed * 1000); // Retry-After is in seconds
    }
  }
  return new NotionRateLimitError(retryAfter);
}

/**
 * Best human-readable detail from a non-2xx response body read with throwOnError:false.
 * Prefers Notion's `message` (e.g. "File size of 6.9 MiB exceeds the limit of 5 MiB"),
 * falls back to the raw JSON/text, never returns a bare "no details". Shared by the
 * file-upload create/send/complete paths AND throwApiError (#1754) so every path
 */
function notionErrorBody(r: Pick<NotionHttpResponse, 'json' | 'text'>): string {
  const j = r.json as { message?: string } | undefined;
  if (j && typeof j.message === 'string' && j.message) return j.message;
  try {
    if (r.json !== undefined) return JSON.stringify(r.json);
  } catch {
    /* fall through to text */
  }
  // || not ??: an empty-string body should also fall to the honest "no error body".
  return r.text || 'no error body';
}

/**
 * Extract error details from a requestUrl error and throw NotionApiError.
 * Reads message/code from .json first, falls back to parsing .text.
 * @param err - The requestUrl error object.
 * @param contextLabel - Label for the error message (e.g. "Notion API error" or "File upload create failed").
 */
/**
 * Internal sentinel: a 401 that should trigger an OAuth refresh + retry.
 * Thrown from inside the rate-limited unit so request()'s outer loop can do the
 * refresh AFTER the concurrency slot is released. Doing the refresh inside the
 * slot (the old recursive re-enqueue) deadlocked the limiter when several
 * requests 401'd at once - each held its slot awaiting a nested enqueue that
 * could never get a slot. Never leaves this module.
 */
class NotionAuthRetryError extends Error {
  constructor(readonly original: RequestUrlError) {
    super('OAuth 401 - refresh and retry');
    this.name = 'NotionAuthRetryError';
  }
}

function throwApiError(err: RequestUrlError, contextLabel: string): never {
  let message = err.json?.message;
  let code = err.json?.code;
  const rawText = err.text;
  if (!message && rawText) {
    try {
      const parsed = JSON.parse(rawText) as { message?: string; code?: string };
      message = parsed.message;
      code = code ?? parsed.code;
    } catch {
      /* text wasn't JSON */
    }
  }
  // Last resort via notionErrorBody: a JSON body without .message, the raw text,
  // or an honest "no error body" - never a bare "no details" (#1754).
  if (!message) message = notionErrorBody(err).substring(0, 200);
  throw new NotionApiError(`${contextLabel} ${err.status}: ${message}`, err.status, code);
}

/** Details of a block-tree that was pulled incomplete (#1523). */
export interface TruncationInfo {
  /** The parent block/page whose children were truncated. */
  blockId: string;
  /** Why it truncated: hit the per-parent page cap, or the recursion depth cap. */
  kind: 'pagination' | 'depth';
  /** Human-readable, user-facing detail line. */
  detail: string;
}

export class NotionClient {
  private rateLimiter: RateLimiter;

  /** Callback to refresh an expired OAuth token. Set by connection manager. */
  private tokenRefreshCallback: (() => Promise<string | null>) | null = null;
  /** Shared promise for in-flight OAuth token refresh - prevents concurrent 401s from triggering multiple refreshes. */
  private refreshPromise: Promise<string | null> | null = null;

  /** Initialize the client with a Notion integration token + HTTP fetch impl. */
  constructor(
    private token: string,
    private httpFetch: NotionHttpFetch,
  ) {
    // Stay safely under Notion's 3 req/s hard limit. Token bucket
    // (rate=2.5, burst=2) caps the steady-state outgoing rate. The
    // concurrency cap (3) bounds the depth of any short-window burst
    // when latency lets multiple requests in flight at once: with the
    // previous cap of 8, the first ~2.4s of a flood could fire 8
    // requests, peaking around 3.3 req/s and skirting Notion's
    // sliding-window enforcement. Concurrency 3 keeps the worst-case
    // burst inside the 3 req/s envelope with zero throughput cost
    // since the rate cap (2.5/s) is the binding constraint anyway.
    this.rateLimiter = new RateLimiter(2.5, 2, 3);
  }

  /** Register a callback that refreshes the OAuth token. Returns new token or null on failure. */
  setTokenRefreshCallback(cb: (() => Promise<string | null>) | null): void {
    this.tokenRefreshCallback = cb;
  }

  /**
   * Reject every queued (not yet dispatched) API request. Called on user
   * cancel so a deep rate-limiter queue dies instantly instead of draining
   * at 2.5 req/s. In-flight requests settle on their own - requestUrl has no
   * abort - which is why the design cancels before dispatch, not mid-flight.
   */
  cancelPending(): void {
    this.rateLimiter.abortPending('Sync cancelled by user');
  }

  /**
   * Clear a previous cancelPending() so requests dispatch again. Every fresh
   * sync/push run calls this at entry; without it a past cancel would poison
   * all future requests.
   */
  resetCancel(): void {
    this.rateLimiter.resetAbort();
  }

  /** Notified when a page's block tree is truncated (over 10k blocks or too deep). */
  private truncationHandler: ((info: TruncationInfo) => void) | null = null;

  /**
   * Register a handler that surfaces block-tree truncation to the user. Without
   * one, a page over 10,000 blocks or nested past the depth cap pulled
   * incomplete with only a debug log, and the missing blocks could later be
   * treated as deletions on push (#1523).
   */
  setTruncationHandler(cb: ((info: TruncationInfo) => void) | null): void {
    this.truncationHandler = cb;
  }

  /** Log a truncation and forward it to the user-facing handler, if any. */
  private reportTruncation(info: TruncationInfo): void {
    log.warn(info.detail);
    this.truncationHandler?.(info);
  }

  /**
   * Make an authenticated Notion API request.
   * @param timeout - Per-request timeout in ms (default: REQUEST_TIMEOUT_MS).
   *   Search calls use a longer timeout because the endpoint is slow on cold starts.
   */
  async request<T>(
    endpoint: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
    body?: unknown,
    timeout: number = REQUEST_TIMEOUT_MS,
    apiVersion?: string,
  ): Promise<T> {
    let authRetries = 0;
    for (;;) {
      try {
        return await this.rateLimiter.enqueue(() =>
          this.attemptRequest<T>(endpoint, method, body, timeout, apiVersion),
        );
      } catch (error) {
        // A 401 surfaces as NotionAuthRetryError from inside the enqueued unit.
        // The refresh + retry happen HERE, after the rate-limiter slot has been
        // released - doing it inside the slot (the old recursive re-enqueue)
        // held the parent slot while awaiting a nested enqueue, so concurrent
        // 401s deadlocked the limiter. The per-request counter caps retries so
        // a token that keeps 401ing after refresh fails fast instead of looping.
        if (error instanceof NotionAuthRetryError) {
          if (this.tokenRefreshCallback && authRetries < MAX_AUTH_RETRIES) {
            authRetries++;
            log.info(
              `Got 401, attempting OAuth token refresh (${authRetries}/${MAX_AUTH_RETRIES})...`,
            );
            const newToken = await this.refreshAuthToken();
            if (newToken) {
              this.setToken(newToken);
              continue;
            }
          }
          // No refresh callback, refresh failed, or retries exhausted.
          throwApiError(error.original, 'Notion API error');
        }
        throw error;
      }
    }
  }

  /**
   * Single-flight OAuth refresh. Concurrent 401s reuse one in-flight refresh so
   * tokenRefreshCallback runs once. Runs outside any rate-limiter slot.
   */
  private async refreshAuthToken(): Promise<string | null> {
    if (!this.refreshPromise) {
      // Non-null: only called when tokenRefreshCallback is set.
      const cb = this.tokenRefreshCallback as () => Promise<string | null>;
      this.refreshPromise = cb().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  /** One HTTP attempt, run inside the rate limiter. Throws NotionAuthRetryError on a refreshable 401. */
  private async attemptRequest<T>(
    endpoint: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body: unknown,
    timeout: number,
    apiVersion?: string,
  ): Promise<T> {
    const url = `${NOTION_API_BASE}${endpoint}`;
    log.debug(`${method} ${endpoint}`);

    let response: NotionHttpResponse;
    try {
      let timeoutId: number;
      response = await Promise.race([
        this.httpFetch({
          url,
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Notion-Version': apiVersion ?? NOTION_VERSION,
            'Content-Type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
          // Opt out of throw-on-error so we can read the 4xx body below
          // (Obsidian's thrown error drops it, surfacing only "no details").
          throwOnError: false,
        }),
        new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(
            () =>
              reject(
                new Error(`Request timed out after ${timeout / 1000}s: ${method} ${endpoint}`),
              ),
            timeout,
          );
        }),
      ]).finally(() => window.clearTimeout(timeoutId));
    } catch (error: unknown) {
      // Impls/stubs that still THROW on non-2xx (the original contract, used
      // by tests) land here - route them through the same handler.
      if (isRequestUrlError(error)) {
        return await this.handleHttpError<T>(error, endpoint, method);
      }
      throw error;
    }

    // Check for API version deprecation warnings
    const respHeaders = response.headers;
    if (respHeaders?.['deprecation'] || respHeaders?.['sunset']) {
      log.warn(
        `Notion API deprecation notice: version ${NOTION_VERSION} - ` +
          `deprecation: ${respHeaders['deprecation'] ?? 'none'}, ` +
          `sunset: ${respHeaders['sunset'] ?? 'none'}. Consider updating NOTION_VERSION.`,
      );
    }

    if (response.status >= 400) {
      let json: { message?: string; code?: string } | undefined;
      try {
        json = response.json as { message?: string; code?: string } | undefined;
      } catch {
        /* body was not JSON */
      }
      return await this.handleHttpError<T>(
        { status: response.status, headers: response.headers, json, text: response.text },
        endpoint,
        method,
      );
    }

    return response.json as T;
  }

  /**
   * Route a non-2xx Notion response: rate-limit (429), conflict (409),
   * OAuth 401 (throws NotionAuthRetryError for the outer loop), 400-body debug
   * log, else throw a NotionApiError carrying the real message. Shared by both
   * the throw path
   * (stubs/impls that reject) and the status path (real requestUrl with
   * throwOnError:false), so the actual Notion error body is never lost.
   */
  private async handleHttpError<T>(
    err: RequestUrlError,
    endpoint: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  ): Promise<T> {
    if (err.status === 429) throw extractRateLimitError(err);

    if (err.status === 409) {
      throw new NotionConflictError(err.json?.message ?? `Conflict on ${method} ${endpoint}`);
    }

    // A 401 means the token expired. Defer refresh + retry to request()'s outer
    // loop (outside the rate-limiter slot) via a sentinel error. Refreshing +
    // re-requesting here, inside the enqueued unit, held the parent's slot while
    // awaiting a nested enqueue - concurrent 401s then deadlocked the limiter.
    if (err.status === 401 && this.tokenRefreshCallback) {
      throw new NotionAuthRetryError(err);
    }

    if (err.status === 400) {
      log.debug(`Notion API 400 raw body: ${err.text?.substring(0, 300) ?? 'empty'}`);
    }
    throwApiError(err, 'Notion API error');
  }

  // ── Pages ──────────────────────────────────────────────

  /** Fetch a single Notion page by ID. */
  async getPage(pageId: string): Promise<NotionPage> {
    return this.request<NotionPage>(`/pages/${pageId}`);
  }

  /** Update a page's properties, and optionally its icon and cover. */
  async updatePage(
    pageId: string,
    properties: unknown,
    options?: { icon?: unknown; cover?: unknown },
  ) {
    const body: Record<string, unknown> = { properties };
    if (options?.icon !== undefined) body.icon = options.icon;
    if (options?.cover !== undefined) body.cover = options.cover;
    return this.request(`/pages/${pageId}`, 'PATCH', body);
  }

  /** Create a new page under the given parent with properties and optional child blocks. */
  async createPage(parent: unknown, properties: unknown, children?: unknown[]) {
    return this.request('/pages', 'POST', { parent, properties, children });
  }

  /**
   * Lock a page to prevent user edits during push.
   * Sets `is_locked: true` on the page via the Update Page endpoint.
   * Note: Locked pages show a lock icon in Notion - should be opt-in via settings.
   */
  async lockPage(pageId: string): Promise<void> {
    await this.request(`/pages/${pageId}`, 'PATCH', { is_locked: true });
  }

  /** Unlock a previously locked page (remove the lock icon in Notion). */
  async unlockPage(pageId: string): Promise<void> {
    await this.request(`/pages/${pageId}`, 'PATCH', { is_locked: false });
  }

  /** Trash a page in Notion (moves to Notion's trash, recoverable for 30 days). */
  async trashPage(pageId: string): Promise<void> {
    await this.request(`/pages/${pageId}`, 'PATCH', { in_trash: true });
  }

  // ── Blocks ─────────────────────────────────────────────

  /** Fetch one page of child blocks for the given block or page ID. */
  async getBlockChildren(
    blockId: string,
    startCursor?: string,
  ): Promise<NotionPaginatedResponse<NotionBlock>> {
    const params = new URLSearchParams({ page_size: '100' });
    if (startCursor) params.set('start_cursor', startCursor);
    return this.request<NotionPaginatedResponse<NotionBlock>>(
      `/blocks/${blockId}/children?${params}`,
    );
  }

  /**
   * Append child blocks to a parent block or page.
   * Uses the `position` parameter for precise placement:
   * - `'start'` - insert at the beginning of the parent's children
   * - `'end'` or omit - append at the end (default)
   * - block ID string - insert after the specified block
   */
  async appendBlockChildren(
    blockId: string,
    children: unknown[],
    position?: string,
  ): Promise<NotionPaginatedResponse<NotionBlock>> {
    const body: Record<string, unknown> = { children };
    if (position === 'start') {
      body.position = { type: 'start' };
    } else if (position && position !== 'end') {
      // Block ID - insert after that block
      body.position = { type: 'after_block', after_block: { id: position } };
    }
    return this.request<NotionPaginatedResponse<NotionBlock>>(
      `/blocks/${blockId}/children`,
      'PATCH',
      body,
    );
  }

  /** Update a block's content or type-specific properties. */
  async updateBlock(blockId: string, data: unknown) {
    return this.request(`/blocks/${blockId}`, 'PATCH', data);
  }

  /** Archive (soft-delete) a block by ID. */
  async deleteBlock(blockId: string) {
    return this.request(`/blocks/${blockId}`, 'DELETE');
  }

  // ── Databases ──────────────────────────────────────────

  /**
   * Route a database request through the correct endpoint.
   * Notion has two database endpoint families:
   * - `/data_sources/{id}/...` - works for data_source IDs (from search API / tree picker)
   * - `/databases/{id}/...` - works for block-level database UUIDs (from blocks API)
   *
   * IDs from different sources hit different endpoints. This helper tries
   * /data_sources/ first, then falls back to /databases/ on 404. The
   * fallback's API version depends on the operation:
   * - GET retrieve (no pathSuffix): use the modern default (2025-09-03) so
   *   the response includes `data_sources[]` - the caller needs that to
   *   resolve the block UUID to a real data_source_id. Passing 2022-06-28
   *   here drops `data_sources[]` from the response, which silently
   *   degrades downstream view discovery for inline child databases.
   * - `/query` and PATCH: 2025-09-03 rejects /databases/{id}/query (the
   *   endpoint only exists on 2022-06-28), so callers explicitly pass
   *   `legacyFallbackVersion: '2022-06-28'` to keep that path working.
   *
   * F-008: every fallback records structured metadata + bumps a
   * session counter. `getFallbackStats()` exposes it.
   */
  private async databaseRequest<T>(
    databaseId: string,
    pathSuffix: string = '',
    method: 'GET' | 'POST' | 'PATCH' = 'GET',
    body?: unknown,
    legacyFallbackVersion?: string,
  ): Promise<T> {
    try {
      return await this.request<T>(`/data_sources/${databaseId}${pathSuffix}`, method, body);
    } catch (error) {
      if (error instanceof NotionApiError && error.statusCode === 404) {
        const fallbackStart = Date.now();
        try {
          const result = await this.request<T>(
            `/databases/${databaseId}${pathSuffix}`,
            method,
            body,
            REQUEST_TIMEOUT_MS,
            legacyFallbackVersion,
          );
          this.recordFallback(databaseId, pathSuffix, method, Date.now() - fallbackStart, 'ok');
          return result;
        } catch (fallbackError) {
          this.recordFallback(databaseId, pathSuffix, method, Date.now() - fallbackStart, 'failed');
          throw fallbackError;
        }
      }
      throw error;
    }
  }

  /**
   * Per-session counter for /data_sources/ -> /databases/ fallback.
   * Exposed via `getFallbackStats()` so QA tests and support tools can
   * see how often the legacy `/databases/` path is exercised. (F-008)
   */
  private fallbackStats: {
    count: number;
    lastAt: string | null;
    lastId: string | null;
    lastPathSuffix: string | null;
    lastMethod: string | null;
    lastOutcome: 'ok' | 'failed' | null;
    lastDurationMs: number | null;
  } = {
    count: 0,
    lastAt: null,
    lastId: null,
    lastPathSuffix: null,
    lastMethod: null,
    lastOutcome: null,
    lastDurationMs: null,
  };

  private recordFallback(
    databaseId: string,
    pathSuffix: string,
    method: string,
    durationMs: number,
    outcome: 'ok' | 'failed',
  ): void {
    this.fallbackStats.count++;
    this.fallbackStats.lastAt = new Date().toISOString();
    this.fallbackStats.lastId = databaseId;
    this.fallbackStats.lastPathSuffix = pathSuffix;
    this.fallbackStats.lastMethod = method;
    this.fallbackStats.lastOutcome = outcome;
    this.fallbackStats.lastDurationMs = durationMs;
    log.warn(
      `/data_sources/ 404 fallback -> /databases/ (2022-06-28): ` +
        `id=${databaseId} suffix="${pathSuffix}" method=${method} ` +
        `duration=${durationMs}ms outcome=${outcome} ` +
        `session-total=${this.fallbackStats.count}`,
    );
  }

  /**
   * Snapshot of fallback metadata. Call from diagnostics / status-bar
   * tooltips / QA probes. Read-only view.
   */
  getFallbackStats(): Readonly<typeof this.fallbackStats> {
    return this.fallbackStats;
  }

  /**
   * Retrieve a database's schema and metadata.
   * Routes through databaseRequest() to handle both data_source IDs and database UUIDs.
   *
   * 2025-09-03 split the response: /databases/{block_uuid} returns
   * `data_sources[]` with NO `properties`; the property schema lives on
   * /data_sources/{ds_id}. When the first call returns the shell shape,
   * make one follow-up call against the first data_source and merge the
   * properties into the response. This keeps every caller (push schema
   * remap, registrar, linked-view resolver) able to read `.properties`
   * regardless of whether they handed in a block UUID or a data_source ID.
   * Multi-data-source databases pick the first; callers that need a
   * specific data_source must call with that ID directly.
   */
  async getDatabase(databaseId: string): Promise<NotionDatabase> {
    const resp = await this.databaseRequest<NotionDatabase>(databaseId);
    const hasProps = resp.properties && Object.keys(resp.properties).length > 0;
    const dsList = (resp as { data_sources?: { id: string }[] }).data_sources;
    if (!hasProps && dsList && dsList.length > 0 && dsList[0]) {
      const firstDsId = dsList[0].id;
      try {
        const dsResp = await this.databaseRequest<NotionDatabase>(firstDsId);
        if (dsResp.properties && Object.keys(dsResp.properties).length > 0) {
          (resp as { properties?: unknown }).properties = dsResp.properties;
        }
      } catch (err) {
        log.warn(
          `getDatabase: data_source follow-up failed for ${databaseId.substring(0, 8)} ` +
            `(ds=${firstDsId.substring(0, 8)}): ${getErrorMessage(err)}`,
        );
      }
    }
    return resp;
  }

  /**
   * Update a database's property schema (e.g. rename properties).
   * Routes through databaseRequest() for data_source/database ID compatibility.
   * On API v2025-09-03, property updates go through /data_sources/{id} (PATCH).
   * Falls back to /databases/{id} with older API version.
   */
  async updateDatabase(
    databaseId: string,
    properties: Record<string, unknown>,
  ): Promise<NotionDatabase> {
    return this.databaseRequest<NotionDatabase>(
      databaseId,
      '',
      'PATCH',
      { properties },
      '2022-06-28',
    );
  }

  /**
   * Query a database with optional filter, sorts, pagination cursor, and property filter.
   * Routes through databaseRequest() for data_source/database ID compatibility.
   * @param filterProperties - Array of Notion property IDs to return (reduces payload ~20-40% for wide DBs).
   */
  async queryDatabase(
    databaseId: string,
    filter?: unknown,
    sorts?: unknown,
    startCursor?: string,
    filterProperties?: string[],
  ) {
    const body: Record<string, unknown> = { page_size: 100 };
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;
    if (startCursor) body.start_cursor = startCursor;
    if (filterProperties && filterProperties.length > 0) {
      body.filter_properties = filterProperties;
    }
    return this.databaseRequest<NotionPaginatedResponse<NotionPage>>(
      databaseId,
      '/query',
      'POST',
      body,
      '2022-06-28',
    );
  }

  // ── Search ─────────────────────────────────────────────

  /**
   * Search across all pages and databases accessible to the integration.
   * Uses a longer timeout (60s) because the search endpoint is slow on cold starts
   * and for large workspaces - Notion must build/scan the search index.
   */
  async search(query?: string, filter?: unknown, sort?: unknown, startCursor?: string) {
    const body: Record<string, unknown> = { page_size: 100 };
    if (query) body.query = query;
    if (filter) body.filter = filter;
    if (sort) body.sort = sort;
    if (startCursor) body.start_cursor = startCursor;
    return this.request<NotionSearchResponse>('/search', 'POST', body, 60_000);
  }

  // ── Views (2025-09-03+) ─────────────────────────────────

  /**
   * List all views for a data source (database).
   * Returns view stubs (id only). Call getView() for full details.
   * One call per database replaces scanning hundreds of pages for linked views.
   */
  async listViewsForDataSource(dataSourceId: string): Promise<NotionViewStub[]> {
    const allViews: NotionViewStub[] = [];
    let cursor: string | undefined;
    let hasMore = true;
    let pages = 0;
    const MAX_PAGES = 100;

    while (hasMore) {
      const url = cursor
        ? `/views?data_source_id=${dataSourceId}&start_cursor=${cursor}`
        : `/views?data_source_id=${dataSourceId}`;
      const result = await this.request<NotionPaginatedResponse<NotionViewStub>>(url);
      allViews.push(...result.results);
      hasMore = result.has_more;
      cursor = result.next_cursor ?? undefined;
      if (hasMore && !cursor) break;
      // Max-iteration guard: a looping cursor (same cursor with has_more) would
      // otherwise spin forever (#1525).
      if (++pages >= MAX_PAGES) {
        log.warn(`listViewsForDataSource: hit ${MAX_PAGES}-page guard for ${dataSourceId}`);
        break;
      }
    }

    return allViews;
  }

  /**
   * Retrieve full view details including configuration, visible properties, filters, sorts.
   */
  async getView(viewId: string): Promise<NotionViewDetail> {
    return this.request<NotionViewDetail>(`/views/${viewId}`);
  }

  // ── Users ──────────────────────────────────────────────

  /** Fetch the bot user associated with the current integration token. */
  async getMe(): Promise<NotionBotUserResponse> {
    return this.request<NotionBotUserResponse>('/users/me');
  }

  // ── File Uploads ────────────────────────────────────────

  /**
   * Create a file upload placeholder on Notion (step 1 of 2).
   * POST /v1/file_uploads - returns an upload object with ID.
   * Requires API version 2025-09-03.
   */
  async createFileUpload(
    fileName: string,
    contentType: string,
    numberOfParts?: number,
  ): Promise<{ id: string }> {
    return this.rateLimiter.enqueue(async () => {
      const url = `${NOTION_API_BASE}/file_uploads`;
      const body: Record<string, unknown> =
        numberOfParts !== undefined
          ? {
              mode: 'multi_part',
              filename: fileName,
              content_type: contentType,
              number_of_parts: numberOfParts,
            }
          : {
              mode: 'single_part',
              filename: fileName,
              content_type: contentType,
            };
      try {
        let timeoutId: number;
        const response = await Promise.race([
          this.httpFetch({
            url,
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.token}`,
              'Notion-Version': NOTION_VERSION,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            throwOnError: false,
          }),
          new Promise<never>((_, reject) => {
            timeoutId = window.setTimeout(
              () =>
                reject(
                  new Error(`File upload create timed out after ${UPLOAD_TIMEOUT_MS / 1000}s`),
                ),
              UPLOAD_TIMEOUT_MS,
            );
          }),
        ]).finally(() => window.clearTimeout(timeoutId));
        if (response.status >= 400) {
          // throwOnError:false: surface Notion's actual error body, not a bodyless
          // "no details". Shared with send/complete via notionErrorBody.
          if (response.status === 429)
            throw extractRateLimitError({ status: response.status, headers: response.headers });
          throw new NotionApiError(
            `File upload create failed (${response.status}): ${notionErrorBody(response)}`,
            response.status,
            (response.json as { code?: string } | undefined)?.code,
          );
        }
        const result = response.json as { id?: string };
        if (!result?.id) {
          throw new NotionApiError('File upload create returned no ID', 0);
        }
        return result as { id: string };
      } catch (error: unknown) {
        if (error instanceof NotionApiError) throw error;
        if (isRequestUrlError(error)) {
          if (error.status === 429) throw extractRateLimitError(error);
          throwApiError(error, 'File upload create failed');
        }
        throw error;
      }
    });
  }

  /**
   * Send file data to Notion (step 2 of 2).
   * POST /v1/file_uploads/{id}/send with multipart/form-data.
   */
  async sendFileUpload(
    fileUploadId: string,
    fileName: string,
    data: ArrayBuffer,
    contentType: string,
    partNumber?: number,
  ): Promise<void> {
    return this.rateLimiter.enqueue(async () => {
      const boundary = `----N2OBoundary${Date.now()}`;
      const encoder = new TextEncoder();

      // Build multipart/form-data body manually. Escape header-breaking chars in
      // the quoted filename (a `"`, `\`, CR or LF would corrupt or inject the
      // header) and add an RFC 5987 filename* so unicode names are properly
      // encoded instead of relying on Notion tolerating raw UTF-8 (#1525).
      const quotedName = fileName.replace(/[\r\n"\\]/g, '_');
      const encodedName = encodeURIComponent(fileName);
      const fileHeader = encoder.encode(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${quotedName}"; filename*=UTF-8''${encodedName}\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
      );
      const partField =
        partNumber !== undefined
          ? encoder.encode(
              `\r\n--${boundary}\r\n` +
                `Content-Disposition: form-data; name="part_number"\r\n\r\n` +
                `${partNumber}`,
            )
          : new Uint8Array(0);
      const footer = encoder.encode(`\r\n--${boundary}--\r\n`);

      const body = new Uint8Array(
        fileHeader.length + data.byteLength + partField.length + footer.length,
      );
      body.set(fileHeader, 0);
      body.set(new Uint8Array(data), fileHeader.length);
      body.set(partField, fileHeader.length + data.byteLength);
      body.set(footer, fileHeader.length + data.byteLength + partField.length);

      try {
        let timeoutId: number;
        const response = await Promise.race([
          this.httpFetch({
            url: `${NOTION_API_BASE}/file_uploads/${fileUploadId}/send`,
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.token}`,
              'Notion-Version': NOTION_VERSION,
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
            },
            body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
            throwOnError: false,
          }),
          new Promise<never>((_, reject) => {
            timeoutId = window.setTimeout(
              () =>
                reject(new Error(`File upload send timed out after ${UPLOAD_TIMEOUT_MS / 1000}s`)),
              UPLOAD_TIMEOUT_MS,
            );
          }),
        ]).finally(() => window.clearTimeout(timeoutId));
        // throwOnError:false: surface Notion's REAL error body (e.g. "File size of
        // 6.9 MiB exceeds the limit of 5 MiB", or "free plan does not support
        // multipart") instead of the old bodyless "no details" that told the user
        // nothing actionable. Same pattern createFileUpload already uses.
        if (response.status >= 400) {
          if (response.status === 429)
            throw extractRateLimitError({ status: response.status, headers: response.headers });
          throw new NotionApiError(
            `File upload send failed (${response.status}): ${notionErrorBody(response)}`,
            response.status,
            (response.json as { code?: string } | undefined)?.code,
          );
        }
      } catch (error: unknown) {
        if (error instanceof NotionApiError) throw error;
        if (isRequestUrlError(error)) {
          if (error.status === 429) throw extractRateLimitError(error);
          throwApiError(error, 'File upload send failed');
        }
        throw error;
      }
    });
  }

  /**
   * Finalize a multi_part file upload after every part has been sent.
   * Required by Notion before the upload object can be referenced in blocks.
   */
  async completeFileUpload(fileUploadId: string): Promise<void> {
    return this.rateLimiter.enqueue(async () => {
      try {
        let timeoutId: number;
        const response = await Promise.race([
          this.httpFetch({
            url: `${NOTION_API_BASE}/file_uploads/${fileUploadId}/complete`,
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.token}`,
              'Notion-Version': NOTION_VERSION,
              'Content-Type': 'application/json',
            },
            body: '{}',
            throwOnError: false,
          }),
          new Promise<never>((_, reject) => {
            timeoutId = window.setTimeout(
              () =>
                reject(
                  new Error(`File upload complete timed out after ${UPLOAD_TIMEOUT_MS / 1000}s`),
                ),
              UPLOAD_TIMEOUT_MS,
            );
          }),
        ]).finally(() => window.clearTimeout(timeoutId));
        if (response.status >= 400) {
          if (response.status === 429)
            throw extractRateLimitError({ status: response.status, headers: response.headers });
          throw new NotionApiError(
            `File upload complete failed (${response.status}): ${notionErrorBody(response)}`,
            response.status,
            (response.json as { code?: string } | undefined)?.code,
          );
        }
      } catch (error: unknown) {
        if (error instanceof NotionApiError) throw error;
        if (isRequestUrlError(error)) {
          if (error.status === 429) throw extractRateLimitError(error);
          throwApiError(error, 'File upload complete failed');
        }
        throw error;
      }
    });
  }

  /**
   * Upload a file to Notion and return the file_upload reference.
   *
   * Files ≤ 20 MiB take the simple single_part path (create + send).
   * Larger files use multi_part: create with number_of_parts, send each
   * chunk with its part_number, then call /complete.
   */
  async uploadFile(
    fileName: string,
    contentType: string,
    data: ArrayBuffer,
    pageId: string,
  ): Promise<{ id: string }> {
    log.info(
      `Uploading file "${fileName}" (${contentType}, ${data.byteLength} bytes) for page ${pageId}`,
    );

    if (data.byteLength <= SINGLE_PART_LIMIT) {
      const upload = await this.createFileUpload(fileName, contentType);
      log.debug(`Created single_part upload ${upload.id}, sending ${data.byteLength} bytes`);
      await this.sendFileUpload(upload.id, fileName, data, contentType);
      return { id: upload.id };
    }

    const numberOfParts = Math.ceil(data.byteLength / MULTI_PART_CHUNK_SIZE);
    if (numberOfParts > 1000) {
      throw new NotionApiError(
        `File "${fileName}" needs ${numberOfParts} parts at ${MULTI_PART_CHUNK_SIZE / (1024 * 1024)} MiB each - exceeds Notion's 1,000-part limit.`,
        0,
      );
    }

    const upload = await this.createFileUpload(fileName, contentType, numberOfParts);
    log.debug(
      `Created multi_part upload ${upload.id} (${numberOfParts} parts, ${data.byteLength} bytes)`,
    );

    for (let i = 0; i < numberOfParts; i++) {
      const start = i * MULTI_PART_CHUNK_SIZE;
      const end = Math.min(start + MULTI_PART_CHUNK_SIZE, data.byteLength);
      const chunk = data.slice(start, end);
      await this.sendFileUpload(upload.id, fileName, chunk, contentType, i + 1);
    }

    await this.completeFileUpload(upload.id);
    log.debug(`Completed multi_part upload ${upload.id}`);
    return { id: upload.id };
  }

  // ── Helpers ────────────────────────────────────────────

  /**
   * Fetch all block children, handling pagination.
   *
   * Optional `blockCache` (plan smooth-jingling-sloth): an in-memory map keyed
   * by block ID that lives one sync-run. When provided, we hit the cache
   * first and skip the API call on hit; populate after a fresh fetch.
   * Lets discovery's block walks feed the apply phase's page fetches so
   * each block tree is only fetched once per sync.
   */
  async getAllBlockChildren(
    blockId: string,
    blockCache?: Map<string, NotionBlock[]>,
  ): Promise<NotionBlock[]> {
    if (blockCache) {
      const hit = blockCache.get(blockId);
      if (hit) return hit;
    }

    const allBlocks: NotionBlock[] = [];
    let cursor: string | undefined;
    let hasMore = true;
    let pages = 0;
    const MAX_PAGES = 100;

    while (hasMore) {
      const cursorSnapshot = cursor;
      const response = await this.getBlockChildren(blockId, cursorSnapshot);

      allBlocks.push(...response.results);
      pages++;
      hasMore = response.has_more;
      cursor = response.next_cursor ?? undefined;

      // Guard: break if has_more=true but no cursor (API bug) or too many pages
      if (hasMore && !cursor) {
        this.reportTruncation({
          blockId,
          kind: 'pagination',
          detail: `Notion returned has_more with no cursor for block ${blockId} - pulled ${allBlocks.length} blocks, the rest could not be fetched.`,
        });
        break;
      }
      if (pages >= MAX_PAGES) {
        this.reportTruncation({
          blockId,
          kind: 'pagination',
          detail: `A Notion page has more than ${MAX_PAGES * 100} blocks - N2O pulled the first ${allBlocks.length}; the rest was not synced (block ${blockId}).`,
        });
        break;
      }
    }

    blockCache?.set(blockId, allBlocks);
    return allBlocks;
  }

  /**
   * Fetch a page with all its blocks (including nested children).
   * Returns the page metadata and a flat-ish block tree ready for the parser.
   *
   * Optional `blockCache` (plan smooth-jingling-sloth): when supplied,
   * any block tree already fetched (e.g. by the discovery phase) is
   * served from the cache instead of re-hitting the API. Cache misses
   * fall through to the real API and are populated on the way back.
   *
   * Optional `pageCache` (plan smooth-jingling-sloth v2): when supplied
   * AND a hit, the getPage round-trip is skipped entirely. Pull's
   * prefetch phase populates this so warm-cache replay can synthesize
   * the {page, blocks} tuple without any network calls.
   */
  async fetchPageWithBlocks(
    pageId: string,
    blockCache?: Map<string, NotionBlock[]>,
    pageCache?: Map<string, NotionPage>,
  ): Promise<{ page: NotionPage; blocks: NotionBlock[] }> {
    log.info(`Fetching page ${pageId} with blocks`);
    const cachedPage = pageCache?.get(pageId);
    const page = cachedPage ?? (await this.getPage(pageId));
    if (!cachedPage) pageCache?.set(pageId, page);
    const blocks = await this.getAllBlockChildrenRecursive(pageId, 0, 10, blockCache);
    log.info(`Fetched ${blocks.length} blocks for page ${pageId}`);
    return { page, blocks };
  }

  /** Max concurrent recursive child-block fetches per level. Prevents queue explosion
   *  when a page has many toggles/callouts - e.g. 50 toggles would spawn 50+ parallel requests. */
  private static readonly RECURSIVE_FETCH_CONCURRENCY = 5;

  /**
   * Block types that CANNOT render without children - fetch them regardless of
   * the Notion API's `has_children` hint. The API has occasionally returned
   * has_children=false for these types even when rows/columns exist, causing
   * tables to render as flat bullet lists downstream. Type-schema truth
   * overrides API hint.
   */
  private static readonly MANDATORY_CHILDREN_BLOCK_TYPES: ReadonlySet<string> = new Set([
    'table', // table rows
    'column_list', // columns
    'column', // column contents
    'synced_block', // synced content
  ]);

  /**
   * Recursively fetch all block children, attaching children to parent blocks.
   * Limits recursion depth to prevent runaway nesting and concurrency to prevent queue explosion.
   *
   * Children fetch policy:
   *   - `has_children === true`  -> fetch (trust API)
   *   - block type in MANDATORY_CHILDREN_BLOCK_TYPES -> fetch anyway
   *     (API sometimes lies about tables/columns; children are required for rendering)
   */
  // Public so the prefetch coordinator (plan smooth-jingling-sloth v2) can
  // refetch blocks alone after a stale L2 validation, without re-doing the
  // page-metadata fetch that was the validation call itself.
  async getAllBlockChildrenRecursive(
    blockId: string,
    depth: number = 0,
    maxDepth: number = 10,
    blockCache?: Map<string, NotionBlock[]>,
  ): Promise<NotionBlock[]> {
    const topBlocks = await this.getAllBlockChildren(blockId, blockCache);

    if (depth >= maxDepth) {
      this.reportTruncation({
        blockId,
        kind: 'depth',
        detail: `A Notion page is nested deeper than ${maxDepth} levels - N2O pulled the top ${maxDepth}; deeper content was not synced (block ${blockId}).`,
      });
      return topBlocks;
    }

    const withChildren = topBlocks.filter(
      (b) =>
        b.has_children ||
        (typeof b.type === 'string' && NotionClient.MANDATORY_CHILDREN_BLOCK_TYPES.has(b.type)),
    );
    const concurrency = NotionClient.RECURSIVE_FETCH_CONCURRENCY;

    // Process in chunks to bound concurrency
    for (let i = 0; i < withChildren.length; i += concurrency) {
      const chunk = withChildren.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(async (block) => {
          // Non-null guaranteed: blocks from Notion API always have IDs
          block.children = await this.getAllBlockChildrenRecursive(
            block.id as string,
            depth + 1,
            maxDepth,
            blockCache,
          );
        }),
      );
    }

    return topBlocks;
  }

  /**
   * Validate the current token by fetching the bot user.
   *
   * Returns a discriminated result so callers can distinguish a genuine
   * auth failure (the user really does need to re-paste their token)
   * from a network failure (Notion is down or unreachable). The previous
   * boolean signature collapsed both into "invalid", which led the UI
   * to blame the user for outages.
   */
  async validateToken(): Promise<
    | { status: 'valid' }
    | { status: 'invalid'; message: string }
    | { status: 'network-error'; message: string }
  > {
    try {
      await this.getMe();
      return { status: 'valid' };
    } catch (err) {
      if (err instanceof NotionApiError) {
        // 401/403: the credential itself is being rejected.
        if (err.statusCode === 401 || err.statusCode === 403) {
          return { status: 'invalid', message: err.message };
        }
        // 5xx: Notion's fault, not the token.
        if (err.statusCode >= 500) {
          return { status: 'network-error', message: err.message };
        }
        // 4xx other than 401/403 (rate-limited, malformed, etc.): treat
        // as transient/network-class so we don't tell the user to
        // re-paste a working token.
        return { status: 'network-error', message: err.message };
      }
      // Non-NotionApiError: network/transport-level failure (DNS, TCP,
      // TLS, request timeout, etc.). These never came back from Notion
      // at all, so the token is unverified.
      return { status: 'network-error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Replace the integration token used for all subsequent requests. */
  setToken(token: string): void {
    this.token = token;
  }

  /** The token the client currently authenticates with. Used to restore it after
   *  a failed validation so a rejected candidate doesn't stick (#1535). */
  getToken(): string {
    return this.token;
  }
}
