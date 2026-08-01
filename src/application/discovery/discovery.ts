/**
 * NotionDiscovery - Discovers all accessible pages and databases in a Notion workspace.
 * Paginates through the Notion Search API, then queries each database for its items.
 */

import type { NotionClient } from '../../infrastructure/notion/client';
import type {
  NotionDatabase,
  NotionPage,
  NotionRichText,
} from '../../domain/models/notion-api-types';
import { extractParentId, extractParentContainerType } from '../../domain/services/parent-utils';
import { getDatabaseTitle } from '../../domain/services/notion-entity-ops';
import { getErrorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/logger';

const log = createLogger('Discovery');

/** Raw result of a Notion page from Search API */
export interface DiscoveredPage {
  notionId: string;
  title: string;
  parentType: 'workspace' | 'page' | 'database';
  parentId?: string;
  lastEditedTime: string;
  url: string;
}

/** Raw result of a Notion database from Search API */
export interface DiscoveredDatabase {
  notionId: string;
  title: string;
  lastEditedTime: string;
  url: string;
}

/** Full discovery result */
export interface DiscoveryResult {
  pages: DiscoveredPage[];
  databases: DiscoveredDatabase[];
  /** Map from database ID -> array of items (pages) in that database */
  databaseItems: Map<string, DiscoveredPage[]>;
  /** Whether discovery completed without errors (safe for orphan detection) */
  complete: boolean;
  /** Errors encountered during discovery (database query failures, pagination errors) */
  errors: string[];
}

export type DiscoveryProgressCallback = (message: string) => void;

export class NotionDiscovery {
  private progressCallback: DiscoveryProgressCallback | null = null;
  private cancelCheck: (() => boolean) | null = null;

  constructor(private notionClient: NotionClient) {}

  /** Set a function that returns true when cancellation is requested. */
  setCancelCheck(fn: () => boolean): void {
    this.cancelCheck = fn;
  }

  private get isCancelled(): boolean {
    return this.cancelCheck?.() ?? false;
  }

  /**
   * Register a callback for discovery progress updates.
   */
  onProgress(cb: DiscoveryProgressCallback): void {
    this.progressCallback = cb;
  }

  private emitProgress(message: string): void {
    this.progressCallback?.(message);
  }

  private emptyCancelledResult(): DiscoveryResult {
    log.info('Discovery cancelled');
    return {
      pages: [],
      databases: [],
      databaseItems: new Map(),
      complete: false,
      errors: ['Discovery cancelled'],
    };
  }

  /**
   * Discover all accessible pages and databases in the workspace.
   * Then query each database for its items.
   */
  async discoverAll(): Promise<DiscoveryResult> {
    log.info('Starting workspace discovery...');
    const discoveryErrors: string[] = [];
    let isComplete = true;

    // Search for all pages
    this.emitProgress('Searching for pages...');
    let pages: (NotionPage | NotionDatabase)[];
    try {
      const pagesResult = await this.searchAll('page');
      pages = pagesResult.results;
      if (pagesResult.truncated) {
        isComplete = false;
        if (pagesResult.reason) discoveryErrors.push(pagesResult.reason);
      }
    } catch (error) {
      const msg = getErrorMessage(error);
      discoveryErrors.push(`Page search failed: ${msg}`);
      log.error(`Page search failed: ${msg}`);
      isComplete = false;
      pages = [];
    }
    if (this.isCancelled) return this.emptyCancelledResult();
    log.info(`Discovered ${pages.length} pages`);

    // Search for all databases
    this.emitProgress(
      `Found ${pages.length.toLocaleString()} pages. Searching for databases\u2026`,
    );
    let databases: (NotionPage | NotionDatabase)[];
    try {
      const dbsResult = await this.searchAll('data_source');
      databases = dbsResult.results;
      if (dbsResult.truncated) {
        isComplete = false;
        if (dbsResult.reason) discoveryErrors.push(dbsResult.reason);
      }
    } catch (error) {
      const msg = getErrorMessage(error);
      discoveryErrors.push(`Database search failed: ${msg}`);
      log.error(`Database search failed: ${msg}`);
      isComplete = false;
      databases = [];
    }
    if (this.isCancelled) return this.emptyCancelledResult();
    log.info(`Discovered ${databases.length} databases`);

    // Parse results
    const discoveredPages: DiscoveredPage[] = pages.map((p) => this.parsePage(p));
    const discoveredDatabases: DiscoveredDatabase[] = databases.map((d) =>
      this.parseDatabase(d as NotionDatabase),
    );

    // Query each database for its items (parallel batches with timeouts)
    const OVERALL_TIMEOUT_MS = 120_000; // 2 minutes for all databases
    const PER_DB_TIMEOUT_MS = 30_000; // 30 seconds per database
    const DB_CONCURRENCY = 3; // Match rate limiter maxConcurrent
    const discoveryStart = Date.now();
    const databaseItems = new Map<string, DiscoveredPage[]>();
    let totalDbItems = 0;

    for (let i = 0; i < discoveredDatabases.length; i += DB_CONCURRENCY) {
      // Check cancellation
      if (this.isCancelled) return this.emptyCancelledResult();
      // Check overall timeout
      if (Date.now() - discoveryStart > OVERALL_TIMEOUT_MS) {
        const remaining = discoveredDatabases.length - i;
        log.warn(`Discovery timeout - ${remaining} databases skipped`);
        discoveryErrors.push(`Timeout: ${remaining} databases not queried`);
        isComplete = false;
        break;
      }

      const chunk = discoveredDatabases.slice(i, i + DB_CONCURRENCY);
      const dbNames = chunk.map((db) => `\uD83D\uDDC4\uFE0F ${db.title}`).join('  ');
      this.emitProgress(
        `Querying databases ${i + 1}\u2013${Math.min(i + DB_CONCURRENCY, discoveredDatabases.length)} of ${discoveredDatabases.length}` +
          (totalDbItems > 0 ? ` \u00B7 ${totalDbItems.toLocaleString()} items` : '') +
          `\n${dbNames}`,
      );

      const results = await Promise.allSettled(
        chunk.map(async (db) => {
          let timeoutId: number;
          // Abort the pagination on timeout so it stops issuing further requests
          // against the rate budget, rather than only rejecting the timer (#1574).
          const controller = new AbortController();
          const queryOutcome = await Promise.race([
            this.queryAllDatabaseItems(db.notionId, controller.signal),
            new Promise<never>((_, reject) => {
              timeoutId = window.setTimeout(() => {
                controller.abort();
                reject(new Error('Database query timed out (30s)'));
              }, PER_DB_TIMEOUT_MS);
            }),
          ]).finally(() => window.clearTimeout(timeoutId));
          return { db, ...queryOutcome };
        }),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const { db, items, truncated, reason } = result.value;
          databaseItems.set(db.notionId, items);
          totalDbItems += items.length;
          log.info(`Database "${db.title}": ${items.length} items`);
          if (truncated) {
            isComplete = false;
            if (reason) discoveryErrors.push(`Database "${db.title}": ${reason}`);
          }
        } else {
          // Find which db failed (match by index in chunk)
          const failedIdx = results.indexOf(result);
          const failedDb = chunk[failedIdx];
          if (!failedDb) continue;
          const msg = getErrorMessage(result.reason);
          log.error(`Failed to query database ${failedDb.notionId}: ${msg}`);
          discoveryErrors.push(`Database "${failedDb.title}" query failed: ${msg}`);
          isComplete = false;
          databaseItems.set(failedDb.notionId, []);
        }
      }
    }

    // Deduplicate: pages that are database items should not also appear as standalone pages
    const dbItemIds = new Set<string>();
    for (const items of databaseItems.values()) {
      for (const item of items) {
        dbItemIds.add(item.notionId);
      }
    }
    const standalonPages = discoveredPages.filter((p) => !dbItemIds.has(p.notionId));

    if (!isComplete) {
      log.warn(`Discovery incomplete - ${discoveryErrors.length} error(s) encountered`);
    }

    log.info(
      `Discovery complete: ${standalonPages.length} standalone pages, ` +
        `${discoveredDatabases.length} databases, ` +
        `${dbItemIds.size} database items`,
    );

    return {
      pages: standalonPages,
      databases: discoveredDatabases,
      databaseItems,
      complete: isComplete,
      errors: discoveryErrors,
    };
  }

  /**
   * Paginate through Search API to find all results of a given type.
   * Always does full pagination - we need the complete set for orphan detection.
   */
  private async searchAll(
    objectType: 'page' | 'data_source',
  ): Promise<{ results: (NotionPage | NotionDatabase)[]; truncated: boolean; reason?: string }> {
    const allResults: (NotionPage | NotionDatabase)[] = [];
    let cursor: string | undefined;
    let hasMore = true;
    let pages = 0;
    const MAX_PAGES = 100;
    const label = objectType === 'data_source' ? 'databases' : 'pages';
    let truncated = false;
    let reason: string | undefined;

    while (hasMore) {
      if (this.isCancelled) break;
      const response = await this.notionClient.search(
        undefined,
        { property: 'object', value: objectType },
        { direction: 'descending', timestamp: 'last_edited_time' },
        cursor,
      );

      // Filter out archived/trashed pages before adding to results
      for (const result of response.results) {
        if (result.archived !== true && result.in_trash !== true) {
          allResults.push(result);
        }
      }

      pages++;
      hasMore = response.has_more;
      cursor = response.next_cursor ?? undefined;

      // Emit progress with running count + recent item names on new line
      if (allResults.length > 0) {
        const icon = label === 'pages' ? '\uD83D\uDCC4' : '\uD83D\uDDC4\uFE0F';
        const recent = response.results
          .slice(0, 3)
          .map((r) => {
            const name = this.extractResultName(r);
            return name ? `${icon} ${name}` : '';
          })
          .filter((t) => t)
          .join('  ');
        this.emitProgress(
          `Searching for ${label}\u2026 ${allResults.length.toLocaleString()} found` +
            (recent ? `\n${recent}` : ''),
        );
      }

      if (hasMore && !cursor) {
        reason = `Pagination guard: has_more=true but next_cursor is null for search(${objectType})`;
        log.warn(reason);
        truncated = true;
        break;
      }
      if (pages >= MAX_PAGES) {
        reason = `Pagination guard: exceeded ${MAX_PAGES} pages for search(${objectType}) - workspace has more than ${MAX_PAGES * 100} ${label}; orphan detection will be skipped to avoid false orphaning (F-017)`;
        log.warn(reason);
        truncated = true;
        break;
      }
    }

    return { results: allResults, truncated, reason };
  }

  /**
   * Query all items in a database, handling pagination.
   */
  private async queryAllDatabaseItems(
    databaseId: string,
    signal?: AbortSignal,
  ): Promise<{ items: DiscoveredPage[]; truncated: boolean; reason?: string }> {
    const allItems: DiscoveredPage[] = [];
    let cursor: string | undefined;
    let hasMore = true;
    let pages = 0;
    const MAX_PAGES = 100;
    let truncated = false;
    let reason: string | undefined;

    while (hasMore) {
      // Stop paginating on a global cancel OR a per-query timeout abort, so a
      // timed-out database query stops consuming the shared rate budget instead
      // of running its remaining pages to completion in the background (#1574).
      if (this.isCancelled || signal?.aborted) break;
      const response = await this.notionClient.queryDatabase(
        databaseId,
        undefined,
        undefined,
        cursor,
      );

      for (const item of response.results) {
        if (item.archived === true || item.in_trash === true) continue;
        allItems.push({
          notionId: item.id.replace(/-/g, ''),
          title: this.extractPageTitle(item),
          parentType: 'database',
          parentId: databaseId,
          lastEditedTime: item.last_edited_time ?? '',
          url: item.url ?? '',
        });
      }

      pages++;
      hasMore = response.has_more;
      cursor = response.next_cursor ?? undefined;

      if (hasMore && !cursor) {
        reason = `Pagination guard: has_more=true but next_cursor is null for database ${databaseId}`;
        log.warn(reason);
        truncated = true;
        break;
      }
      if (pages >= MAX_PAGES) {
        reason = `Pagination guard: exceeded ${MAX_PAGES} pages for database ${databaseId} - database has more than ${MAX_PAGES * 100} rows (F-017)`;
        log.warn(reason);
        truncated = true;
        break;
      }
    }

    return { items: allItems, truncated, reason };
  }

  /**
   * Parse a Notion Search API page result.
   */
  private parsePage(page: NotionPage | NotionDatabase): DiscoveredPage {
    const parent = page.parent ?? (page as NotionPage).parent;
    let parentType: 'workspace' | 'page' | 'database' = 'workspace';
    let parentId: string | undefined;

    const containerType = extractParentContainerType(parent);
    if (containerType) {
      parentType = containerType;
      parentId = extractParentId(parent);
    }

    return {
      notionId: page.id.replace(/-/g, ''),
      title: this.extractPageTitle(page),
      parentType,
      parentId,
      lastEditedTime:
        (page as NotionPage).last_edited_time ?? (page as NotionDatabase).last_edited_time ?? '',
      url: (page as NotionPage).url ?? (page as NotionDatabase).url ?? '',
    };
  }

  /**
   * Parse a Notion Search API database result.
   */
  private parseDatabase(db: NotionDatabase): DiscoveredDatabase {
    const title = getDatabaseTitle(db);

    return {
      notionId: db.id.replace(/-/g, ''),
      title,
      lastEditedTime: db.last_edited_time ?? '',
      url: db.url ?? '',
    };
  }

  /**
   * Extract the title from a Notion page object's properties.
   */
  /**
   * Extract display name from a search result.
   * For pages: reads the title property from properties.
   * For databases: reads the title rich-text array.
   */
  private extractResultName(result: NotionPage | NotionDatabase): string {
    if (result.object === 'database') {
      const db = result;
      return db.title?.map((t) => t.plain_text).join('') ?? '';
    }
    return this.extractPageTitle(result);
  }

  private extractPageTitle(page: NotionPage | NotionDatabase): string {
    const pageObj = page as NotionPage;
    const properties = pageObj.properties;
    if (!properties) return 'Untitled';

    // Find the title property (it's always type: "title")
    for (const prop of Object.values(properties)) {
      if (prop.type === 'title') {
        const titleArray: NotionRichText[] | undefined = prop.title;
        if (titleArray && titleArray.length > 0) {
          return titleArray.map((t) => t.plain_text ?? '').join('');
        }
      }
    }

    return 'Untitled';
  }
}
