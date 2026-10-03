/**
 * BlockCacheStore - File-based block cache with in-memory LRU.
 *
 * Implements BlockCacheAccessor (sync get) via an in-memory LRU cache.
 * Writes are persisted to individual JSON files (debounced, async).
 * On startup, files are listed but loaded lazily on first access.
 *
 * Directory: data/{workspace}/block-cache/{notion-id}.json
 */

import type { DataAdapter } from 'obsidian';
import type { NotionBlock, NotionPage } from '../../domain/models/notion-api-types';
import { createLogger } from '../../shared/logger';

/**
 * Synchronous block-cache read/write surface consumed by the sync pipeline.
 * The cache store owns this contract so the pipeline depends on the store
 * rather than the other way round.
 */
export interface BlockCacheAccessor {
  get(
    notionId: string,
  ): { blocks: NotionBlock[]; lastEdited: string; pageMeta?: NotionPage } | null;
  set(notionId: string, blocks: NotionBlock[], lastEdited: string, pageMeta?: NotionPage): void;
  delete(notionId: string): void;
  /** Ensure cache is warmed up (deferred from startup). No-op if already warm. */
  ensureWarmedUp(): Promise<void>;
}

const log = createLogger('BlockCacheStore');

/** Max entries in the in-memory LRU. ~10MB budget at ~50KB avg per entry. */
const LRU_CAPACITY = 200;

/** Files older than this are pruned on startup. */
const MAX_AGE_HOURS = 72;

/** Maximum number of files before size-based eviction. */
const MAX_FILES = 10_000;

interface CacheEntry {
  blocks: NotionBlock[];
  lastEdited: string;
  cachedAt: string;
  /**
   * Optional cached NotionPage. Populated by pull's prefetch phase so the
   * replay phase can synthesize the {page, blocks} tuple without re-fetching
   * page metadata. Old entries (push-side) won't have this; back-compat is
   * preserved (consumers treat undefined as "validate via getPage").
   */
  pageMeta?: NotionPage;
}

/**
 * Normalize a Notion ID to dashless lowercase form. Single source of truth
 * for cache keys: in-memory map keys, file lookups via filePath(), and
 * warmup() reload all run through this function. Prevents the historical
 * push-side (sanitized-with-underscores file names) vs pull-side
 * (dashless via normalizeNotionId()) key mismatch from causing cache
 * misses across the two pipelines.
 */
function normalizeKey(notionId: string): string {
  return notionId.replace(/[-_]/g, '').toLowerCase();
}

interface LRUNode {
  key: string;
  entry: CacheEntry;
  prev: LRUNode | null;
  next: LRUNode | null;
}

export class BlockCacheStore implements BlockCacheAccessor {
  private cacheDir: string;
  private adapter: DataAdapter;

  // LRU doubly-linked list + map
  private map = new Map<string, LRUNode>();
  private head: LRUNode | null = null;
  private tail: LRUNode | null = null;

  // Pending writes (debounced)
  private pendingWrites = new Map<string, CacheEntry>();
  private flushTimer: number | null = null;
  private static readonly FLUSH_INTERVAL_MS = 5000;

  /** Whether warmup has been completed (or is in progress). */
  private warmedUp = false;
  private warmupPromise: Promise<void> | null = null;

  constructor(adapter: DataAdapter, dataDir: string, workspaceId: string = 'default') {
    this.adapter = adapter;
    this.cacheDir = `${dataDir}/${workspaceId}/block-cache`;
  }

  /**
   * Sync get - returns from LRU if present, otherwise returns null.
   * Cache miss means the pusher falls back to Notion API fetch.
   */
  get(
    notionId: string,
  ): { blocks: NotionBlock[]; lastEdited: string; pageMeta?: NotionPage } | null {
    const key = normalizeKey(notionId);
    const node = this.map.get(key);
    if (!node) return null;

    // Move to front of LRU
    this.moveToFront(node);
    return {
      blocks: node.entry.blocks,
      lastEdited: node.entry.lastEdited,
      pageMeta: node.entry.pageMeta,
    };
  }

  /**
   * Set a cache entry - updates LRU and schedules file write.
   * `pageMeta` is optional - populated by pull's prefetch phase.
   */
  set(notionId: string, blocks: NotionBlock[], lastEdited: string, pageMeta?: NotionPage): void {
    const key = normalizeKey(notionId);
    const entry: CacheEntry = {
      blocks,
      lastEdited,
      cachedAt: new Date().toISOString(),
      ...(pageMeta ? { pageMeta } : {}),
    };

    const existing = this.map.get(key);
    if (existing) {
      // Preserve existing pageMeta if caller didn't supply one - lets push
      // refresh blocks without wiping pull's cached metadata.
      if (!pageMeta && existing.entry.pageMeta) {
        entry.pageMeta = existing.entry.pageMeta;
      }
      existing.entry = entry;
      this.moveToFront(existing);
    } else {
      const node: LRUNode = { key, entry, prev: null, next: null };
      this.map.set(key, node);
      this.addToFront(node);

      // Evict if over capacity
      if (this.map.size > LRU_CAPACITY) {
        this.evictLRU();
      }
    }

    // Schedule async file write
    this.pendingWrites.set(key, entry);
    this.scheduleFlush();
  }

  /**
   * Delete a cache entry from LRU and schedule file deletion.
   */
  delete(notionId: string): void {
    const key = normalizeKey(notionId);
    const node = this.map.get(key);
    if (node) {
      this.removeNode(node);
      this.map.delete(key);
    }
    this.pendingWrites.delete(key);

    // Async file delete - fire and forget
    const filePath = this.filePath(key);
    this.adapter
      .exists(filePath)
      .then((exists) => {
        if (exists) this.adapter.remove(filePath).catch(() => {});
      })
      .catch(() => {});
  }

  /**
   * Clear entire cache (LRU + pending writes).
   */
  clear(): void {
    // Cancel any pending flush so it can't re-write entries we're clearing.
    if (this.flushTimer) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.map.clear();
    this.head = null;
    this.tail = null;
    this.pendingWrites.clear();
    // Also delete the on-disk cache, or the next warmup reloads exactly the
    // entries we just cleared and the clear is a no-op after restart (#1568).
    // Best-effort and non-blocking - clear() stays synchronous.
    void this.deleteDiskCache();
  }

  /** Remove all persisted cache files (best-effort). */
  private async deleteDiskCache(): Promise<void> {
    try {
      if (!(await this.adapter.exists(this.cacheDir))) return;
      const listing = await this.adapter.list(this.cacheDir);
      for (const file of listing.files) {
        await this.adapter.remove(file).catch(() => {});
      }
    } catch {
      /* best-effort - a stale file just gets pruned on next warmup */
    }
  }

  /**
   * Ensure cache is warmed up before first use. Deferred from startup to first push
   * to save ~200-500ms on plugin load. Safe to call multiple times - only warms once.
   */
  async ensureWarmedUp(): Promise<void> {
    if (this.warmedUp) return;
    if (this.warmupPromise) return this.warmupPromise;
    this.warmupPromise = this.warmup();
    try {
      await this.warmupPromise;
    } finally {
      // If warmup did not succeed, drop the cached promise so a later call can
      // retry instead of returning the already-settled (failed) promise forever.
      if (!this.warmedUp) this.warmupPromise = null;
    }
  }

  /**
   * Load existing cache entries from disk into LRU.
   * Called lazily on first push - loads cache files into memory.
   */
  async warmup(): Promise<void> {
    if (this.warmedUp) return;
    try {
      if (!(await this.adapter.exists(this.cacheDir))) {
        this.warmedUp = true;
        return;
      }

      const listing = await this.adapter.list(this.cacheDir);
      const jsonFiles = listing.files.filter((f: string) => f.endsWith('.json'));

      // UUID-based cache names are NOT chronological, so sort by mtime for real
      // age order before pruning. Pre-fix there was no sort at all: the age
      // cutoff only touched an arbitrary tail and the overflow delete removed an
      // arbitrary set, so files outside the tail accumulated to the 10k cap and
      // the wrong ones were pruned (#1562). warmup runs once per session, so one
      // stat per file is acceptable.
      const stated = await Promise.all(
        jsonFiles.map(async (file) => ({
          file,
          mtime: (await this.adapter.stat(file))?.mtime ?? 0,
        })),
      );
      stated.sort((a, b) => a.mtime - b.mtime); // oldest first

      const cutoff = Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000;
      let pruned = 0;

      // Age-prune everything older than MAX_AGE across the WHOLE listing, then
      // cap the survivors at MAX_FILES by dropping the oldest.
      const fresh = stated.filter((x) => x.mtime >= cutoff);
      const aged = stated.filter((x) => x.mtime < cutoff);
      const overflow = fresh.length > MAX_FILES ? fresh.slice(0, fresh.length - MAX_FILES) : [];

      for (const { file } of [...aged, ...overflow]) {
        try {
          await this.adapter.remove(file);
          pruned++;
        } catch {
          /* ignore */
        }
      }

      // Load the newest survivors up to LRU capacity.
      const toLoad = fresh
        .slice(overflow.length)
        .slice(-LRU_CAPACITY)
        .map((x) => x.file);

      for (const file of toLoad) {
        try {
          const content = await this.adapter.read(file);
          const parsed = JSON.parse(content) as CacheEntry;

          // Check age
          const cachedTime = new Date(parsed.cachedAt).getTime();
          if (isNaN(cachedTime) || cachedTime < cutoff) {
            await this.adapter.remove(file);
            pruned++;
            continue;
          }

          // Extract notion ID from filename. Old files were sanitized
          // with underscores in place of dashes; normalizeKey() drops both
          // so old and new files reload to the same canonical key.
          const fileName = (file.split('/').pop() ?? file).replace('.json', '');
          const key = normalizeKey(fileName);

          const node: LRUNode = { key, entry: parsed, prev: null, next: null };
          this.map.set(key, node);
          this.addToFront(node);
        } catch (err) {
          log.debug(`Cache warmup: skipping corrupt file ${file}`, err);
          try {
            await this.adapter.remove(file);
          } catch {
            /* best-effort cleanup */
          }
        }
      }

      if (pruned > 0) {
        log.info(`Block cache warmup: loaded ${this.map.size} entries, pruned ${pruned}`);
      } else if (this.map.size > 0) {
        log.info(`Block cache warmup: loaded ${this.map.size} entries`);
      }
      this.warmedUp = true;
    } catch (err) {
      log.warn('Block cache warmup failed - starting empty', err);
      // Don't set warmedUp so retry is possible on next access
    }
  }

  /** Flush all pending writes to disk. */
  async flush(): Promise<void> {
    if (this.pendingWrites.size === 0) return;

    const writes = new Map(this.pendingWrites);
    this.pendingWrites.clear();

    for (const [notionId, entry] of writes) {
      try {
        const filePath = this.filePath(notionId);
        await this.adapter.write(filePath, JSON.stringify(entry));
      } catch {
        log.warn(`Failed to write block cache for ${notionId}`);
      }
    }
  }

  /** Return memory stats for the in-memory LRU cache. */
  getMemoryStats(): { entryCount: number; capacity: number; pendingWrites: number } {
    return {
      entryCount: this.map.size,
      capacity: LRU_CAPACITY,
      pendingWrites: this.pendingWrites.size,
    };
  }

  /** Stop the flush timer and flush any pending writes. Call on shutdown. */
  async destroy(): Promise<void> {
    if (this.flushTimer) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingWrites.size > 0) {
      await this.flush();
    }
  }

  // ── LRU internals ─────────────────────────────────────

  private addToFront(node: LRUNode): void {
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  private removeNode(node: LRUNode): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = null;
    node.next = null;
  }

  private moveToFront(node: LRUNode): void {
    if (node === this.head) return;
    this.removeNode(node);
    this.addToFront(node);
  }

  private evictLRU(): void {
    if (!this.tail) return;
    const evicted = this.tail;
    this.removeNode(evicted);
    this.map.delete(evicted.key);
  }

  private filePath(notionId: string): string {
    const safeName = notionId.replace(/[^a-zA-Z0-9-_]/g, '_');
    return `${this.cacheDir}/${safeName}.json`;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((err) => {
        log.warn('Block cache flush failed', err);
      });
    }, BlockCacheStore.FLUSH_INTERVAL_MS);
  }
}
