/**
 * ConflictAuditLog - records what N2O decided when Notion and Obsidian disagreed,
 * so a surprising result can be traced back to the decision that caused it.
 *
 * The SQLite table is still called `merge_audit` and still carries the
 * `auto_merge_count` and `operations_json` columns. Those are persisted state
 * with rows in shipped 1.0.3 vaults, so they are read, not renamed. Nothing
 * writes a meaningful value into either since automatic merge was removed
 * (#1919); see ConflictAuditDetails.
 */

import type { HistoryDatabase } from '../../infrastructure/storage/history-database';
import { createLogger } from '../../shared/logger';

const log = createLogger('ConflictAudit');

/**
 * One recorded merge action, from before #1919 removed automatic merge.
 *
 * Kept ONLY to read `operations_json` out of rows written by 1.0.x. Nothing
 * produces one now. It is persisted on-disk state, so changing the shape needs a
 * migration, not an edit.
 */
export interface ConflictOperation {
  type: 'apply-notion' | 'apply-obsidian' | 'apply-both';
  target: 'property' | 'block' | 'title';
  key: string;
  value: unknown;
}

type ConflictDecision =
  /** Both sides changed; the local file was left alone and Notion's version
   *  written beside it as `<name>.conflict.md` (#1919). */
  | 'conflict-file-written'
  /** Explicit "Overwrite from Notion": the local version was replaced. */
  | 'conflict-notion-wins'
  | 'skipped';

export interface ConflictAuditEntry {
  id: string;
  timestamp: string;
  notionId: string;
  title: string;
  decision: ConflictDecision;
  details: ConflictAuditDetails;
}

interface ConflictAuditDetails {
  conflictCount: number;
  unchangedCount: number;
  /** Content hash of the Notion version when the conflict was recorded. */
  notionHash?: string;
  /** Content hash of the Obsidian version when the conflict was recorded. */
  obsidianHash?: string;
  /**
   * Legacy columns. Only rows written before #1919 carry a meaningful value;
   * `log()` writes 0 and `[]`. Present so `getRecent()` can still surface an
   * old row honestly instead of dropping half of it.
   */
  autoMergeCount?: number;
  operations?: ConflictOperation[];
}

export class ConflictAuditLog {
  constructor(
    private historyDb: HistoryDatabase,
    private workspaceId: string = 'default',
  ) {}

  /**
   * Record one conflict decision.
   */
  log(entry: ConflictAuditEntry): void {
    const db = this.historyDb.getDb();
    db.run(
      `INSERT INTO merge_audit (
        id, workspace_id, timestamp, notion_id, title, decision,
        auto_merge_count, conflict_count, unchanged_count, operations_json,
        notion_hash, obsidian_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        this.workspaceId,
        entry.timestamp,
        entry.notionId,
        entry.title,
        entry.decision,
        // Legacy columns, see ConflictAuditDetails.
        0,
        entry.details.conflictCount,
        entry.details.unchangedCount,
        '[]',
        entry.details.notionHash ?? null,
        entry.details.obsidianHash ?? null,
      ],
    );
    this.historyDb.markDirty();
    log.debug(
      `Audit logged: ${entry.notionId} - ${entry.decision} (${entry.details.conflictCount} conflicts)`,
    );
  }

  /**
   * Get recent conflict decisions, newest first.
   */
  getRecent(limit = 50): ConflictAuditEntry[] {
    const db = this.historyDb.getDb();
    const stmt = db.prepare(
      'SELECT * FROM merge_audit WHERE workspace_id = ? ORDER BY timestamp DESC LIMIT ?',
    );
    stmt.bind([this.workspaceId, limit]);
    const entries: ConflictAuditEntry[] = [];
    try {
      while (stmt.step()) {
        const row = stmt.getAsObject();
        entries.push({
          id: row['id'] as string,
          timestamp: row['timestamp'] as string,
          notionId: row['notion_id'] as string,
          title: (row['title'] as string) ?? '',
          decision: row['decision'] as ConflictDecision,
          details: {
            autoMergeCount: row['auto_merge_count'] as number,
            conflictCount: row['conflict_count'] as number,
            unchangedCount: row['unchanged_count'] as number,
            operations: JSON.parse(
              (row['operations_json'] as string) || '[]',
            ) as ConflictOperation[],
            notionHash: (row['notion_hash'] as string) ?? undefined,
            obsidianHash: (row['obsidian_hash'] as string) ?? undefined,
          },
        });
      }
    } finally {
      stmt.free();
    }
    return entries;
  }

  /**
   * Get audit entries for a specific Notion page.
   */
  getByNotionId(notionId: string, limit = 20): ConflictAuditEntry[] {
    const db = this.historyDb.getDb();
    const stmt = db.prepare(
      'SELECT * FROM merge_audit WHERE notion_id = ? AND workspace_id = ? ORDER BY timestamp DESC LIMIT ?',
    );
    stmt.bind([notionId, this.workspaceId, limit]);
    const entries: ConflictAuditEntry[] = [];
    try {
      while (stmt.step()) {
        const row = stmt.getAsObject();
        entries.push({
          id: row['id'] as string,
          timestamp: row['timestamp'] as string,
          notionId: row['notion_id'] as string,
          title: (row['title'] as string) ?? '',
          decision: row['decision'] as ConflictDecision,
          details: {
            autoMergeCount: row['auto_merge_count'] as number,
            conflictCount: row['conflict_count'] as number,
            unchangedCount: row['unchanged_count'] as number,
            operations: JSON.parse(
              (row['operations_json'] as string) || '[]',
            ) as ConflictOperation[],
            notionHash: (row['notion_hash'] as string) ?? undefined,
            obsidianHash: (row['obsidian_hash'] as string) ?? undefined,
          },
        });
      }
    } finally {
      stmt.free();
    }
    return entries;
  }
}
