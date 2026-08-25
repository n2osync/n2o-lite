/**
 * Pull-side sync commands: pullFromNotion, pullFile, syncNow, previewSync.
 *
 * Extracted from SyncCommandHandler to reduce file size (CQ-08).
 * Each function receives the host + shared helpers as parameters.
 */

import type { SyncResult } from './orchestrator';
import { ERR_SYNC_IN_PROGRESS } from './orchestrator';
import type { SyncCommandHost } from './sync-command-types';
import type { AsyncMutex } from '../../shared/async-mutex';
import { MSG_SYNC_ALREADY_RUNNING, MSG_NOT_LINKED, notifyResultErrors } from './sync-command-types';
import { getErrorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/logger';
import { LITE_PAGE_LIMIT } from './page-budget';
import { writeWelcomeNote, WELCOME_NOTE_NAME } from './welcome-note';

const log = createLogger('PullCommands');

/** Shared helper references passed from the facade. */
export interface CommandHelpers {
  guardOrNotify(): boolean;
  guardPullCommand(): boolean;
  guardSelectedScope(): boolean;
  syncMutex: AsyncMutex;
  addToSyncHistory(duration: number, result: SyncResult): void;
}

/**
 * Notification twins shared by pullFromNotion and syncNow. Both commands must
 * report these outcomes with identical wording, so the single copy lives here
 * (avoiding-drift rule 1: twin paths share a core, never copy-paste).
 */
function notifyEmptyFirstSync(host: SyncCommandHost, result: SyncResult): void {
  if (result.itemsSynced !== 0 || result.counts.total !== 0) return;
  if (host.getSyncState().getAllRecords().length !== 0) return;
  const isOAuth = host.profile.authType === 'oauth';
  host.notify(
    isOAuth
      ? 'N2O: No Notion pages found. Try reconnecting via OAuth to grant access to more pages, or check your sync scope in Settings.'
      : "N2O: No Notion pages found. Make sure you've shared your pages with the N2O integration in Notion (click the ... menu on a page, then Connect to, then your integration).",
    15000,
  );
}

function notifyOrphanedFiles(host: SyncCommandHost, result: SyncResult): void {
  const { counts } = result;
  if (counts.orphaned === 0) return;
  const orphanNames = result.items
    .filter((i) => i.status === 'orphaned')
    .map((i) => i.title)
    .slice(0, 5)
    .join(', ');
  const more = counts.orphaned > 5 ? ` +${counts.orphaned - 5} more` : '';
  const dest = host.profile.syncDeletedItems ? 'trash' : '_orphaned folder';
  host.notify(
    `N2O: ${counts.orphaned} file${counts.orphaned > 1 ? 's' : ''} moved to ${dest} (no longer in Notion):\n${orphanNames}${more}`,
    15000,
  );
}

/**
 * Name the conflict files a sync wrote (#1919).
 *
 * Lite never merges: when a page changed in Notion AND in Obsidian, the local
 * file is left alone and Notion's version lands beside it. The user has to be
 * told where, or the conflict file is just litter they did not ask for.
 *
 * Named here in ONE summary rather than a Notice per page: an unresolved
 * conflict is re-detected on every sync, so per-page notices would fire again
 * and again for the same unresolved thing.
 */
function notifyConflicts(host: SyncCommandHost, result: SyncResult): void {
  const conflicts = result.items.filter((i) => i.status === 'local-change');
  if (conflicts.length === 0) return;
  const names = conflicts
    .map((i) => i.title)
    .slice(0, 5)
    .join(', ');
  const more = conflicts.length > 5 ? ` +${conflicts.length - 5} more` : '';
  const plural = conflicts.length > 1 ? 's' : '';
  host.notify(
    `N2O: ${conflicts.length} page${plural} changed in both Notion and Obsidian. Your file${plural} ${conflicts.length > 1 ? 'were' : 'was'} left untouched and Notion's version saved beside ${conflicts.length > 1 ? 'them' : 'it'} as .conflict.md:\n${names}${more}`,
    15000,
  );
}

/**
 * Report a run that hit Lite's page limit (#1918).
 *
 * A truncated run must never pass as "sync complete". The summary notice above
 * says how many were written; this says how many were not, and why, so the user
 * is never left to work out on their own why a page they expected is missing.
 */
function notifyPageLimit(host: SyncCommandHost, result: SyncResult): void {
  const skipped = result.counts.skipped ?? 0;
  if (skipped === 0) return;
  const total = result.truncated?.total ?? result.itemsSynced + skipped;
  const names = result.items
    .filter((i) => i.status === 'skipped')
    .map((i) => i.title)
    .slice(0, 5)
    .join(', ');
  const more = skipped > 5 ? ` +${skipped - 5} more` : '';
  host.notify(
    `N2O: ${result.itemsSynced} of ${total} pages synced, ${skipped} skipped. ` +
      `N2O Sync Lite syncs up to ${LITE_PAGE_LIMIT} pages per vault, and everything ` +
      `already synced keeps syncing. The full edition has no limit.
${names}${more}`,
    20000,
  );
}

/**
 * Write the welcome note after the first successful sync (#1973).
 *
 * Once, ever, and only when something actually synced - a run that pulled
 * nothing has nothing to welcome anyone to. Failure is swallowed on purpose:
 * a missing welcome note must never turn a successful sync into a failed one,
 * and writeWelcomeNote already logs the reason.
 */
async function maybeWriteWelcomeNote(host: SyncCommandHost, result: SyncResult): Promise<void> {
  const settings = host.getSettings();
  if (settings.welcomeNoteWritten) return;
  if (!result.success || result.itemsSynced === 0) return;

  const written = await writeWelcomeNote(
    host.getVaultAdapter(),
    host.profile.syncFolder,
    result.itemsSynced,
  );
  // Record the attempt either way. A user who deleted the note should not have
  // it reappear on the next sync.
  settings.welcomeNoteWritten = true;
  await host.saveSettings();
  if (written) {
    host.notify(`N2O: Added "${WELCOME_NOTE_NAME}" to your sync folder. Worth a read.`, 10000);
  }
}

/**
 * Pull from Notion -- Notion wins on conflicts, no three-way merge.
 */
export async function pullFromNotion(
  host: SyncCommandHost,
  helpers: CommandHelpers,
): Promise<void> {
  if (!helpers.guardPullCommand()) return;

  await helpers.syncMutex.run(async () => {
    const orchestrator = host.getOrchestrator();
    const statusBar = host.getStatusBar();

    host.notify('N2O: Pulling from Notion...');
    statusBar.setOperationLabel('Pulling...');
    statusBar.update({ ...orchestrator.getStatus(), state: 'syncing' });

    let result;
    try {
      result = await orchestrator.startPull();
    } catch (error) {
      const msg = getErrorMessage(error);
      log.error('Pull failed with uncaught error', error);
      statusBar.update(orchestrator.getStatus());
      host.notify(`N2O: Pull failed - ${msg}`, 12000);
      return;
    }
    statusBar.update(orchestrator.getStatus());

    try {
      if (result.duration === 0 && result.errors.includes(ERR_SYNC_IN_PROGRESS)) {
        host.notify(MSG_SYNC_ALREADY_RUNNING, 5000);
      } else {
        helpers.addToSyncHistory(result.duration, result);

        const duration = (result.duration / 1000).toFixed(1);
        const { counts } = result;

        if (result.success) {
          const parts: string[] = [];
          if (counts.created > 0) parts.push(`${counts.created} new`);
          if (counts.updated > 0) parts.push(`${counts.updated} updated`);
          if (counts.unchanged > 0) parts.push(`${counts.unchanged} unchanged`);
          if (counts.orphaned > 0) parts.push(`${counts.orphaned} orphaned`);
          if ((counts.skipped ?? 0) > 0) parts.push(`${counts.skipped} skipped`);
          const summary = parts.length > 0 ? parts.join(', ') : 'nothing to pull';
          host.notify(`N2O: Pull complete (${duration}s)\n${summary}`, 8000);

          notifyEmptyFirstSync(host, result);
          notifyPageLimit(host, result);
          notifyOrphanedFiles(host, result);
          await maybeWriteWelcomeNote(host, result);
        } else {
          notifyResultErrors(host, result, 'pull');
        }
      } // end else (not "already in progress")
    } finally {
      host.refreshDashboards();
    }
  });
}

/**
 * Pull a single file from Notion, replacing the local version.
 *
 * The one caller that opts OUT of the local-edit guard: it sits behind
 * OverwriteConfirmModal, so the user has already been told and agreed.
 */
export async function pullFile(
  host: SyncCommandHost,
  helpers: CommandHelpers,
  path: string,
): Promise<void> {
  if (helpers.guardOrNotify()) return;
  log.info(`Pulling single file: ${path}`);

  const notionId = host.resolveNotionId(path);
  if (!notionId) {
    host.notify(MSG_NOT_LINKED, 12000);
    return;
  }

  const engine = host.getEngine();
  const fileName = path.split('/').pop()?.replace('.md', '') ?? path;
  host.notify(`N2O: Pulling "${fileName}" from Notion...`);
  try {
    await engine.syncSinglePage(notionId, path, undefined, { overwriteDirty: true });
    host.notify(`N2O: "${fileName}" pulled from Notion.`);
  } catch (error) {
    const msg = getErrorMessage(error);
    host.notify(`N2O: Failed to pull - ${msg}`, 10000);
  }
}

/**
 * Full sync. On a page changed in both places the local file is left alone
 * and Notion's version is written beside it as `<name>.conflict.md` (#1919).
 */
export async function syncNow(host: SyncCommandHost, helpers: CommandHelpers): Promise<void> {
  if (!helpers.guardPullCommand()) return;

  await helpers.syncMutex.run(async () => {
    const orchestrator = host.getOrchestrator();
    const statusBar = host.getStatusBar();

    host.notify('N2O: Syncing...');
    statusBar.setOperationLabel('Syncing...');
    statusBar.update({ ...orchestrator.getStatus(), state: 'syncing' });

    let result;
    try {
      result = await orchestrator.startSync();
    } catch (error) {
      const msg = getErrorMessage(error);
      log.error('Sync failed with uncaught error', error);
      statusBar.update(orchestrator.getStatus());
      host.notify(`N2O: Sync failed - ${msg}`, 12000);
      return;
    }
    statusBar.update(orchestrator.getStatus());

    try {
      // Handle "already in progress" -- don't return early, let finally handle cleanup + refreshDashboards
      if (result.duration === 0 && result.errors.includes(ERR_SYNC_IN_PROGRESS)) {
        host.notify(MSG_SYNC_ALREADY_RUNNING, 5000);
      } else {
        // Add to change log
        helpers.addToSyncHistory(result.duration, result);

        // Rich sync summary notice
        const duration = (result.duration / 1000).toFixed(1);
        const { counts } = result;

        if (result.success) {
          const parts: string[] = [];
          if (counts.created > 0) parts.push(`${counts.created} new`);
          if (counts.updated > 0) parts.push(`${counts.updated} updated`);
          if (counts.unchanged > 0) parts.push(`${counts.unchanged} unchanged`);
          if (counts.orphaned > 0) parts.push(`${counts.orphaned} orphaned`);
          if (counts.localChanges > 0) parts.push(`${counts.localChanges} conflicts`);
          if ((counts.skipped ?? 0) > 0) parts.push(`${counts.skipped} skipped`);
          const summary = parts.length > 0 ? parts.join(', ') : 'nothing to sync';
          host.notify(`N2O: Sync complete (${duration}s)\n${summary}`, 8000);

          notifyEmptyFirstSync(host, result);
          notifyPageLimit(host, result);
          notifyConflicts(host, result);
          await maybeWriteWelcomeNote(host, result);
          notifyOrphanedFiles(host, result);
        } else {
          notifyResultErrors(host, result, 'sync');
        }

        // First sync celebration -- one-time notice when 10+ pages synced
        if (result.success && result.itemsSynced >= 10) {
          const syncSettings = host.getSettings();
          if (!syncSettings.firstSyncCelebrated) {
            host.notify(
              `N2O synced ${result.itemsSynced} pages! Loving it? Leave a review on Obsidian.`,
              8000,
            );
            syncSettings.firstSyncCelebrated = true;
            await host.saveSettings();
          }
        }
      } // end else (not "already in progress")
    } finally {
      host.refreshDashboards();
    }
  });
}

/**
 * Preview sync (dry run) -- shows what would change without applying.
 */
export async function previewSync(host: SyncCommandHost, helpers: CommandHelpers): Promise<void> {
  if (!helpers.guardPullCommand()) return;

  await helpers.syncMutex.run(async () => {
    const orchestrator = host.getOrchestrator();
    const statusBar = host.getStatusBar();

    host.notify('N2O: Previewing sync...');
    statusBar.update({ ...orchestrator.getStatus(), state: 'syncing' });

    const result = await orchestrator.startSync({ dryRun: true });
    statusBar.update(orchestrator.getStatus());
    host.refreshDashboards();

    host.showDryRunPreview(result, () => syncNow(host, helpers));
  });
}

/**
 * Retry only pages with failed media downloads.
 * Re-syncs each failed page individually via syncSinglePage (no full sync).
 * Uses syncMutex so it waits for any running sync to finish first.
 */
export async function retryFailedMedia(
  host: SyncCommandHost,
  helpers: CommandHelpers,
): Promise<void> {
  // Skip guardPullCommand() - it rejects when mutex is locked.
  // We want to wait for the running sync, not reject.
  const preconditionError = host.guardSyncPreconditions();
  if (preconditionError) {
    host.notify(preconditionError, 5000);
    return;
  }

  // Wait for any running sync to finish (up to 5 minutes)
  if (helpers.syncMutex.isLocked) {
    host.notify('N2O: Will retry failed downloads after current sync completes.', 5000);
    const maxWait = 300_000;
    const start = Date.now();
    while (helpers.syncMutex.isLocked && Date.now() - start < maxWait) {
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    if (helpers.syncMutex.isLocked) {
      host.notify('N2O: Sync is still running. Try again later.', 5000);
      return;
    }
  }

  await helpers.syncMutex.run(async () => {
    const syncState = host.getSyncState();
    // Only re-sync pages that have at least one RETRYABLE failure. A page whose
    // media is permanently gone (404, forbidden) can never recover from a retry,
    // so re-syncing it just burns an API call and reports a false "still failing"
    // (#1780). Those items stay on the dashboard under "unavailable at source".
    const records = syncState
      .getAllRecords()
      .filter((r) => r.failedMedia?.some((m) => m.class !== 'permanent'));

    if (records.length === 0) {
      host.notify(
        'N2O: No downloads to retry - any remaining failures are permanent (source is gone).',
      );
      return;
    }

    const totalFailed = records.reduce((sum, r) => sum + (r.failedMedia?.length ?? 0), 0);
    host.notify(`N2O: Retrying ${totalFailed} failed downloads across ${records.length} pages...`);

    const engine = host.getEngine();
    let fixed = 0;

    for (const record of records) {
      try {
        await engine.syncSinglePage(record.notionId, record.obsidianPath);
        const updated = syncState.getByNotionId(record.notionId);
        // Recovered = no RETRYABLE failures left. A leftover permanent item
        // (source gone) is not "still failing" for the purpose of this retry.
        if (!updated?.failedMedia?.some((m) => m.class !== 'permanent')) fixed++;
      } catch (e) {
        log.warn(`Media retry failed for ${record.obsidianPath}: ${getErrorMessage(e)}`);
      }
    }

    const remaining = records.length - fixed;
    if (remaining === 0) {
      host.notify('N2O: All downloads recovered!');
    } else {
      host.notify(`N2O: ${fixed} pages recovered, ${remaining} still failing.`);
    }

    host.refreshDashboards();
  });
}
