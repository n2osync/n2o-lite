/**
 * VaultScanner - scans vault files for Notion IDs and auto-selects sync items.
 *
 * Extracted from main.ts to isolate vault scanning logic from the plugin class.
 */

import type { VaultAdapter } from '../../infrastructure/obsidian/vault';
import type { SyncStateDB } from '../../infrastructure/storage/sync-state';
import type { WorkspaceProfile } from '../../settings';
import { VaultInventory } from './vault-inventory';
import { getSyncRecordDirection } from '../sync/orchestrator';
import { createLogger } from '../../shared/logger';
import { normalizeNotionId } from '../../domain/models/notion-id';

const log = createLogger('VaultScanner');

/**
 * Host interface - the minimal contract the plugin provides to vault scanner functions.
 */
export interface VaultScannerHost {
  readonly dbInitFailed: boolean;
  readonly profile: WorkspaceProfile;
  getSyncState(): SyncStateDB;
  getVaultAdapter(): VaultAdapter;
  saveSettings(): Promise<void>;
  refreshDashboards(): void;
  /** Show a transient notification to the user. Decouples application layer from Obsidian's Notice. */
  notify(message: string, duration?: number): void;
}

/**
 * Scan the vault for files with notion_id frontmatter and register them.
 */
export async function scanVault(host: VaultScannerHost): Promise<void> {
  if (host.dbInitFailed) {
    host.notify(
      'N2O: Database failed to initialize. Restart Obsidian or reinstall the plugin.',
      10000,
    );
    return;
  }

  host.notify('N2O: Scanning vault...');

  const vi = new VaultInventory(host.getVaultAdapter(), host.getSyncState());
  const result = await vi.scanVault(host.profile.syncFolder, () => getSyncRecordDirection());

  // Clean stale records - delete sync records whose files/folders no longer exist in vault.
  // fileExists() uses getAbstractFileByPath which works for both .md files and database folders.
  const allRecords = host.getSyncState().getAllRecords();
  const vault = host.getVaultAdapter();
  let staleDeleted = 0;
  for (const record of allRecords) {
    if (!vault.fileExists(record.obsidianPath)) {
      host.getSyncState().deleteRecord(record.id);
      staleDeleted++;
    }
  }
  if (staleDeleted > 0) {
    log.info(`Cleaned ${staleDeleted} stale sync records (files no longer in vault)`);
    host.notify(
      `N2O: Removed ${staleDeleted} stale record${staleDeleted > 1 ? 's' : ''} for deleted files.`,
      5000,
    );
  }

  // Notify about auto-unlinked duplicates
  const autoUnlinked = result.actions.filter((a) => a.type === 'duplicate_auto_unlinked');
  if (autoUnlinked.length > 0) {
    host.notify(
      `N2O: ${autoUnlinked.length} duplicate file${autoUnlinked.length > 1 ? 's' : ''} auto-unlinked. They stay in your vault and are no longer tied to a Notion page.`,
      8000,
    );
  }

  if (result.newRecordsCreated > 0) {
    host.notify(
      `N2O: Scan complete - ${result.newRecordsCreated} file${result.newRecordsCreated > 1 ? 's' : ''} registered` +
        (result.alreadyTracked > 0 ? `, ${result.alreadyTracked} already tracked` : ''),
      8000,
    );
  } else if (result.alreadyTracked > 0) {
    host.notify(`N2O: All ${result.alreadyTracked} files already tracked.`, 5000);
  } else {
    host.notify('N2O: No files with notion_id found in sync folder.', 5000);
  }

  await autoSelectSyncRecords(host);
  host.refreshDashboards();
}

/**
 * Run vault scan and return the set of notion_ids found in the vault.
 * Used as a callback for the tree picker's "Scan Vault" button.
 */
export async function scanVaultIds(host: VaultScannerHost): Promise<Set<string>> {
  const vi = new VaultInventory(host.getVaultAdapter(), host.getSyncState());
  await vi.scanVault(host.profile.syncFolder, () => getSyncRecordDirection());

  // Note: do NOT call autoSelectSyncRecords here - this function is used by the
  // tree picker which only needs IDs for visual matching. Mutating profile.selectedItems
  // as a side effect would corrupt user selections if they cancel the picker.

  const records = host.getSyncState().getAllRecords();
  // Include both notionId (block UUID) and dataSourceId (canonical) so tree picker can match either
  const ids = new Set<string>();
  for (const r of records) {
    ids.add(r.notionId);
    if (r.dataSourceId) ids.add(r.dataSourceId);
  }
  return ids;
}

/** Alias for backward compatibility within this module. */
const normalizeId = normalizeNotionId;

/**
 * Read all sync records from DB and merge into settings.selectedItems.
 * Switches syncScope to 'selected' so the next sync uses tree-picker selections.
 */
export async function autoSelectSyncRecords(host: VaultScannerHost): Promise<void> {
  const records = host.getSyncState().getAllRecords();
  if (records.length === 0) return;

  const profile = host.profile;

  // Normalize all existing IDs to dashless for consistent comparison
  const existingIds = new Set(profile.selectedItems.map((i) => normalizeId(i.id)));

  // Collect all database IDs (existing + from records) to skip their children
  const selectedDbIds = new Set(
    profile.selectedItems.filter((i) => i.type === 'database').map((i) => normalizeId(i.id)),
  );
  for (const record of records) {
    if (record.itemType === 'database') selectedDbIds.add(normalizeId(record.notionId));
  }

  // Build itemCount map from database-item records (keyed by normalized ID)
  const itemCountMap: Record<string, number> = {};
  for (const record of records) {
    if (record.itemType === 'database-item' && record.notionParentId) {
      const parentId = normalizeId(record.notionParentId);
      itemCountMap[parentId] = (itemCountMap[parentId] ?? 0) + 1;
    }
  }

  let added = 0;

  for (const record of records) {
    const normId = normalizeId(record.notionId);
    if (existingIds.has(normId)) continue;

    // Skip database records - users select databases via the tree picker.
    // Auto-adding them here causes duplicates because sync records use block UUIDs
    // while the tree picker uses data_source IDs (different IDs for the same database).
    if (record.itemType === 'database') continue;

    // Skip database-item records when their parent database is selected
    if (
      record.itemType === 'database-item' &&
      record.notionParentId &&
      selectedDbIds.has(normalizeId(record.notionParentId))
    ) {
      continue;
    }

    // Derive title from obsidianPath: strip folder prefix + .md extension
    const fileName = record.obsidianPath.split('/').pop()?.replace(/\.md$/, '') ?? 'Untitled';

    profile.selectedItems.push({
      id: normId,
      title: fileName,
      type: 'page',
    });
    existingIds.add(normId);
    added++;
  }

  // Update itemCount for existing database entries
  for (const item of profile.selectedItems) {
    if (item.type === 'database') {
      const normId = normalizeId(item.id);
      if (itemCountMap[normId] !== undefined) {
        item.itemCount = itemCountMap[normId];
      }
    }
  }

  // Deduplicate selectedItems by normalized ID (keep first occurrence)
  const seen = new Set<string>();
  const beforeCount = profile.selectedItems.length;
  const deduped = profile.selectedItems.filter((item) => {
    const normId = normalizeId(item.id);
    if (seen.has(normId)) return false;
    seen.add(normId);
    return true;
  });

  const removedDupes = beforeCount - deduped.length;
  if (removedDupes > 0) {
    log.warn(`Removed ${removedDupes} duplicate selected items`);
    profile.selectedItems.length = 0;
    profile.selectedItems.push(...deduped);
  }

  if (added > 0 || removedDupes > 0) {
    profile.syncScope = 'selected';
    await host.saveSettings();
    log.info(`Auto-selected ${added} items from sync records`);
  }
}
