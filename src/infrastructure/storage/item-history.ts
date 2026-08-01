/**
 * ItemHistoryDB - Per-item change tracking.
 *
 * Records individual page sync events (created, updated, deleted, conflict-resolved, error)
 * in the history database. Used for per-page sync history in the dashboard.
 */

import type { HistoryDatabase } from './history-database';
import { createLogger } from '../../shared/logger';

const log = createLogger('ItemHistory');

export type ItemAction = 'created' | 'updated' | 'deleted' | 'conflict-resolved' | 'error';

export interface ItemHistoryEntry {
  id: number;
  workspaceId: string;
  notionId: string;
  obsidianPath: string | null;
  timestamp: string;
  direction: string;
  action: ItemAction;
  detail: string | null;
}

export class ItemHistoryDB {
  constructor(
    private historyDb: HistoryDatabase,
    private workspaceId: string = 'default',
  ) {}

  /**
   * Log a per-item sync event.
   */
  log(
    notionId: string,
    obsidianPath: string | null,
    direction: 'pull',
    action: ItemAction,
    detail?: string,
  ): void {
    try {
      const db = this.historyDb.getDb();
      db.run(
        `INSERT INTO item_history (workspace_id, notion_id, obsidian_path, timestamp, direction, action, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          this.workspaceId,
          notionId,
          obsidianPath,
          new Date().toISOString(),
          direction,
          action,
          detail ?? null,
        ],
      );
      this.historyDb.markDirty();
    } catch (error) {
      log.warn('Failed to log item history entry', error);
    }
  }

  /**
   * Get history for a specific Notion page.
   */
  getByNotionId(notionId: string, limit = 20): ItemHistoryEntry[] {
    try {
      const db = this.historyDb.getDb();
      const result = db.exec(
        `SELECT id, workspace_id, notion_id, obsidian_path, timestamp, direction, action, detail
         FROM item_history WHERE notion_id = ? AND workspace_id = ?
         ORDER BY timestamp DESC LIMIT ?`,
        [notionId, this.workspaceId, limit],
      );
      return this.parseResults(result);
    } catch (error) {
      log.warn(`Failed to load item history for ${notionId}`, error);
      return [];
    }
  }

  /**
   * Get recent item history across all pages.
   */
  getRecent(limit = 50): ItemHistoryEntry[] {
    try {
      const db = this.historyDb.getDb();
      const result = db.exec(
        `SELECT id, workspace_id, notion_id, obsidian_path, timestamp, direction, action, detail
         FROM item_history WHERE workspace_id = ?
         ORDER BY timestamp DESC LIMIT ?`,
        [this.workspaceId, limit],
      );
      return this.parseResults(result);
    } catch (error) {
      log.warn('Failed to load recent item history', error);
      return [];
    }
  }

  private parseResults(result: { columns: string[]; values: unknown[][] }[]): ItemHistoryEntry[] {
    const first = result[0];
    if (!first || first.values.length === 0) return [];
    return first.values.map((row) => ({
      id: row[0] as number,
      workspaceId: row[1] as string,
      notionId: row[2] as string,
      obsidianPath: row[3] as string | null,
      timestamp: row[4] as string,
      direction: row[5] as string,
      action: row[6] as ItemAction,
      detail: row[7] as string | null,
    }));
  }
}
