/**
 * PageCacheStore - Persistent cache of Notion accessible pages and databases.
 *
 * Stores metadata from workspace discovery in the `accessible_pages` SQLite table.
 * Powers instant tree picker loading and fast search without hitting the Notion API.
 *
 * All IDs are stored in dashless lowercase format (normalizeNotionId convention).
 */

import type { DatabaseRef } from './database-ref';
import { createLogger } from '../../shared/logger';

const log = createLogger('PageCacheStore');

export interface CachedPage {
  notionId: string;
  title: string;
  itemType: 'database' | 'page' | 'database-item';
  parentType: string | null; // 'workspace' | 'page' | 'database'
  parentId: string | null;
  itemCount: number | null; // page count for databases
  lastEdited: string | null;
  discoveredAt: string;
}

export class PageCacheStore {
  /**
   * @param workspaceId partitions the cache so discovery, search, and pruning
   * for one workspace never touch another's rows (#1544). Defaults to the only
   * workspace instantiated today.
   */
  constructor(
    private database: DatabaseRef,
    private workspaceId: string = 'default',
  ) {}

  /** Get all cached databases. */
  getAllDatabases(): CachedPage[] {
    const db = this.database.getDb();
    const results = db.exec(
      `SELECT * FROM accessible_pages WHERE item_type = 'database' AND workspace_id = ? ORDER BY title`,
      [this.workspaceId],
    );
    const first = results[0];
    if (!first) return [];
    return this.resultToPages(first);
  }

  /** Get all top-level pages (parent_type = 'workspace' or parent_type IS NULL and item_type = 'page'). */
  getAllTopLevelPages(): CachedPage[] {
    const db = this.database.getDb();
    const results = db.exec(
      `SELECT * FROM accessible_pages WHERE item_type = 'page' AND (parent_type = 'workspace' OR parent_type IS NULL) AND workspace_id = ? ORDER BY title`,
      [this.workspaceId],
    );
    const first = results[0];
    if (!first) return [];
    return this.resultToPages(first);
  }

  /** Get children of a specific parent. */
  getChildrenOf(parentId: string): CachedPage[] {
    const db = this.database.getDb();
    const results = db.exec(
      `SELECT * FROM accessible_pages WHERE parent_id = ? AND workspace_id = ? ORDER BY title`,
      [parentId, this.workspaceId],
    );
    const first = results[0];
    if (!first) return [];
    return this.resultToPages(first);
  }

  /** Search pages by title (case-insensitive LIKE). */
  search(query: string): CachedPage[] {
    const db = this.database.getDb();
    // Escape LIKE wildcards in user input to prevent wildcard injection
    const escaped = query.replace(/[%_\\]/g, '\\$&');
    const results = db.exec(
      `SELECT * FROM accessible_pages WHERE title LIKE ? ESCAPE '\\' COLLATE NOCASE AND workspace_id = ? ORDER BY title LIMIT 100`,
      [`%${escaped}%`, this.workspaceId],
    );
    const first = results[0];
    if (!first) return [];
    return this.resultToPages(first);
  }

  /** Get total count of cached pages. */
  count(): number {
    const db = this.database.getDb();
    const result = db.exec('SELECT COUNT(*) FROM accessible_pages WHERE workspace_id = ?', [
      this.workspaceId,
    ]);
    const first = result[0];
    if (!first) return 0;
    return (first.values[0]?.[0] as number) ?? 0;
  }

  /** Check if cache has any data. */
  isEmpty(): boolean {
    return this.count() === 0;
  }

  /** Per-workspace discovery-time key. 'default' keeps the original unsuffixed
   *  key so existing installs don't lose their last-discovery timestamp. */
  private discoveryTimeKey(): string {
    return this.workspaceId === 'default'
      ? 'last_page_discovery_time'
      : `last_page_discovery_time:${this.workspaceId}`;
  }

  /** Get last discovery timestamp from n2o_meta. */
  getLastDiscoveryTime(): string | null {
    const db = this.database.getDb();
    const result = db.exec(`SELECT value FROM n2o_meta WHERE key = ?`, [this.discoveryTimeKey()]);
    const first = result[0];
    if (!first || first.values.length === 0) return null;
    return (first.values[0]?.[0] as string | null | undefined) ?? null;
  }

  /** Set last discovery timestamp in n2o_meta. */
  setLastDiscoveryTime(time: string): void {
    const db = this.database.getDb();
    db.run(`INSERT OR REPLACE INTO n2o_meta (key, value) VALUES (?, ?)`, [
      this.discoveryTimeKey(),
      time,
    ]);
    this.database.markDirty();
  }

  /** Batch upsert pages (INSERT OR REPLACE) in a single transaction. */
  upsertPages(pages: CachedPage[]): void {
    if (pages.length === 0) return;
    const db = this.database.getDb();
    // SAVEPOINT nests safely inside an outer transaction (#1568).
    db.run('SAVEPOINT upsert_pages');
    try {
      for (const page of pages) {
        db.run(
          `INSERT OR REPLACE INTO accessible_pages (
            notion_id, workspace_id, title, item_type, parent_type, parent_id,
            item_count, last_edited, discovered_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            page.notionId,
            this.workspaceId,
            page.title,
            page.itemType,
            page.parentType ?? null,
            page.parentId ?? null,
            page.itemCount ?? null,
            page.lastEdited ?? null,
            page.discoveredAt,
          ],
        );
      }
      db.run('RELEASE upsert_pages');
    } catch (error) {
      try {
        db.run('ROLLBACK TO upsert_pages');
        db.run('RELEASE upsert_pages');
      } catch (rollbackErr) {
        log.error('Savepoint rollback failed after page cache upsert error', rollbackErr);
      }
      throw error;
    }
    this.database.markDirty();
    log.info(`Upserted ${pages.length} pages into cache`);
  }

  /** Remove pages not in the given set of IDs (prune deleted). Returns count of removed. */
  removeMissing(currentIds: Set<string>): number {
    const db = this.database.getDb();
    const results = db.exec('SELECT notion_id FROM accessible_pages WHERE workspace_id = ?', [
      this.workspaceId,
    ]);
    const first = results[0];
    if (!first) return 0;

    const toDelete: string[] = [];
    for (const row of first.values) {
      const id = row[0] as string;
      if (!currentIds.has(id)) {
        toDelete.push(id);
      }
    }

    if (toDelete.length === 0) return 0;

    db.run('SAVEPOINT prune_pages');
    try {
      for (const id of toDelete) {
        db.run('DELETE FROM accessible_pages WHERE notion_id = ? AND workspace_id = ?', [
          id,
          this.workspaceId,
        ]);
      }
      db.run('RELEASE prune_pages');
    } catch (error) {
      try {
        db.run('ROLLBACK TO prune_pages');
        db.run('RELEASE prune_pages');
      } catch (rollbackErr) {
        log.error('Savepoint rollback failed after page cache prune error', rollbackErr);
      }
      throw error;
    }
    this.database.markDirty();
    log.info(`Pruned ${toDelete.length} stale pages from cache`);
    return toDelete.length;
  }

  /** Clear this workspace's cached pages and its discovery timestamp. */
  clear(): void {
    const db = this.database.getDb();
    db.run('DELETE FROM accessible_pages WHERE workspace_id = ?', [this.workspaceId]);
    db.run(`DELETE FROM n2o_meta WHERE key = ?`, [this.discoveryTimeKey()]);
    this.database.markDirty();
    log.info('Page cache cleared');
  }

  // ── Private helpers ──────────────────────────────────────

  private resultToPages(result: { columns: string[]; values: unknown[][] }): CachedPage[] {
    const { columns, values } = result;
    return values.map((row) => {
      const obj: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        obj[col] = row[i];
      });
      return this.rowToPage(obj);
    });
  }

  private static readonly VALID_ITEM_TYPES = new Set(['database', 'page', 'database-item']);

  private rowToPage(row: Record<string, unknown>): CachedPage {
    const itemType = row['item_type'] as string;
    return {
      notionId: row['notion_id'] as string,
      title: row['title'] as string,
      itemType: PageCacheStore.VALID_ITEM_TYPES.has(itemType)
        ? (itemType as CachedPage['itemType'])
        : 'page',
      parentType: (row['parent_type'] as string) || null,
      parentId: (row['parent_id'] as string) || null,
      itemCount: row['item_count'] as number | null,
      lastEdited: (row['last_edited'] as string) || null,
      discoveredAt: row['discovered_at'] as string,
    };
  }
}
