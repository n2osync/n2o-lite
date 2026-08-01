/**
 * SyncEngine - Thin facade over extracted sync modules.
 *
 * Delegates all work to:
 * - PullSyncProcessor: Notion -> Obsidian sync
 * - ConflictManager: Conflict resolution + notes
 * - PropertyHelper: Schema parsing + property remapping
 * - RegistryBuilder: Discovery + registry construction
 * - MediaHandler: Media download orchestration
 *
 * Public API is 100% unchanged - all callers (main.ts, orchestrator.ts, tests)
 * work without modification.
 */

import type { NotionClient } from '../../infrastructure/notion/client';
import type { NotionParser } from '../../infrastructure/notion/parser';
import type { ObsidianBuilder } from '../../infrastructure/obsidian/builder';
import type { BlockCacheAccessor } from '../../infrastructure/storage/block-cache-store';
import type { BlockIdentityStore } from '../../infrastructure/storage/block-identity-store';
import type { VaultAdapter } from '../../infrastructure/obsidian/vault';
import type { SyncStateDB } from '../../infrastructure/storage/sync-state';
import type { SyncConfig } from '../../domain/models/sync-config';
import type { SyncResult, ProgressCallback, ErrorCallback, ItemCallback } from './orchestrator';
import type { NotionDiscovery } from '../discovery/discovery';
import type { MediaDownloader } from '../media/media-downloader';
import type { ConflictAuditLog } from '../conflict/conflict-audit';
import { PullSyncProcessor } from './pull-orchestrator';
import { ConflictManager } from '../conflict/conflict-manager';
import { PropertyHelper } from '../discovery/property-helper';
import { RegistryBuilder } from '../discovery/registry-builder';
import { MediaHandler } from '../media/media-handler';
import { VaultInventory } from '../discovery/vault-inventory';

/**
 * Configuration object for SyncEngine optional components.
 * Replaces individual setter calls with a single `configure()` call.
 * All properties are optional - only set the ones you need.
 */
export interface SyncEngineConfig {
  /** Merge audit log for recording three-way merge decisions. */
  conflictAudit?: ConflictAuditLog | null;
  /** Base version store for tracking ancestor content after sync. */
  /** Block cache accessor so pulls can reuse recently-fetched block trees. */
  blockCache?: BlockCacheAccessor | null;
  /**
   * Persistent cache of `child_database` block classifications. When wired,
   * sync-page runs a pre-parse enrichment that populates the registry with
   * inline databases and linked views so pull rendering can produce valid
   * `.base` embeds for any page, independent of discovery completeness.
   */
  blockIdentityStore?: BlockIdentityStore | null;
}

export class SyncEngine {
  private settings: SyncConfig;
  private pullSync: PullSyncProcessor;
  private conflictManager: ConflictManager;
  private propertyHelper: PropertyHelper;
  private registryBuilder: RegistryBuilder;
  private conflictAudit: ConflictAuditLog | null = null;

  constructor(
    private notionClient: NotionClient,
    parser: NotionParser,
    builder: ObsidianBuilder,
    vaultAdapter: VaultAdapter,
    syncState: SyncStateDB,
    settings: SyncConfig,
    discovery: NotionDiscovery,
    mediaDownloader: MediaDownloader,
    notify: (message: string, duration?: number) => void,
  ) {
    this.settings = settings;
    this.propertyHelper = new PropertyHelper();
    this.conflictManager = new ConflictManager(vaultAdapter);
    this.registryBuilder = new RegistryBuilder(
      notionClient,
      vaultAdapter,
      syncState,
      discovery,
      this.propertyHelper,
    );
    const registryBuilder = this.registryBuilder;
    const mediaHandler = new MediaHandler(mediaDownloader, 3, settings.generateThumbnails);
    const vaultInventory = new VaultInventory(vaultAdapter, syncState);

    this.pullSync = new PullSyncProcessor({
      notionClient,
      parser,
      builder,
      vaultAdapter,
      syncState,
      mediaDownloader,
      mediaHandler,
      conflictManager: this.conflictManager,
      registryBuilder,
      propertyHelper: this.propertyHelper,
      vaultInventory,
      notify,
    });

    // Wire discovery cancellation to pull sync's cancel flag
    if (typeof discovery.setCancelCheck === 'function') {
      discovery.setCancelCheck(() => this.pullSync.isCancelled());
    }
  }

  /**
   * Configure multiple optional components at once.
   * Preferred over individual setters - call once after construction
   * with all the components you need.
   */
  configure(config: Partial<SyncEngineConfig>): void {
    if (config.conflictAudit !== undefined) {
      this.conflictAudit = config.conflictAudit;
      this.pullSync.setMergeAudit(config.conflictAudit);
    }
    if (config.blockCache !== undefined) this.pullSync.setBlockCache(config.blockCache);
    if (config.blockIdentityStore !== undefined)
      this.pullSync.setBlockIdentityStore(config.blockIdentityStore);
  }

  /**
   * Register a callback for sync progress updates.
   */
  onProgress(cb: ProgressCallback): void {
    this.pullSync.onProgress(cb);
  }

  /**
   * Register a callback for fine-grained sync phase transitions.
   * The surface mirrors onProgress so consumers (SyncOrchestrator)
   * don't need to know which inner processor is running.
   */
  onPhase(cb: (phase: 'discovering' | 'applying' | 'finalizing' | 'idle') => void): void {
    this.pullSync.onPhase(cb);
  }

  /**
   * Register a callback fired as each entry lands during the apply phase.
   */
  onItem(cb: ItemCallback): void {
    this.pullSync.onItem(cb);
  }

  /**
   * Register a callback for per-item sync errors.
   */
  onError(cb: ErrorCallback): void {
    this.pullSync.onError(cb);
  }

  /**
   * Update settings reference (called when settings change).
   */
  updateSettings(settings: SyncConfig): void {
    this.settings = settings;
  }

  /**
   * Register page/database IDs for forced refresh on next sync.
   * Bypasses incremental skip logic for the given pages.
   */
  addForceRefreshIds(ids: string[]): void {
    this.pullSync.addForceRefreshIds(ids);
  }

  /**
   * Cancel a running sync. The sync loop will stop between items, and every
   * queued (not yet dispatched) Notion request is rejected immediately so a
   * deep rate-limiter queue doesn't keep the "cancelled" sync visibly running.
   *
   * ORDER MATTERS: set the pull cancel flag FIRST, then drain the queue - the
   * drain rejections then land in code paths that already early-return on
   * isCancelled(), instead of being reported as sync errors.
   */
  cancelSync(): void {
    this.pullSync.cancel();
    this.notionClient.cancelPending();
  }

  /**
   * Run the Notion -> Obsidian sync (three-way merge on conflicts).
   * Lite: sync is pull-only.
   */
  async sync(options?: { dryRun?: boolean }): Promise<SyncResult> {
    return this.pullSync.sync(this.settings, { ...options, mode: 'sync' });
  }

  /**
   * Pull from Notion -> Obsidian (Notion wins on conflicts, no merge).
   */
  async pull(options?: { dryRun?: boolean }): Promise<SyncResult> {
    return this.pullSync.sync(this.settings, { ...options, mode: 'pull' });
  }

  /**
   * Sync a single page by its Notion ID and vault path.
   * Used by the "Pull current file" command.
   * @param knownLastEdited - If provided, enables early-exit when sync record already matches this timestamp.
   * @param options.overwriteDirty - Opt OUT of the local-edit guard. Off by
   *   default, so a file with unsynced edits is never overwritten unless the
   *   caller explicitly asks. Only "Overwrite from Notion" asks.
   */
  async syncSinglePage(
    notionId: string,
    vaultPath: string,
    knownLastEdited?: string,
    options?: { overwriteDirty?: boolean },
  ): Promise<{ contentChanged: boolean; skipped?: boolean }> {
    return this.pullSync.syncSinglePage(
      notionId,
      vaultPath,
      this.settings,
      knownLastEdited,
      options,
    );
  }

  /**
   * Drive a single registry entry through the full conflict-detection
   * pipeline (no scoped full-pull, no discovery). Used by QA tests
   * and conflict-resolution tooling that need to exercise the merge
   * path deterministically.
   */
  async syncSingleEntry(
    entry: import('../discovery/page-registry').PageRegistryEntry,
    options?: { dryRun?: boolean; authoritative?: boolean },
  ): ReturnType<PullSyncProcessor['syncSingleEntry']> {
    return this.pullSync.syncSingleEntry(entry, this.settings, options);
  }
}
