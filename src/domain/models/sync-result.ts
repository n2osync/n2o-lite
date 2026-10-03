/**
 * SyncResult and related types - domain-level sync outcome data.
 *
 * Lives in domain so infrastructure (sync-history, auto-push) can reference these types
 * without importing from the application layer.
 */

export interface SyncResultItem {
  notionId: string;
  title: string;
  vaultPath: string;
  status: 'created' | 'updated' | 'unchanged' | 'failed' | 'orphaned' | 'local-change' | 'skipped';
  error?: string;
  /** Direction of sync for this item */
  direction?: 'pull' | 'push';
  /** Human-readable detail (e.g. line count change for local edits) */
  detail?: string;
}

export interface SyncResultCounts {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  orphaned: number;
  localChanges: number;
  conflicts?: number;
  /** Pages refused by the Lite page budget (#1918). */
  skipped?: number;
}

export interface SyncResult {
  success: boolean;
  itemsSynced: number;
  counts: SyncResultCounts;
  items: SyncResultItem[];
  conflicts: number;
  errors: string[];
  /** Non-fatal warnings (large files, disk space, etc.) */
  warnings: string[];
  /** Informational notices (#1756: auto-optimized uploads) - handled events, never error-toned. */
  notices?: string[];
  duration: number;
  truncated?: { total: number; synced: number };
  /** Whether discovery completed fully (false = orphan detection was skipped) */
  discoveryComplete?: boolean;
  /**
   * True when the sync exited early because the user canceled it.
   * When set, success MUST be false - cancellation is not success.
   * The dashboard reads this to render a distinct "Sync canceled"
   * surface instead of misleading the user with "All caught up."
   */
  canceled?: boolean;
  /**
   * Short correlation id (8 hex chars) minted per orchestrated sync run.
   * The same id is stamped on every log line of the run, so a reported
   * failure can be matched to its logs.
   * Absent on results that did not go through SyncOrchestrator.startSync.
   */
  correlationId?: string;
}

/**
 * High-level sync phase - a human-readable progress indicator for long syncs.
 *
 * Motivated by the 2026-04-20 debugging session: the status bar showing
 * "Syncing..." for 2+ minutes on full-workspace discovery is visually
 * indistinguishable from a frozen sync, and users cancel healthy runs
 * thinking they're stuck. Phase-level visibility lets users see which
 * stage is actually running.
 *
 * - 'idle'                 : no sync running
 * - 'waiting-on-discovery' : sync queued, waiting for in-flight workspace
 *                            discovery (tree-picker cache) to finish so
 *                            both don't compete for the Notion rate limit
 * - 'discovering'          : walking Notion API to find pages/databases/views,
 *                            plus vault inventory reconcile
 * - 'applying'             : writing markdown files + downloading media
 * - 'finalizing'           : post-apply work (bases generation, cover extraction,
 *                            deletes, orphan cleanup)
 */
export type SyncPhase = 'idle' | 'waiting-on-discovery' | 'discovering' | 'applying' | 'finalizing';

export interface SyncRunStatus {
  state: 'idle' | 'syncing' | 'paused' | 'error';
  /**
   * Fine-grained phase within the 'syncing' state. Always 'idle' when
   * state is not 'syncing'. Dashboards surface this as "Discovering...",
   * "Writing files...", "Finalizing..." etc., so users can see progress
   * through the long-running stages instead of a single spinner.
   */
  phase: SyncPhase;
  lastSyncTime: string | null;
  lastResult: SyncResult | null;
  pendingChanges: number;
  conflicts: number;
}
