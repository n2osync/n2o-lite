/**
 * SyncStateDB - Manages sync state persistence via SQLite.
 * All lookups are O(1) via indexed columns. State is persisted to the
 * shared N2ODatabase with debounced disk writes.
 */

import type { SyncRecord, SyncItemStatus, FailedMediaItem } from '../../domain/models/sync-record';
import { coerceString } from '../../shared/coerce';
import { asDataSourceId } from '../../domain/models/notion-id';
import type { CoreDatabase } from './core-database';
import { N2OError, getErrorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/logger';

const log = createLogger('SyncState');

/**
 * F-030 - canonicalize a record so its id + notionId are in normalized
 * (no-dash) form. Every code path that writes a SyncRecord flows through
 * upsertRecord / upsertRecords, so doing this here makes the invariant
 * self-enforcing and prevents duplicate records with dashed vs non-dashed
 * variants of the same Notion page ID.
 *
 * Only UUID-shaped IDs (32 hex chars after dash-stripping) are normalized - * synthetic test IDs and legacy non-UUID identifiers pass through untouched.
 */
const NOTION_UUID_RE = /^[0-9a-f]{32}$/i;

function canonicalizeIfUuid(id: string): string {
  const stripped = id.replace(/-/g, '').toLowerCase();
  return NOTION_UUID_RE.test(stripped) ? stripped : id;
}

function canonicalizeRecord(r: SyncRecord): SyncRecord {
  const normalizedId = canonicalizeIfUuid(r.notionId);
  const normalizedParent = r.notionParentId
    ? canonicalizeIfUuid(r.notionParentId)
    : r.notionParentId;
  // If the caller built id as `n2o-<notionId>` using the dashed form and
  // notionId normalized to a UUID, align the id with the normalized form.
  // Otherwise leave id alone - callers that use arbitrary ids (legacy
  // codepaths, database-item aliases) keep whatever they passed.
  const expectedPrefix = 'n2o-';
  const canonicalId =
    r.id.startsWith(expectedPrefix) && normalizedId !== r.notionId
      ? expectedPrefix + normalizedId
      : r.id;
  return { ...r, id: canonicalId, notionId: normalizedId, notionParentId: normalizedParent };
}

export interface SyncState {
  version: number;
  lastSyncTime: string | null;
  records: Record<string, SyncRecord>;
}

export class SyncStateDB {
  constructor(
    private database: CoreDatabase,
    private workspaceId: string = 'default',
  ) {}

  /**
   * Memoized result of getAllRecords(). Cleared on every write so the
   * cache never returns rows that don't reflect the current DB state.
   * Avoids re-running SELECT * + JSON.parse(attachments_json) +
   * JSON.parse(failed_media_json) on every caller (the audit found 15+
   * sites calling this per sync cycle, each parsing every record's
   * attachment/failed-media blobs from scratch).
   */
  private allRecordsCache: SyncRecord[] | null = null;
  private invalidateAllRecordsCache(): void {
    this.allRecordsCache = null;
  }

  /**
   * Drop the in-memory all-records cache. Call this from any caller that
   * mutates `sync_records` outside the SyncStateDB API (raw SQL, bulk
   * deletes from DatabaseManager, factory reset, etc.). Without this,
   * `getAllRecords()` keeps returning stale rows that SQL has already
   * removed - which surfaces as resetN2O leaving a "ghost" record visible
   * to the dashboard until the next plugin reload.
   */
  invalidateCache(): void {
    this.invalidateAllRecordsCache();
  }

  /**
   * Clean up resources. No-op now that prepared statements are no longer cached.
   * Kept for API compatibility (called by engine shutdown).
   */
  close(): void {
    // No cached statements to free - all queries use db.exec() for concurrency safety
  }

  // ── CRUD ───────────────────────────────────────────────

  getRecord(id: string): SyncRecord | null {
    const db = this.database.getDb();
    const results = db.exec('SELECT * FROM sync_records WHERE id = ? AND workspace_id = ?', [
      id,
      this.workspaceId,
    ]);
    const first = results[0];
    if (!first || first.values.length === 0) return null;
    return this.resultToRecords(first)[0] ?? null;
  }

  getByNotionId(notionId: string): SyncRecord | null {
    const db = this.database.getDb();
    // F-030: normalize the query so callers that pass the dashed form
    // still hit records stored under the normalized key. Non-UUID inputs
    // pass through unchanged so synthetic/legacy identifiers still match.
    const normalized = canonicalizeIfUuid(notionId);
    const results = db.exec('SELECT * FROM sync_records WHERE notion_id = ? AND workspace_id = ?', [
      normalized,
      this.workspaceId,
    ]);
    const first = results[0];
    if (!first || first.values.length === 0) return null;
    return this.resultToRecords(first)[0] ?? null;
  }

  getByObsidianPath(path: string): SyncRecord | null {
    const db = this.database.getDb();
    const results = db.exec(
      'SELECT * FROM sync_records WHERE obsidian_path = ? AND workspace_id = ?',
      [path, this.workspaceId],
    );
    const first = results[0];
    if (!first || first.values.length === 0) return null;
    return this.resultToRecords(first)[0] ?? null;
  }

  /**
   * Return the database sync record for a folder path, or null.
   * Used by push sync to resolve the parent database for new items in a database folder.
   */
  getDatabaseByFolder(folderPath: string): SyncRecord | null {
    const db = this.database.getDb();
    const results = db.exec(
      'SELECT * FROM sync_records WHERE obsidian_path = ? AND item_type = ? AND workspace_id = ?',
      [folderPath, 'database', this.workspaceId],
    );
    const first = results[0];
    if (!first || first.values.length === 0) return null;
    return this.resultToRecords(first)[0] ?? null;
  }

  upsertRecord(record: SyncRecord): void {
    const canon = canonicalizeRecord(record);
    const db = this.database.getDb();
    /* Monotonic sequence: increment on every upsert. Preserves caller-
     * supplied value when they pass one (e.g. conflict-resolution paths
     * that want to bump explicitly); otherwise pulls the prior value
     * from DB and +1's it. First write of a record starts at 1. */
    let nextSequence = canon.localSequence;
    if (nextSequence === undefined) {
      // Read the prior sequence over the (workspace_id, notion_id) unique index,
      // NOT by id. INSERT OR REPLACE fires on that index, so a record whose id
      // changed (dashed vs normalized) but whose notion_id collides would miss a
      // by-id lookup and reset the monotonic counter to 1 (#1567).
      const priorResult = db.exec(
        'SELECT MAX(local_sequence) FROM sync_records WHERE notion_id = ? AND workspace_id = ?',
        [canon.notionId, this.workspaceId],
      );
      const priorRow = priorResult[0];
      const prior =
        priorRow && priorRow.values.length > 0 ? Number(priorRow.values[0]?.[0] ?? 0) : 0;
      nextSequence = prior + 1;
    }
    db.run(
      `INSERT OR REPLACE INTO sync_records (
        id, notion_id, obsidian_path, item_type, notion_parent_id,
        notion_last_edited, obsidian_last_modified, notion_content_hash,
        obsidian_content_hash, status, sync_direction, last_sync_time,
        last_error, attachments_json, failed_media_json, workspace_id,
        data_source_id, last_fetched_at, local_sequence, last_verified_at,
        renderer_version, notion_block_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        canon.id,
        canon.notionId,
        canon.obsidianPath,
        canon.itemType,
        canon.notionParentId ?? null,
        canon.notionLastEdited,
        canon.obsidianLastModified,
        canon.notionContentHash,
        canon.obsidianContentHash,
        canon.status,
        canon.syncDirection,
        canon.lastSyncTime,
        canon.lastError ?? null,
        JSON.stringify(canon.attachments ?? []),
        JSON.stringify(canon.failedMedia ?? []),
        this.workspaceId,
        canon.dataSourceId ?? null,
        canon.lastFetchedAt ?? null,
        nextSequence,
        canon.lastVerifiedAt ?? null,
        canon.rendererVersion ?? null,
        canon.notionBlockHash ?? null,
      ],
    );
    this.invalidateAllRecordsCache();
    this.database.markDirty();
  }

  /**
   * Upsert a record AND flush the SQLite binary to disk synchronously
   * before returning. Use this anywhere the caller has just written user-
   * visible content to the vault and needs the sync_records row that
   * tracks that content to be durable too.
   *
   * Without this, the default `upsertRecord` path schedules a 200ms
   * debounced flush. A crash inside that 200ms window leaves the vault
   * holding new content while the on-disk DB still records the old
   * content hash. On recovery the change detector then misclassifies the
   * pulled / merged / resolved content as an "obsidian-side edit" and
   * pushes it back to Notion, potentially clobbering newer Notion state.
   *
   * The remaining race is the small window between `vault.writeFile`
   * completing and this function being called. Eliminating that requires
   * a full write-ahead-journal (intent column + recovery replay) which is
   * tracked as a follow-up; this change shrinks the exposure from 200ms
   * to ~one flush latency (single-digit milliseconds for typical DBs).
   */
  async upsertRecordDurable(record: SyncRecord): Promise<void> {
    this.upsertRecord(record);
    await this.database.flushToDisk();
  }

  /**
   * F-030: delete a record by notion ID (dashed or normalized accepted).
   * Safer than deleteRecord(id) for callers who only know the notionId.
   */
  deleteByNotionId(notionId: string): boolean {
    const record = this.getByNotionId(notionId);
    if (!record) return false;
    this.deleteRecord(record.id);
    return true;
  }

  /**
   * F-030 migration: collapse rows that share the same normalized
   * notion_id but have different id strings (dashed vs non-dashed).
   * Keep the row with the latest lastSyncTime; delete the rest.
   * Returns the number of duplicate rows removed.
   */
  dedupeByNormalizedId(): number {
    const all = this.getAllRecords();
    const groups = new Map<string, SyncRecord[]>();
    for (const r of all) {
      const key = canonicalizeIfUuid(r.notionId);
      const bucket = groups.get(key);
      if (bucket) bucket.push(r);
      else groups.set(key, [r]);
    }
    let removed = 0;
    for (const bucket of groups.values()) {
      if (bucket.length <= 1) continue;
      bucket.sort((a, b) => (b.lastSyncTime ?? '').localeCompare(a.lastSyncTime ?? ''));
      const [winner, ...losers] = bucket;
      if (!winner) continue; // bucket.length > 1 guarantees this (NUIA)
      for (const loser of losers) {
        this.deleteRecord(loser.id);
        removed++;
      }
      // Re-upsert the winner through canonicalization so its id/notionId
      // land in normalized form even if they weren't already.
      this.upsertRecord(winner);
    }
    if (removed > 0) {
      log.info(
        `F-030 dedupe: collapsed ${removed} duplicate sync record(s) via normalized notion_id`,
      );
    }
    return removed;
  }

  /**
   * Update the obsidianPath for a record when a file is renamed/moved in Obsidian.
   * Returns true if a record was updated, false if no record found at oldPath.
   */
  updatePath(oldPath: string, newPath: string): boolean {
    const record = this.getByObsidianPath(oldPath);
    if (!record) return false;
    record.obsidianPath = newPath;
    this.upsertRecord(record);
    log.info(`Updated path: ${oldPath} -> ${newPath}`);
    return true;
  }

  /**
   * Update the obsidianPath for a record looked up by Notion ID.
   * Returns true if a record was updated, false if no record found.
   */
  updatePathByNotionId(notionId: string, newPath: string): boolean {
    const record = this.getByNotionId(notionId);
    if (!record) return false;
    const oldPath = record.obsidianPath;
    record.obsidianPath = newPath;
    this.upsertRecord(record);
    log.info(`Updated path by notionId: ${oldPath} -> ${newPath}`);
    return true;
  }

  deleteRecord(id: string): void {
    const db = this.database.getDb();
    db.run('DELETE FROM sync_records WHERE id = ? AND workspace_id = ?', [id, this.workspaceId]);
    this.invalidateAllRecordsCache();
    this.database.markDirty();
  }

  /**
   * Batch upsert multiple records in a single transaction.
   * Much faster than individual upsertRecord() calls for large syncs.
   */
  upsertRecords(records: SyncRecord[]): void {
    if (records.length === 0) return;
    const db = this.database.getDb();
    // Use SAVEPOINT instead of BEGIN TRANSACTION so this is safe even when
    // called from within an existing transaction (savepoints nest, transactions don't).
    db.run('SAVEPOINT upsert_records');
    try {
      for (const record of records) {
        const canon = canonicalizeRecord(record);
        /* Batch upsert keeps caller-supplied sequence; defaults to 1
         * (initial write) when absent. Batch callers are typically
         * discovery/reconciliation that don't care about sequence
         * arithmetic. */
        const nextSequence = canon.localSequence ?? 1;
        db.run(
          `INSERT OR REPLACE INTO sync_records (
            id, notion_id, obsidian_path, item_type, notion_parent_id,
            notion_last_edited, obsidian_last_modified, notion_content_hash,
            obsidian_content_hash, status, sync_direction, last_sync_time,
            last_error, attachments_json, failed_media_json, workspace_id,
            data_source_id, last_fetched_at, local_sequence, last_verified_at,
            renderer_version, notion_block_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            canon.id,
            canon.notionId,
            canon.obsidianPath,
            canon.itemType,
            canon.notionParentId ?? null,
            canon.notionLastEdited,
            canon.obsidianLastModified,
            canon.notionContentHash,
            canon.obsidianContentHash,
            canon.status,
            canon.syncDirection,
            canon.lastSyncTime,
            canon.lastError ?? null,
            JSON.stringify(canon.attachments ?? []),
            JSON.stringify(canon.failedMedia ?? []),
            this.workspaceId,
            canon.dataSourceId ?? null,
            canon.lastFetchedAt ?? null,
            nextSequence,
            canon.lastVerifiedAt ?? null,
            canon.rendererVersion ?? null,
            canon.notionBlockHash ?? null,
          ],
        );
      }
      db.run('RELEASE upsert_records');
    } catch (error) {
      try {
        db.run('ROLLBACK TO upsert_records');
        db.run('RELEASE upsert_records');
      } catch (rollbackErr) {
        log.error('Savepoint rollback failed after transaction error', rollbackErr);
      }
      throw error;
    }
    this.invalidateAllRecordsCache();
    this.database.markDirty();
    log.info(`Batch upserted ${records.length} sync records`);
  }

  // ── Queries ────────────────────────────────────────────

  getAllRecords(): SyncRecord[] {
    if (this.allRecordsCache !== null) return this.allRecordsCache;
    const db = this.database.getDb();
    const results = db.exec('SELECT * FROM sync_records WHERE workspace_id = ?', [
      this.workspaceId,
    ]);
    const allFirst = results[0];
    this.allRecordsCache = allFirst ? this.resultToRecords(allFirst) : [];
    return this.allRecordsCache;
  }

  /**
   * Return lightweight data for orphan detection.
   * Only fetches the columns needed to check if a record is orphaned - * avoids deserializing JSON blobs (attachments_json, failed_media_json).
   */
  getAllOrphanCheckData(): Array<{
    id: string;
    notionId: string;
    notionParentId: string | undefined;
    obsidianPath: string;
    status: string;
    itemType: string;
  }> {
    const db = this.database.getDb();
    const results = db.exec(
      'SELECT id, notion_id, notion_parent_id, obsidian_path, status, item_type FROM sync_records WHERE workspace_id = ?',
      [this.workspaceId],
    );
    const mapFirst = results[0];
    if (!mapFirst) return [];
    return mapFirst.values.map((row: unknown[]) => ({
      id: row[0] as string,
      notionId: row[1] as string,
      notionParentId: (row[2] as string) || undefined,
      obsidianPath: row[3] as string,
      status: row[4] as string,
      itemType: row[5] as string,
    }));
  }

  /**
   * Return lightweight data for registry building and vault inventory.
   * Fetches the columns needed for seeding registries and reconciliation - * avoids deserializing JSON blobs (attachments_json, failed_media_json).
   */
  getAllForRegistry(): Array<{
    notionId: string;
    obsidianPath: string;
    itemType: string;
    notionParentId: string | undefined;
    notionLastEdited: string;
    status: string;
  }> {
    const db = this.database.getDb();
    const results = db.exec(
      'SELECT notion_id, obsidian_path, item_type, notion_parent_id, notion_last_edited, status FROM sync_records WHERE workspace_id = ?',
      [this.workspaceId],
    );
    const first = results[0];
    if (!first) return [];
    return first.values.map((row: unknown[]) => ({
      notionId: row[0] as string,
      obsidianPath: row[1] as string,
      itemType: row[2] as string,
      notionParentId: (row[3] as string) || undefined,
      notionLastEdited: row[4] as string,
      status: row[5] as string,
    }));
  }

  /**
   * Return lightweight path mappings for wikilink resolution.
   * Only fetches (notionId, obsidianPath) - avoids loading full records with
   * JSON fields, hashes, and timestamps that wikilink resolution doesn't need.
   */
  getAllPathMappings(): Array<{ notionId: string; obsidianPath: string }> {
    const db = this.database.getDb();
    const results = db.exec(
      'SELECT notion_id, obsidian_path FROM sync_records WHERE workspace_id = ?',
      [this.workspaceId],
    );
    const first = results[0];
    if (!first) return [];
    return first.values.map((row: unknown[]) => ({
      notionId: row[0] as string,
      obsidianPath: row[1] as string,
    }));
  }

  getConflicts(): SyncRecord[] {
    return this.getByStatus('conflict');
  }

  getPendingChanges(): SyncRecord[] {
    const db = this.database.getDb();
    const results = db.exec(
      `SELECT * FROM sync_records WHERE workspace_id = ? AND status IN ('notion-ahead', 'obsidian-ahead')`,
      [this.workspaceId],
    );
    const first = results[0];
    if (!first) return [];
    return this.resultToRecords(first);
  }

  getErrors(): SyncRecord[] {
    return this.getByStatus('error');
  }

  // ── State Management ──────────────────────────────────

  getLastSyncTime(): string | null {
    const db = this.database.getDb();
    const key =
      this.workspaceId === 'default' ? 'last_sync_time' : `last_sync_time:${this.workspaceId}`;
    const result = db.exec(`SELECT value FROM n2o_meta WHERE key = ?`, [key]);
    const first = result[0];
    if (!first || first.values.length === 0) return null;
    return first.values[0]?.[0] as string;
  }

  setLastSyncTime(time: string): void {
    const db = this.database.getDb();
    const key =
      this.workspaceId === 'default' ? 'last_sync_time' : `last_sync_time:${this.workspaceId}`;
    db.run(`INSERT OR REPLACE INTO n2o_meta (key, value) VALUES (?, ?)`, [key, time]);
    this.database.markDirty();
  }

  /** Read an arbitrary key from the n2o_meta table. */
  getMeta(key: string): string | null {
    const db = this.database.getDb();
    const result = db.exec(`SELECT value FROM n2o_meta WHERE key = ?`, [key]);
    const first = result[0];
    if (!first || first.values.length === 0) return null;
    return first.values[0]?.[0] as string;
  }

  /** Write an arbitrary key/value pair to the n2o_meta table. */
  setMeta(key: string, value: string): void {
    const db = this.database.getDb();
    db.run(`INSERT OR REPLACE INTO n2o_meta (key, value) VALUES (?, ?)`, [key, value]);
    this.database.markDirty();
  }

  // ── Synced block locations (#1719) ────────────────────
  // Which page a synced-block ORIGINAL lives on, keyed by the synced block's
  // own id (the id a reference points at via `synced_from`). A cross-page
  // synced reference resolves its target page here. Recorded as pages render.

  /** Remember that synced-block original `blockId` lives on page `pageNotionId`. */
  recordSyncedBlockLocation(blockId: string, pageNotionId: string): void {
    // Canonicalize the key so a dashed block id and its no-dash form resolve to
    // the same row - the original's block.id and a reference's syncedFrom can
    // arrive in either form depending on the code path.
    const key = canonicalizeIfUuid(blockId);
    const db = this.database.getDb();
    db.run(
      `INSERT OR REPLACE INTO synced_block_locations (block_id, workspace_id, page_notion_id) VALUES (?, ?, ?)`,
      [key, this.workspaceId, canonicalizeIfUuid(pageNotionId)],
    );
    this.database.markDirty();
  }

  /** The Notion page id a synced-block original lives on, or null if not indexed yet. */
  getSyncedBlockPage(blockId: string): string | null {
    const key = canonicalizeIfUuid(blockId);
    const db = this.database.getDb();
    const result = db.exec(
      `SELECT page_notion_id FROM synced_block_locations WHERE block_id = ? AND workspace_id = ?`,
      [key, this.workspaceId],
    );
    const first = result[0];
    if (!first || first.values.length === 0) return null;
    return (first.values[0]?.[0] as string) ?? null;
  }

  /**
   * Distinct PAGES tracked in this workspace, for the Lite page budget (#1918).
   *
   * EVERY note counts, including database rows. A row in a Notion database is a
   * page in Notion's own model, and it becomes a note in the vault exactly like
   * a standalone page does, so exempting rows let one database carry a whole
   * workspace past the cap. 1.0.5 shipped with rows free; 1.0.6 counts them.
   *
   * Database and linked-view records are excluded because they are containers,
   * not notes - a database is a folder, and a linked view is registry
   * bookkeeping. Neither writes a note of its own.
   */
  getPageRecordCount(): number {
    const db = this.database.getDb();
    const result = db.exec(
      "SELECT count(DISTINCT notion_id) FROM sync_records WHERE workspace_id = ? AND item_type IN ('page','database-item')",
      [this.workspaceId],
    );
    const first = result[0];
    if (!first) return 0;
    return (first.values[0]?.[0] as number) ?? 0;
  }

  /**
   * What is actually synced, by kind, for the panel's scope card (#1978).
   *
   * The card used to show the tree-picker's idea of workspace REACH, which is
   * empty until the user opens the picker, so a whole-workspace sync reported
   * "0 pages, 0 databases" right after succeeding. One query, both numbers,
   * from the same place the "files" tile already describes: the vault.
   */
  getSyncedCounts(): { pages: number; databases: number } {
    const db = this.database.getDb();
    const result = db.exec(
      "SELECT item_type, count(DISTINCT notion_id) FROM sync_records WHERE workspace_id = ? AND item_type IN ('page','database') GROUP BY item_type",
      [this.workspaceId],
    );
    const counts = { pages: 0, databases: 0 };
    for (const row of result[0]?.values ?? []) {
      if (row[0] === 'page') counts.pages = row[1] as number;
      if (row[0] === 'database') counts.databases = row[1] as number;
    }
    return counts;
  }

  getRecordCount(): number {
    const db = this.database.getDb();
    const result = db.exec('SELECT count(*) FROM sync_records WHERE workspace_id = ?', [
      this.workspaceId,
    ]);
    const first = result[0];
    if (!first) return 0;
    return first.values[0]?.[0] as number;
  }

  /**
   * Invalidate all timestamps to force a full re-sync on next run.
   * Used when property mappings or filters change.
   */
  invalidateAllTimestamps(): number {
    const db = this.database.getDb();
    db.run(`UPDATE sync_records SET notion_last_edited = '' WHERE workspace_id = ?`, [
      this.workspaceId,
    ]);
    this.invalidateAllRecordsCache();
    this.database.markDirty();
    const count = this.getRecordCount();
    log.info(`Invalidated timestamps on ${count} records - next sync will re-fetch all`);
    return count;
  }

  /**
   * Reset all sync state. Use with caution.
   */
  reset(): void {
    const db = this.database.getDb();
    db.run('DELETE FROM sync_records WHERE workspace_id = ?', [this.workspaceId]);
    const key =
      this.workspaceId === 'default' ? 'last_sync_time' : `last_sync_time:${this.workspaceId}`;
    db.run(`DELETE FROM n2o_meta WHERE key = ?`, [key]);
    this.invalidateAllRecordsCache();
    this.database.markDirty();
    log.warn('Sync state reset');
  }

  /**
   * Export state for backup/debugging. Reconstructs the legacy JSON format.
   */
  exportState(): SyncState {
    const records: Record<string, SyncRecord> = {};
    for (const rec of this.getAllRecords()) {
      records[rec.id] = rec;
    }
    return {
      version: 1,
      lastSyncTime: this.getLastSyncTime(),
      records,
    };
  }

  /**
   * Import state from a previously exported JSON object.
   * Merges imported records into the current database (upsert).
   */
  /** Maximum import file size: 50 MB (sanity limit). */
  private static readonly MAX_IMPORT_RECORDS = 100_000;

  /**
   * Validate a single sync record's field types before import.
   * Throws on invalid data.
   */
  private validateImportRecord(_id: string, record: Record<string, unknown>): void {
    if (typeof record.notionId !== 'string' || record.notionId.length === 0) {
      throw new N2OError(`Missing or invalid notionId`, 'SYNC_STATE_CORRUPT');
    }
    if (typeof record.obsidianPath !== 'string') {
      throw new N2OError(`Missing or invalid obsidianPath`, 'SYNC_STATE_CORRUPT');
    }
    if (record.status && !SyncStateDB.VALID_STATUSES.has(record.status as string)) {
      throw new N2OError(`Invalid status: ${coerceString(record.status)}`, 'SYNC_STATE_CORRUPT');
    }
    if (record.lastSyncTime && typeof record.lastSyncTime !== 'string') {
      throw new N2OError(`Invalid lastSyncTime type`, 'SYNC_STATE_CORRUPT');
    }
  }

  importState(state: SyncState): { imported: number; skipped: number } {
    // Schema validation
    if (typeof state.version !== 'number' || state.version < 1) {
      throw new N2OError('Invalid state version', 'SYNC_STATE_CORRUPT');
    }
    if (
      typeof state.records !== 'object' ||
      state.records === null ||
      Array.isArray(state.records)
    ) {
      throw new N2OError('Invalid records field - expected an object', 'SYNC_STATE_CORRUPT');
    }
    const recordCount = Object.keys(state.records).length;
    if (recordCount > SyncStateDB.MAX_IMPORT_RECORDS) {
      throw new N2OError(
        `Too many records (${recordCount}). Max: ${SyncStateDB.MAX_IMPORT_RECORDS}`,
        'SYNC_STATE_CORRUPT',
      );
    }

    const db = this.database.getDb();
    let imported = 0;
    let skipped = 0;
    // SAVEPOINT (not BEGIN TRANSACTION) so this nests safely inside an outer
    // transaction - a nested BEGIN throws in SQLite (#1568).
    db.run('SAVEPOINT import_state');
    try {
      for (const [id, record] of Object.entries(state.records)) {
        try {
          this.validateImportRecord(id, record as unknown as Record<string, unknown>);
          const r = { ...record, id };
          // Inline upsertRecord SQL to avoid triggering markDirty() inside the transaction
          db.run(
            `INSERT OR REPLACE INTO sync_records (
              id, notion_id, obsidian_path, item_type, notion_parent_id,
              notion_last_edited, obsidian_last_modified, notion_content_hash,
              obsidian_content_hash, status, sync_direction, last_sync_time,
              last_error, attachments_json, failed_media_json, workspace_id,
              data_source_id, last_fetched_at, local_sequence, last_verified_at,
              renderer_version, notion_block_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              r.id,
              r.notionId,
              r.obsidianPath,
              r.itemType,
              r.notionParentId ?? null,
              r.notionLastEdited,
              r.obsidianLastModified,
              r.notionContentHash,
              r.obsidianContentHash,
              r.status,
              r.syncDirection,
              r.lastSyncTime,
              r.lastError ?? null,
              JSON.stringify(r.attachments ?? []),
              JSON.stringify(r.failedMedia ?? []),
              this.workspaceId,
              // These were dropped on import, so a restored/imported record
              // lost its data-source link (breaks database-item lookups),
              // fetch/verify timestamps, and ordering sequence. exportState
              // persists them, so import must restore them symmetrically.
              r.dataSourceId ?? null,
              r.lastFetchedAt ?? null,
              r.localSequence ?? 1,
              r.lastVerifiedAt ?? null,
              r.rendererVersion ?? null,
              r.notionBlockHash ?? null,
            ],
          );
          imported++;
        } catch (e) {
          const msg = getErrorMessage(e);
          // Fatal SQL errors (disk/DB corruption) should abort the transaction
          if (msg.includes('disk I/O') || msg.includes('malformed') || msg.includes('readonly')) {
            throw e;
          }
          log.warn(`Skipped record ${id}: ${msg}`);
          skipped++;
        }
      }
      if (state.lastSyncTime) {
        // Inline setLastSyncTime SQL to avoid triggering markDirty() inside the transaction
        const key =
          this.workspaceId === 'default' ? 'last_sync_time' : `last_sync_time:${this.workspaceId}`;
        db.run(`INSERT OR REPLACE INTO n2o_meta (key, value) VALUES (?, ?)`, [
          key,
          state.lastSyncTime,
        ]);
      }
      db.run('RELEASE import_state');
    } catch (error) {
      try {
        db.run('ROLLBACK TO import_state');
        db.run('RELEASE import_state');
      } catch (rollbackErr) {
        log.error('Savepoint rollback failed after import error', rollbackErr);
      }
      throw error;
    }
    // Signal dirty once after the transaction commits (not during)
    this.invalidateAllRecordsCache();
    this.database.markDirty();
    log.info(`Imported ${imported} records (${skipped} skipped)`);
    return { imported, skipped };
  }

  // ── Private helpers ────────────────────────────────────

  private getByStatus(status: SyncItemStatus): SyncRecord[] {
    const db = this.database.getDb();
    const results = db.exec('SELECT * FROM sync_records WHERE status = ? AND workspace_id = ?', [
      status,
      this.workspaceId,
    ]);
    const first = results[0];
    if (!first) return [];
    return this.resultToRecords(first);
  }

  private resultToRecords(result: { columns: string[]; values: unknown[][] }): SyncRecord[] {
    const { columns, values } = result;
    return values.map((row) => {
      const obj: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        obj[col] = row[i];
      });
      return this.rowToRecord(obj);
    });
  }

  private static readonly VALID_ITEM_TYPES = new Set(['page', 'database', 'database-item']);
  private static readonly VALID_STATUSES = new Set([
    'synced',
    'notion-ahead',
    'obsidian-ahead',
    'conflict',
    'new-notion',
    'new-obsidian',
    'deleted',
    'error',
  ]);
  private static readonly VALID_DIRECTIONS = new Set(['both', 'notion-only', 'obsidian-only']);

  private rowToRecord(row: Record<string, unknown>): SyncRecord {
    const itemType = row['item_type'] as string;
    const status = row['status'] as string;
    const syncDirection = row['sync_direction'] as string;

    return {
      id: row['id'] as string,
      notionId: row['notion_id'] as string,
      obsidianPath: row['obsidian_path'] as string,
      itemType: SyncStateDB.VALID_ITEM_TYPES.has(itemType)
        ? (itemType as SyncRecord['itemType'])
        : 'page',
      notionParentId: (row['notion_parent_id'] as string) || undefined,
      // Brand at the storage boundary: anything we previously persisted
      // through upsertRecord came in as a DataSourceId, so re-branding on
      // read preserves the type guarantee for downstream consumers.
      dataSourceId: row['data_source_id']
        ? asDataSourceId(row['data_source_id'] as string)
        : undefined,
      notionLastEdited: row['notion_last_edited'] as string,
      obsidianLastModified: row['obsidian_last_modified'] as number,
      notionContentHash: row['notion_content_hash'] as string,
      obsidianContentHash: row['obsidian_content_hash'] as string,
      notionBlockHash: (row['notion_block_hash'] as string) ?? undefined,
      status: SyncStateDB.VALID_STATUSES.has(status) ? (status as SyncRecord['status']) : 'error',
      syncDirection: SyncStateDB.VALID_DIRECTIONS.has(syncDirection)
        ? (syncDirection as SyncRecord['syncDirection'])
        : 'both',
      lastSyncTime: row['last_sync_time'] as string,
      lastError: (row['last_error'] as string) || undefined,
      attachments: this.safeJsonParse(row['attachments_json'] as string, []),
      failedMedia: this.normalizeFailedMedia(
        this.safeJsonParse(row['failed_media_json'] as string, []),
      ),
      lastFetchedAt: (row['last_fetched_at'] as string) || undefined,
      localSequence:
        typeof row['local_sequence'] === 'number'
          ? row['local_sequence']
          : Number(row['local_sequence'] ?? 0),
      lastVerifiedAt: (row['last_verified_at'] as string) || undefined,
      // NULL (pre-v11 rows) reads as undefined = "unknown renderer" - the
      // pull gate re-renders once and stamps the current fingerprint (#1628).
      rendererVersion: (row['renderer_version'] as string) || undefined,
    };
  }

  /**
   * Normalize failed media from DB. Old format stored plain string IDs;
   * new format stores FailedMediaItem objects. Convert on read, no migration needed.
   */
  private normalizeFailedMedia(raw: unknown[]): FailedMediaItem[] {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    if (typeof raw[0] === 'string') {
      return (raw as string[]).map((id) => ({
        id,
        mediaType: inferMediaTypeFromId(id),
        error: 'Unknown (previous sync)',
      }));
    }
    return raw as FailedMediaItem[];
  }

  /** Parse JSON with fallback - prevents corrupt DB rows from crashing the entire sync state. */
  private safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
    if (!json) return fallback;
    try {
      return JSON.parse(json) as T;
    } catch {
      log.warn(`Malformed JSON in sync record, using fallback: ${json.slice(0, 100)}`);
      return fallback;
    }
  }
}

/** Infer media type from a legacy failed-media ID string. */
function inferMediaTypeFromId(id: string): string {
  if (id.endsWith('-cover')) return 'cover';
  if (id.endsWith('-icon')) return 'icon';
  // File property IDs contain the property key: "abc123-files-0"
  if (/-[a-z]+-\d+$/.test(id)) return 'file-property';
  return 'image';
}
