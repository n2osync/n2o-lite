/**
 * FileHashIndex - SQLite-backed content-hash index for vault media files.
 *
 * Purpose (F-025): prevent duplicate file writes when the sync cycle
 * round-trips user-placed media. If a user drops `X.pdf` at the vault
 * root, embeds it in a synced note, and pushes - the post-push
 * write-back fetches Notion's authoritative state and tries to
 * download the same bytes back. Without this index, it writes a
 * content-addressed copy into `_files/`, leaving two identical files
 * in the vault.
 *
 * With this index: before the media-downloader writes, it asks "do
 * we already have a vault file with this SHA256?" via `findByHash()`.
 * If yes, it skips the write and reuses the existing vault path.
 *
 * The index is maintained incrementally by the vault file-watcher
 * (create/modify/rename/delete) and lazy-rebuilt from disk on cold
 * start when empty. Rebuilds scan media extensions only - markdown
 * and other files are out of scope.
 */

import type { CoreDatabase } from './core-database';

/** Extensions indexed by this store. Mirrors MediaDownloader + file-uploader. */
const INDEXED_EXTENSIONS: ReadonlySet<string> = new Set([
  // Images
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'avif',
  'ico',
  'tiff',
  'tif',
  'heic',
  // Video
  'mp4',
  'webm',
  'mov',
  'mkv',
  'avi',
  'mpeg',
  'mpg',
  'wmv',
  'ogv',
  // Audio
  'mp3',
  'ogg',
  'wav',
  'm4a',
  'flac',
  'aac',
  // Documents
  'pdf',
]);

/** A file-index row as it surfaces to callers. */
export interface FileIndexEntry {
  path: string;
  hash: string;
  size: number;
  mtime: number;
  lastVerified: number;
}

export class FileHashIndex {
  constructor(
    private database: CoreDatabase,
    private workspaceId: string = 'default',
  ) {}

  /**
   * Look up any vault path whose content matches the given SHA256.
   * Returns the most recently verified match, or null.
   *
   * The media-downloader calls this right after hashing freshly-
   * fetched bytes - if a match exists, the download is skipped and
   * the caller reuses the existing path. Kills the F-025 duplicate.
   */
  findByHash(hash: string): FileIndexEntry | null {
    const db = this.database.getDb();
    const result = db.exec(
      `SELECT path, hash, size, mtime, last_verified
       FROM file_index
       WHERE hash = ? AND workspace_id = ?
       ORDER BY last_verified DESC
       LIMIT 1`,
      [hash, this.workspaceId],
    );
    const first = result[0];
    if (!first || first.values.length === 0) return null;
    const row = first.values[0];
    if (!row) return null;
    return {
      path: row[0] as string,
      hash: row[1] as string,
      size: row[2] as number,
      mtime: row[3] as number,
      lastVerified: row[4] as number,
    };
  }

  /** Get the index entry for a specific vault path, or null. */
  getByPath(path: string): FileIndexEntry | null {
    const db = this.database.getDb();
    const result = db.exec(
      `SELECT path, hash, size, mtime, last_verified
       FROM file_index
       WHERE path = ? AND workspace_id = ?`,
      [path, this.workspaceId],
    );
    const first = result[0];
    if (!first || first.values.length === 0) return null;
    const row = first.values[0];
    if (!row) return null;
    return {
      path: row[0] as string,
      hash: row[1] as string,
      size: row[2] as number,
      mtime: row[3] as number,
      lastVerified: row[4] as number,
    };
  }

  /**
   * Record a path + its hash. Overwrites any previous entry for this
   * path. Safe to call from any hot path - single SQLite upsert.
   */
  record(path: string, hash: string, size: number, mtime: number): void {
    const db = this.database.getDb();
    db.run(
      `INSERT OR REPLACE INTO file_index
       (path, workspace_id, hash, size, mtime, last_verified)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [path, this.workspaceId, hash, size, mtime, Date.now()],
    );
    this.database.markDirty();
  }

  /** Forget a path (vault delete). No-op if not indexed. */
  forget(path: string): void {
    const db = this.database.getDb();
    db.run(`DELETE FROM file_index WHERE path = ? AND workspace_id = ?`, [path, this.workspaceId]);
    this.database.markDirty();
  }

  /**
   * Rename a path. Hash stays the same (Obsidian's rename is a pure
   * move, no content change). Single UPDATE keeps the entry live.
   */
  rename(oldPath: string, newPath: string): void {
    const db = this.database.getDb();
    db.run(
      `UPDATE file_index
       SET path = ?, last_verified = ?
       WHERE path = ? AND workspace_id = ?`,
      [newPath, Date.now(), oldPath, this.workspaceId],
    );
    this.database.markDirty();
  }

  /** Row count for this workspace - used to gate cold-start rebuilds. */
  count(): number {
    const db = this.database.getDb();
    const result = db.exec(`SELECT COUNT(*) FROM file_index WHERE workspace_id = ?`, [
      this.workspaceId,
    ]);
    const first = result[0];
    if (!first) return 0;
    return (first.values[0]?.[0] as number) ?? 0;
  }

  /**
   * Wipe every entry for this workspace. Used by rebuild() and tests.
   * The caller is responsible for repopulating.
   */
  clear(): void {
    const db = this.database.getDb();
    db.run(`DELETE FROM file_index WHERE workspace_id = ?`, [this.workspaceId]);
    this.database.markDirty();
  }

  /**
   * Return all entries for the workspace. Intended for diagnostics +
   * tests - callers that need to filter should do so in SQL.
   */
  all(): FileIndexEntry[] {
    const db = this.database.getDb();
    const result = db.exec(
      `SELECT path, hash, size, mtime, last_verified
       FROM file_index WHERE workspace_id = ?`,
      [this.workspaceId],
    );
    const first = result[0];
    if (!first) return [];
    return first.values.map((row) => ({
      path: row[0] as string,
      hash: row[1] as string,
      size: row[2] as number,
      mtime: row[3] as number,
      lastVerified: row[4] as number,
    }));
  }
}

/**
 * Extract the lowercase extension from a path, without the dot.
 * Returns empty string if none. Used by both the watcher and
 * rebuilder to decide which files to index.
 */
export function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (dot <= slash) return '';
  return path.substring(dot + 1).toLowerCase();
}

/** True if this path points at a file the index should track. */
export function shouldIndex(path: string): boolean {
  return INDEXED_EXTENSIONS.has(extensionOf(path));
}
