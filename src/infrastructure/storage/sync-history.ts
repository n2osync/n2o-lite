/**
 * SyncHistoryDB - Manages sync history persistence in the history database.
 *
 * Records sync cycle results with workspace isolation and time-based pruning (90 days).
 */

import type { HistoryDatabase } from './history-database';
import type { SyncResult } from '../../domain/models/sync-result';
import { createLogger } from '../../shared/logger';

const log = createLogger('SyncHistory');

export interface SyncHistoryEntry {
  timestamp: string;
  duration: number;
  direction: string;
  pagesSynced: number;
  pagesFailed: number;
  result: SyncResult;
}

export class SyncHistoryDB {
  constructor(
    private historyDb: HistoryDatabase,
    private workspaceId: string = 'default',
  ) {}

  /**
   * Add a sync history entry.
   * Time-based pruning (90 days) happens on DB open, not per-insert.
   */
  addEntry(duration: number, result: SyncResult, direction: string = 'pull'): void {
    try {
      const db = this.historyDb.getDb();
      const pagesSynced =
        (result.counts?.created ?? 0) + (result.counts?.updated ?? 0) || result.itemsSynced;
      const pagesFailed = result.counts?.failed ?? 0;
      db.run(
        `INSERT INTO sync_history (workspace_id, timestamp, duration, direction, pages_synced, pages_failed, result_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          this.workspaceId,
          new Date().toISOString(),
          duration,
          direction,
          pagesSynced,
          pagesFailed,
          JSON.stringify(result),
        ],
      );
      this.historyDb.markDirty();
    } catch (error) {
      log.warn('Failed to persist sync history entry', error);
    }
  }

  /**
   * Load recent sync history entries (newest first).
   */
  loadHistory(limit = 50): SyncHistoryEntry[] {
    try {
      const db = this.historyDb.getDb();
      const results = db.exec(
        `SELECT timestamp, duration, direction, pages_synced, pages_failed, result_json
         FROM sync_history WHERE workspace_id = ?
         ORDER BY timestamp DESC LIMIT ?`,
        [this.workspaceId, limit],
      );
      const first = results[0];
      if (!first) return [];
      return first.values.map((row: unknown[]) => ({
        timestamp: row[0] as string,
        duration: row[1] as number,
        direction: row[2] as string,
        pagesSynced: row[3] as number,
        pagesFailed: row[4] as number,
        result: JSON.parse(row[5] as string) as SyncResult,
      }));
    } catch (error) {
      log.warn('Failed to load sync history', error);
      return [];
    }
  }
}
