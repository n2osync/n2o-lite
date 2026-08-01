/**
 * ApplyPhaseDeps - dependency contract for the pull-sync apply phase.
 *
 * Lives in its own file to break the cycle between pull-apply-phase.ts
 * (the orchestrator + re-exports) and sync-entry.ts / sync-page.ts /
 * sync-database.ts (the focused submodules). Pre-fix, those submodules
 * imported ApplyPhaseDeps as a type from pull-apply-phase.ts while
 * pull-apply-phase.ts re-exported their values, producing 3 madge
 * cycles centered on the re-export hub.
 *
 * Putting the type in a leaf file (no value imports) means every
 * apply-phase module now depends on apply-phase-deps -> no cycle.
 *
 * @module
 */

import type { NotionClient } from '../../infrastructure/notion/client';
import type { NotionBlock, NotionPage } from '../../domain/models/notion-api-types';
import type { NotionParser } from '../../infrastructure/notion/parser';
import type { ObsidianBuilder } from '../../infrastructure/obsidian/builder';
import type { VaultAdapter } from '../../infrastructure/obsidian/vault';
import type { SyncStateDB } from '../../infrastructure/storage/sync-state';
import type { ConflictAuditLog } from '../conflict/conflict-audit';
import type { PageBudget } from './page-budget';
import type { BlockCacheAccessor } from '../../infrastructure/storage/block-cache-store';
import type { BlockIdentityStore } from '../../infrastructure/storage/block-identity-store';
import type { PageRegistry } from '../discovery/page-registry';
import type { MediaHandler } from '../media/media-handler';
import type { ConflictManager } from '../conflict/conflict-manager';
import type { PropertyHelper } from '../discovery/property-helper';
import type { MediaDownloader } from '../media/media-downloader';
import type { SyncResultItem } from '../../domain/models/sync-result';

/** Dependencies needed by the apply-phase functions. */
export interface ApplyPhaseDeps {
  notionClient: NotionClient;
  parser: NotionParser;
  builder: ObsidianBuilder;
  vaultAdapter: VaultAdapter;
  syncState: SyncStateDB;
  mediaDownloader: MediaDownloader;
  mediaHandler: MediaHandler;
  conflictManager: ConflictManager;
  propertyHelper: PropertyHelper;
  // Optional deps
  conflictAudit: ConflictAuditLog | null;
  /**
   * The Lite page budget (#1918). Null disables the cap entirely, which is what
   * the unit fixtures use; production always supplies one.
   */
  pageBudget: PageBudget | null;
  blockCache: BlockCacheAccessor | null;
  /**
   * Persistent classification cache for `child_database` blocks.
   * Optional - when present, the sync-page pre-parse pass populates
   * the registry with resolved inline databases / linked views so
   * rendering has enough info to produce correct `.base` embeds.
   * When null, the renderer falls back to its stable id-prefix
   * placeholder (Phase 1).
   */
  blockIdentityStore: BlockIdentityStore | null;
  // State accessors
  currentRegistry: PageRegistry | null;
  currentWarnings: string[];
  forceRefreshIds: Set<string>;
  isCancelled: () => boolean;
  emitProgress: (message: string, current?: number, total?: number) => void;
  emitError: (title: string, error: string) => void;
  /**
   * Push a failure into the per-sync error accumulator that becomes
   * `SyncResult.errors[]` and, when non-empty, flips `success` to false.
   * For apply-phase callers (sync-page) that need a non-item failure
   * (e.g. linked-view resolver could not honor a Notion view's filter)
   * to surface in the user-visible result rather than only as a toast.
   * Distinct from `emitError` (UI callback only) to avoid double-pushing
   * when the caller already wrote to the threaded `errors[]` array.
   */
  appendError: (message: string) => void;
  /**
   * Optional per-item callback. The diff phase invokes this for every
   * SyncResultItem that lands during a parallel/sequential apply pass,
   * so a status surface can show files appearing live during a long
   * sync instead of only after it completes.
   */
  emitItem?: (item: SyncResultItem) => void;
  /**
   * Sync mode. 'pull' overwrites the local file with Notion's version (the
   * explicit "Overwrite from Notion" command); 'sync' never touches it and
   * writes Notion's version beside it as `<name>.conflict.md` (#1919).
   */
  mode: 'pull' | 'sync';
  /** Show a transient notification to the user. Decouples application layer from Obsidian's Notice. */
  notify(message: string, duration?: number): void;
  /**
   * In-memory block cache shared across one sync run (plan
   * smooth-jingling-sloth). Populated by discovery's `getAllBlockChildren`
   * walks; consumed by the apply phase's page fetches so block trees are
   * fetched once per sync instead of twice. Null when the orchestrator
   * isn't running progressive sync; cache misses fall through to the API.
   */
  discoveryBlockCache: Map<string, NotionBlock[]> | null;
  /**
   * In-memory page-metadata cache shared across one sync run (plan
   * smooth-jingling-sloth v2). Populated by PrefetchCoordinator. When
   * an apply-phase page fetch hits this map, the getPage round-trip
   * inside fetchPageWithBlocks is skipped entirely - replay reads
   * blocks AND metadata from cache. Null outside prefetch-replay mode.
   */
  discoveryPageCache: Map<string, NotionPage> | null;
}
