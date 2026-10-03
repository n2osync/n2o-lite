/**
 * BlockIdentityStore - Persistent cache of child_database block classification.
 *
 * Every pull that encounters a `child_database` block classifies it as one
 * of three kinds (inline-database, linked-view, unresolved) and persists
 * the result here. Subsequent pulls read the classification from this
 * cache, skipping the API probes that were needed to resolve it originally.
 *
 * This is the persistence layer for the architectural fix described in
 *
 * Lookups are O(1) via the (block_id, workspace_id) primary key.
 *
 * @module
 */

import type { CoreDatabase } from './core-database';
import { createLogger } from '../../shared/logger';

const log = createLogger('BlockIdentityStore');

/** How a child_database block was classified. */
type BlockIdentityKind = 'inline-database' | 'linked-view' | 'unresolved';

/** Which resolution path produced the classification. */
type BlockIdentitySource =
  | 'official-api' // getDatabase(blockId) returned 200
  | 'views-api' // getView(blockId) returned 200
  | 'fallback'; // all probes failed, using deterministic fallback name

/** Resolved identity for a `child_database` block. */
export interface BlockIdentity {
  /** Normalized (dashless) Notion block UUID. */
  blockId: string;
  /** Classification. */
  kind: BlockIdentityKind;
  /**
   * Source database Notion ID (dashless).
   * For inline databases: same as blockId.
   * For linked views: the database the view filters.
   * Null for unresolved.
   */
  databaseId: string | null;
  /** Authoritative database title (from `getDatabase` or recordMap). */
  databaseTitle: string | null;
  /** For linked views: `table` | `gallery` | `list` | `board` | etc. */
  viewType: string | null;
  /** For linked views: the user-set view name (e.g. "All Members"). */
  viewTitle: string | null;
  /** Notion ID of the page hosting this block (for linked views). */
  parentPageId: string | null;
  /** Title of the parent page. */
  parentPageTitle: string | null;
  /**
   * Deterministic file name for the `.base` embed. Always present, even
   * when kind is 'unresolved' - we fall back to an id-prefix scheme so
   * the renderer ALWAYS has a valid filename to emit.
   */
  stableName: string;
  /** Unix-ms timestamp of when this classification was resolved. */
  resolvedAt: number;
  /** Which probe path produced this result. */
  source: BlockIdentitySource;
}

/**
 * How stale an entry can be before it must be re-probed.
 * 7 days - catches renamed databases without thrashing the API.
 */
export const BLOCK_IDENTITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class BlockIdentityStore {
  constructor(
    private database: CoreDatabase,
    private workspaceId: string = 'default',
  ) {}

  /** Look up the cached identity for a block. Returns null on miss. */
  get(blockId: string): BlockIdentity | null {
    const db = this.database.getDb();
    const results = db.exec(
      'SELECT * FROM block_identity WHERE block_id = ? AND workspace_id = ?',
      [blockId, this.workspaceId],
    );
    const first = results[0];
    if (!first || first.values.length === 0) return null;
    const row = first.values[0];
    if (!row) return null;
    return this.rowToIdentity(first.columns, row);
  }

  /**
   * Look up a cached identity if it is still fresh (within TTL).
   * Returns null on miss OR on stale entry, so callers can decide to
   * re-probe uniformly.
   */
  getFresh(blockId: string, now: number = Date.now()): BlockIdentity | null {
    const entry = this.get(blockId);
    if (!entry) return null;
    if (now - entry.resolvedAt > BLOCK_IDENTITY_TTL_MS) return null;
    return entry;
  }

  /** Return every cached identity in this workspace. */
  getAll(): BlockIdentity[] {
    const db = this.database.getDb();
    const results = db.exec('SELECT * FROM block_identity WHERE workspace_id = ?', [
      this.workspaceId,
    ]);
    const first = results[0];
    if (!first || first.values.length === 0) return [];
    return first.values.map((row) => this.rowToIdentity(first.columns, row));
  }

  /** Insert or overwrite a classification. */
  upsert(identity: BlockIdentity): void {
    const db = this.database.getDb();
    db.run(
      `INSERT OR REPLACE INTO block_identity (
        block_id, workspace_id, kind, database_id, database_title,
        view_type, view_title, parent_page_id, parent_page_title,
        stable_name, resolved_at, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        identity.blockId,
        this.workspaceId,
        identity.kind,
        identity.databaseId,
        identity.databaseTitle,
        identity.viewType,
        identity.viewTitle,
        identity.parentPageId,
        identity.parentPageTitle,
        identity.stableName,
        identity.resolvedAt,
        identity.source,
      ],
    );
    this.database.markDirty();
    log.debug(
      `Cached identity for ${identity.blockId.substring(0, 8)}... \u2192 ${identity.kind} (${identity.source})`,
    );
  }

  /** Remove a single entry (e.g. after repeated probe failures). */
  delete(blockId: string): void {
    const db = this.database.getDb();
    db.run('DELETE FROM block_identity WHERE block_id = ? AND workspace_id = ?', [
      blockId,
      this.workspaceId,
    ]);
    this.database.markDirty();
  }

  /**
   * Age past which an untouched entry is deleted. 2x the freshness TTL: a block
   * that still exists gets re-probed and re-upserted (refreshing resolved_at)
   * within one TTL of any access, so an entry older than 2x TTL has not been
   * seen in a long time and is treated as orphaned.
   */
  static readonly PRUNE_AGE_MS = 2 * BLOCK_IDENTITY_TTL_MS;

  /**
   * Delete entries not resolved within PRUNE_AGE_MS. getFresh skipped stale rows
   * but never deleted them and there was no periodic cleanup, so rows for deleted
   * Notion blocks accumulated without bound (#1566). Returns the number removed.
   */
  pruneStale(now: number = Date.now()): number {
    const db = this.database.getDb();
    const cutoff = now - BlockIdentityStore.PRUNE_AGE_MS;
    const before = this.count();
    db.run('DELETE FROM block_identity WHERE workspace_id = ? AND resolved_at < ?', [
      this.workspaceId,
      cutoff,
    ]);
    const removed = before - this.count();
    if (removed > 0) {
      this.database.markDirty();
      log.info(`Pruned ${removed} stale block_identity entries`);
    }
    return removed;
  }

  /** Wipe the entire cache. Debug / reset use only. */
  clear(): void {
    const db = this.database.getDb();
    db.run('DELETE FROM block_identity WHERE workspace_id = ?', [this.workspaceId]);
    this.database.markDirty();
    log.info('Cleared block_identity cache');
  }

  /** Number of cached entries in this workspace. */
  count(): number {
    const db = this.database.getDb();
    const results = db.exec('SELECT COUNT(*) FROM block_identity WHERE workspace_id = ?', [
      this.workspaceId,
    ]);
    const first = results[0];
    if (!first || first.values.length === 0) return 0;
    return (first.values[0]?.[0] as number) ?? 0;
  }

  /** Convert a SQLite row (columns + values) into a BlockIdentity. */
  private rowToIdentity(columns: string[], row: unknown[]): BlockIdentity {
    const map = new Map<string, unknown>();
    columns.forEach((col, i) => map.set(col, row[i]));
    return {
      blockId: map.get('block_id') as string,
      kind: map.get('kind') as BlockIdentityKind,
      databaseId: (map.get('database_id') as string | null) ?? null,
      databaseTitle: (map.get('database_title') as string | null) ?? null,
      viewType: (map.get('view_type') as string | null) ?? null,
      viewTitle: (map.get('view_title') as string | null) ?? null,
      parentPageId: (map.get('parent_page_id') as string | null) ?? null,
      parentPageTitle: (map.get('parent_page_title') as string | null) ?? null,
      stableName: map.get('stable_name') as string,
      resolvedAt: map.get('resolved_at') as number,
      source: map.get('source') as BlockIdentitySource,
    };
  }
}
