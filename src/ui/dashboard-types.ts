/**
 * Shared dashboard types. Extracted from dashboard.ts so child render
 * modules (hero-scenes, dashboard/connect-flow-renderer, ...) can
 * import the types they need without re-importing from dashboard.ts
 * and creating a TypeScript-source-level cycle.
 *
 * Only types live here. Values (renderers, helpers) stay in
 * dashboard.ts so this module has no runtime side-effects.
 */

import type { SyncResult } from '../application/sync/orchestrator';
import type { SyncHistoryEntry } from '../infrastructure/storage/sync-history';
import type { ErrorLogEntry } from '../infrastructure/storage/error-log';
import type { FailedMediaItem } from '../domain/models/sync-record';

export interface DashboardData {
  syncState: 'idle' | 'syncing' | 'paused' | 'error';
  /**
   * Fine-grained phase within the 'syncing' state, surfaced to users as
   * "Discovering..." / "Writing files..." / "Finalizing..." to distinguish a
   * healthy slow sync from a hung one. 'idle' outside of 'syncing'.
   */
  syncPhase: import('../domain/models/sync-result').SyncPhase;
  /**
   * True while the tree picker (or any other UI surface) is running a
   * workspace scan to populate the page cache. Independent of syncState - * picker discovery can happen before a sync is ever triggered. Drives
   * the radar scan scene on the hero panel.
   */
  isDiscoveringPages: boolean;
  /**
   * Live progress message from the active workspace discovery, e.g.
   * "Searching for pages... 200 items found" or "Querying databases 3 of 8".
   * Used as the scan scene's subtitle so the hero isn't stuck on
   * static copy while work is obviously happening.
   */
  pageDiscoveryMessage: string | null;
  totalPages: number;
  /** Pages actually synced, from sync_records - what the scope card reports (#1978). */
  syncedPages: number;
  /** Databases actually synced, from sync_records (#1978). */
  syncedDatabases: number;
  totalDatabasePages: number;
  totalDatabases: number;
  totalAttachments: number;
  syncProgress: { message: string; current: number; total: number } | null;
  /** Rolling ETA in ms for current sync, or null when not projectable. */
  syncEtaMs: number | null;
  lastSyncTime: string | null;
  lastResult: SyncResult | null;
  conflicts: number;
  errors: number;
  failedMedia: {
    pageName: string;
    notionId: string;
    obsidianPath: string;
    items: FailedMediaItem[];
  }[];
  /** Number of files with duplicate notion_ids in the sync folder */
  duplicateNotionIds: number;
  syncHistory: SyncHistoryEntry[];
  /** Recent persisted sync errors (newest first) from the error_log table. */
  errorHistory: ErrorLogEntry[];
  syncFolder: string;
  /** Workspace name from Notion API (null if not yet fetched - NOT a connection gate) */
  workspaceName: string | null;
  /**
   * Whether the active profile has a Notion token configured.
   * This is the authoritative onboarding gate - workspaceName is a display
   * field only. A valid token with no cached workspace name is still
   * "connected" (the name is populated lazily by testConnection / startup).
   */
  hasToken: boolean;
  /** Current sync scope setting */
  syncScope: 'all' | 'selected';
  /** Sync direction: notion-only (in), obsidian-only (out), or both */
  /** Total media files in vault (for stats display) */
  totalMedia: number;
  /** Number of selected items when scope=selected */
  selectedItemCount: number;
  /** Selected sync items (databases + pages) with titles */
  selectedItems: { title: string; type: 'database' | 'page'; itemCount?: number }[];
  /**
   * Per-database live counts during a sync. Key = sanitized DB folder
   * name (matches `sanitizeFileName(db.title)`). Empty when no sync is
   * running. Updated on every onItem tick by the dashboard manager.
   */
  liveDbCounts?: Record<string, number>;
  /** Name of the active workspace profile (for multi-workspace indicator) */
  activeWorkspaceName?: string;
  /** Total number of workspace profiles (shows switcher if > 1) */
  profileCount?: number;
  /** Whether the plugin database initialized successfully */
  dbReady: boolean;
  /** Plugin version for display */
  pluginVersion: string;
  /** PageCache stats */
  pageCacheCount: number;
  pageCacheDatabases: number;
  pageCacheAge: string | null;
}

export interface DashboardCallbacks {
  onPullChanges: () => Promise<void>;
  onSyncNow: () => Promise<void>;
  onOpenSettings: (tab?: 'Connection' | 'Sync' | 'Activity' | 'Advanced') => void;
  onRetryFailedMedia: () => Promise<void>;
  /** Open a vault note (the page a failed media item belongs to) (#1780). */
  onOpenNote: (obsidianPath: string) => void;
  /** Open a page in Notion (browser) - the fix-it destination for a dead source (#1780). */
  onOpenPageInNotion: (notionId: string) => void;
  /** Dismiss a permanently-failed media item so it stops counting/alarming (#1780). */
  onDismissFailedMedia: (notionId: string, itemId: string) => Promise<void>;
  onCancelSync: () => void | Promise<void>;
  onPreviewSync: () => Promise<void>;
  onOpenSyncLog: () => Promise<void>;
  onOpenTreePicker: () => void;
  onResolveConflicts: () => void;
  onSetSyncScopeAll: () => void;
  /** Start the OAuth flow (opens browser). No-op if OAuth unavailable. */
  onStartOAuth: () => void;
  /** Newsletter opt-in checkbox state (connect flow). Persisted in settings. */
  getNewsletterOptIn: () => boolean;
  onSetNewsletterOptIn: (optIn: boolean) => void;
  /** Try to connect with a manual integration token. Validates + saves on success. */
  onValidateManualToken: (token: string) => Promise<{ success: boolean; detail: string }>;
  /** Poll snapshot of connection state (for inline OAuth waiting screen).
   *  `error` is set when the protocol handler rejects the callback. Consumers
   *  should treat it as a one-shot: the plugin clears it after read. */
  onPollConnectionState: () => {
    hasToken: boolean;
    workspaceName: string | null;
    error: string | null;
  };
  onScanVault: () => Promise<void>;
  onDiscoverPages: () => Promise<void>;
  onOpenSyncConfig: () => void;
  onResetN2O: () => void;
  /** Open the upgrade-to-full-edition dialog. */
  onOpenUpgrade: () => void;
}

/**
 * Plugin interface -- minimal surface to avoid circular imports.
 * The actual plugin class implements these.
 */
export interface DashboardPluginRef {
  buildDashboardDataAsync(): Promise<DashboardData>;
  getDashboardCallbacks(): DashboardCallbacks;
}
