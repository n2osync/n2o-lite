/**
 * SyncRecord - Tracks sync state for each item.
 * Stored in the sync state database.
 */

import type { DataSourceId } from './notion-id';

export interface SyncRecord {
  /** Internal N2O ID */
  id: string;
  /** Notion page/block UUID */
  notionId: string;
  /** Vault-relative file path */
  obsidianPath: string;
  /** Item type */
  itemType: SyncItemType;
  /** Parent Notion ID (for hierarchy) */
  notionParentId?: string;
  /**
   * Canonical data_source ID for databases (resolves block UUID -> modern
   * 2025-09-03+ API ID). Branded so the type system catches the
   * data_source-vs-block-uuid confusion at compile time. Storage layer
   * persists as plain TEXT; the brand is restored at the rowToRecord
   * boundary in sync-state.ts.
   */
  dataSourceId?: DataSourceId;

  /** Notion last_edited_time at last successful sync */
  notionLastEdited: string;
  /** Obsidian file mtime (ms) at last successful sync */
  obsidianLastModified: number;
  /** Content hash of Notion version at last sync */
  notionContentHash: string;
  /** Content hash of Obsidian version at last sync */
  obsidianContentHash: string;
  /** Structural hash of the Notion BLOCK TREE at last sync (#1746). Lets the push
   *  conflict gate distinguish a genuine remote edit from a stale-baseline false
   *  positive. Empty on legacy records / until the next pull backfills it. */
  notionBlockHash?: string;

  /** Current sync status */
  status: SyncItemStatus;
  /** Sync direction for this item */
  syncDirection: SyncRecordDirection;
  /** Last successful sync timestamp (ISO) */
  lastSyncTime: string;
  /** Error message if last sync failed */
  lastError?: string;

  /** Attachment records */
  attachments: AttachmentRecord[];

  /** Failed media downloads - forces re-sync to retry */
  failedMedia?: FailedMediaItem[];

  /**
   * ISO timestamp of the most recent authoritative Notion fetch for
   * this record (sync-entry's fetch-and-decide flow). Used to
   * short-circuit back-to-back manual syncs where a fresh fetch
   * would add latency without changing the answer. Nullable for
   * records written before v0.9.35 (schema v7).
   */
  lastFetchedAt?: string;
  /**
   * Monotonic per-page sequence counter. Incremented on every
   * upsert of this record. Replaces minute-granularity timestamps
   * as the internal version-identity anchor. Optional in the type
   * because legacy records (schema < v7) and many construction sites
   * don't supply it - the SQL DEFAULT 0 handles the rest.
   */
  localSequence?: number;
  /**
   * ISO timestamp of the most recent successful push-side verification.
   * Set by the post-push readback (push-verifier.ts) when the Notion
   * state matches what we tried to push. Stays null when we've never
   * verified the record - distinct from "we pushed but didn't check"
   * vs "we checked and it was clean." UI surfaces this separately
   * from lastSyncTime so users see verification freshness, not just
   * sync recency. Nullable for records written before schema v9.
   */
  lastVerifiedAt?: string;
  /**
   * Fingerprint of the renderer build that produced this note's markdown
   * (RENDERER_VERSION, a build-time hash of the parser/builder sources).
   * The pull skip gate re-renders when this differs from the running build,
   * so shipped renderer fixes reach already-synced notes (#1628). Nullable
   * for records written before schema v11 - null reads as "unknown
   * renderer" and re-renders once on the first sync after upgrade.
   */
  rendererVersion?: string;
}

/** Details about a single failed media download. */
export interface FailedMediaItem {
  /** Block ID or synthetic ID like "abc123-cover" */
  id: string;
  /** What kind of media: 'cover', 'icon', 'image', 'video', 'audio', 'file', 'pdf', 'file-property' */
  mediaType: string;
  /** Error message from the downloader */
  error: string;
  /**
   * Number of prior re-sync attempts that still failed this item. 0 on first
   * failure, incremented via mergeFailedMedia() on each re-sync. Sync-entry
   * stops forcing a re-sync once all items reach MAX_MEDIA_RETRIES (F-013).
   */
  retryCount?: number;
  /**
   * Plain-words, user-facing reason for the failure (#1780), e.g. "The source
   * file no longer exists (404 from images.unsplash.com)." Additive: absent on
   * records written before this field, which read as undefined (no migration).
   */
  reason?: string;
  /** The HTTP status recovered from the failing response, when there was one. */
  statusCode?: number;
  /**
   * Whether retrying can help (#1780). `permanent` = the source is gone/forbidden,
   * Retry is a dead end and the item stops alarming after the cap; `transient` =
   * a timeout / 5xx / expired-signature that a re-sync will likely fix. Additive.
   */
  class?: 'permanent' | 'transient';
  /**
   * The failing source URL (#1780), shown truncated on the dashboard card so the
   * user can see WHICH file died. Also the change-detector for `dismissed`: if the
   * URL changes on a later sync, the dismissal is cleared and the item re-alarms.
   * Additive.
   */
  url?: string;
  /**
   * True once the user has dismissed this item from the dashboard (#1780). A
   * dismissed item stops counting toward the needs-attention surface and never
   * re-alarms unless its `url` changes. Only offered for permanent failures.
   * Additive.
   */
  dismissed?: boolean;
}

export type SyncItemType = 'page' | 'database' | 'database-item' | 'linked-view';

export type SyncItemStatus =
  | 'synced'
  | 'notion-ahead'
  | 'obsidian-ahead'
  | 'conflict'
  | 'new-notion'
  | 'new-obsidian'
  | 'deleted'
  | 'error';

/**
 * Per-record sync direction. Distinct from config-schema's SyncDirection
 * (bidirectional / notion-to-obsidian / obsidian-to-notion), which is the
 * profile SETTING. Named apart so importing the wrong one is a compile error,
 * not a value literal that silently never matches at runtime (#1558).
 */
export type SyncRecordDirection = 'both' | 'notion-only' | 'obsidian-only';

export interface AttachmentRecord {
  /** Notion file block/property reference */
  notionFileId: string;
  /** Current Notion URL (may be expired) */
  notionUrl: string;
  /** Vault-relative local path */
  localPath: string;
  /** Content hash for change detection */
  contentHash: string;
  /** Last synced timestamp */
  lastSynced: string;
}

export interface N2OAttachment {
  /** Original URL (Notion CDN or external) */
  url: string;
  /** Local path in vault (if downloaded) */
  localPath?: string;
  /** File name */
  fileName: string;
  /** MIME type */
  mimeType?: string;
  /** File size in bytes */
  size?: number;
  /** Content hash */
  contentHash?: string;
  /** Source type */
  sourceType: 'notion-hosted' | 'external' | 'local';
}
