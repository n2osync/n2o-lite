/**
 * PrefetchCoordinator - phase A of the prefetch-then-replay sync pipeline.
 *
 * Walks the workspace tree from a set of seed page IDs, fetching every
 * page's metadata + recursive blocks into:
 *   - L1 (per-sync `Map<id, NotionBlock[]>` and `Map<id, NotionPage>`)
 *   - L2 (persistent `BlockCacheStore` via the `BlockCacheAccessor` interface)
 *
 * Replay phase (phase B) reads from L1; the API is never called outside
 * this coordinator. Cancellation between batches leaves L2 in a partial
 * but valid state - next sync resumes from the cache and only fetches
 * missing pages.
 */

import type { NotionClient } from '../../infrastructure/notion/client';
import type { NotionBlock, NotionPage } from '../../domain/models/notion-api-types';
import type { BlockCacheAccessor } from '../../infrastructure/storage/block-cache-store';
import { normalizeNotionId } from '../../domain/models/notion-id';
import { getErrorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/logger';
import { scanBlocksForChildRefs } from '../discovery/scan-block-refs';

const log = createLogger('PrefetchCoordinator');

/** Maximum BFS passes before bailing as a safety net (real convergence is the stop). */
export const PREFETCH_MAX_PASSES = 10;

/** Maximum depth for `getAllBlockChildrenRecursive` (matches the client's existing default). */
const PREFETCH_MAX_DEPTH = 10;

/** Default in-flight concurrency. RateLimiter still serializes at 2.5 req/s. */
const PREFETCH_DEFAULT_CONCURRENCY = 8;

export interface PrefetchOptions {
  /** Default 10 (matches the recursive walker's existing ceiling). */
  maxDepth?: number;
  /** Default 8. RateLimiter enforces 2.5 req/s; this is purely about latency hiding. */
  maxConcurrent?: number;
  /**
   * Default true. When true, an L2 cache hit triggers a single getPage()
   * call to verify last_edited_time matches; mismatch refetches blocks.
   * When false, trust L2 unconditionally - faster but risks staleness.
   */
  validateLastEdited?: boolean;
  syncChildPages: boolean;
  syncChildDatabases: boolean;
  /**
   * Sanitized titles of databases the user explicitly selected. child_database
   * blocks matching one of these are skipped during ref expansion - the
   * explicit selection wins because it has a known data_source_id.
   */
  selectedDbTitles?: Set<string>;
}

export interface PrefetchStats {
  cached: number; // L2 hit, validated, no refetch
  refreshed: number; // L2 hit but stale -> refetched
  fetched: number; // L2 miss -> cold fetch
  skipped: number; // already in L1 (dedup)
  errored: number; // fetch threw
  passes: number; // BFS iterations completed
  durationMs: number;
}

export interface PrefetchResult {
  /** L1 block cache keyed by normalized (dashless lowercase) Notion ID. */
  blockCache: Map<string, NotionBlock[]>;
  /** L1 page-metadata cache keyed by normalized Notion ID. */
  pageCache: Map<string, NotionPage>;
  /** All page IDs surfaced during BFS (selected pages + child_page refs). */
  discoveredPageIds: string[];
  /** Block IDs of child_database blocks surfaced during BFS. */
  discoveredDatabaseIds: string[];
  stats: PrefetchStats;
  /** True if cancellation triggered an early exit. Caller still gets the partial L1/L2 state. */
  canceled: boolean;
}

export interface PrefetchDeps {
  notionClient: NotionClient;
  /** Persistent block cache (L2). Optional - prefetch still works as a one-shot fetcher. */
  blockCache: BlockCacheAccessor | null;
  /** Caller-provided cancel signal. Checked between batches and at every fetchOne start. */
  isCancelled: () => boolean;
  /** Optional progress emitter. Receives one message per pass + per-batch totals. */
  emitProgress?: (msg: string, current?: number, total?: number) => void;
}

/**
 * Split an array into fixed-size chunks. Avoids importing lodash for one helper.
 */
function chunked<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export class PrefetchCoordinator {
  private readonly l1Blocks: Map<string, NotionBlock[]> = new Map();
  private readonly l1Pages: Map<string, NotionPage> = new Map();
  private readonly visited: Set<string> = new Set();
  private readonly discoveredPageIds: string[] = [];
  private readonly discoveredDatabaseIds: string[] = [];
  private readonly stats: PrefetchStats = {
    cached: 0,
    refreshed: 0,
    fetched: 0,
    skipped: 0,
    errored: 0,
    passes: 0,
    durationMs: 0,
  };

  constructor(private readonly deps: PrefetchDeps) {}

  /**
   * Crawl the tree starting from `seedIds` until either the frontier
   * empties (convergence) or `PREFETCH_MAX_PASSES` is reached. Returns
   * the populated L1 caches plus statistics.
   */
  async prefetchAll(seedIds: string[], opts: PrefetchOptions): Promise<PrefetchResult> {
    const startedAt = Date.now();
    const maxConcurrent = opts.maxConcurrent ?? PREFETCH_DEFAULT_CONCURRENCY;

    let frontier = new Set(
      seedIds.map((id) => normalizeNotionId(id)).filter((id) => id.length > 0),
    );
    let canceled = false;

    // Mention-follow is a one-hop expansion from the originally-seeded
    // pages, NOT a transitive walk. Following mentions at every BFS pass
    // would explode (one page can mention 88+ others, each mentioning 50+
    // more - runaway fan-out). Structural child_page / child_database refs
    // still propagate through every pass; they represent containment.
    const seedSet = new Set(frontier);

    while (frontier.size > 0 && this.stats.passes < PREFETCH_MAX_PASSES) {
      this.stats.passes++;
      this.deps.emitProgress?.(`Prefetch pass ${this.stats.passes} \u00B7 ${frontier.size} pages`);

      const batch = Array.from(frontier);
      frontier = new Set();

      // Parallel fetch each chunk. RateLimiter still serializes at 2.5/s so
      // the maxConcurrent ceiling here is about latency hiding, not throughput.
      let processed = 0;
      for (const chunk of chunked(batch, maxConcurrent)) {
        if (this.deps.isCancelled()) {
          canceled = true;
          break;
        }
        await Promise.all(chunk.map((id) => this.fetchOne(id, opts)));
        processed += chunk.length;
        this.deps.emitProgress?.(
          `Prefetch pass ${this.stats.passes} \u00B7 ${processed}/${batch.length}`,
          processed,
          batch.length,
        );
      }
      if (canceled) break;

      // After the batch, scan everything we just landed for new refs.
      for (const id of batch) {
        const blocks = this.l1Blocks.get(id);
        if (!blocks) continue;
        const isSeed = seedSet.has(id);
        const refs = scanBlocksForChildRefs(blocks, {
          // Mention scanning is gated to seed pages only - same one-hop
          // semantic as registry-builder.discoverChildrenFromBlocks.
          syncChildPages: opts.syncChildPages,
          syncChildDatabases: opts.syncChildDatabases,
          selectedDbTitles: opts.selectedDbTitles,
        });
        for (const ref of refs) {
          // Drop transitively-discovered mentions: only seed pages contribute
          // mention refs to the next frontier. Structural child_* refs are
          // always followed.
          const isMention = ref.type === 'mention_page' || ref.type === 'mention_database';
          if (isMention && !isSeed) continue;
          if (this.visited.has(ref.blockId) || frontier.has(ref.blockId)) continue;
          frontier.add(ref.blockId);
          // child_page + mention_page route to page discovery; child_database
          // + mention_database route to database discovery. The downstream
          // registry-builder reverse-lookup handles the linked-view case.
          if (ref.type === 'child_page' || ref.type === 'mention_page') {
            this.discoveredPageIds.push(ref.blockId);
          } else {
            this.discoveredDatabaseIds.push(ref.blockId);
          }
        }
      }
    }

    if (this.stats.passes >= PREFETCH_MAX_PASSES && frontier.size > 0) {
      log.warn(
        `Prefetch hit MAX_PASSES (${PREFETCH_MAX_PASSES}) with ${frontier.size} unprocessed seeds; stopping.`,
      );
    }

    this.stats.durationMs = Date.now() - startedAt;
    log.info(
      `Prefetch done: ${this.stats.passes} passes, ${this.l1Blocks.size} pages cached ` +
        `(cached=${this.stats.cached} refreshed=${this.stats.refreshed} fetched=${this.stats.fetched} ` +
        `skipped=${this.stats.skipped} errored=${this.stats.errored}) in ${this.stats.durationMs}ms`,
    );

    return {
      blockCache: this.l1Blocks,
      pageCache: this.l1Pages,
      discoveredPageIds: this.discoveredPageIds.slice(),
      discoveredDatabaseIds: this.discoveredDatabaseIds.slice(),
      stats: { ...this.stats },
      canceled,
    };
  }

  /**
   * Fetch a single page's blocks + metadata into L1 (and L2). Honors the
   * three-state cache flow: L1 dedup -> L2 hit-validate -> cold fetch.
   */
  private async fetchOne(rawId: string, opts: PrefetchOptions): Promise<void> {
    const norm = normalizeNotionId(rawId);
    if (!norm) return;
    if (this.visited.has(norm) || this.l1Blocks.has(norm)) {
      this.stats.skipped++;
      return;
    }
    this.visited.add(norm);

    if (this.deps.isCancelled()) return;

    const hit = this.deps.blockCache?.get(norm) ?? null;
    const maxDepth = opts.maxDepth ?? PREFETCH_MAX_DEPTH;
    const validate = opts.validateLastEdited !== false;

    // L2 hit path
    if (hit) {
      if (!validate) {
        this.l1Blocks.set(norm, hit.blocks);
        if (hit.pageMeta) this.l1Pages.set(norm, hit.pageMeta);
        this.stats.cached++;
        return;
      }
      try {
        const page = await this.deps.notionClient.getPage(rawId);
        if (page.last_edited_time === hit.lastEdited) {
          this.l1Blocks.set(norm, hit.blocks);
          this.l1Pages.set(norm, page);
          // Back-fill pageMeta on legacy entries that predate the field.
          if (!hit.pageMeta) {
            this.deps.blockCache?.set(norm, hit.blocks, page.last_edited_time, page);
          }
          this.stats.cached++;
          return;
        }
        // Stale - refetch blocks; getPage already done so reuse it.
        const blocks = await this.deps.notionClient.getAllBlockChildrenRecursive(
          rawId,
          0,
          maxDepth,
          this.l1Blocks,
        );
        this.l1Blocks.set(norm, blocks);
        this.l1Pages.set(norm, page);
        this.deps.blockCache?.set(norm, blocks, page.last_edited_time, page);
        this.stats.refreshed++;
        return;
      } catch (err) {
        log.warn(
          `Prefetch validation failed for ${norm.substring(0, 8)}\u2026: ${getErrorMessage(err)}`,
        );
        this.stats.errored++;
        return;
      }
    }

    // Cold fetch
    try {
      const { page, blocks } = await this.deps.notionClient.fetchPageWithBlocks(
        rawId,
        this.l1Blocks,
        this.l1Pages,
      );
      this.l1Blocks.set(norm, blocks);
      this.l1Pages.set(norm, page);
      this.deps.blockCache?.set(norm, blocks, page.last_edited_time, page);
      this.stats.fetched++;
    } catch (err) {
      log.warn(
        `Prefetch cold fetch failed for ${norm.substring(0, 8)}\u2026: ${getErrorMessage(err)}`,
      );
      this.stats.errored++;
    }
  }
}
