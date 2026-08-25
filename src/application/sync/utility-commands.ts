/**
 * Utility sync commands: syncFile, unlinkFromNotion, batchProcess.
 *
 * Extracted from SyncCommandHandler to reduce file size (CQ-08).
 */

import type { SyncCommandHost } from './sync-command-types';
import type { AsyncMutex } from '../../shared/async-mutex';
import { MSG_OPERATION_IN_PROGRESS, MSG_NOT_LINKED } from './sync-command-types';
import { getErrorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/logger';
import { NOTICE_MEDIUM } from '../../shared/constants';

const log = createLogger('UtilityCommands');

/** Shared helper references passed from the facade. */
export interface UtilityCommandHelpers {
  guardOrNotify(): boolean;
  syncMutex: AsyncMutex;
}

/**
 * Sync a single file through the full conflict-detection pipeline.
 *
 * This is the USER-facing "Sync current file" command. It routes
 * through `engine.syncSingleEntry`, so a file edited on BOTH sides is
 * detected as a conflict: the local file is left untouched and Notion's
 * version is written beside it as `<name>.conflict.md` (#1919).
 *
 * NOT to be confused with `engine.syncSinglePage` which is the
 * pull-overwrite primitive used by background paths (layout-ready-
 * handler backfill, "Pull current file" command). That primitive
 * stays - this command was mis-wired to it. See
 * docs/reports/audits/2026-04-23-qa-session-findings.md#f-004.
 */
export async function syncFile(
  host: SyncCommandHost,
  helpers: UtilityCommandHelpers,
  path: string,
): Promise<void> {
  if (helpers.guardOrNotify()) return;

  if (helpers.syncMutex.isLocked) {
    host.notify(MSG_OPERATION_IN_PROGRESS, 5000);
    return;
  }

  log.info(`Syncing single file: ${path}`);

  const notionId = host.resolveNotionId(path);
  if (!notionId) {
    host.notify(MSG_NOT_LINKED, 12000);
    return;
  }

  const engine = host.getEngine();
  const fileName = path.split('/').pop()?.replace('.md', '') ?? path;
  host.notify(`N2O: Syncing "${fileName}"...`);
  try {
    /* Fetch the live last_edited_time from Notion so syncOneEntry's
     * conflict gate (entry.lastEditedTime !== record.notionLastEdited)
     * opens when Notion has changes the vault hasn't seen. Without
     * this, an identical stored timestamp would short-circuit the
     * conflict branch and fall back to overwrite. */
    const notionPage = await host.getNotionClient().getPage(notionId);
    const lastEditedTime = notionPage.last_edited_time;

    const folder = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
    const entry = {
      notionId,
      title: fileName,
      type: 'page' as const,
      fileName,
      vaultPath: path,
      folder,
      lastEditedTime,
    };
    /* `authoritative: true` routes this user-triggered sync through
     * the 4-way truth table (ADR sync-entry-4way-truth-table.md).
     * It always fetches, hashes both sides, and dispatches on actual
     * content change - sidestepping Notion's minute-granularity
     * last_edited_time that caused F-004, F-034, and the wdio #82
     * sub-minute race. */
    await engine.syncSingleEntry(entry, { authoritative: true });
    host.notify(`N2O: "${fileName}" synced successfully.`);
  } catch (error) {
    const msg = getErrorMessage(error);
    host.notify(`N2O: Failed to sync - ${msg}`, 10000);
  }
}

/**
 * Unlink a file from Notion - strips N2O frontmatter and removes sync record.
 */
export async function unlinkFromNotion(host: SyncCommandHost, path: string): Promise<void> {
  const fileName = path.split('/').pop()?.replace('.md', '') ?? path;
  await host.getVaultAdapter().unlinkFromNotion(path);

  // Remove sync record if one exists for this path
  let removedNotionId: string | undefined;
  const syncState = host.getSyncState();
  if (syncState) {
    const record = syncState.getByObsidianPath(path);
    if (record) {
      removedNotionId = record.notionId;
      syncState.deleteRecord(record.id);
    }
  }

  // Remove from selectedItems so the selection page count stays accurate
  if (removedNotionId) {
    const normId = removedNotionId.replace(/-/g, '');
    const idx = host.profile.selectedItems.findIndex(
      (item) => item.id.replace(/-/g, '') === normId,
    );
    if (idx !== -1) {
      host.profile.selectedItems.splice(idx, 1);
      await host.saveSettings();
    }
  }

  host.notify(`N2O: "${fileName}" unlinked from Notion.`, NOTICE_MEDIUM);
  host.refreshDashboards();
}

/** Run an async operation on a batch of items with progress/result Notices. */
export async function batchProcess<T extends { vaultPath: string }>(
  host: SyncCommandHost,
  items: T[],
  verb: string,
  pastVerb: string,
  fn: (item: T) => Promise<unknown>,
): Promise<{ succeeded: number; failed: number }> {
  host.notify(`N2O: ${verb} ${items.length} file${items.length > 1 ? 's' : ''}...`);
  let succeeded = 0;
  let failedCount = 0;
  for (const item of items) {
    try {
      await fn(item);
      succeeded++;
    } catch (err) {
      log.warn(`${verb} failed for ${item.vaultPath}`, err);
      failedCount++;
    }
  }
  if (failedCount === 0) {
    host.notify(`N2O: ${pastVerb} ${succeeded} file${succeeded > 1 ? 's' : ''}.`, 8000);
  } else {
    host.notify(`N2O: ${pastVerb} ${succeeded}, ${failedCount} failed.`, 10000);
  }
  return { succeeded, failed: failedCount };
}
