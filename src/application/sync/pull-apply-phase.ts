/**
 * Pull sync Phase 3: Apply changes.
 *
 * Holds the applyChanges orchestrator and thin wrappers for orphan
 * detection/cleanup. The heavy lifting lives in three sibling modules:
 *   sync-entry.ts     - syncOneEntry (conflict routing, dispatcher)
 *   sync-page.ts      - syncPage, renderWithTemplate
 *   sync-database.ts  - syncDatabase, syncLinkedViewBase
 *
 * The shared ApplyPhaseDeps contract lives in apply-phase-deps.ts -
 * keeping the type in a leaf file breaks the import cycle that pre-fix
 * formed when the submodules imported the type from this hub while
 * this hub re-exported their values.
 *
 * @module
 */

import type { SyncConfig } from '../../domain/models/sync-config';
import type { SyncResultItem, SyncResultCounts } from './orchestrator';
import type { PageRegistry, PageRegistryEntry } from '../discovery/page-registry';
import type { ApplyPhaseDeps } from './apply-phase-deps';
import {
  detectOrphans as detectOrphansImpl,
  cleanOrphanedAttachments as cleanOrphanedAttachmentsImpl,
} from '../content/orphan-detector';
import { createLogger } from '../../shared/logger';

const log = createLogger('PullSync');

export type { ApplyPhaseDeps } from './apply-phase-deps';

/**
 * Phase 3: Apply changes - orphan detection, attachment cleanup, post-sync housekeeping.
 */
export async function applyChanges(
  registryEntries: PageRegistryEntry[],
  registry: PageRegistry,
  settings: SyncConfig,
  counts: SyncResultCounts,
  items: SyncResultItem[],
  errors: string[],
  deps: ApplyPhaseDeps,
  options: { dryRun?: boolean } | undefined,
  discoveryComplete: boolean,
): Promise<void> {
  // Orphan Detection - runs for both scopes. At scope='selected' the
  // detector narrows to records inside the user's selection envelope
  // (F-029). At scope='all' it covers everything.
  if (!discoveryComplete) {
    log.warn(`Orphan detection skipped - discovery incomplete (${errors.length} errors)`);
  } else {
    await detectOrphans(registryEntries, registry, settings, counts, items, deps, options);
  }

  // Orphaned Attachment Cleanup
  if (counts.orphaned > 0 && !options?.dryRun) {
    await cleanOrphanedAttachments(settings, deps);
  }

  // Clear force-refresh IDs after all entries processed
  deps.forceRefreshIds.clear();

  // Persist media manifests before clearing cache
  await deps.mediaDownloader.saveAllManifests();

  // Clear media download cache to free memory
  deps.mediaDownloader.clearCache();

  // Persist sync state (skip in dry run)
  if (!options?.dryRun) {
    deps.syncState.setLastSyncTime(new Date().toISOString());
  }
}

/** Detect orphaned pages - delegates to orphan-detector module. */
async function detectOrphans(
  registryEntries: PageRegistryEntry[],
  registry: PageRegistry,
  settings: SyncConfig,
  counts: SyncResultCounts,
  items: SyncResultItem[],
  deps: ApplyPhaseDeps,
  options?: { dryRun?: boolean },
): Promise<void> {
  return detectOrphansImpl(
    registryEntries,
    registry,
    settings,
    counts,
    items,
    deps.syncState,
    deps.vaultAdapter,
    options,
  );
}

/** Clean orphaned attachments - delegates to orphan-detector module. */
async function cleanOrphanedAttachments(settings: SyncConfig, deps: ApplyPhaseDeps): Promise<void> {
  return cleanOrphanedAttachmentsImpl(settings, deps.syncState, deps.vaultAdapter);
}
