/**
 * MediaAliasStore - maps the SHA256 of an auto-optimized uploaded image to
 * the SHA256 of the untouched vault original (#1756).
 *
 * When push auto-optimizes an oversized image before uploading, the bytes
 * Notion stores differ from the vault file. On the next pull the downloader
 * hashes Notion's copy, misses in the file index, and would write a duplicate.
 * This store records "optimized hash -> original hash" at upload time so pull
 * can resolve the optimized bytes back to the untouched vault original and
 * reuse it.
 *
 * Backed by the `media_alias` table in the core database (schema v14).
 * PK-scoped lookups only; rows are per workspace.
 */

import type { CoreDatabase } from './core-database';

export class MediaAliasStore {
  constructor(
    private database: CoreDatabase,
    private workspaceId: string = 'default',
  ) {}

  /**
   * Resolve an optimized image's hash to the vault original's hash.
   * Returns null when the hash was never recorded as an alias.
   */
  get(aliasHash: string): { originalHash: string } | null {
    const db = this.database.getDb();
    const result = db.exec(
      `SELECT original_hash FROM media_alias
       WHERE alias_hash = ? AND workspace_id = ?`,
      [aliasHash, this.workspaceId],
    );
    const first = result[0];
    if (!first || first.values.length === 0) return null;
    const row = first.values[0];
    if (!row) return null;
    return { originalHash: row[0] as string };
  }

  /**
   * Record an alias: the hash of the optimized bytes that were uploaded,
   * pointing at the hash of the untouched vault original. Overwrites any
   * previous mapping for this alias hash.
   */
  record(aliasHash: string, originalHash: string, now: number): void {
    const db = this.database.getDb();
    db.run(
      `INSERT OR REPLACE INTO media_alias
       (alias_hash, workspace_id, original_hash, created)
       VALUES (?, ?, ?, ?)`,
      [aliasHash, this.workspaceId, originalHash, now],
    );
    this.database.markDirty();
  }
}
