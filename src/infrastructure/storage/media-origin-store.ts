/**
 * MediaOriginStore - remembers the external source URL of a localized image.
 *
 * When pull localizes an externally-hosted image (downloads it into the
 * vault), the vault file loses its connection to the URL it came from. On
 * push, N2O would re-upload those bytes to Notion as a file upload. This
 * store records "content hash -> source URL" at localization time so push
 * can relink the block to its original external URL instead of re-uploading.
 *
 * Backed by the `media_origin` table in the core database (schema v14).
 * PK-scoped lookups only; rows are per workspace.
 */

import type { CoreDatabase } from './core-database';

export class MediaOriginStore {
  constructor(
    private database: CoreDatabase,
    private workspaceId: string = 'default',
  ) {}

  /**
   * Resolve a localized image's content hash to the external URL it was
   * downloaded from. Returns null when the hash was never recorded.
   */
  lookupByHash(contentHash: string): { sourceUrl: string } | null {
    const db = this.database.getDb();
    const result = db.exec(
      `SELECT source_url FROM media_origin
       WHERE content_hash = ? AND workspace_id = ?`,
      [contentHash, this.workspaceId],
    );
    const first = result[0];
    if (!first || first.values.length === 0) return null;
    const row = first.values[0];
    if (!row) return null;
    return { sourceUrl: row[0] as string };
  }

  /**
   * Record the external source URL an image's bytes were downloaded from,
   * keyed by their content hash. Overwrites any previous URL for this hash.
   */
  record(contentHash: string, sourceUrl: string, now: number): void {
    const db = this.database.getDb();
    db.run(
      `INSERT OR REPLACE INTO media_origin
       (content_hash, workspace_id, source_url, created)
       VALUES (?, ?, ?, ?)`,
      [contentHash, this.workspaceId, sourceUrl, now],
    );
    this.database.markDirty();
  }
}
