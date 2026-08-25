/**
 * SyncCommandHandler -- Thin facade that delegates to focused command modules.
 *
 * Owns the sync mutex and shared guard logic, but all command implementations
 * live in pull-commands.ts and utility-commands.ts.
 *
 * Split from a 1034-line monolith as part of CQ-08.
 */

import type { SyncResult } from './orchestrator';
import type { SyncCommandHost } from './sync-command-types';
import { MSG_OPERATION_IN_PROGRESS, MSG_NO_PAGES_CONFIGURED } from './sync-command-types';
import { AsyncMutex } from '../../shared/async-mutex';
import { createLogger } from '../../shared/logger';

// Re-export types so existing imports from './sync-commands' keep working
export type { SyncCommandHost } from './sync-command-types';
// Command module imports
import * as pull from './pull-commands';
import * as util from './utility-commands';

const log = createLogger('SyncCommands');

/**
 * Handles all sync-related commands: full sync, preview, pull, sync file.
 * Owns the `syncMutex` guard to prevent concurrent operations.
 */
export class SyncCommandHandler {
  /** Plugin-level guard: prevents concurrent sync operations (preview, sync, pull). */
  private syncMutex = new AsyncMutex();

  constructor(private host: SyncCommandHost) {}

  /** Check if a sync operation is currently in progress. */
  isSyncOperationInProgress(): boolean {
    return this.syncMutex.isLocked;
  }

  /**
   * Run a background operation under the SAME sync mutex that manual commands
   * observe, so background work can't run concurrently with a manual command
   * on the same records (#1466). No-ops when a sync is already in progress -
   * now logged rather than a silent undefined (#1550).
   */
  async runUnderSyncLock(fn: () => Promise<void>): Promise<void> {
    const result = await this.syncMutex.run(fn);
    if (!result.ran) {
      log.debug('runUnderSyncLock: skipped - a sync is already in progress');
    }
  }

  // ── Guards ──────────────────────────────────────────────────

  /** Returns true if the guard fired (caller should return early). */
  private guardOrNotify(): boolean {
    const msg = this.host.guardSyncPreconditions();
    if (msg) {
      this.host.notify(msg, 10000);
      return true;
    }
    return false;
  }

  /** Returns true if selected scope has no configured pages (caller should return early). */
  private guardSelectedScope(): boolean {
    if (
      this.host.profile.syncScope === 'selected' &&
      (!this.host.profile.selectedItems || this.host.profile.selectedItems.length === 0) &&
      (!this.host.profile.notionPages || this.host.profile.notionPages.length === 0)
    ) {
      this.host.notify(MSG_NO_PAGES_CONFIGURED);
      return true;
    }
    return false;
  }

  /**
   * Common guard-check-notify wrapper for pull/sync/preview commands.
   * Checks preconditions, sync direction, scope, and mutex in sequence.
   * Returns true if the command should proceed (all guards passed).
   */
  private guardPullCommand(): boolean {
    if (this.guardOrNotify()) return false;
    if (this.guardSelectedScope()) return false;
    if (this.syncMutex.isLocked) {
      this.host.notify(MSG_OPERATION_IN_PROGRESS, 5000);
      return false;
    }
    return true;
  }

  // ── Command helpers (bound for delegation) ─────────────────

  private get pullHelpers(): pull.CommandHelpers {
    return {
      guardOrNotify: () => this.guardOrNotify(),
      guardPullCommand: () => this.guardPullCommand(),
      guardSelectedScope: () => this.guardSelectedScope(),
      syncMutex: this.syncMutex,
      addToSyncHistory: (d, r) => this.addToSyncHistory(d, r),
    };
  }

  private get utilHelpers(): util.UtilityCommandHelpers {
    return {
      guardOrNotify: () => this.guardOrNotify(),
      syncMutex: this.syncMutex,
    };
  }

  // ── Pull commands ──────────────────────────────────────────

  async pullFromNotion(): Promise<void> {
    return pull.pullFromNotion(this.host, this.pullHelpers);
  }

  async pullFile(path: string): Promise<void> {
    return pull.pullFile(this.host, this.pullHelpers, path);
  }

  async syncNow(): Promise<void> {
    return pull.syncNow(this.host, this.pullHelpers);
  }

  async previewSync(): Promise<void> {
    return pull.previewSync(this.host, this.pullHelpers);
  }

  async retryFailedMedia(): Promise<void> {
    return pull.retryFailedMedia(this.host, this.pullHelpers);
  }

  // ── Utility commands ───────────────────────────────────────

  async syncFile(path: string): Promise<void> {
    return util.syncFile(this.host, this.utilHelpers, path);
  }

  /** Unlink a file from Notion - strips N2O frontmatter and removes its sync record. */
  async unlinkFromNotion(path: string): Promise<void> {
    return util.unlinkFromNotion(this.host, path);
  }

  async batchProcess<T extends { vaultPath: string }>(
    items: T[],
    verb: string,
    pastVerb: string,
    fn: (item: T) => Promise<unknown>,
  ): Promise<{ succeeded: number; failed: number }> {
    return util.batchProcess(this.host, items, verb, pastVerb, fn);
  }

  // ── Private helpers ────────────────────────────────────────

  /** Max error_log rows persisted per operation - bounds a pathological result. */
  private static readonly MAX_ERROR_LOG_ROWS = 10;

  private addToSyncHistory(duration: number, result: SyncResult): void {
    // Persist to SQLite via SyncHistoryDB
    const database = this.host.getDatabase();
    if (database) {
      this.host.getSyncHistoryDB().addEntry(duration, result);

      // Persist the operation's errors so the settings Activity view can show
      // recent failures across restarts (the in-memory diagnostics buffer can't).
      if (!result.success || result.errors.length > 0) {
        const errorLog = this.host.getErrorLogDB();
        const timestamp = new Date().toISOString();
        for (const message of result.errors.slice(0, SyncCommandHandler.MAX_ERROR_LOG_ROWS)) {
          errorLog.addEntry({
            timestamp,
            correlationId: result.correlationId,
            direction: 'pull',
            message,
          });
        }
      }
    }

    // Update any open views (change log panel)
    this.host.refreshOpenViews(result);
  }
}
