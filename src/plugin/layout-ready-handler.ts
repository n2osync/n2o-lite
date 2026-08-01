/**
 * LayoutReadyHandler - deferred initialization after Obsidian layout is ready.
 *
 * Handles database opening and DB-dependent component wiring.
 *
 * Extracted from main.ts to keep the plugin class slim.
 */

import { Notice } from 'obsidian';
import type { InitHost } from './plugin-host';
import { DatabaseManager } from '../infrastructure/storage/database-manager';
import { DashboardView, DASHBOARD_VIEW_TYPE } from '../ui/dashboard';
import { DbErrorModal } from '../ui/db-error-modal';
import { createLogger } from '../shared/logger';
import { getErrorMessage } from '../shared/errors';

const log = createLogger('LayoutReady');

/**
 * Execute all deferred initialization that depends on the Obsidian layout being ready.
 */
export async function handleLayoutReady(plugin: InitHost): Promise<void> {
  // Open storage (CoreDatabase + HistoryDatabase + file stores + migration)
  const dbManager = new DatabaseManager();
  try {
    await dbManager.open(plugin.app);
  } catch (error) {
    const msg = getErrorMessage(error);
    log.error('Fatal: database failed to open', error);
    plugin.dbInitFailed = true;
    new DbErrorModal(plugin.app, dbManager, msg, async () => {
      plugin.dbInitFailed = false;
      await continueInit(plugin, dbManager);
    }).open();
    return;
  }

  await continueInit(plugin, dbManager);
}

/**
 * Post-DB-open initialization: wire components and kick off background work.
 * Called directly on the happy path, or from DbErrorModal on successful retry.
 */
async function continueInit(plugin: InitHost, dbManager: DatabaseManager): Promise<void> {
  // Notify user if corruption was detected and recovered
  if (dbManager.wasCorrupted) {
    const recovered = dbManager.recoveredRecords;
    const detail =
      recovered > 0
        ? `${recovered} sync records were salvaged. `
        : 'Your sync state will be recovered from vault files on the next sync. ';
    new Notice(
      `N2O: Database was corrupted and has been rebuilt. ${detail}Corrupt backup saved.`,
      15000,
    );
  }

  // Store database manager on plugin and create all DB-dependent components
  plugin.setDatabaseManager(dbManager);
  plugin.initializeDatabaseComponents();

  // Fetch workspace name in background for the dashboard connection indicator
  if (plugin.profile.notionToken) {
    void (async () => {
      try {
        const connResult = await plugin.testConnection();
        if (connResult.success && connResult.workspaceName) {
          plugin.cachedWorkspaceName = connResult.workspaceName;
          void plugin.getDashboardManager().refreshDashboardPanels();
        }
      } catch {
        /* ignore - dashboard will show "Not connected" */
      }
    })();
  }

  log.info('N2O ready');

  // Background discovery: populate PageCacheStore if empty and connected.
  // Uses shared lock so modals opening during discovery await the same operation.
  if (plugin.profile.notionToken) {
    const cache = plugin.getDatabase().getPageCacheStore();
    if (cache.isEmpty()) {
      log.info('PageCacheStore empty - starting background discovery');
      plugin
        .runSharedDiscovery((msg) => {
          log.debug(`Background discovery: ${msg}`);
        })
        .then(() => {
          log.info('Background discovery complete');
          plugin.getDashboardManager()?.refreshDashboards();
        })
        .catch((err) => {
          log.warn(`Background discovery failed: ${getErrorMessage(err)}`);
        });
    }
  }

  // Refresh any dashboards that were workspace-restored before DB was ready
  const restoredLeaves = plugin.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
  for (const leaf of restoredLeaves) {
    const view = leaf.view;
    if (view && typeof (view as DashboardView).refresh === 'function') {
      void (view as DashboardView).refresh();
    }
  }

  // Auto-open dashboard if no leaves exist (handles disable/re-enable and fresh install)
  if (plugin.profile.notionToken && restoredLeaves.length === 0) {
    await plugin.getDashboardManager().openDashboard();
  }

  // First install (no token) - open the dashboard; its connect hero drives onboarding.
  if (!plugin.profile.notionToken) {
    await plugin.getDashboardManager().openDashboard();
  }
}
