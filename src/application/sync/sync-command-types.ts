/**
 * Shared types, interfaces, and constants for sync commands.
 *
 * Extracted from sync-commands.ts to allow focused command modules
 * to import types without circular dependencies.
 */

import type { App } from 'obsidian';
import type { SyncOrchestrator, SyncResult } from './orchestrator';
import type { SyncEngine } from './engine';
import type { SyncStateDB } from '../../infrastructure/storage/sync-state';
import type { VaultAdapter } from '../../infrastructure/obsidian/vault';
import type { NotionClient } from '../../infrastructure/notion/client';
import type { WorkspaceProfile, N2OSettings } from '../../settings';
import type { CoreDatabase } from '../../infrastructure/storage/core-database';
import type { SyncHistoryDB } from '../../infrastructure/storage/sync-history';
import type { ErrorLogDB } from '../../infrastructure/storage/error-log';
import type { SyncRunStatus } from '../../domain/models/sync-result';

/**
 * Minimal status-bar contract used by SyncCommandHandler.
 * Decouples the application layer from the concrete StatusBarWidget in ui/.
 */
interface StatusUpdater {
  setOperationLabel(label: string | null): void;
  update(status: SyncRunStatus): void;
}

// ── Guard notification messages (CQ-15) ──────────────────────────
export const MSG_OPERATION_IN_PROGRESS = 'N2O: An operation is already running. Please wait.';
export const MSG_NO_PAGES_CONFIGURED =
  'N2O: No pages configured. Add Notion page URLs in settings.';
export const MSG_NOT_LINKED =
  'N2O: This file is not linked to Notion.\nAdd notion_id: <page-url> to the YAML frontmatter to link it.';
export const MSG_SYNC_ALREADY_RUNNING =
  'N2O: A sync is already running. Please wait for it to finish.';

/**
 * Host interface - the minimal contract the plugin provides to SyncCommandHandler.
 */
export interface SyncCommandHost {
  readonly app: App;
  readonly profile: WorkspaceProfile;

  // Components
  getSyncState(): SyncStateDB;
  getOrchestrator(): SyncOrchestrator;
  getEngine(): SyncEngine;
  getVaultAdapter(): VaultAdapter;
  getNotionClient(): NotionClient;
  getStatusBar(): StatusUpdater;
  getDatabase(): CoreDatabase;
  getSyncHistoryDB(): SyncHistoryDB;
  getErrorLogDB(): ErrorLogDB;

  // Guards
  guardSyncPreconditions(): string | null;
  resolveNotionId(path: string): string | undefined;

  // Settings persistence
  saveSettings(): Promise<void>;
  getSettings(): N2OSettings;

  // Dashboard refresh
  refreshDashboards(): void;

  // UI callbacks - decouples core from UI layer
  showDryRunPreview(result: SyncResult, onSync: () => Promise<void>): void;
  refreshOpenViews(result: SyncResult): void;
  /** Show a transient notification to the user. Decouples application layer from Obsidian's Notice. */
  notify(message: string, duration?: number): void;
}

/**
 * One shared "finished with errors" Notice for pull AND sync (#1755):
 * what succeeded, how many failed, and the first 3 real error messages plus a
 * "+N more" count. Shared so the two commands can never drift back to the old
 * errors[0]-only / "Unknown error" shape (avoiding-drift rule #1: twin paths
 * share a core).
 */
export function notifyResultErrors(
  host: SyncCommandHost,
  result: SyncResult,
  mode: 'pull' | 'sync',
): void {
  const { counts } = result;
  const title = mode === 'pull' ? 'Pull' : 'Sync';
  const okWord = mode === 'pull' ? 'pulled' : 'synced';
  const duration = (result.duration / 1000).toFixed(1);
  const successParts: string[] = [];
  if (counts.created > 0) successParts.push(`${counts.created} new`);
  if (counts.updated > 0) successParts.push(`${counts.updated} updated`);
  const successSummary = successParts.length > 0 ? `${successParts.join(', ')} ${okWord} OK` : '';
  const failMsg = counts.failed > 0 ? `${counts.failed} failed` : '';
  const errorCount = result.errors.length;
  const shownErrors = result.errors.slice(0, 3).join('\n');
  const moreErrors = errorCount > 3 ? `\n...and ${errorCount - 3} more` : '';
  const msgParts = [successSummary, failMsg].filter(Boolean).join(', ');
  host.notify(
    `N2O: ${title} finished with errors (${duration}s)\n${msgParts}${msgParts ? '\n' : ''}${shownErrors}${moreErrors}`,
    12000,
  );
}
