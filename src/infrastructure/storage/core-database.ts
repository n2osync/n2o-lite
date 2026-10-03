/**
 * CoreDatabase - SQLite lifecycle manager for the core sync state database.
 *
 * Manages `n2o-core.db` which contains the hot-path tables:
 * sync_records, retry_queue, property_schema_cache,
 * accessible_pages, and n2o_meta.
 *
 * Separated from history/content data so flush size stays ~2-3MB
 * regardless of how much content is cached.
 */

import { debounce } from 'obsidian';
import type { DataAdapter } from 'obsidian';
import initSqlJs, { type Database } from 'sql.js';
import { PageCacheStore } from './page-cache-store';
import { N2OError, getErrorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/logger';

const log = createLogger('CoreDatabase');

const SCHEMA_VERSION = 15;
const FLUSH_DEBOUNCE_MS = 200;
const MAX_BACKUPS = 3;

/**
 * Distinguish "ALTER TABLE ADD COLUMN failed because the column was
 * already added" from real errors. Migrations are idempotent on
 * re-run / fresh-installed schemas, so this specific case is safe
 * to swallow. Anything else (disk full, lock contention, schema
 * corruption) MUST propagate or we silently leave the DB in an
 * inconsistent state.
 *
 * sql.js surfaces SQLite's native error string verbatim. The relevant
 * one is "duplicate column name: <name>".
 *
 * Exported for unit tests that exercise the migration error-handling
 * contract without spinning up a real SQLite instance.
 */
export function isDuplicateColumnError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /duplicate column name/i.test(msg);
}

export class CoreDatabase {
  private db: Database | null = null;
  private dirty = false;
  private debouncedFlush: () => void;
  /** The write currently swapping files, or null. See flushToDisk. */
  private flushing: Promise<void> | null = null;
  /** The single follow-up write queued behind the in-flight one. */
  private queuedFlush: Promise<void> | null = null;
  private dbPath = '';
  private adapter!: DataAdapter;
  private pageCacheStore: PageCacheStore | null = null;

  /** True if corruption was detected and recovered on last open */
  public wasCorrupted = false;
  /** Details about the corruption if detected */
  public corruptionDetails = '';
  /** Number of sync records salvaged during partial recovery */
  public recoveredRecords = 0;

  constructor() {
    this.debouncedFlush = () => {};
  }

  /** Get the PageCacheStore instance (lazy init). */
  getPageCacheStore(): PageCacheStore {
    if (!this.pageCacheStore) {
      this.pageCacheStore = new PageCacheStore(this);
    }
    return this.pageCacheStore;
  }

  /**
   * Open or create the core database.
   */
  async open(
    adapter: DataAdapter,
    pluginDir: string,
    sql: Awaited<ReturnType<typeof initSqlJs>>,
  ): Promise<void> {
    this.adapter = adapter;
    this.dbPath = `${pluginDir}/n2o-core.db`;

    // If a previous atomic write was interrupted by a crash mid-swap, restore
    // the DB from its temp/backup before we try to open the live file (#1457).
    await this.recoverInterruptedWrite();

    this.debouncedFlush = debounce(
      () => {
        this.flushToDisk().catch((err) => {
          log.error('Debounced flush failed - data may not be persisted', err);
        });
      },
      FLUSH_DEBOUNCE_MS,
      true,
    );

    const exists = await adapter.exists(this.dbPath);
    if (exists) {
      try {
        const dbBinary = await adapter.readBinary(this.dbPath);
        this.db = new sql.Database(new Uint8Array(dbBinary));
        this.db.exec('SELECT count(*) FROM sqlite_master');
        this.db.exec('SELECT count(*) FROM sync_records');

        // Run quick_check regardless of size. It was skipped above 10MB, so a
        // power user with a large DB who hit a torn write loaded a subtly corrupt
        // DB with no recovery triggered (#1576). The DB is already in memory
        // (sql.js), so the check is milliseconds even for a large footprint.
        const integrityResult = this.db.exec('PRAGMA quick_check');
        const integrityFirst = integrityResult[0];
        if (integrityFirst) {
          const status = integrityFirst.values[0]?.[0] as string;
          if (status !== 'ok') {
            throw new N2OError(`PRAGMA quick_check: ${status}`, 'DATABASE_CORRUPT');
          }
        }
        log.info('Loaded existing core database (integrity OK)');
      } catch (error) {
        const errorMsg = getErrorMessage(error);
        log.error('Core database appears corrupt, attempting recovery', error);
        this.corruptionDetails = errorMsg;

        await this.backupCorruptFile();
        let salvaged: Record<string, Record<string, unknown>[]> = {};
        if (this.db) {
          salvaged = this.salvageRecords();
          this.db.close();
          this.db = null;
        }

        this.db = new sql.Database();
        this.createSchema();

        if (Object.keys(salvaged).length > 0) {
          try {
            this.recoveredRecords = this.reimportSalvagedRecords(salvaged);
            const summary = Object.entries(salvaged)
              .filter(([, rows]) => rows.length > 0)
              .map(([table, rows]) => `${table}:${rows.length}`)
              .join(', ');
            log.info(`Recovered from corrupt DB (${summary})`);
          } catch (reimportErr) {
            log.error('Failed to reimport salvaged records - starting fresh', reimportErr);
          }
        }

        this.dirty = true;
        this.wasCorrupted = true;
      }
    } else {
      this.db = new sql.Database();
      this.createSchema();
      this.dirty = true;
      log.info('Created new core database');
    }

    this.runMigrations();

    if (this.dirty) {
      await this.flushToDisk();
    }
  }

  /** Get the underlying sql.js Database instance. */
  getDb(): Database {
    if (!this.db) {
      throw new N2OError(
        'Core database not initialized. Call open() first.',
        'DATABASE_INIT_FAILED',
      );
    }
    return this.db;
  }

  /** Estimate database size in KB from SQLite page stats (lightweight, no export). */
  getSizeKB(): number {
    if (!this.db) return 0;
    try {
      const result = this.db.exec(
        'SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()',
      );
      const first = result[0];
      if (first && first.values.length > 0) {
        return Math.round(((first.values[0]?.[0] as number) ?? 0) / 1024);
      }
    } catch {
      /* ignore */
    }
    return 0;
  }

  /** Mark the database as dirty (has pending changes). Triggers debounced flush. */
  markDirty(): void {
    this.dirty = true;
    this.debouncedFlush();
  }

  /**
   * Immediately write the database to disk.
   *
   * Serialised, and it has to be. `atomicWriteBinary` is a four-step swap and
   * nothing guarded it, while `upsertRecordDurable` calls this for EVERY page
   * written and pages sync in parallel. Overlapping swaps renamed a `.tmp` a
   * previous one had already consumed ("Failed to write core database to
   * disk"), and worse, the live file does not exist between steps 2 and 3, so a
   * concurrent flush checking `exists(dbPath)` there skipped its own backup
   * rotation. The atomic write added for crash safety (#1457) had become a
   * concurrency hazard.
   *
   * Callers are also coalesced. The export is a snapshot of the whole database,
   * so one write that STARTS after a caller's change already covers it. A
   * hundred pages finishing at once therefore cost two writes, not a hundred.
   */
  async flushToDisk(): Promise<void> {
    if (!this.db) return;

    if (this.flushing) {
      // A write is already running and may have snapshotted before our change.
      // Join the single follow-up, which starts after it and so includes us.
      this.queuedFlush ??= this.flushing
        .catch(() => undefined)
        .then(() => {
          this.queuedFlush = null;
          return this.runFlush();
        });
      return this.queuedFlush;
    }
    return this.runFlush();
  }

  /** One swap, start to finish, with nothing else touching the files. */
  private runFlush(): Promise<void> {
    const run = (async () => {
      try {
        const db = this.db;
        if (!db) return;
        const data = db.export();
        await this.atomicWriteBinary(
          data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
        );
        this.dirty = false;
        log.debug('Core database flushed to disk');
      } catch (error) {
        log.error('Failed to write core database to disk', error);
        throw new N2OError('Failed to write core database to disk.', 'DATABASE_WRITE_ERROR', error);
      }
    })();
    // Clear the slot only if it is still OURS. A finishing write must never
    // clear a newer one's handle, or the next caller sees an idle slot and
    // starts a second concurrent swap - the exact race this method prevents.
    const handle: Promise<void> = run.finally(() => {
      if (this.flushing === handle) this.flushing = null;
    });
    this.flushing = handle;
    return run;
  }

  /**
   * Write the DB image atomically: full write to a temp file, then a rename
   * swap, so a crash can never leave a torn/truncated DB (#1457). The previous
   * file is rotated to `.bak` during the swap and dropped on success. Real
   * Obsidian DataAdapters support rename; a minimal test adapter that does not
   * falls back to a direct write.
   */
  private async atomicWriteBinary(data: ArrayBuffer): Promise<void> {
    if (typeof this.adapter.rename !== 'function') {
      await this.adapter.writeBinary(this.dbPath, data);
      return;
    }
    const tmp = `${this.dbPath}.tmp`;
    const bak = `${this.dbPath}.bak`;
    // 1. Full new image to a temp file. A crash here leaves the live DB intact.
    await this.adapter.writeBinary(tmp, data);
    // 2. Rotate the live file to .bak, then move the temp file into place. A
    //    crash between these two renames is recovered on the next open.
    if (await this.adapter.exists(this.dbPath)) {
      if (await this.adapter.exists(bak)) await this.adapter.remove(bak);
      await this.adapter.rename(this.dbPath, bak);
    }
    await this.adapter.rename(tmp, this.dbPath);
    // 3. Swap complete: drop the backup.
    if (await this.adapter.exists(bak)) await this.adapter.remove(bak);
  }

  /**
   * Restore a DB whose atomic swap was interrupted by a crash. If the live file
   * is present, just clear any stale temp. If it is missing, promote the
   * completed temp image, else the previous-good backup (#1457).
   */
  private async recoverInterruptedWrite(): Promise<void> {
    if (typeof this.adapter.rename !== 'function') return;
    const tmp = `${this.dbPath}.tmp`;
    const bak = `${this.dbPath}.bak`;
    if (await this.adapter.exists(this.dbPath)) {
      // Normal path: drop a stale temp left by a crash during the temp write.
      if (await this.adapter.exists(tmp)) await this.adapter.remove(tmp);
      return;
    }
    if (await this.adapter.exists(tmp)) {
      // A completed new image is the freshest good state.
      if (await this.adapter.exists(bak)) await this.adapter.remove(bak);
      await this.adapter.rename(tmp, this.dbPath);
      log.warn('Recovered core DB from an interrupted write (.tmp)');
    } else if (await this.adapter.exists(bak)) {
      await this.adapter.rename(bak, this.dbPath);
      log.warn('Recovered core DB from an interrupted write (.bak)');
    }
  }

  /** Close the database. Flushes pending changes immediately. */
  async close(): Promise<void> {
    if (!this.db) return;
    log.info('Closing core database...');
    if (this.dirty) {
      await this.flushToDisk();
    }
    this.db.close();
    this.db = null;
    log.info('Core database closed');
  }

  /**
   * Prune stale retry queue entries.
   * Intentionally prunes across all workspaces - this is a global housekeeping
   * operation. Workspace-scoped pruning is handled at the application layer via
   * RetryQueueStore when a workspace is removed.
   */
  pruneRetryQueue(keepDays = 7): number {
    const db = this.getDb();
    const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
    db.run(`DELETE FROM retry_queue WHERE created_at < ?`, [cutoff]);
    const changes = db.getRowsModified();
    if (changes > 0) {
      this.markDirty();
      log.info(`Pruned ${changes} stale retry queue entries (older than ${keepDays} days)`);
    }
    return changes;
  }

  // ── Schema ─────────────────────────────────────────────

  private createSchema(): void {
    if (!this.db) throw new N2OError('Database not initialized', 'DATABASE_INIT_FAILED');
    const db = this.db;

    db.run(`
      CREATE TABLE IF NOT EXISTS n2o_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS sync_records (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        notion_id TEXT NOT NULL,
        obsidian_path TEXT NOT NULL,
        item_type TEXT NOT NULL,
        notion_parent_id TEXT,
        notion_last_edited TEXT NOT NULL,
        obsidian_last_modified INTEGER NOT NULL,
        notion_content_hash TEXT NOT NULL,
        obsidian_content_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        sync_direction TEXT NOT NULL DEFAULT 'both',
        last_sync_time TEXT NOT NULL,
        last_error TEXT,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        failed_media_json TEXT NOT NULL DEFAULT '[]',
        data_source_id TEXT,
        last_fetched_at TEXT,
        local_sequence INTEGER NOT NULL DEFAULT 0,
        last_verified_at TEXT,
        renderer_version TEXT,
        notion_block_hash TEXT
      );
    `);
    // Uniqueness is per-workspace, not global. A single notion_id can exist
    // in multiple workspaces; the (workspace_id, notion_id) pair is the real
    // key. Pre-v8 the schema had a GLOBAL UNIQUE on notion_id which caused
    // a second workspace's INSERT OR REPLACE to clobber the first
    // workspace's row. The v7->v8 migration drops that bad index.
    db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_ws_notion ON sync_records(workspace_id, notion_id);`,
    );
    db.run(`CREATE INDEX IF NOT EXISTS idx_sync_obsidian_path ON sync_records(obsidian_path);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sync_status ON sync_records(status);`);
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_sync_ws_path ON sync_records(workspace_id, obsidian_path);`,
    );

    db.run(`
      CREATE TABLE IF NOT EXISTS retry_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        notion_id TEXT NOT NULL,
        obsidian_path TEXT NOT NULL,
        direction TEXT NOT NULL,
        error_message TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, notion_id, direction)
      );
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_retry_next ON retry_queue(next_retry_at);`);
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_rq_ws ON retry_queue(workspace_id, notion_id, direction);`,
    );

    db.run(`
      CREATE TABLE IF NOT EXISTS property_schema_cache (
        database_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        schema_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (database_id, workspace_id)
      );
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS accessible_pages (
        notion_id    TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        title        TEXT NOT NULL DEFAULT '',
        item_type    TEXT NOT NULL DEFAULT 'page',
        parent_type  TEXT DEFAULT NULL,
        parent_id    TEXT DEFAULT NULL,
        item_count   INTEGER DEFAULT NULL,
        last_edited  TEXT DEFAULT NULL,
        discovered_at TEXT NOT NULL
      );
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ap_parent ON accessible_pages(parent_id);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ap_type ON accessible_pages(item_type);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ap_ws ON accessible_pages(workspace_id, parent_id);`);

    // block_identity - persistent cache of child_database block classification.
    // Source of truth for rendering child_database blocks without re-probing
    // Notion API on every pull. TTL-based re-probe catches stale titles /
    // renamed databases on the Notion side.
    db.run(`
      CREATE TABLE IF NOT EXISTS block_identity (
        block_id          TEXT NOT NULL,
        workspace_id      TEXT NOT NULL DEFAULT 'default',
        kind              TEXT NOT NULL,
        database_id       TEXT,
        database_title    TEXT,
        view_type         TEXT,
        view_title        TEXT,
        parent_page_id    TEXT,
        parent_page_title TEXT,
        stable_name       TEXT NOT NULL,
        resolved_at       INTEGER NOT NULL,
        source            TEXT NOT NULL,
        PRIMARY KEY (block_id, workspace_id)
      );
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_bi_database ON block_identity(database_id);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_bi_kind ON block_identity(kind);`);

    // file_index - content-addressed index of all vault media files.
    // Powers F-025 dedup: when the media-downloader is about to write a
    // file whose SHA256 already exists somewhere in the vault, it skips
    // the write and reuses the existing path. Prevents push->writeback
    // from duplicating user-placed files into _files/.
    //
    // One row per vault path; hash is indexed for O(log n) reverse
    // lookup. Maintained incrementally by the vault file-watcher
    // (create/modify/rename/delete) and lazy-rebuilt from disk on
    // cold start when empty.
    db.run(`
      CREATE TABLE IF NOT EXISTS file_index (
        path TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        last_verified INTEGER NOT NULL,
        PRIMARY KEY (path, workspace_id)
      );
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_fi_hash ON file_index(hash, workspace_id);`);

    // synced_block_locations (#1719) - which PAGE a synced-block ORIGINAL lives
    // on, keyed by the synced block's own id (what a reference points at via
    // `synced_from`). A cross-page synced reference resolves its target page
    // here so it can render `![[OriginalPage#^blockId]]`. Recorded as each page
    // renders during a pull; self-healing across pulls.
    db.run(`
      CREATE TABLE IF NOT EXISTS synced_block_locations (
        block_id       TEXT NOT NULL,
        workspace_id   TEXT NOT NULL DEFAULT 'default',
        page_notion_id TEXT NOT NULL,
        PRIMARY KEY (block_id, workspace_id)
      );
    `);

    // media_alias (#1756) - maps the sha256 of an auto-optimized uploaded image
    // to the sha256 of the untouched vault original, so pull can reuse the
    // original instead of downloading the optimized copy as a duplicate.
    db.run(`
      CREATE TABLE IF NOT EXISTS media_alias (
        alias_hash    TEXT NOT NULL,
        workspace_id  TEXT NOT NULL DEFAULT 'default',
        original_hash TEXT NOT NULL,
        created       INTEGER NOT NULL,
        PRIMARY KEY (alias_hash, workspace_id)
      );
    `);

    // media_origin - remembers the external source URL of a localized image so
    // push can relink to the source instead of re-uploading the bytes.
    db.run(`
      CREATE TABLE IF NOT EXISTS media_origin (
        content_hash TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        source_url   TEXT NOT NULL,
        created      INTEGER NOT NULL,
        PRIMARY KEY (content_hash, workspace_id)
      );
    `);

    db.run(`INSERT OR REPLACE INTO n2o_meta (key, value) VALUES ('schema_version', ?);`, [
      String(SCHEMA_VERSION),
    ]);

    db.run('PRAGMA foreign_keys=ON;');
  }

  private runMigrations(): void {
    if (!this.db) throw new N2OError('Database not initialized', 'DATABASE_INIT_FAILED');
    const db = this.db;

    db.run(`
      CREATE TABLE IF NOT EXISTS n2o_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const result = db.exec(`SELECT value FROM n2o_meta WHERE key = 'schema_version'`);
    const versionFirst = result[0];
    const currentVersion = versionFirst
      ? parseInt((versionFirst.values[0]?.[0] as string) ?? '0', 10)
      : 0;

    if (currentVersion >= SCHEMA_VERSION) return;

    db.run('BEGIN EXCLUSIVE');
    try {
      // v1 -> v2: Add property_schema_cache table
      if (currentVersion < 2) {
        db.run(`
          CREATE TABLE IF NOT EXISTS property_schema_cache (
            database_id TEXT NOT NULL,
            workspace_id TEXT NOT NULL DEFAULT 'default',
            schema_json TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (database_id, workspace_id)
          );
        `);
      }

      // v2 -> v3: Add accessible_pages table for persistent page cache
      if (currentVersion < 3) {
        db.run(`
          CREATE TABLE IF NOT EXISTS accessible_pages (
            notion_id    TEXT PRIMARY KEY,
            title        TEXT NOT NULL DEFAULT '',
            item_type    TEXT NOT NULL DEFAULT 'page',
            parent_type  TEXT DEFAULT NULL,
            parent_id    TEXT DEFAULT NULL,
            item_count   INTEGER DEFAULT NULL,
            last_edited  TEXT DEFAULT NULL,
            discovered_at TEXT NOT NULL
          );
        `);
        db.run(`CREATE INDEX IF NOT EXISTS idx_ap_parent ON accessible_pages(parent_id);`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_ap_type ON accessible_pages(item_type);`);
      }

      // v3 -> v4: Add data_source_id column for canonical database ID resolution
      if (currentVersion < 4) {
        try {
          db.run(`ALTER TABLE sync_records ADD COLUMN data_source_id TEXT;`);
        } catch (e) {
          // Tolerate only "duplicate column name" (idempotent re-run on a
          // fresh-installed v4 schema). Real errors - disk full, lock
          // contention, schema corruption - must surface, not be swallowed.
          if (!isDuplicateColumnError(e)) throw e;
        }
      }

      // v4 -> v5: Add block_identity table for child_database classification cache.
      if (currentVersion < 5) {
        db.run(`
          CREATE TABLE IF NOT EXISTS block_identity (
            block_id          TEXT NOT NULL,
            workspace_id      TEXT NOT NULL DEFAULT 'default',
            kind              TEXT NOT NULL,
            database_id       TEXT,
            database_title    TEXT,
            view_type         TEXT,
            view_title        TEXT,
            parent_page_id    TEXT,
            parent_page_title TEXT,
            stable_name       TEXT NOT NULL,
            resolved_at       INTEGER NOT NULL,
            source            TEXT NOT NULL,
            PRIMARY KEY (block_id, workspace_id)
          );
        `);
        db.run(`CREATE INDEX IF NOT EXISTS idx_bi_database ON block_identity(database_id);`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_bi_kind ON block_identity(kind);`);
      }

      // v5 -> v6: Add file_index for content-hash dedup (F-025).
      if (currentVersion < 6) {
        db.run(`
          CREATE TABLE IF NOT EXISTS file_index (
            path TEXT NOT NULL,
            workspace_id TEXT NOT NULL DEFAULT 'default',
            hash TEXT NOT NULL,
            size INTEGER NOT NULL,
            mtime INTEGER NOT NULL,
            last_verified INTEGER NOT NULL,
            PRIMARY KEY (path, workspace_id)
          );
        `);
        db.run(`CREATE INDEX IF NOT EXISTS idx_fi_hash ON file_index(hash, workspace_id);`);
      }

      /* v6 -> v7: Additive columns for the 4-way truth table design
       * last_fetched_at: ISO timestamp of the most recent authoritative
       * fetch. Lets back-to-back manual syncs short-circuit if a fetch
       * just completed. local_sequence: monotonic per-page version
       * counter, incremented on every record write. Replaces
       * minute-granularity timestamp as internal version identity. */
      if (currentVersion < 7) {
        try {
          db.run(`ALTER TABLE sync_records ADD COLUMN last_fetched_at TEXT;`);
        } catch (e) {
          if (!isDuplicateColumnError(e)) throw e;
        }
        try {
          db.run(`ALTER TABLE sync_records ADD COLUMN local_sequence INTEGER NOT NULL DEFAULT 0;`);
        } catch (e) {
          if (!isDuplicateColumnError(e)) throw e;
        }
      }

      /* v7 -> v8: Replace the global UNIQUE(notion_id) with a composite
       * UNIQUE(workspace_id, notion_id). The previous constraint enforced
       * uniqueness across ALL workspaces, so a second workspace's
       * INSERT OR REPLACE for the same notion_id would clobber the first
       * workspace's row. Per-workspace isolation is the actual invariant
       * we need. The non-unique idx_sync_ws_notion index already existed
       * for query speed; we drop and recreate it as UNIQUE.
       *
       * Pre-existing data is safe under this migration: the old constraint
       * meant every notion_id was already unique globally, so collapsing
       * it to per-workspace uniqueness cannot introduce duplicates. Any
       * data already lost to past clobbers stays lost; we cannot recover
       * rows the old constraint silently destroyed. */
      if (currentVersion < 8) {
        // DROP INDEX IF EXISTS is already idempotent - it does NOT throw
        // on a missing index. The previous try/catch added nothing and
        // would have hidden real errors (e.g., lock contention).
        db.run(`DROP INDEX IF EXISTS idx_sync_notion_id;`);
        db.run(`DROP INDEX IF EXISTS idx_sync_ws_notion;`);
        db.run(`CREATE UNIQUE INDEX idx_sync_ws_notion ON sync_records(workspace_id, notion_id);`);
      }

      /* v8 -> v9: Additive column for the post-push readback verifier.
       * last_verified_at: ISO timestamp set when push-verifier confirms
       * the Notion state matches what we tried to push. Distinguishes
       * "synced 5 min ago" from "verified clean 5 min ago" - the
       * dashboard renders both so users see verification freshness,
       * not just sync recency. Nullable; legacy rows leave it as NULL
       * and the verifier sets it on next clean push. */
      if (currentVersion < 9) {
        try {
          db.run(`ALTER TABLE sync_records ADD COLUMN last_verified_at TEXT;`);
        } catch (e) {
          if (!isDuplicateColumnError(e)) throw e;
        }
      }

      /* v9 -> v10: partition accessible_pages by workspace (#1544). Every other
       * table already carries workspace_id; accessible_pages did not, so a
       * per-workspace discovery prune (removeMissing) and search ran across ALL
       * rows and would delete / surface another workspace's cached pages once a
       * second workspace exists. Additive column, defaults existing rows to the
       * only workspace that has ever run ('default'). */
      if (currentVersion < 10) {
        // Self-sufficient: a DB upgrading from >= v3 already has accessible_pages
        // (so this CREATE no-ops and the ALTER adds the column); a DB that never
        // created it gets the full current shape here. The ALTER then throws a
        // guarded duplicate-column error on the freshly-created table.
        db.run(`
          CREATE TABLE IF NOT EXISTS accessible_pages (
            notion_id    TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL DEFAULT 'default',
            title        TEXT NOT NULL DEFAULT '',
            item_type    TEXT NOT NULL DEFAULT 'page',
            parent_type  TEXT DEFAULT NULL,
            parent_id    TEXT DEFAULT NULL,
            item_count   INTEGER DEFAULT NULL,
            last_edited  TEXT DEFAULT NULL,
            discovered_at TEXT NOT NULL
          );
        `);
        try {
          db.run(
            `ALTER TABLE accessible_pages ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';`,
          );
        } catch (e) {
          if (!isDuplicateColumnError(e)) throw e;
        }
        db.run(
          `CREATE INDEX IF NOT EXISTS idx_ap_ws ON accessible_pages(workspace_id, parent_id);`,
        );
      }

      /* v10 -> v11: renderer fingerprint per note (#1628). Stores which build
       * of the parser/builder produced the note's markdown; the pull skip gate
       * re-renders on mismatch, so shipped renderer fixes reach already-synced
       * notes. Additive and nullable: existing rows read NULL = "unknown
       * renderer", which re-renders each note ONCE on the first sync after
       * this upgrade and stamps the current fingerprint. That one-time sweep
       * IS the migration path - no data is wiped. */
      if (currentVersion < 11) {
        try {
          db.run(`ALTER TABLE sync_records ADD COLUMN renderer_version TEXT;`);
        } catch (e) {
          if (!isDuplicateColumnError(e)) throw e;
        }
      }

      // v11 -> v12: synced_block_locations (#1719). Additive, no data touched.
      if (currentVersion < 12) {
        db.run(`
          CREATE TABLE IF NOT EXISTS synced_block_locations (
            block_id       TEXT NOT NULL,
            workspace_id   TEXT NOT NULL DEFAULT 'default',
            page_notion_id TEXT NOT NULL,
            PRIMARY KEY (block_id, workspace_id)
          );
        `);
      }

      /* v12 -> v13: notion_block_hash (#1746). A content signature of the Notion
       * block tree at last pull, used by the push conflict gate to tell a genuine
       * remote edit from a stale-baseline false positive. Nullable; legacy rows leave
       * it NULL and the gate falls through to the timestamp-only check (fail-safe),
       * so no false conflict is silenced until the next pull backfills the hash. */
      if (currentVersion < 13) {
        try {
          db.run(`ALTER TABLE sync_records ADD COLUMN notion_block_hash TEXT;`);
        } catch (e) {
          if (!isDuplicateColumnError(e)) throw e;
        }
      }

      /* v13 -> v14: media_alias + media_origin (#1756). Additive, no data
       * touched. media_alias maps the sha256 of an auto-optimized uploaded
       * image to the sha256 of the untouched vault original so pull can reuse
       * the original; media_origin remembers the external source URL of a
       * localized image so push can relink instead of re-uploading. */
      if (currentVersion < 14) {
        db.run(`
          CREATE TABLE IF NOT EXISTS media_alias (
            alias_hash    TEXT NOT NULL,
            workspace_id  TEXT NOT NULL DEFAULT 'default',
            original_hash TEXT NOT NULL,
            created       INTEGER NOT NULL,
            PRIMARY KEY (alias_hash, workspace_id)
          );
        `);
        db.run(`
          CREATE TABLE IF NOT EXISTS media_origin (
            content_hash TEXT NOT NULL,
            workspace_id TEXT NOT NULL DEFAULT 'default',
            source_url   TEXT NOT NULL,
            created      INTEGER NOT NULL,
            PRIMARY KEY (content_hash, workspace_id)
          );
        `);
      }

      /* v14 -> v15: drop base_version_index (#1919). It held the content hash of
       * each note's last-synced ancestor, read only by automatic three-way merge.
       * Lite no longer merges: on a page changed in both places the local file is
       * left alone and Notion's version is written beside it. The rows are derived
       * data, never user content, so dropping them loses nothing the plugin can
       * still use. The matching markdown files under data/{workspace}/base-versions/
       * are removed by DatabaseManager.removeBaseVersions on startup. */
      if (currentVersion < 15) {
        db.run(`DROP INDEX IF EXISTS idx_bvi_ws;`);
        db.run(`DROP TABLE IF EXISTS base_version_index;`);
      }

      db.run(`INSERT OR REPLACE INTO n2o_meta (key, value) VALUES ('schema_version', ?);`, [
        String(SCHEMA_VERSION),
      ]);
      db.run('COMMIT');
      this.dirty = true;
    } catch (err) {
      db.run('ROLLBACK');
      throw err;
    }
  }

  // ── Recovery ───────────────────────────────────────────

  private async backupCorruptFile(): Promise<void> {
    try {
      if (!(await this.adapter.exists(this.dbPath))) return;
      const corruptData = await this.adapter.readBinary(this.dbPath);
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dir = this.dbPath.substring(0, this.dbPath.lastIndexOf('/'));
      const backupPath = `${dir}/n2o-core.db.corrupt.${ts}`;
      await this.adapter.writeBinary(backupPath, corruptData);
      log.warn(`Corrupt core DB backed up to ${backupPath}`);

      await this.pruneOldBackups(dir);
    } catch (err) {
      log.error('Could not backup corrupt core database', err);
    }
  }

  private async pruneOldBackups(dir: string): Promise<void> {
    try {
      const files = await this.adapter.list(dir);
      const backups = files.files
        .filter((f: string) => f.includes('n2o-core.db.corrupt.'))
        .sort()
        .reverse();
      for (let i = MAX_BACKUPS; i < backups.length; i++) {
        const backup = backups[i];
        if (backup === undefined) continue;
        await this.adapter.remove(backup);
      }
    } catch (err) {
      log.warn('Could not prune old core DB backups', err);
    }
  }

  /**
   * Tables salvaged wholesale on corruption recovery. sync_records first so it
   * reimports ahead of the rest. Recovering n2o_meta.last_sync_time alongside it
   * is what avoids forcing a heavy full re-sync after a recovery (#1575);
   * pre-fix only sync_records survived and everything else was silently
   * recreated empty.
   */
  private static readonly SALVAGE_TABLES = [
    'sync_records',
    'retry_queue',
    'n2o_meta',
    'property_schema_cache',
    'accessible_pages',
    'block_identity',
    'file_index',
    'media_alias',
    'media_origin',
  ];

  /** Read every salvageable table out of the corrupt DB, keyed by table name.
   *  A corrupt page may make one table unreadable while others survive, so each
   *  read is independent. */
  private salvageRecords(): Record<string, Record<string, unknown>[]> {
    const salvaged: Record<string, Record<string, unknown>[]> = {};
    if (!this.db) return salvaged;
    for (const table of CoreDatabase.SALVAGE_TABLES) {
      try {
        const result = this.db.exec(`SELECT * FROM ${table}`);
        const first = result[0];
        if (!first) continue;
        const columns = first.columns;
        salvaged[table] = first.values.map((row) => {
          const record: Record<string, unknown> = {};
          for (let i = 0; i < columns.length; i++) {
            const col = columns[i];
            if (col === undefined) continue;
            record[col] = row[i];
          }
          return record;
        });
      } catch {
        log.warn(`Could not salvage ${table} from corrupt core DB`);
      }
    }
    return salvaged;
  }

  /** Reimport every salvaged table into the fresh schema. Returns the
   *  sync_records count (surfaced to the dashboard as "recovered N records").
   *  n2o_meta.schema_version is never reimported: createSchema already stamped
   *  the current version and an old value would confuse the migration runner. */
  private reimportSalvagedRecords(salvaged: Record<string, Record<string, unknown>[]>): number {
    if (!this.db) return 0;
    let syncRecordCount = 0;
    for (const table of CoreDatabase.SALVAGE_TABLES) {
      const rows = salvaged[table];
      if (!rows || rows.length === 0) continue;
      const exclude = table === 'n2o_meta' ? ['schema_version'] : [];
      const count = this.reimportTable(table, rows, exclude);
      if (table === 'sync_records') syncRecordCount = count;
    }
    return syncRecordCount;
  }

  /** Reimport one table's salvaged rows, restricted to columns the current
   *  schema still has (tolerates schema drift between the corrupt and fresh DB). */
  private reimportTable(
    table: string,
    rows: Record<string, unknown>[],
    excludeKeys: string[],
  ): number {
    if (!this.db) return 0;
    const pragmaResult = this.db.exec(`PRAGMA table_info(${table})`);
    const pragmaFirst = pragmaResult[0];
    if (!pragmaFirst) return 0;
    const schemaColumns = new Set(pragmaFirst.values.map((row: unknown[]) => row[1] as string));

    const firstRow = rows[0];
    if (!firstRow) return 0;
    const columns = Object.keys(firstRow).filter(
      (key) => schemaColumns.has(key) && !excludeKeys.includes(key),
    );
    if (columns.length === 0) return 0;

    const placeholders = columns.map(() => '?').join(', ');
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
    );
    let imported = 0;
    try {
      for (const row of rows) {
        try {
          stmt.run(columns.map((col) => row[col] ?? null));
          imported++;
        } catch {
          log.debug(`Skipped unrecoverable ${table} row`);
        }
      }
    } finally {
      stmt.free();
    }
    return imported;
  }
}
