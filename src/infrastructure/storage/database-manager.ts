/**
 * DatabaseManager - Orchestrates all N2O storage: two SQLite databases + file stores.
 *
 * Replaces the monolithic N2ODatabase as the single storage entry point.
 *
 * Architecture:
 * - CoreDatabase (`n2o-core.db`): sync_records, retry_queue, base_version_index, accessible_pages, n2o_meta
 * - HistoryDatabase (`n2o-history.db`): sync_history, item_history, merge_audit
 * - File stores under `data/{workspace_id}/`:
 *   - block-cache/ - Notion block JSON (disposable)
 *   - page-versions/ - Future: content snapshots
 */

import type { App, DataAdapter } from 'obsidian';
import initSqlJs from 'sql.js';
import sqlWasmBinary from 'sql.js/dist/sql-wasm.wasm';
import { CoreDatabase } from './core-database';
import { HistoryDatabase } from './history-database';
import { N2OError, getErrorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/logger';
import { PLUGIN_ID } from '../../shared/plugin-metadata';

const log = createLogger('DatabaseManager');

/**
 * SHA-256 of sql.js 1.13.0's sql-wasm.wasm (659,806 bytes). The wasm is
 * embedded into main.js at build time (esbuild's binary loader), so no file
 * on disk and no download is involved at runtime. Bump together with the
 * sql.js version in package.json - the unit test hashes the npm dist file
 * against this constant, so a version bump without a pin bump fails the
 * suite instead of silently shipping different engine bytes.
 */
export const SQL_WASM_SHA256 = '0734155c83e493983d1f2ff5b09a4fab6e35a32e9449c7e4e545756439f62d73';

export class DatabaseManager {
  private _coreDb: CoreDatabase | null = null;
  private _historyDb: HistoryDatabase | null = null;
  private adapter!: DataAdapter;
  // Resolved in open() from the vault's config dir, which is not always
  // ".obsidian" - users can rename it, so these must never be hardcoded.
  private pluginDir!: string;
  private dataDir!: string;

  /** True if corruption was detected during open */
  get wasCorrupted(): boolean {
    return this._coreDb?.wasCorrupted ?? false;
  }
  get corruptionDetails(): string {
    return this._coreDb?.corruptionDetails ?? '';
  }
  get recoveredRecords(): number {
    return this._coreDb?.recoveredRecords ?? 0;
  }

  get coreDb(): CoreDatabase {
    if (!this._coreDb)
      throw new N2OError('DatabaseManager not initialized', 'DATABASE_INIT_FAILED');
    return this._coreDb;
  }

  get historyDb(): HistoryDatabase {
    if (!this._historyDb)
      throw new N2OError('DatabaseManager not initialized', 'DATABASE_INIT_FAILED');
    return this._historyDb;
  }

  /**
   * Open all storage: boot the embedded WASM engine, open both DBs, ensure directories.
   */
  async open(app: App): Promise<void> {
    this.adapter = app.vault.adapter;
    this.pluginDir = `${app.vault.configDir}/plugins/${PLUGIN_ID}`;
    this.dataDir = `${this.pluginDir}/data`;
    log.info('Opening storage...');

    let SQL: Awaited<ReturnType<typeof initSqlJs>>;
    try {
      SQL = await initSqlJs({ wasmBinary: sqlWasmBinary });
    } catch (error) {
      throw new N2OError('Failed to initialize sql.js WASM engine.', 'DATABASE_INIT_FAILED', error);
    }

    // Ensure data directories
    await this.ensureDataDirectories('default');

    // Open both databases
    this._coreDb = new CoreDatabase();
    await this._coreDb.open(this.adapter, this.pluginDir, SQL);

    this._historyDb = new HistoryDatabase();
    await this._historyDb.open(this.adapter, this.pluginDir, SQL);

    // Prune stale data
    this._coreDb.pruneRetryQueue();

    log.info('Storage ready');
  }

  /** Close all storage. Flushes pending changes. */
  async close(): Promise<void> {
    log.info('Closing storage...');
    await this._coreDb?.close();
    await this._historyDb?.close();
    this._coreDb = null;
    this._historyDb = null;
    log.info('Storage closed');
  }

  /** Ensure per-workspace data directories exist. */
  async ensureDataDirectories(workspaceId: string): Promise<void> {
    const wsDir = `${this.dataDir}/${workspaceId}`;
    await this.removeBaseVersions(workspaceId);
    const dirs = [`${wsDir}/block-cache`, `${wsDir}/page-versions`];
    for (const dir of dirs) {
      // Obsidian adapter doesn't have a simple mkdir - use ensureFolder pattern
      // by creating a placeholder file then checking the directory exists
      if (!(await this.adapter.exists(dir))) {
        // Create by writing a placeholder, then the dir exists
        await this.adapter.mkdir(dir);
      }
    }
  }

  /**
   * Delete the base-versions directory left over from automatic three-way merge.
   *
   * The merge went in #1919 and nothing reads these files any more. They are
   * derived data, never user content, so deleting them loses nothing - but they
   * are real files in the user's plugin folder and orphaning them silently is
   * not acceptable. Runs on every startup rather than behind a version flag:
   * it is one existence check, and it self-heals a vault that upgraded while
   * the directory was momentarily unreachable.
   */
  private async removeBaseVersions(workspaceId: string): Promise<void> {
    const dirPath = `${this.dataDir}/${workspaceId}/base-versions`;
    try {
      if (!(await this.adapter.exists(dirPath))) return;
      const listing = await this.adapter.list(dirPath);
      for (const file of listing.files) {
        await this.adapter.remove(file);
      }
      await this.adapter.rmdir(dirPath, true);
      log.info(`Removed ${listing.files.length} obsolete base-version files from ${dirPath}`);
    } catch (err) {
      // Non-fatal: stale files waste disk, they do not break a sync. Surfacing
      // it as a startup failure would be worse than the leak.
      log.warn(`Could not remove obsolete base versions at ${dirPath}: ${getErrorMessage(err)}`);
    }
  }

  /** Delete all data for a workspace. */
  async deleteWorkspaceData(workspaceId: string): Promise<void> {
    const wsDir = `${this.dataDir}/${workspaceId}`;

    // Delete files in data directories
    for (const subdir of ['block-cache', 'page-versions']) {
      const dirPath = `${wsDir}/${subdir}`;
      try {
        if (await this.adapter.exists(dirPath)) {
          const listing = await this.adapter.list(dirPath);
          for (const file of listing.files) {
            await this.adapter.remove(file);
          }
        }
      } catch (err) {
        log.warn(`Failed to clean ${dirPath}: ${getErrorMessage(err)}`);
      }
    }

    // Delete DB rows for workspace
    if (this._coreDb) {
      const db = this._coreDb.getDb();
      db.run('DELETE FROM sync_records WHERE workspace_id = ?', [workspaceId]);
      db.run('DELETE FROM retry_queue WHERE workspace_id = ?', [workspaceId]);
      // Remaining workspace-scoped core tables (#1545). Left behind, these leak
      // forever and - on workspace-id reuse - resurface stale block
      // classifications and hash-to-path mappings.
      db.run('DELETE FROM block_identity WHERE workspace_id = ?', [workspaceId]);
      db.run('DELETE FROM file_index WHERE workspace_id = ?', [workspaceId]);
      db.run('DELETE FROM property_schema_cache WHERE workspace_id = ?', [workspaceId]);
      db.run('DELETE FROM accessible_pages WHERE workspace_id = ?', [workspaceId]);
      this._coreDb.markDirty();
    }
    if (this._historyDb) {
      const db = this._historyDb.getDb();
      db.run('DELETE FROM sync_history WHERE workspace_id = ?', [workspaceId]);
      db.run('DELETE FROM item_history WHERE workspace_id = ?', [workspaceId]);
      db.run('DELETE FROM merge_audit WHERE workspace_id = ?', [workspaceId]);
      this._historyDb.markDirty();
    }

    log.info(`Deleted workspace data: ${workspaceId}`);
  }

  /** Get the filesystem adapter. */
  getAdapter(): DataAdapter {
    return this.adapter;
  }

  /** Get the base data directory (parent of workspace dirs). */
  getDataDir(): string {
    return this.dataDir;
  }
}
