/**
 * Reset manager - the "Reset N2O" flow: cancel any running sync, wipe the
 * active workspace's persisted state and caches, and return the profile to
 * a safe quiescent configuration.
 *
 * Extracted from main.ts to keep the plugin class a composition root;
 * main.ts keeps a one-line delegator (SettingsTabHost requires resetN2O
 * on the plugin).
 */

import type { WorkspaceProfile } from '../settings';
import type { SyncOrchestrator } from '../application/sync/orchestrator';
import type { DatabaseManager } from '../infrastructure/storage/database-manager';
import type { SyncStateDB } from '../infrastructure/storage/sync-state';
import type { BlockCacheStore } from '../infrastructure/storage/block-cache-store';

/** Grace period (ms) after cancelling sync before tearing down state. */
const SYNC_CANCEL_GRACE_MS = 500;

/** The slice of the plugin the reset flow needs. Getters returning
 *  `| undefined` mirror the optional chaining the original code used for
 *  components that may not be wired yet. */
export interface ResetHost {
  readonly profile: WorkspaceProfile;
  getOrchestrator(): SyncOrchestrator | undefined;
  getDatabaseManager(): DatabaseManager;
  getSyncState(): SyncStateDB | undefined;
  getBlockCacheStore(): BlockCacheStore | undefined;
  getActiveWorkspaceId(): string;
  saveSettings(): Promise<void>;
  refreshDashboards(): void;
}

/**
 * Reset N2O for the active profile: cancel sync, delete the workspace's
 * persisted data, clear caches, and reset the profile to a quiescent
 * state (audit F-005).
 */
export async function resetN2O(host: ResetHost): Promise<void> {
  // Cancel ongoing sync if running
  const orchestrator = host.getOrchestrator();
  if (orchestrator?.getStatus().state === 'syncing') {
    orchestrator.cancelSync();
    await new Promise((resolve) => window.setTimeout(resolve, SYNC_CANCEL_GRACE_MS));
  }

  // Wipe SQLite data + filesystem caches for the ACTIVE profile's workspace
  // (sync_records, retry_queue, block_identity, file_index,
  // property_schema_cache, accessible_pages, sync_history, item_history,
  // merge_audit, + files in block-cache/, page-versions/).
  // Derive the id rather than hardcode 'default': reset mutates the active
  // profile, so it must clear the same workspace that profile's rows live in.
  await host.getDatabaseManager().deleteWorkspaceData(host.getActiveWorkspaceId());

  // deleteWorkspaceData runs raw DELETE SQL against sync_records,
  // bypassing SyncStateDB's API - so its in-memory all-records cache
  // still holds the pre-reset rows. Drop it so getAllRecords() rereads
  // the (now empty) table on the next call instead of returning ghost
  // entries that the dashboard would surface as "still synced".
  host.getSyncState()?.invalidateCache();

  // Page cache (accessible pages)
  host.getDatabaseManager().coreDb.getPageCacheStore().clear();

  // Block cache in-memory LRU
  host.getBlockCacheStore()?.clear();

  // Reset to a safe, quiescent profile state: scope='selected' with an empty
  // selectedItems means any accidental pull has nothing to pull, where 'all'
  // would sweep the whole integration the next time a sync fires. (F-005)
  host.profile.selectedItems = [];
  host.profile.notionPages = [];
  host.profile.syncScope = 'selected';
  await host.saveSettings();

  // Refresh UI surfaces
  host.refreshDashboards();
}
