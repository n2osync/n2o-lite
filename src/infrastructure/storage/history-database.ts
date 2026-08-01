/**
 * HistoryDatabase - SQLite lifecycle manager for the history/diagnostic database.
 *
 * Manages `n2o-history.db` which contains diagnostic and audit tables:
 * sync_history, item_history, merge_audit, and error_log.
 *
 * Uses a longer debounce (15s) since this data is diagnostic, not critical path.
 */

import { debounce } from 'obsidian';
import type { DataAdapter } from 'obsidian';
import type initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import { N2OError } from '../../shared/errors';
import { createLogger } from '../../shared/logger';

const log = createLogger('HistoryDatabase');

const SCHEMA_VERSION = 4;
const FLUSH_DEBOUNCE_MS = 15000;

export class HistoryDatabase {
  private db: Database | null = null;
  private dirty = false;
  private debouncedFlush: () => void;
  /** The write currently swapping files, or null. See flushToDisk. */
  private flushing: Promise<void> | null = null;
  /** The single follow-up write queued behind the in-flight one. */
  private queuedFlush: Promise<void> | null = null;
  private dbPath = '';
  private adapter!: DataAdapter;

  constructor() {
    this.debouncedFlush = () => {};
  }

  /**
   * Open or create the history database.
   */
  async open(
    adapter: DataAdapter,
    pluginDir: string,
    sql: Awaited<ReturnType<typeof initSqlJs>>,
  ): Promise<void> {
    this.adapter = adapter;
    this.dbPath = `${pluginDir}/n2o-history.db`;

    // Recover from a write interrupted mid-swap before opening the live file (#1457).
    await this.recoverInterruptedWrite();

    this.debouncedFlush = debounce(
      () => {
        this.flushToDisk().catch((err) => {
          log.error('Debounced flush failed - history data may not be persisted', err);
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
        log.info('Loaded existing history database');
      } catch (error) {
        log.error('History database corrupt - creating fresh', error);
        if (this.db) {
          this.db.close();
          this.db = null;
        }
        // Backup corrupt file before recreating
        try {
          const backupPath = this.dbPath.replace('.db', `.corrupt-${Date.now()}.db`);
          const corruptData = await adapter.readBinary(this.dbPath);
          await adapter.writeBinary(backupPath, corruptData);
          log.info(`Backed up corrupt history DB to ${backupPath}`);
          // Keep only the newest few backups so repeated corruption events do
          // not leave .corrupt-*.db files accumulating in the plugin dir (#1585).
          await this.pruneCorruptBackups(adapter);
        } catch {
          /* best-effort backup */
        }
        this.db = new sql.Database();
        this.createSchema();
        this.dirty = true;
      }
    } else {
      this.db = new sql.Database();
      this.createSchema();
      this.dirty = true;
      log.info('Created new history database');
    }

    this.runMigrations();
    this.pruneOldData();

    if (this.dirty) {
      await this.flushToDisk();
    }
  }

  /** Max `.corrupt-*.db` backups to retain; older ones are pruned (#1585). */
  private static readonly MAX_CORRUPT_BACKUPS = 3;

  /**
   * Remove all but the newest MAX_CORRUPT_BACKUPS corrupt-history backups so
   * repeated corruption events do not leak files. Best-effort - a listing or
   * remove failure is logged and swallowed, never fatal to open().
   */
  private async pruneCorruptBackups(adapter: DataAdapter): Promise<void> {
    try {
      const slash = this.dbPath.lastIndexOf('/');
      const dir = slash >= 0 ? this.dbPath.slice(0, slash) : '';
      const prefix = `${(slash >= 0 ? this.dbPath.slice(slash + 1) : this.dbPath).replace('.db', '')}.corrupt-`;
      const listing = await adapter.list(dir || '/');
      // Timestamp suffixes are fixed-width epoch ms, so lexical sort is chronological.
      const backups = listing.files
        .filter((f) => {
          const name = f.slice(f.lastIndexOf('/') + 1);
          return name.startsWith(prefix) && name.endsWith('.db');
        })
        .sort();
      const stale = backups.slice(
        0,
        Math.max(0, backups.length - HistoryDatabase.MAX_CORRUPT_BACKUPS),
      );
      for (const f of stale) {
        try {
          await adapter.remove(f);
        } catch {
          /* best-effort */
        }
      }
      if (stale.length > 0) log.info(`Pruned ${stale.length} old corrupt history backup(s)`);
    } catch {
      /* listing is not critical */
    }
  }

  /** Get the underlying sql.js Database instance. */
  getDb(): Database {
    if (!this.db) {
      throw new N2OError(
        'History database not initialized. Call open() first.',
        'DATABASE_INIT_FAILED',
      );
    }
    return this.db;
  }

  /** Mark the database as dirty. Triggers debounced flush (15s). */
  markDirty(): void {
    this.dirty = true;
    this.debouncedFlush();
  }

  /**
   * Immediately write the database to disk.
   *
   * Serialised and coalesced, for the same reason as CoreDatabase: the atomic
   * swap is four steps over three paths and overlapping callers rename a `.tmp`
   * a previous swap already consumed. This one swallows its error rather than
   * throwing, so the symptom here would have been silently lost history rather
   * than a visible failure.
   */
  async flushToDisk(): Promise<void> {
    if (!this.db) return;

    if (this.flushing) {
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
        log.debug('History database flushed to disk');
      } catch (error) {
        log.error('Failed to write history database to disk', error);
      }
    })();
    // Clear the slot only if it is still ours - see CoreDatabase.runFlush.
    const handle: Promise<void> = run.finally(() => {
      if (this.flushing === handle) this.flushing = null;
    });
    this.flushing = handle;
    return run;
  }

  /**
   * Atomic DB write: temp file then rename swap so a crash cannot leave a torn
   * image (#1457). Falls back to a direct write on adapters without rename.
   */
  private async atomicWriteBinary(data: ArrayBuffer): Promise<void> {
    if (typeof this.adapter.rename !== 'function') {
      await this.adapter.writeBinary(this.dbPath, data);
      return;
    }
    const tmp = `${this.dbPath}.tmp`;
    const bak = `${this.dbPath}.bak`;
    await this.adapter.writeBinary(tmp, data);
    if (await this.adapter.exists(this.dbPath)) {
      if (await this.adapter.exists(bak)) await this.adapter.remove(bak);
      await this.adapter.rename(this.dbPath, bak);
    }
    await this.adapter.rename(tmp, this.dbPath);
    if (await this.adapter.exists(bak)) await this.adapter.remove(bak);
  }

  /** Restore a DB whose atomic swap was interrupted by a crash (#1457). */
  private async recoverInterruptedWrite(): Promise<void> {
    if (typeof this.adapter.rename !== 'function') return;
    const tmp = `${this.dbPath}.tmp`;
    const bak = `${this.dbPath}.bak`;
    if (await this.adapter.exists(this.dbPath)) {
      if (await this.adapter.exists(tmp)) await this.adapter.remove(tmp);
      return;
    }
    if (await this.adapter.exists(tmp)) {
      if (await this.adapter.exists(bak)) await this.adapter.remove(bak);
      await this.adapter.rename(tmp, this.dbPath);
      log.warn('Recovered history DB from an interrupted write (.tmp)');
    } else if (await this.adapter.exists(bak)) {
      await this.adapter.rename(bak, this.dbPath);
      log.warn('Recovered history DB from an interrupted write (.bak)');
    }
  }

  /** Close the database. Flushes pending changes immediately. */
  async close(): Promise<void> {
    if (!this.db) return;
    log.info('Closing history database...');
    if (this.dirty) {
      await this.flushToDisk();
    }
    this.db.close();
    this.db = null;
    log.info('History database closed');
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
      CREATE TABLE IF NOT EXISTS sync_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        timestamp TEXT NOT NULL,
        duration INTEGER NOT NULL,
        direction TEXT NOT NULL DEFAULT 'pull',
        pages_synced INTEGER DEFAULT 0,
        pages_failed INTEGER DEFAULT 0,
        result_json TEXT NOT NULL
      );
    `);
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_sh_ws_ts ON sync_history(workspace_id, timestamp DESC);`,
    );

    db.run(`
      CREATE TABLE IF NOT EXISTS item_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        notion_id TEXT NOT NULL,
        obsidian_path TEXT,
        timestamp TEXT NOT NULL,
        direction TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT
      );
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ih_notion ON item_history(notion_id, timestamp DESC);`);
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_ih_ws_ts ON item_history(workspace_id, timestamp DESC);`,
    );

    db.run(`
      CREATE TABLE IF NOT EXISTS merge_audit (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        timestamp TEXT NOT NULL,
        notion_id TEXT NOT NULL,
        title TEXT,
        decision TEXT NOT NULL,
        auto_merge_count INTEGER DEFAULT 0,
        conflict_count INTEGER DEFAULT 0,
        unchanged_count INTEGER DEFAULT 0,
        operations_json TEXT,
        notion_hash TEXT,
        obsidian_hash TEXT
      );
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_merge_audit_ts ON merge_audit(timestamp);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_merge_audit_notion ON merge_audit(notion_id);`);
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_merge_audit_ws ON merge_audit(workspace_id, timestamp DESC);`,
    );

    // KEEP IN SYNC with the v4 migration in runMigrations() - a fresh DB gets
    // the table here, an upgraded DB gets it there, and both must agree.
    db.run(`
      CREATE TABLE IF NOT EXISTS error_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        timestamp TEXT NOT NULL,
        correlation_id TEXT,
        direction TEXT,
        code TEXT,
        message TEXT NOT NULL
      );
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_el_ws_ts ON error_log(workspace_id, timestamp DESC);`);

    db.run(`INSERT OR REPLACE INTO n2o_meta (key, value) VALUES ('schema_version', ?);`, [
      String(SCHEMA_VERSION),
    ]);
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
      // v1 -> v2: Add workspace_id to merge_audit
      if (currentVersion < 2) {
        try {
          db.run(
            `ALTER TABLE merge_audit ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';`,
          );
          db.run(
            `CREATE INDEX IF NOT EXISTS idx_merge_audit_ws ON merge_audit(workspace_id, timestamp DESC);`,
          );
          log.info('History DB migration: added workspace_id to merge_audit');
        } catch (e) {
          // Only ignore the column-already-exists case (schema created fresh at
          // v2). A real ALTER failure must propagate so the outer catch rolls
          // back and schema_version is NOT advanced past a column that never got added.
          if (!(e instanceof Error && /duplicate column name/i.test(e.message))) throw e;
        }
      }

      // v2 -> v3: Add content hashes to merge_audit for post-incident debugging
      if (currentVersion < 3) {
        try {
          db.run(`ALTER TABLE merge_audit ADD COLUMN notion_hash TEXT;`);
          db.run(`ALTER TABLE merge_audit ADD COLUMN obsidian_hash TEXT;`);
          log.info('History DB migration: added content hashes to merge_audit');
        } catch (e) {
          // Only the column-already-exists case is safe to ignore (fresh v3
          // schema); any other ALTER failure must roll back the migration.
          if (!(e instanceof Error && /duplicate column name/i.test(e.message))) throw e;
        }
      }

      // v3 -> v4: Add the error_log table (persistent bounded error history).
      // CREATE TABLE IF NOT EXISTS is idempotent, so a DB created fresh at v4
      // (which enters here at version 4 and skips) and one created fresh at v3
      // (which enters here at version 3) both end up with the table - no
      // duplicate-column dance like the merge_audit ALTERs above.
      if (currentVersion < 4) {
        db.run(`
          CREATE TABLE IF NOT EXISTS error_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_id TEXT NOT NULL DEFAULT 'default',
            timestamp TEXT NOT NULL,
            correlation_id TEXT,
            direction TEXT,
            code TEXT,
            message TEXT NOT NULL
          );
        `);
        db.run(
          `CREATE INDEX IF NOT EXISTS idx_el_ws_ts ON error_log(workspace_id, timestamp DESC);`,
        );
        log.info('History DB migration: added error_log table');
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

  /** Prune old diagnostic data to prevent unbounded growth. */
  private pruneOldData(): void {
    const db = this.getDb();

    // sync_history: 90 days
    const sh90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    db.run(`DELETE FROM sync_history WHERE timestamp < ?`, [sh90]);
    const shPruned = db.getRowsModified();
    if (shPruned > 0) {
      this.dirty = true;
      log.info(`Pruned ${shPruned} sync_history entries older than 90 days`);
    }

    // item_history: 30 days
    const ih30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    db.run(`DELETE FROM item_history WHERE timestamp < ?`, [ih30]);
    const ihPruned = db.getRowsModified();
    if (ihPruned > 0) {
      this.dirty = true;
      log.info(`Pruned ${ihPruned} item_history entries older than 30 days`);
    }

    // merge_audit: 30 days
    const ma30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    db.run(`DELETE FROM merge_audit WHERE timestamp < ?`, [ma30]);
    const maPruned = db.getRowsModified();
    if (maPruned > 0) {
      this.dirty = true;
      log.info(`Pruned ${maPruned} merge_audit entries older than 30 days`);
    }

    // error_log: 30 days
    const el30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    db.run(`DELETE FROM error_log WHERE timestamp < ?`, [el30]);
    const elPruned = db.getRowsModified();
    if (elPruned > 0) {
      this.dirty = true;
      log.info(`Pruned ${elPruned} error_log entries older than 30 days`);
    }

    // error_log: hard cap of 500 rows per workspace, newest kept, so a
    // pathological error loop can't grow the DB inside the 30-day window.
    db.run(`
      DELETE FROM error_log WHERE id NOT IN (
        SELECT id FROM error_log AS keep
        WHERE keep.workspace_id = error_log.workspace_id
        ORDER BY keep.timestamp DESC LIMIT 500
      )
    `);
    const elCapped = db.getRowsModified();
    if (elCapped > 0) {
      this.dirty = true;
      log.info(`Pruned ${elCapped} error_log entries over the 500-row per-workspace cap`);
    }
  }
}
