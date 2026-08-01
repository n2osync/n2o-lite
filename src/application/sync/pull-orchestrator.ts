/**
 * PullSyncProcessor - Notion -> Obsidian pull sync pipeline.
 *
 * Orchestrates the three-phase pull sync:
 * - Phase 1: Discover changes (vault inventory + registry)
 * - Phase 2: Diff and resolve (fetch, render, write, conflict handling)
 * - Phase 3: Apply changes (orphans, cleanup, post-sync housekeeping)
 *
 * The actual logic for each phase is delegated to:
 * - pull-diff-phase.ts - Parallel/sequential entry processing
 * - pull-apply-phase.ts - Entry sync, database sync, page sync, orphan handling
 */

import type { NotionClient } from '../../infrastructure/notion/client';
import type { NotionBlock, NotionPage } from '../../domain/models/notion-api-types';
import { PrefetchCoordinator } from './prefetch-coordinator';
import type { NotionParser } from '../../infrastructure/notion/parser';
import type { ObsidianBuilder } from '../../infrastructure/obsidian/builder';
import type { VaultAdapter } from '../../infrastructure/obsidian/vault';
import type { SyncStateDB } from '../../infrastructure/storage/sync-state';
import type { SyncConfig } from '../../domain/models/sync-config';
import { getSyncRecordDirection } from './orchestrator';
import type {
  SyncResult,
  SyncResultItem,
  SyncResultCounts,
  ProgressCallback,
  ErrorCallback,
  ItemCallback,
} from './orchestrator';
import type { ConflictAuditLog } from '../conflict/conflict-audit';
import type { BlockCacheAccessor } from '../../infrastructure/storage/block-cache-store';
import type { BlockIdentityStore } from '../../infrastructure/storage/block-identity-store';
import { PageRegistry } from '../discovery/page-registry';
import type { PageRegistryEntry } from '../discovery/page-registry';
import { MediaHandler } from '../media/media-handler';
import { hashContentForChange } from '../../shared/hash';
import { ConflictManager } from '../conflict/conflict-manager';
import { RegistryBuilder } from '../discovery/registry-builder';
import { PropertyHelper } from '../discovery/property-helper';
import type { MediaDownloader } from '../media/media-downloader';
import type { VaultInventory } from '../discovery/vault-inventory';
import { sanitizeFileName, vaultRelativePathBudget } from '../../shared/sanitize';
import { createLogger } from '../../shared/logger';
import { mapNotionSvgFilenameToEmoji } from '../../shared/notion-icon-map';

// Phase modules
import { diffAndResolve } from './pull-diff-phase';
import { applyChanges } from './pull-apply-phase';
import { syncOneEntry } from './sync-entry';
import { syncPage } from './sync-page';
import type { ApplyPhaseDeps } from './apply-phase-deps';
import { PageBudget, LITE_PAGE_LIMIT } from './page-budget';

const log = createLogger('PullSync');

export interface PullSyncDeps {
  notionClient: NotionClient;
  parser: NotionParser;
  builder: ObsidianBuilder;
  vaultAdapter: VaultAdapter;
  syncState: SyncStateDB;
  mediaDownloader: MediaDownloader;
  mediaHandler: MediaHandler;
  conflictManager: ConflictManager;
  registryBuilder: RegistryBuilder;
  propertyHelper: PropertyHelper;
  vaultInventory: VaultInventory;
  /** Show a transient notification to the user. Decouples application layer from Obsidian's Notice. */
  notify: (message: string, duration?: number) => void;
  // Optional deps
  conflictAudit?: ConflictAuditLog | null;
  blockCache?: BlockCacheAccessor | null;
  blockIdentityStore?: BlockIdentityStore | null;
}

/**
 * Fine-grained sync phase. Mirrors SyncPhase from domain/models/sync-result.
 * Re-declared locally to keep the pull-orchestrator decoupled from that
 * module; callers bridge via onPhase().
 */
export type PullSyncPhase = 'discovering' | 'applying' | 'finalizing' | 'idle';

export type PhaseCallback = (phase: PullSyncPhase) => void;

export class PullSyncProcessor {
  private progressCallback: ProgressCallback | null = null;
  private errorCallback: ErrorCallback | null = null;
  private itemCallback: ItemCallback | null = null;
  private phaseCallback: PhaseCallback | null = null;
  private currentRegistry: PageRegistry | null = null;
  private currentWarnings: string[] = [];
  /**
   * Per-sync error accumulator written by `emitError`. Merged into
   * SyncResult.errors at result-build time so apply-phase failures
   * fired through deps.emitError(...) (e.g. linked-view resolution
   * failures from sync-page) surface in the user-visible result, not
   * only in the UI callback. Reset alongside currentWarnings.
   */
  private currentErrors: string[] = [];
  private lastProgressTime = 0;
  private cancelled = false;
  private syncing = false;
  private forceRefreshIds: Set<string> = new Set();

  private notionClient: NotionClient;
  private parser: NotionParser;
  private builder: ObsidianBuilder;
  private vaultAdapter: VaultAdapter;
  private syncState: SyncStateDB;
  private mediaDownloader: MediaDownloader;
  private mediaHandler: MediaHandler;
  private conflictManager: ConflictManager;
  private registryBuilder: RegistryBuilder;
  private propertyHelper: PropertyHelper;
  private vaultInventory: VaultInventory;
  private conflictAudit: ConflictAuditLog | null;
  private blockCache: BlockCacheAccessor | null;
  private blockIdentityStore: BlockIdentityStore | null;
  private notify: (message: string, duration?: number) => void;

  constructor(deps: PullSyncDeps) {
    this.notify = deps.notify;
    this.notionClient = deps.notionClient;
    this.parser = deps.parser;
    this.builder = deps.builder;
    this.vaultAdapter = deps.vaultAdapter;
    this.syncState = deps.syncState;
    this.mediaDownloader = deps.mediaDownloader;
    this.mediaHandler = deps.mediaHandler;
    this.conflictManager = deps.conflictManager;
    this.registryBuilder = deps.registryBuilder;
    this.propertyHelper = deps.propertyHelper;
    this.vaultInventory = deps.vaultInventory;
    this.conflictAudit = deps.conflictAudit ?? null;
    this.blockCache = deps.blockCache ?? null;
    this.blockIdentityStore = deps.blockIdentityStore ?? null;
  }

  // ── Dependency update methods (called by facade) ──────
  setMergeAudit(audit: ConflictAuditLog | null): void {
    this.conflictAudit = audit;
  }
  setBlockCache(cache: BlockCacheAccessor | null): void {
    this.blockCache = cache;
  }
  setBlockIdentityStore(store: BlockIdentityStore | null): void {
    this.blockIdentityStore = store;
  }

  /** Register page/database IDs for forced refresh on next sync (bypasses skip logic). */
  addForceRefreshIds(ids: string[]): void {
    for (const id of ids) this.forceRefreshIds.add(id);
  }

  onProgress(cb: ProgressCallback): void {
    this.progressCallback = cb;
  }
  onError(cb: ErrorCallback): void {
    this.errorCallback = cb;
  }
  /**
   * Subscribe to per-item completion events. Fired once per SyncResultItem
   * as the diff phase finishes each entry, so a status surface can show
   * items live during a long sync.
   */
  onItem(cb: ItemCallback): void {
    this.itemCallback = cb;
  }
  /**
   * Subscribe to phase transitions. Fired once per phase change, not per
   * progress tick. Wired up by the SyncOrchestrator so status surfaces can
   * show "Discovering..." vs "Writing files..." instead of a generic
   * "Syncing..." spinner.
   */
  onPhase(cb: PhaseCallback): void {
    this.phaseCallback = cb;
  }

  private emitPhase(phase: PullSyncPhase): void {
    this.phaseCallback?.(phase);
  }

  /** Signal cancellation - the sync loop checks this between items. */
  cancel(): void {
    this.cancelled = true;
  }

  /** Whether cancellation has been requested. */
  isCancelled(): boolean {
    return this.cancelled;
  }

  /** True while a full sync is in progress. Used to skip single-page syncs. */
  isSyncing(): boolean {
    return this.syncing;
  }

  private emitProgress(message: string, current?: number, total?: number): void {
    const now = Date.now();
    const isLast = current !== undefined && total !== undefined && current >= total;
    if (!isLast && now - this.lastProgressTime < 200) return;
    this.lastProgressTime = now;
    this.progressCallback?.(message, current, total);
  }

  private emitError(title: string, error: string): void {
    // UI-only notification surface. Use `appendError` if you also need
    // the failure to land in SyncResult.errors[]. Per-item apply-phase
    // failures already push into the threaded `errors[]` accumulator
    // directly (see sync-entry.ts) so they would double-count if this
    // method also pushed.
    this.errorCallback?.(title, error);
  }

  /**
   * Push a message into the per-sync error accumulator that becomes
   * SyncResult.errors[]. For apply-phase callers (sync-page) that don't
   * have direct access to the local errors[] threaded through the
   * apply functions but still need the failure to surface in the
   * user-visible result (not just a UI toast).
   */
  private appendError(message: string): void {
    this.currentErrors.push(message);
  }

  /** Build scope filtering options for VaultInventory from settings. */
  private buildScopeOptions(settings: SyncConfig): {
    syncScope: 'all' | 'selected';
    allowedPrefixes?: string[];
    allowedPageIds?: Set<string>;
  } {
    if (settings.syncScope !== 'selected' || !settings.selectedItems?.length) {
      return { syncScope: settings.syncScope };
    }
    const allowedPrefixes = settings.selectedItems
      .filter((s) => s.type === 'database')
      .map((s) => `${settings.syncFolder}/${sanitizeFileName(s.title)}/`);
    const allowedPageIds = new Set(
      settings.selectedItems.filter((s) => s.type === 'page').map((s) => s.id.replace(/-/g, '')),
    );
    return { syncScope: 'selected', allowedPrefixes, allowedPageIds };
  }

  /** Build the ApplyPhaseDeps context object for extracted functions. */
  /**
   * Per-sync block cache (plan smooth-jingling-sloth). Populated on every
   * `getAllBlockChildren` call during discovery; reused by the apply
   * phase's page fetches so block trees are fetched once per sync. Reset
   * to null between sync runs so stale data can't bleed across cycles.
   */
  private discoveryBlockCache: Map<string, NotionBlock[]> | null = null;

  /**
   * Per-sync page-metadata cache (plan smooth-jingling-sloth v2). Populated
   * by PrefetchCoordinator during the prefetch phase. Apply-phase fetches
   * use this to skip the getPage round-trip when a hit. Reset to null
   * between sync runs.
   */
  private discoveryPageCache: Map<string, NotionPage> | null = null;

  /**
   * The page budget for the current run (#1918). Rebuilt per sync so the count
   * reflects what is actually in sync_records at the moment the run starts, and
   * so a claim taken by one run never leaks into the next.
   */
  private pageBudget: PageBudget | null = null;

  private buildApplyDeps(mode: 'pull' | 'sync' = 'sync'): ApplyPhaseDeps {
    return {
      pageBudget: this.pageBudget,
      notionClient: this.notionClient,
      parser: this.parser,
      builder: this.builder,
      vaultAdapter: this.vaultAdapter,
      syncState: this.syncState,
      mediaDownloader: this.mediaDownloader,
      mediaHandler: this.mediaHandler,
      conflictManager: this.conflictManager,
      propertyHelper: this.propertyHelper,
      conflictAudit: this.conflictAudit,
      blockCache: this.blockCache,
      discoveryBlockCache: this.discoveryBlockCache,
      discoveryPageCache: this.discoveryPageCache,
      blockIdentityStore: this.blockIdentityStore,
      currentRegistry: this.currentRegistry,
      currentWarnings: this.currentWarnings,
      forceRefreshIds: this.forceRefreshIds,
      isCancelled: () => this.cancelled,
      emitProgress: (msg, cur, tot) => this.emitProgress(msg, cur, tot),
      emitError: (title, error) => this.emitError(title, error),
      appendError: (message) => this.appendError(message),
      emitItem: (item) => this.itemCallback?.(item),
      notify: (msg, duration) => this.notify(msg, duration),
      mode,
    };
  }

  /**
   * Main pull sync method - the full Notion -> Obsidian pipeline.
   * @param options.mode - 'pull' skips three-way merge (Notion wins), 'sync' uses merge (default).
   */
  async sync(
    settings: SyncConfig,
    options?: { dryRun?: boolean; mode?: 'pull' | 'sync' },
  ): Promise<SyncResult> {
    const startTime = Date.now();
    log.info(`Starting ${options?.mode === 'pull' ? 'pull' : 'sync'} cycle`);
    this.cancelled = false;
    // A previous cancel drained + poisoned the rate limiter queue; a fresh
    // run must clear that or every request it makes is rejected on arrival.
    this.notionClient.resetCancel();
    this.syncing = true;

    try {
      return await this._syncImpl(settings, options, startTime);
    } finally {
      this.syncing = false;
      this.forceRefreshIds.clear();
      // Drop the per-sync block cache so it can't bleed across cycles -
      // a future sync starts fresh and only re-uses blocks observed
      // during its own discovery phase.
      this.discoveryBlockCache = null;
      this.discoveryPageCache = null;
      // F-031: reset phase here so any caller - orchestrator.startSync OR
      // a direct engine.pull() - sees the terminal state. Previously only
      // the outer orchestrator reset phase, so programmatic callers left
      // the status surface stuck on "Finalizing...".
      this.emitPhase('idle');
    }
  }

  private async _syncImpl(
    settings: SyncConfig,
    options: { dryRun?: boolean; mode?: 'pull' | 'sync' } | undefined,
    startTime: number,
  ): Promise<SyncResult> {
    const errors: string[] = [];
    this.currentWarnings = [];
    this.currentErrors = [];
    const items: SyncResultItem[] = [];
    const counts: SyncResultCounts = {
      total: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      failed: 0,
      orphaned: 0,
      localChanges: 0,
      conflicts: 0,
      skipped: 0,
    };

    /* Page budget for this run (#1918). Built from what sync_records holds RIGHT
     * NOW so a vault that was already over the cap keeps all of its pages, and
     * rebuilt every run so a claim never leaks between runs. */
    this.pageBudget = new PageBudget(LITE_PAGE_LIMIT, this.syncState.getPageRecordCount());

    // Fresh per-sync L1 caches. Discovery's block walks + Phase A prefetch
    // populate them; the apply phase reads back so each block tree is
    // fetched at most once per sync run.
    this.discoveryBlockCache = new Map();
    this.discoveryPageCache = new Map();

    // ── Phase 1: Discover changes (vault inventory + registry) ──
    const discovery = await this.discoverChanges(settings, errors);

    // Early returns from discovery phase
    if (discovery.earlyReturn) {
      const wasCanceled = discovery.earlyReturn === 'cancelled';
      const mergedErrors = [...errors, ...this.currentErrors];
      return {
        // Cancellation is NOT success. Pre-fix this returned success:true
        // and the UI rendered "All caught up" after a cancel, misleading
        // the user that nothing was wrong. The canceled flag lets the UI
        // render a distinct "Sync canceled" surface.
        // Errors via appendError (e.g. linked-view resolution failures)
        // also flip success to false on this early-return path.
        success: !wasCanceled && mergedErrors.length === 0,
        canceled: wasCanceled || undefined,
        itemsSynced: 0,
        counts,
        items,
        conflicts: 0,
        errors: mergedErrors,
        warnings: wasCanceled ? ['Sync cancelled by user'] : this.currentWarnings,
        duration: Date.now() - startTime,
      };
    }

    const { registry, registryEntries, discoveryComplete } = discovery;
    const allEntries = [...registryEntries];

    // Force-refresh parent pages of ALL linked views that were resolved in this
    // sync. Parent pages may have [!missing] callouts from previous syncs that
    // need re-rendering.
    for (const entry of registryEntries) {
      if (entry.type === 'linked-view' && entry.linkedViewContext?.parentPageId) {
        this.forceRefreshIds.add(entry.linkedViewContext.parentPageId.replace(/-/g, ''));
      }
    }

    // ── Phase 1.5: Prefetch (warm-cache validation) ──
    // When the persistent L2 cache has entries from a prior sync, walk
    // seed pages once to validate (cheap getPage per entry) and prime the
    // L1 caches before the apply phase reads them. Skipped on cold L2
    // (first sync) - the L2 cache populates as a side effect of apply
    // (sync-page.ts / sync-entry.ts) so the NEXT sync sees warm cache.
    const l2Stats =
      this.blockCache && 'getMemoryStats' in this.blockCache
        ? (this.blockCache as { getMemoryStats: () => { entryCount: number } }).getMemoryStats()
        : null;
    const l2HasEntries = (l2Stats?.entryCount ?? 0) > 0;
    if (l2HasEntries) {
      this.emitPhase('discovering');
      this.emitProgress(`Validating cache for ${registryEntries.length} pages...`);
      try {
        const seedIds = registryEntries
          .filter((e) => e.type === 'page' || e.type === 'database-item')
          .map((e) => e.notionId);
        const prefetcher = new PrefetchCoordinator({
          notionClient: this.notionClient,
          blockCache: this.blockCache,
          isCancelled: () => this.cancelled,
          emitProgress: (msg, cur, tot) => this.emitProgress(msg, cur, tot),
        });
        const result = await prefetcher.prefetchAll(seedIds, {
          syncChildPages: settings.syncChildPages,
          syncChildDatabases: settings.syncChildDatabases,
          selectedDbTitles: new Set(
            registryEntries.filter((e) => e.type === 'database').map((e) => e.title),
          ),
        });
        // Adopt the populated L1 caches as the orchestrator's working maps.
        // PrefetchCoordinator returns its own Maps; replace ours so the apply
        // phase reads from the prefetched data.
        this.discoveryBlockCache = result.blockCache;
        this.discoveryPageCache = result.pageCache;
        log.info(
          `Prefetch: ${result.stats.passes} passes, ${result.blockCache.size} pages cached ` +
            `(cached=${result.stats.cached} refreshed=${result.stats.refreshed} ` +
            `fetched=${result.stats.fetched} errored=${result.stats.errored}) in ${result.stats.durationMs}ms`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Prefetch phase failed; falling back to live fetch: ${msg}`);
        this.currentWarnings.push(`Prefetch failed: ${msg}`);
      }
      if (this.cancelled) {
        return this.cancelResult(counts, items, errors, startTime);
      }
    }

    // ── Phase 2: Diff and resolve ──
    // Single discovery pass already populated the registry (selected items +
    // their nested children + linked views + DB metadata via the backstop in
    // registry-builder). One apply call drives the full tree.
    this.emitPhase('applying');
    const applyDeps = this.buildApplyDeps(options?.mode ?? 'sync');
    this.emitProgress(`Syncing ${registryEntries.length} items`);
    await diffAndResolve(
      registryEntries,
      registry,
      settings,
      counts,
      items,
      errors,
      {
        builder: this.builder,
        syncOneEntry: (entry, s, c, it, er, opt) =>
          syncOneEntry(entry, s, c, it, er, applyDeps, opt),
        emitProgress: (msg, cur, tot) => this.emitProgress(msg, cur, tot),
        isCancelled: () => this.cancelled,
        emitItem: (item) => this.itemCallback?.(item),
      },
      options,
    );

    if (this.cancelled) {
      return this.cancelResult(counts, items, errors, startTime);
    }

    // ── Phase 3: Apply changes (orphans, cleanup, post-sync) ──
    this.emitPhase('finalizing');
    await applyChanges(
      allEntries,
      registry,
      settings,
      counts,
      items,
      errors,
      applyDeps,
      options,
      discoveryComplete,
    );

    const itemsSynced = counts.created + counts.updated;
    const duration = Date.now() - startTime;
    log.info(
      `Sync complete: ${itemsSynced} synced, ${counts.unchanged} unchanged, ${counts.failed} failed in ${duration}ms`,
    );

    // Invalidate cached indexes after sync cycle - file writes/renames during
    // the cycle may have changed paths, so stale caches would cause incorrect
    // lookups on the next sync.
    this.vaultAdapter.invalidateNotionIdIndex();
    this.vaultAdapter.invalidateMarkdownFilesCache();

    // Merge per-sync emitError accumulator into result.errors so apply-
    // phase failures (e.g. linked-view resolution that could not honor
    // the Notion view's filter) surface in the user-visible result.
    // success stays driven by counts.failed (per-item semantic) AND
    // by the presence of orchestrator-level errors so a sync that
    // could not resolve a linked-view filter is not reported as
    // success=true with a wrong row set.
    const mergedErrors = [...errors, ...this.currentErrors];
    /* A run that hit the page cap must NEVER read as a clean success (#1918).
     * `truncated` carries the honest pair - how many pages were in scope and how
     * many were actually written - so the notice can say "100 of 340 synced,
     * 240 skipped" instead of "sync complete". */
    const skipped = counts.skipped ?? 0;
    const truncated =
      skipped > 0 ? { total: itemsSynced + skipped, synced: itemsSynced } : undefined;
    return {
      success: counts.failed === 0 && mergedErrors.length === 0,
      itemsSynced,
      counts,
      items,
      conflicts: counts.conflicts ?? 0,
      errors: mergedErrors,
      warnings: this.currentWarnings,
      duration,
      discoveryComplete,
      truncated,
    };
  }

  /**
   * Build the cancellation SyncResult shared by every cancel exit point.
   * Centralising the shape here prevents drift when fields are added.
   */
  private cancelResult(
    counts: SyncResultCounts,
    items: SyncResultItem[],
    errors: string[],
    startTime: number,
  ): SyncResult {
    log.info('Sync cancelled by user');
    const itemsSynced = counts.created + counts.updated;
    return {
      success: false,
      canceled: true,
      itemsSynced,
      counts,
      items,
      conflicts: counts.conflicts ?? 0,
      errors: [...errors, ...this.currentErrors],
      warnings: ['Sync cancelled by user'],
      duration: Date.now() - startTime,
      discoveryComplete: false,
    };
  }

  /**
   * Phase 1: Discover changes - reconcile vault and build the registry.
   * Returns the registry entries and metadata, or an earlyReturn signal if sync should stop.
   *
   * On the 'selected' path this only registers directly-selected items
   * (pass 1 seeds). Pass 2 BFS in the orchestrator drives nested-child
   * discovery via `discoverChildrenFromBlocks` so apply runs between
   * layers and the vault fills as work progresses.
   */
  private async discoverChanges(
    settings: SyncConfig,
    errors: string[],
  ): Promise<{
    earlyReturn?: 'cancelled' | 'empty';
    registry: PageRegistry;
    registryEntries: PageRegistryEntry[];
    discoveryComplete: boolean;
  }> {
    // Pre-sync vault inventory: reconcile vault state against sync DB
    const scopeOptions = this.buildScopeOptions(settings);
    const report = await this.vaultInventory.reconcileVault(
      settings.syncFolder,
      () => getSyncRecordDirection(),
      (msg) => this.emitProgress(msg),
      scopeOptions,
    );
    if (report.actions.length > 0) {
      log.info(`Vault inventory: ${report.actions.length} actions in ${report.duration}ms`);
    }
    // Notify user when duplicates were auto-unlinked during sync
    const autoUnlinked = report.actions.filter((a) => a.type === 'duplicate_auto_unlinked');
    if (autoUnlinked.length > 0) {
      this.notify(
        `N2O: ${autoUnlinked.length} duplicate file${autoUnlinked.length > 1 ? 's' : ''} auto-unlinked.`,
        8000,
      );
    }

    // One-time migration: convert SVG icon filenames to emoji in existing vault files
    await this.migrateIconFrontmatter(settings.syncFolder);

    if (this.cancelled) {
      return {
        earlyReturn: 'cancelled',
        registry: new PageRegistry(),
        registryEntries: [],
        discoveryComplete: false,
      };
    }

    // Build registry from Notion workspace
    this.emitProgress('Discovering workspace...');
    const registry = new PageRegistry();
    registry.setRelativePathBudget(
      vaultRelativePathBudget(this.vaultAdapter.getVaultBasePath().length),
    );
    this.currentRegistry = registry;
    let registryEntries: PageRegistryEntry[];

    let discoveryComplete = true;
    if (settings.syncScope === 'all') {
      const discoveryOut = await this.registryBuilder.buildFromDiscovery(
        registry,
        settings,
        errors,
        (msg) => this.emitProgress(msg),
        () => this.cancelled,
      );
      registryEntries = discoveryOut.entries;
      discoveryComplete = discoveryOut.discoveryComplete;
    } else {
      const selectedOut = await this.registryBuilder.buildFromSelected(
        registry,
        settings,
        errors,
        (msg) => this.emitProgress(msg),
        () => this.cancelled,
      );
      registryEntries = selectedOut.entries;
      discoveryComplete = selectedOut.discoveryComplete;
    }

    // Deduplicate registryEntries by notionId - prevents double-processing
    // when the same item appears via different API paths (e.g. data_source vs block ID)
    {
      const seenIds = new Set<string>();
      const before = registryEntries.length;
      registryEntries = registryEntries.filter((e) => {
        if (seenIds.has(e.notionId)) return false;
        seenIds.add(e.notionId);
        return true;
      });
      if (registryEntries.length < before) {
        log.warn(`Deduplicated ${before - registryEntries.length} duplicate registry entries`);
      }
    }

    if (registryEntries.length === 0 && errors.length === 0) {
      // F-034: don't early-return if there are existing sync records - // apply phase still needs to run so orphan detection and zombie
      // GC can clean them up. Only bail when there's truly nothing to do.
      const existingRecordCount = this.syncState.getRecordCount();
      if (existingRecordCount === 0) {
        log.info('No pages to sync and no existing records');
        return { earlyReturn: 'empty', registry, registryEntries: [], discoveryComplete };
      }
      log.info(
        `No pages in registry but ${existingRecordCount} sync record(s) exist - continuing to apply phase for orphan/zombie cleanup`,
      );
    }

    // Clean up stale database sync records not in the current registry.
    // This prevents ghost records from previous syncs causing duplicate folders.
    const registeredDbIds = new Set(
      registryEntries.filter((e) => e.type === 'database').map((e) => e.notionId),
    );
    if (registeredDbIds.size > 0) {
      const allDbRecords = this.syncState.getAllRecords().filter((r) => r.itemType === 'database');
      for (const rec of allDbRecords) {
        if (!registeredDbIds.has(rec.notionId)) {
          this.syncState.deleteRecord(rec.id);
          log.info(
            `Deleted stale database record: ${rec.notionId.substring(0, 8)}... ("${rec.obsidianPath}")`,
          );
        }
      }
    }

    return { registry, registryEntries, discoveryComplete };
  }

  /** Meta key used to persist icon migration completion in the database. */
  private static readonly ICON_MIGRATION_META_KEY = 'icon_migration_done';

  /**
   * One-time migration: scan vault files for SVG icon filenames in frontmatter
   * and replace them with emoji equivalents using the icon map.
   * Runs once - tracks completion via a persisted flag in n2o_meta.
   */
  private async migrateIconFrontmatter(_syncFolder: string): Promise<void> {
    if (this.syncState.getMeta(PullSyncProcessor.ICON_MIGRATION_META_KEY) === '1') return;

    let records: { notionId: string; obsidianPath: string }[];
    try {
      records = this.syncState.getAllPathMappings();
    } catch {
      return; // syncState may not support this method in tests
    }
    if (!records || records.length === 0) return;

    let migrated = 0;
    let errors = 0;
    for (const record of records) {
      if (!record.obsidianPath.endsWith('.md')) continue;
      try {
        const content = await this.vaultAdapter.readFile(record.obsidianPath);
        if (!content) continue;

        // Operate ONLY within the YAML frontmatter block (between the leading
        // --- fences). The old code matched /^icon:/m and string-replaced the
        // first match anywhere, so an `icon: "x.svg"` line in the body or a code
        // block could be silently mutated.
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;
        const fmBody = fmMatch[1];
        if (fmBody === undefined) continue;
        const iconMatch = fmBody.match(/^icon:\s*"([^"]+\.svg)"/m);
        if (!iconMatch) continue;

        const svgFilename = iconMatch[1];
        if (svgFilename === undefined) continue;
        const emoji = mapNotionSvgFilenameToEmoji(svgFilename);
        if (!emoji) continue;

        // Replace the icon line within the frontmatter block only.
        const newFm = fmBody.replace(`icon: "${svgFilename}"`, `icon: "${emoji}"`);
        const updated = content.replace(fmMatch[0], `---\n${newFm}\n---`);
        if (updated !== content) {
          this.vaultAdapter.setSyncLock(record.obsidianPath);
          try {
            await this.vaultAdapter.writeFile(record.obsidianPath, updated);
          } finally {
            this.vaultAdapter.clearSyncLock(record.obsidianPath);
          }
          migrated++;
        }
      } catch {
        // Non-fatal - skip files that can't be read/written, but track for completion check
        errors++;
      }
    }

    if (migrated > 0) {
      log.info(`Icon migration: converted ${migrated} SVG icon(s) to emoji`);
    }

    // Only mark complete if all files processed without errors
    if (errors === 0) {
      this.syncState.setMeta(PullSyncProcessor.ICON_MIGRATION_META_KEY, '1');
    } else {
      log.warn(`Icon migration: ${errors} file(s) had errors - will retry on next sync`);
    }
  }

  /**
   * Sync a single page by its Notion ID and vault path.
   * Skips if a full sync is already running to prevent race conditions.
   *
   * @param knownLastEdited - If provided, enables early-exit when sync record already matches this timestamp.
   * @param options.overwriteDirty - Opt OUT of the local-edit guard and
   *   overwrite the file even when it has unsynced edits. ONLY for commands
   *   where the user asked for exactly that and confirmed it.
   */
  async syncSinglePage(
    notionId: string,
    vaultPath: string,
    settings: SyncConfig,
    knownLastEdited?: string,
    options?: { overwriteDirty?: boolean },
  ): Promise<{ contentChanged: boolean; skipped?: boolean }> {
    if (this.syncing) {
      // A full sync is running, so this single-page pass did NOT run. Callers
      // must treat this as "not done", not as a success (#1459).
      log.info(`Skipping syncSinglePage("${vaultPath}") - full sync in progress`);
      return { contentChanged: false, skipped: true };
    }

    // Fresh single-page run: clear any abort left behind by a cancelled full
    // sync. Placed AFTER the syncing guard so an unwinding cancelled sync
    // can't have its queue silently re-armed by a concurrent caller.
    this.notionClient.resetCancel();

    // Fetch sync record once - used for early-exit check and entry construction.
    const record = this.syncState.getByNotionId(notionId);

    // Early exit: if sync record has a NEWER version, skip the API call entirely.
    // NOTE: We use `>` (not `>=`) because Notion timestamps have minute-level
    // granularity - edits within the same minute share the same timestamp.
    // Using `>=` would skip within-minute edits, a common scenario.
    if (knownLastEdited && record && record.notionLastEdited > knownLastEdited) {
      log.debug(`syncSinglePage: "${vaultPath}" already at ${record.notionLastEdited} - skipping`);
      return { contentChanged: false };
    }

    // Resolve actual file path via frontmatter before constructing entry
    const folder = vaultPath.split('/').slice(0, -1).join('/');
    const resolvedPath =
      this.vaultAdapter.resolveFileByNotionId(notionId, vaultPath, folder || settings.syncFolder) ??
      vaultPath;

    if (resolvedPath !== vaultPath) {
      log.info(
        `syncSinglePage: resolved "${notionId}" at "${resolvedPath}" (expected "${vaultPath}")`,
      );
      this.syncState.updatePathByNotionId(notionId, resolvedPath);
    }

    const entry: PageRegistryEntry = {
      notionId,
      title: resolvedPath.split('/').pop()?.replace('.md', '') ?? 'Unknown',
      // Use sync record as authoritative type source - prevents overwriting
      // 'database-item' records with 'page' on repeated single-page syncs.
      type: record?.itemType ?? 'page',
      parentDatabaseId:
        record?.itemType === 'database-item' ? (record.notionParentId ?? undefined) : undefined,
      fileName: resolvedPath.split('/').pop()?.replace('.md', '') ?? 'Unknown',
      vaultPath: resolvedPath,
      folder,
      lastEditedTime: knownLastEdited,
    };
    /* P0 data-safety guard, ON BY DEFAULT. syncSinglePage calls syncPage
     * directly, which means "Notion wins" with no copy of the local version
     * kept, so an unguarded call silently destroys a user's edits.
     *
     * This used to be opt-IN (`conflictIfDirty`) and NOTHING opted in, so it
     * protected nothing while reading as a solved problem. retryFailedMedia
     * reached here with no guard: a user who edited a note and then retried a
     * failed image download lost the edit. Inverted per avoiding-drift rule 2 -
     * a new caller now gets the safe behaviour for free and has to ask, in
     * writing, to overwrite.
     *
     * When the file on disk differs from record.obsidianContentHash (what we
     * last wrote), route through the full conflict-detection pipeline instead:
     * the local file is left alone and Notion's version is written beside it.
     * The fast overwrite path stays for provably-clean files. */
    if (!options?.overwriteDirty && record) {
      const localContent = await this.vaultAdapter.readFile(resolvedPath);
      if (
        localContent !== null &&
        hashContentForChange(localContent) !== record.obsidianContentHash
      ) {
        log.info(
          `syncSinglePage: "${resolvedPath}" has local edits - routing through conflict detection instead of overwriting`,
        );
        /* authoritative: true is load-bearing. Without it syncSingleEntry
         * gates conflict detection on entry.lastEditedTime, which is undefined
         * here unless a caller happened to pass knownLastEdited - so it fell
         * straight through to the overwrite and the guard did nothing at all.
         * Authoritative mode fetches Notion once and compares content hashes on
         * both sides instead of trusting a timestamp we do not have. */
        const res = await this.syncSingleEntry(entry, settings, { authoritative: true });
        return { contentChanged: res.counts.updated > 0 || res.counts.created > 0 };
      }
    }

    const applyDeps = this.buildApplyDeps();
    return syncPage(entry, settings, applyDeps, undefined, { detectTitleRename: true });
  }

  /**
   * Sync a single page (standalone or database item) to the vault.
   * Public API preserved for external callers (engine.ts).
   */
  async syncPage(
    entry: PageRegistryEntry,
    settings: SyncConfig,
    prefetched?: {
      page: import('../../domain/models/notion-api-types').NotionPage;
      blocks: import('../../domain/models/notion-api-types').NotionBlock[];
      doc: import('../../domain/models/document').N2ODocument;
      markdown: string;
    },
    options?: { detectTitleRename?: boolean },
  ): Promise<{ contentChanged: boolean }> {
    const applyDeps = this.buildApplyDeps();
    return syncPage(entry, settings, applyDeps, prefetched, options);
  }

  /**
   * Drive a single registry entry through the full conflict-detection
   * pipeline (syncOneEntry), returning the counts / items / conflicts /
   * errors produced. Unlike `syncSinglePage`, which bypasses conflict
   * detection by calling `syncPage` directly, this goes through the
   * three-way merge path.
   *
   * Exposed for QA tests and future conflict-resolution tooling that
   * needs to exercise the merge pipeline without running a full scoped
   * pull (which re-does discovery and touches every page in scope).
   */
  async syncSingleEntry(
    entry: PageRegistryEntry,
    settings: SyncConfig,
    options?: { dryRun?: boolean; authoritative?: boolean },
  ): Promise<{
    counts: SyncResultCounts;
    items: SyncResultItem[];
    errors: string[];
  }> {
    const counts: SyncResultCounts = {
      total: 1,
      created: 0,
      updated: 0,
      unchanged: 0,
      failed: 0,
      orphaned: 0,
      localChanges: 0,
    };
    const items: SyncResultItem[] = [];
    const errors: string[] = [];
    const applyDeps = this.buildApplyDeps();
    await syncOneEntry(entry, settings, counts, items, errors, applyDeps, options);
    return { counts, items, errors };
  }
}
