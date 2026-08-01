/**
 * VaultInventory - Pre-sync vault scan and reconciliation.
 *
 * Runs before every sync to reconcile vault state against the sync DB:
 * - Detects files renamed/moved outside N2O -> fixes stale paths
 * - Detects files deleted while Obsidian was closed -> reports missing
 * - Detects local edits (hash mismatch) -> reports change (hash only updated after sync)
 * - Creates sync records for untracked files with notion_id frontmatter
 * - Detects duplicate notion_ids -> warns, keeps canonical file (sync record match or older)
 *
 * Performance: Uses MetadataCache for frontmatter (O(1) per file).
 * Only reads file content when mtime differs from stored value.
 */

import type { VaultAdapter } from '../../infrastructure/obsidian/vault';
import type { SyncStateDB } from '../../infrastructure/storage/sync-state';
import type {
  SyncRecord,
  SyncItemType,
  SyncRecordDirection,
} from '../../domain/models/sync-record';
import { hashContentForChange } from '../../shared/hash';
import { createLogger } from '../../shared/logger';
import { normalizeNotionId } from '../../domain/models/notion-id';

const log = createLogger('VaultInventory');

// ── Helpers ────────────────────────────────────────────────

function itemTypeFromFrontmatter(fm: Record<string, unknown>): SyncItemType {
  if (fm.n2o_type === 'database') return 'database';
  if (fm.n2o_type === 'database-item') return 'database-item';
  return 'page';
}

// ── Types ─────────────────────────────────────────────────

interface InventoryEntry {
  /** Normalized Notion ID (no dashes) */
  notionId: string;
  /** Vault-relative file path */
  path: string;
  /** File modification time (epoch ms) */
  mtime: number;
  /** File creation time (epoch ms) - immutable after creation, used for duplicate detection */
  ctime: number;
  /** Content hash - only computed when mtime changed from stored value */
  contentHash: string | null;
  /** Item type derived from frontmatter */
  itemType: SyncItemType;
  /** Parent database ID from frontmatter */
  parentDatabaseId: string | undefined;
  /** Notion last_edited_time from frontmatter 'updated' field */
  notionLastEdited: string;
}

interface ReconciliationAction {
  type:
    | 'path_updated'
    | 'hash_updated'
    | 'record_created'
    | 'file_missing'
    | 'duplicate_detected'
    | 'duplicate_auto_unlinked';
  notionId: string;
  detail: string;
}

export interface InventoryReport {
  filesScanned: number;
  trackedFiles: number;
  recordsReconciled: number;
  actions: ReconciliationAction[];
  /** Files auto-unlinked during duplicate detection - excluded from push in current cycle */
  unlinkedFiles: Array<{ path: string; notionId: string }>;
  duration: number;
}

export interface ScanResult {
  filesScanned: number;
  newRecordsCreated: number;
  alreadyTracked: number;
  duplicatesDetected: number;
  actions: ReconciliationAction[];
  duration: number;
}

export interface ReconcileOptions {
  /** Sync scope - 'all' or 'selected' */
  syncScope?: 'all' | 'selected';
  /** Allowed folder prefixes (for 'selected' scope with databases) */
  allowedPrefixes?: string[];
  /** Allowed standalone page IDs (for 'selected' scope) */
  allowedPageIds?: Set<string>;
}

// ── Class ─────────────────────────────────────────────────

export class VaultInventory {
  constructor(
    private vaultAdapter: VaultAdapter,
    private syncState: SyncStateDB,
  ) {}

  /**
   * Scan the vault and reconcile against sync state DB.
   * Should run before every sync cycle.
   */
  async reconcileVault(
    syncFolder: string,
    getSyncRecordDirection: () => SyncRecordDirection,
    emitProgress: (msg: string) => void,
    options?: ReconcileOptions,
  ): Promise<InventoryReport> {
    const start = Date.now();
    const actions: ReconciliationAction[] = [];

    // ── Step 1: Scan vault files ────────────────────────
    const files = this.vaultAdapter.getMarkdownFiles(syncFolder);

    // Sort by ctime ascending - oldest files first. This ensures the original
    // file (oldest ctime) is always the first entry in the Map, so duplicates
    // (newer ctime) are detected against it. ctime is immutable after creation,
    // unlike mtime which changes on every edit.
    files.sort((a, b) => a.stat.ctime - b.stat.ctime);

    const inventory = new Map<string, InventoryEntry>();
    const unlinkedFiles: Array<{ path: string; notionId: string }> = [];
    let filesScanned = 0;

    for (const file of files) {
      const fm = this.vaultAdapter.getFrontmatter(file.path);
      if (typeof fm?.notion_id !== 'string') continue;

      const notionId = normalizeNotionId(fm.notion_id);
      filesScanned++;

      // ── Scope filtering ─────────────────────────────
      if (options?.syncScope === 'selected') {
        const inAllowedFolder =
          options.allowedPrefixes?.some((p) => file.path.startsWith(p)) ?? false;
        const inAllowedPages = options.allowedPageIds?.has(notionId) ?? false;
        if (!inAllowedFolder && !inAllowedPages) continue;
      }

      // Determine item type from frontmatter
      const itemType: SyncItemType = itemTypeFromFrontmatter(fm);

      const parentDatabaseId =
        typeof fm.n2o_database === 'string' ? normalizeNotionId(fm.n2o_database) : undefined;

      const notionLastEdited =
        typeof fm.updated === 'string' ? new Date(fm.updated).toISOString() : '';

      const entry: InventoryEntry = {
        notionId,
        path: file.path,
        mtime: file.stat.mtime,
        ctime: file.stat.ctime,
        contentHash: null, // lazy - computed only when needed
        itemType,
        parentDatabaseId,
        notionLastEdited,
      };

      // ── Duplicate detection ─────────────────────────
      const existing = inventory.get(notionId);
      if (existing) {
        // Determine canonical file: prefer the one matching existing sync record
        const syncRecord = this.syncState.getByNotionId(notionId);
        const canonicalPath = syncRecord?.obsidianPath;

        let keepExisting: boolean;
        if (canonicalPath) {
          // Sync record exists - canonical is whichever matches the recorded path
          keepExisting = existing.path === canonicalPath;
        } else {
          // No sync record - keep older file by ctime (the original, not the copy).
          // ctime is immutable after creation, unlike mtime which changes on edit.
          keepExisting = existing.ctime <= file.stat.ctime;
        }

        const keptPath = keepExisting ? existing.path : file.path;
        const blockedPath = keepExisting ? file.path : existing.path;

        // Auto-strip N2O sync-identity keys from the duplicate copy.
        // Backfill n2o_parent_id from sync record for files synced before that field existed.
        const backfillParentId = syncRecord?.notionParentId;
        const backfillParentType =
          syncRecord?.itemType === 'database-item' ? ('database' as const) : ('page' as const);
        await this.vaultAdapter.unlinkFromNotion(
          blockedPath,
          backfillParentId,
          backfillParentId ? backfillParentType : undefined,
        );
        this.vaultAdapter.releaseSyncLock(blockedPath); // Don't hold the lock - later passes need to see this file
        unlinkedFiles.push({ path: blockedPath, notionId });

        actions.push({
          type: 'duplicate_auto_unlinked',
          notionId,
          detail: `Duplicate auto-unlinked: "${blockedPath}" (canonical: "${keptPath}")`,
        });
        log.warn(
          `Duplicate notion_id ${notionId}: auto-unlinked "${blockedPath}", keeping "${keptPath}"`,
        );

        if (!keepExisting) {
          inventory.set(notionId, entry);
        }
        continue;
      }

      inventory.set(notionId, entry);
    }

    const trackedFiles = inventory.size;

    // ── Step 2: Load all sync records ───────────────────
    // Uses full getAllRecords() here because reconciliation mutates records
    // (path updates, mtime updates) and upserts them back.
    const allRecords = this.syncState.getAllRecords();
    const pendingUpdates: SyncRecord[] = [];
    let recordsReconciled = 0;

    const orphanedDbRecordIds: string[] = [];

    // ── Step 3: Reconcile each record against inventory ─
    for (const record of allRecords) {
      // Skip deleted records
      if (record.status === 'deleted') continue;

      // Database folder records have no .md file - check folder existence instead
      if (record.itemType === 'database') {
        if (record.obsidianPath && !this.vaultAdapter.fileExists(record.obsidianPath)) {
          orphanedDbRecordIds.push(record.id);
          log.info(`Orphaned database record: "${record.obsidianPath}" - folder no longer exists`);
        }
        continue;
      }

      const inventoryEntry = inventory.get(record.notionId);

      if (!inventoryEntry) {
        // File missing from inventory - report but don't delete record
        // (orphan detection in Pass 3 handles deletion)
        actions.push({
          type: 'file_missing',
          notionId: record.notionId,
          detail: `Expected at "${record.obsidianPath}" - file not found in vault`,
        });
        continue;
      }

      let recordDirty = false;
      recordsReconciled++;

      // (a) Path mismatch -> update sync record path
      if (inventoryEntry.path !== record.obsidianPath) {
        log.info(
          `Path updated: "${record.obsidianPath}" \u2192 "${inventoryEntry.path}" (notion_id: ${record.notionId})`,
        );
        actions.push({
          type: 'path_updated',
          notionId: record.notionId,
          detail: `"${record.obsidianPath}" \u2192 "${inventoryEntry.path}"`,
        });
        record.obsidianPath = inventoryEntry.path;
        recordDirty = true;
      }

      // (b) mtime differs -> read file, check hash
      if (inventoryEntry.mtime !== record.obsidianLastModified) {
        const content = await this.vaultAdapter.readFile(inventoryEntry.path);
        if (content !== null) {
          const hash = hashContentForChange(content);
          inventoryEntry.contentHash = hash;

          if (hash !== record.obsidianContentHash) {
            actions.push({
              type: 'hash_updated',
              notionId: record.notionId,
              detail: `Content changed since last sync: ${record.obsidianContentHash} \u2192 ${hash}`,
            });
            // NOTE: Do NOT update record.obsidianContentHash here.
            // The stored hash represents "content at last sync time" and must only
            // be updated after a successful pull. Updating it here would cause
            // conflict detection to miss the change.
          }
        }
        // Always update mtime to avoid re-reading next cycle
        record.obsidianLastModified = inventoryEntry.mtime;
        recordDirty = true;
      }

      if (recordDirty) {
        pendingUpdates.push(record);
      }

      // Remove processed entry from inventory
      inventory.delete(record.notionId);
    }

    // ── Step 4: Remaining entries = files NOT in sync DB ─
    // Create new sync records for them (recovery + new file detection)
    for (const [notionId, entry] of inventory) {
      // Compute content hash if not already done
      if (entry.contentHash === null) {
        const content = await this.vaultAdapter.readFile(entry.path);
        entry.contentHash = content !== null ? hashContentForChange(content) : '';
      }

      const record: SyncRecord = {
        id: `n2o-${notionId}`,
        notionId,
        obsidianPath: entry.path,
        itemType: entry.itemType,
        notionParentId: entry.parentDatabaseId,
        notionLastEdited: entry.notionLastEdited,
        obsidianLastModified: entry.mtime,
        notionContentHash: '', // forces re-fetch from Notion
        obsidianContentHash: '', // empty - forces the file to read as changed on the first sync
        status: 'synced',
        syncDirection: getSyncRecordDirection(),
        lastSyncTime: new Date().toISOString(),
        attachments: [],
      };

      pendingUpdates.push(record);
      actions.push({
        type: 'record_created',
        notionId,
        detail: `New sync record for "${entry.path}"`,
      });

      log.info(`Created sync record for untracked file: "${entry.path}" (notion_id: ${notionId})`);
    }

    // ── Step 5: Batch upsert all changes ────────────────
    if (pendingUpdates.length > 0) {
      this.syncState.upsertRecords(pendingUpdates);
    }

    // ── Step 5b: Delete orphaned database records ──────
    for (const id of orphanedDbRecordIds) {
      this.syncState.deleteRecord(id);
      actions.push({
        type: 'file_missing',
        notionId: id.replace('n2o-', ''),
        detail: `Deleted orphaned database record - folder no longer exists`,
      });
    }

    const duration = Date.now() - start;

    if (actions.length > 0) {
      emitProgress(
        `Vault inventory: ${actions.length} reconciliation action${actions.length === 1 ? '' : 's'}`,
      );
    }

    log.info(
      `Vault inventory complete: ${filesScanned} scanned, ${trackedFiles} tracked, ${recordsReconciled} reconciled, ${actions.length} actions in ${duration}ms`,
    );

    return {
      filesScanned,
      trackedFiles,
      recordsReconciled,
      actions,
      unlinkedFiles,
      duration,
    };
  }

  /**
   * Lightweight vault scan - registers files with `notion_id` frontmatter
   * as sync records without any API calls or content overwriting.
   * Designed for post-deploy or new-user scenarios where the sync DB is
   * empty but vault files already exist.
   */
  async scanVault(
    syncFolder: string,
    getSyncRecordDirection: () => SyncRecordDirection,
  ): Promise<ScanResult> {
    const start = Date.now();
    const actions: ReconciliationAction[] = [];
    let alreadyTracked = 0;
    let duplicatesDetected = 0;

    // ── Step 1: Scan vault files for notion_id ──────────
    const files = this.vaultAdapter.getMarkdownFiles(syncFolder);

    // Sort by ctime ascending - oldest first for deterministic duplicate detection
    files.sort((a, b) => a.stat.ctime - b.stat.ctime);

    // Build in-memory set of tracked notion IDs for O(1) duplicate/already-tracked checks
    // Avoids per-item SQL queries against the sync state DB.
    const trackedNotionIds = new Set<string>(this.syncState.getAllRecords().map((r) => r.notionId));

    const inventory = new Map<string, InventoryEntry>();
    let filesScanned = 0;

    for (const file of files) {
      const fm = this.vaultAdapter.getFrontmatter(file.path);
      if (typeof fm?.notion_id !== 'string') continue;

      const notionId = normalizeNotionId(fm.notion_id);
      filesScanned++;

      // Determine item type from frontmatter
      const itemType: SyncItemType = itemTypeFromFrontmatter(fm);

      const parentDatabaseId =
        typeof fm.n2o_database === 'string' ? normalizeNotionId(fm.n2o_database) : undefined;

      const notionLastEdited =
        typeof fm.updated === 'string' ? new Date(fm.updated).toISOString() : '';

      const entry: InventoryEntry = {
        notionId,
        path: file.path,
        mtime: file.stat.mtime,
        ctime: file.stat.ctime,
        contentHash: null,
        itemType,
        parentDatabaseId,
        notionLastEdited,
      };

      // ── Duplicate detection ───────────────────────────
      const existing = inventory.get(notionId);
      if (existing) {
        duplicatesDetected++;
        const syncRecord = this.syncState.getByNotionId(notionId);
        const canonicalPath = syncRecord?.obsidianPath;

        let keepExisting: boolean;
        if (canonicalPath) {
          keepExisting = existing.path === canonicalPath;
        } else {
          // Keep older file by ctime (immutable after creation)
          keepExisting = existing.ctime <= file.stat.ctime;
        }

        const keptPath = keepExisting ? existing.path : file.path;
        const blockedPath = keepExisting ? file.path : existing.path;

        // Auto-strip N2O sync-identity keys from the duplicate copy.
        // Backfill n2o_parent_id from sync record for files synced before that field existed.
        const backfillParentId = syncRecord?.notionParentId;
        const backfillParentType =
          syncRecord?.itemType === 'database-item' ? ('database' as const) : ('page' as const);
        await this.vaultAdapter.unlinkFromNotion(
          blockedPath,
          backfillParentId,
          backfillParentId ? backfillParentType : undefined,
        );
        this.vaultAdapter.releaseSyncLock(blockedPath); // Don't hold the lock - later passes need to see this file

        actions.push({
          type: 'duplicate_auto_unlinked',
          notionId,
          detail: `Duplicate auto-unlinked: "${blockedPath}" (canonical: "${keptPath}")`,
        });

        if (!keepExisting) {
          inventory.set(notionId, entry);
        }
        continue;
      }

      inventory.set(notionId, entry);
    }

    // ── Step 2: Filter out already-tracked entries ──────
    const newRecords: SyncRecord[] = [];

    for (const [notionId, entry] of inventory) {
      if (trackedNotionIds.has(notionId)) {
        alreadyTracked++;
        continue;
      }

      const record: SyncRecord = {
        id: `n2o-${notionId}`,
        notionId,
        obsidianPath: entry.path,
        itemType: entry.itemType,
        notionParentId: entry.parentDatabaseId,
        notionLastEdited: entry.notionLastEdited,
        obsidianLastModified: entry.mtime,
        notionContentHash: '',
        obsidianContentHash: '', // empty - forces the file to read as changed on the first sync
        status: 'synced',
        syncDirection: getSyncRecordDirection(),
        lastSyncTime: new Date().toISOString(),
        attachments: [],
      };

      newRecords.push(record);
      actions.push({
        type: 'record_created',
        notionId,
        detail: `New sync record for "${entry.path}"`,
      });
    }

    // ── Step 2b: Infer database records from database-items ──
    // Databases have no .md file (only a folder + sync record), so they're
    // invisible to the scanner. Infer them from their children's parentDatabaseId.
    const inferredDatabases = new Map<string, { path: string; lastEdited: string }>();
    for (const entry of inventory.values()) {
      if (entry.itemType === 'database-item' && entry.parentDatabaseId) {
        if (!inferredDatabases.has(entry.parentDatabaseId)) {
          // Database folder = parent directory of the database-item file
          const parts = entry.path.split('/');
          parts.pop(); // remove filename
          const dbFolderPath = parts.join('/');
          inferredDatabases.set(entry.parentDatabaseId, {
            path: dbFolderPath,
            lastEdited: entry.notionLastEdited,
          });
        }
      }
    }

    for (const [dbId, info] of inferredDatabases) {
      // Skip if already in inventory (unlikely) or already tracked
      if (inventory.has(dbId)) continue;
      if (trackedNotionIds.has(dbId)) {
        alreadyTracked++;
        continue;
      }

      const record: SyncRecord = {
        id: `n2o-${dbId}`,
        notionId: dbId,
        obsidianPath: info.path,
        itemType: 'database',
        notionLastEdited: info.lastEdited,
        obsidianLastModified: Date.now(),
        notionContentHash: '',
        obsidianContentHash: '',
        status: 'synced',
        syncDirection: getSyncRecordDirection(),
        lastSyncTime: new Date().toISOString(),
        attachments: [],
      };

      newRecords.push(record);
      actions.push({
        type: 'record_created',
        notionId: dbId,
        detail: `Inferred database record for folder "${info.path}"`,
      });
    }

    // ── Step 3: Batch upsert ────────────────────────────
    if (newRecords.length > 0) {
      this.syncState.upsertRecords(newRecords);
    }

    const duration = Date.now() - start;

    log.info(
      `Vault scan complete: ${filesScanned} scanned, ${newRecords.length} new, ${alreadyTracked} already tracked, ${duplicatesDetected} duplicates in ${duration}ms`,
    );

    return {
      filesScanned,
      newRecordsCreated: newRecords.length,
      alreadyTracked,
      duplicatesDetected,
      actions,
      duration,
    };
  }
}
