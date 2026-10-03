/**
 * ErrorLogDB - Persistent bounded error history in the history database.
 *
 * Records per-operation sync errors with workspace isolation. Bounded two
 * ways on DB open (see HistoryDatabase.pruneOldData): 30-day time prune and
 * a 500-row per-workspace cap.
 */

import type { HistoryDatabase } from './history-database';
import { createLogger } from '../../shared/logger';

const log = createLogger('ErrorLog');

/** One persisted sync error. */
export interface ErrorLogEntry {
  /** ISO timestamp of when the error was recorded. */
  timestamp: string;
  /** Correlation id of the sync run that produced it, when known. */
  correlationId?: string;
  /** Operation direction. Lite only ever pulls; the column predates that. */
  direction?: string;
  /** Stable classification code, when known. */
  code?: string;
  /** The error text as it appeared in SyncResult.errors. */
  message: string;
}

export class ErrorLogDB {
  constructor(
    private historyDb: HistoryDatabase,
    private workspaceId: string = 'default',
  ) {}

  /**
   * Add an error entry.
   * Pruning (30 days + 500-row cap) happens on DB open, not per-insert.
   */
  addEntry(entry: ErrorLogEntry): void {
    try {
      const db = this.historyDb.getDb();
      db.run(
        `INSERT INTO error_log (workspace_id, timestamp, correlation_id, direction, code, message)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          this.workspaceId,
          entry.timestamp,
          entry.correlationId ?? null,
          entry.direction ?? null,
          entry.code ?? null,
          entry.message,
        ],
      );
      this.historyDb.markDirty();
    } catch (error) {
      log.warn('Failed to persist error log entry', error);
    }
  }

  /**
   * Load recent error entries (newest first).
   */
  load(limit = 50): ErrorLogEntry[] {
    try {
      const db = this.historyDb.getDb();
      const results = db.exec(
        `SELECT timestamp, correlation_id, direction, code, message
         FROM error_log WHERE workspace_id = ?
         ORDER BY timestamp DESC LIMIT ?`,
        [this.workspaceId, limit],
      );
      const first = results[0];
      if (!first) return [];
      return first.values.map((row: unknown[]) => ({
        timestamp: row[0] as string,
        correlationId: (row[1] as string | null) ?? undefined,
        direction: (row[2] as string | null) ?? undefined,
        code: (row[3] as string | null) ?? undefined,
        message: row[4] as string,
      }));
    } catch (error) {
      log.warn('Failed to load error log', error);
      return [];
    }
  }
}
