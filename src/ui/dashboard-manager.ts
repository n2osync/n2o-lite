/**
 * DashboardManager - Extracted from main.ts to reduce God Class size.
 *
 * Owns all dashboard/sync-log view lifecycle, data building, and callback wiring.
 * Communicates with the plugin via the DashboardHost interface.
 */

import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import { N2OError, getErrorMessage } from '../shared/errors';
import { openExternalUrl } from '../shared/electron-cookies';
import { NOTICE_SHORT, NOTICE_ERROR } from '../shared/constants';
import type { SyncOrchestrator, SyncResultItem } from '../application/sync/orchestrator';
import type { SyncEngine } from '../application/sync/engine';
import type { SyncStateDB } from '../infrastructure/storage/sync-state';
import type { CoreDatabase } from '../infrastructure/storage/core-database';
import type { SyncHistoryDB } from '../infrastructure/storage/sync-history';
import type { ErrorLogDB, ErrorLogEntry } from '../infrastructure/storage/error-log';
import type { VaultAdapter } from '../infrastructure/obsidian/vault';
import type { NotionClient } from '../infrastructure/notion/client';
import type { StatusBarWidget } from './status-bar';
import type { N2OSettings, WorkspaceProfile } from '../settings';
import type { SettingTabLike } from './setting-tab-like';
import { DashboardView, DASHBOARD_VIEW_TYPE } from './dashboard';
import type { DashboardData, DashboardCallbacks, DashboardPluginRef } from './dashboard';
import type { SyncHistoryEntry } from '../infrastructure/storage/sync-history';
import { SyncTreePicker } from './sync-tree-picker';
import { ResetConfirmModal } from './reset-confirm-modal';
import { openSyncSettings } from './sync-config-modal';

/**
 * Host interface - the minimal contract the plugin provides to DashboardManager.
 * Avoids circular dependencies by keeping the plugin behind an interface.
 */
export interface DashboardHost {
  readonly app: App;
  readonly settings: N2OSettings;
  readonly profile: WorkspaceProfile;
  readonly dbInitFailed: boolean;
  readonly cachedWorkspaceName: string | null;

  // Components
  getSyncState(): SyncStateDB;
  getOrchestrator(): SyncOrchestrator;
  getStatusBar(): StatusBarWidget;
  getNotionClient(): NotionClient;
  getDatabase(): CoreDatabase;
  getSyncHistoryDB(): SyncHistoryDB;
  getErrorLogDB(): ErrorLogDB;
  getSettingTab(): SettingTabLike;
  getVaultAdapter(): VaultAdapter;

  getEngine(): SyncEngine;

  // Connection flows
  startOAuthFlow(): void;
  testConnection(): Promise<{ success: boolean; detail: string; workspaceName?: string }>;

  // Actions the dashboard delegates back to the plugin
  pullFromNotion(): Promise<void>;
  syncNow(): Promise<void>;
  previewSync(): Promise<void>;
  scanVault(): Promise<void>;
  scanVaultIds(): Promise<Set<string>>;
  retryFailedMedia(): Promise<void>;
  saveSettings(): Promise<void>;
  resetN2O(): Promise<void>;
  openUpgradeModal(): void;
  runSharedDiscovery(onProgress?: (msg: string) => void): Promise<void>;
  /** Authoritative "is a workspace discovery in flight" flag - source of
      truth for the hero radar scan scene. Set by runSharedDiscovery's
      shared lock, read by every caller. */
  readonly isDiscoveryRunning: boolean;
}

/**
 * Manages dashboard views, sync log panels, and all related data/callback wiring.
 * Implements DashboardPluginRef so DashboardView can call into it.
 */
export class DashboardManager implements DashboardPluginRef {
  /**
   * Latest progress message from the active discovery (e.g. "Searching
   * for pages... 200 items found"). Nulled between runs. The "is discovery
   * running" signal is NOT stored here - it's derived from
   * `host.isDiscoveryRunning`, the shared lock in main.ts. Keeping a
   * cached boolean here would drift (see avoiding-drift rule 4).
   */
  private pageDiscoveryMessage: string | null = null;

  /**
   * Latest sync progress emit. Held here so a refresh() that rebuilds
   * `data` from buildData() doesn't wipe the live message. Pre-fix
   * buildData() unconditionally returned syncProgress: null, so during
   * a 95-min real-workspace sync the hero kept snapping back to the
   * "Discovering pages... / Scanning your Notion workspace." static
   * fallback every time the timeAgo timer fired a refresh.
   */
  private lastSyncProgress: { message: string; current: number; total: number } | null = null;

  /**
   * Rate window for ETA computation - we keep the last N (current, ts)
   * samples and project the remaining items at the observed rate. Uses
   * a rolling window so a slow stretch in the middle doesn't permanently
   * inflate the ETA, and a fast burst at the start doesn't deflate it.
   */
  private rateSamples: { current: number; at: number }[] = [];
  private static readonly RATE_WINDOW = 20;

  /**
   * Per-database live sync counts. Key is the folder segment under the
   * sync root - e.g. for vaultPath "Notion/Books DB/My Book.md" the key
   * is "Books DB". The dashboard joins this against the sanitized
   * selected DB titles to render "12 / 245" next to each DB row in the
   * scopecard during a sync. Cleared on phase=idle.
   */
  private liveDbCounts: Map<string, number> = new Map();

  constructor(private host: DashboardHost) {}

  /**
   * Called by `runSharedDiscovery` in main.ts on every progress tick, and
   * with `null` once when the run finishes to clear the stored message.
   * Also updates the hero sub in-place on every tick so the scan scene
   * feels alive without a full re-render (discovery fires often).
   */
  setPageDiscoveryMessage(msg: string | null): void {
    this.pageDiscoveryMessage = msg;
    if (msg === null) return;
    for (const leaf of this.host.app.workspace.getLeavesOfType('n2o-dashboard')) {
      const view = leaf.view as { contentEl?: HTMLElement } | undefined;
      const sub = view?.contentEl?.querySelector('.n2o-dash-hybrid-sub');
      if (sub instanceof HTMLElement) sub.textContent = msg;
    }
  }

  /**
   * Persist the latest engine.onProgress emit so subsequent buildData()
   * calls return the real message instead of null. Cleared on the
   * orchestrator's idle phase (sync done) so the next render falls back
   * to the post-sync "All caught up" copy.
   */
  setSyncProgress(progress: { message: string; current: number; total: number } | null): void {
    this.lastSyncProgress = progress;
    if (progress === null) {
      this.rateSamples = [];
      this.liveDbCounts.clear();
      return;
    }
    if (progress.total > 0 && progress.current >= 0) {
      this.rateSamples.push({ current: progress.current, at: Date.now() });
      while (this.rateSamples.length > DashboardManager.RATE_WINDOW) this.rateSamples.shift();
    }
  }

  /**
   * Append a per-item event from the engine's onItem callback to the
   * per-DB live count buffer. Skips 'unchanged' so the counts only
   * reflect actual write activity. Caller (main.ts) triggers this on
   * every engine.onItem; we throttle DOM updates to 250ms so we don't
   * re-render the panel for every item on a multi-thousand-page sync.
   */
  pushLiveItem(item: SyncResultItem): void {
    if (item.status === 'unchanged') return;
    // Per-DB count: derive the parent folder under the sync root from the
    // vaultPath. Items at the root (e.g. "Notion/Standalone.md") have no
    // DB folder and are skipped. Items under a DB ("Notion/Books DB/My Book.md")
    // increment the count for "Books DB".
    const segs = item.vaultPath.split('/');
    if (segs.length >= 3) {
      const dbFolder = segs[segs.length - 2];
      if (dbFolder !== undefined) {
        this.liveDbCounts.set(dbFolder, (this.liveDbCounts.get(dbFolder) ?? 0) + 1);
      }
    }
    // Throttled DOM update: refresh the count cells at most every 250ms.
    // A 5,000-page sync emits items at ~25/s on a fast connection - rebuilding
    // the rows on each one would burn paint cycles for no UX benefit.
    const now = Date.now();
    if (now - this.lastLiveRenderAt < 250) return;
    this.lastLiveRenderAt = now;
    const dbCountsObj = Object.fromEntries(this.liveDbCounts);
    for (const leaf of this.host.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)) {
      const view = leaf.view;
      if (view && typeof (view as DashboardView).updateLiveDbCounts === 'function') {
        (view as DashboardView).updateLiveDbCounts(dbCountsObj);
      }
    }
  }
  private lastLiveRenderAt = 0;

  /**
   * ETA in milliseconds based on the rolling rate window, or `null` when
   * we can't project (no rate yet, total = 0, already done, or rate is
   * 0). Caller formats for display.
   */
  getSyncEtaMs(): number | null {
    const p = this.lastSyncProgress;
    if (!p || p.total <= 0 || p.current >= p.total) return null;
    const samples = this.rateSamples;
    if (samples.length < 2) return null;
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (!first || !last) return null;
    const dt = last.at - first.at;
    const dn = last.current - first.current;
    if (dt <= 0 || dn <= 0) return null;
    const ratePerMs = dn / dt;
    const remaining = p.total - p.current;
    return Math.round(remaining / ratePerMs);
  }

  // ── DashboardPluginRef implementation ───────────────────

  async buildDashboardDataAsync(): Promise<DashboardData> {
    const syncState = this.host.getSyncState();
    if (!syncState) {
      if (this.host.dbInitFailed) {
        throw new N2OError(
          'Database failed to initialize. Delete the N2O database files (n2o-core.db, n2o-history.db) in the plugin folder, then restart Obsidian.',
          'DATABASE_INIT_FAILED',
        );
      }
      throw new N2OError('Database not ready', 'DATABASE_INIT_FAILED');
    }
    const records = syncState.getAllRecords();
    const pages = records.filter((r) => r.itemType === 'page' || r.itemType === 'database-item');
    const databasePages = records.filter((r) => r.itemType === 'database-item');
    const databases = records.filter((r) => r.itemType === 'database');
    const attachments = records.reduce((sum, r) => sum + (r.attachments?.length ?? 0), 0);

    // Build fallback itemCount map from sync records for databases missing counts
    // Index by both notionId and dataSourceId to handle dual ID namespace
    const itemCountMap: Record<string, number> = {};
    for (const r of records) {
      if (r.itemType === 'database-item' && r.notionParentId) {
        const parentId = r.notionParentId.replace(/-/g, '');
        itemCountMap[parentId] = (itemCountMap[parentId] ?? 0) + 1;
      }
    }
    // Also index database counts by their dataSourceId for cross-namespace matching
    for (const r of records) {
      if (r.itemType === 'database' && r.dataSourceId && r.notionId !== r.dataSourceId) {
        const blockCount = itemCountMap[r.notionId.replace(/-/g, '')];
        if (blockCount !== undefined) {
          itemCountMap[r.dataSourceId.replace(/-/g, '')] = blockCount;
        }
      }
    }

    // Read sync history + recent persisted errors from SQLite directly
    const syncHistory = await this.loadSyncHistory();
    const errorHistory = this.loadErrorHistory();

    // Defensive: during plugin teardown (e.g. Lite disabling itself after the
    // in-app upgrade) a queued dashboard refresh can land after the
    // orchestrator is gone. Bail instead of crashing the unload.
    const orchestrator = this.host.getOrchestrator() as SyncOrchestrator | undefined;
    if (!orchestrator) {
      throw new N2OError('Sync engine is shutting down', 'DATABASE_INIT_FAILED');
    }
    const status = orchestrator.getStatus();
    const conflicts = syncState.getConflicts();
    const errors = syncState.getErrors();
    const failedMedia = records.flatMap((r) => {
      // Dismissed items (#1780) drop off the needs-attention surface entirely -
      // they still live on the record so a URL change can re-alarm them, but
      // the user has said "I know, leave me alone".
      const items = (r.failedMedia ?? []).filter((i) => !i.dismissed);
      if (items.length === 0) return [];
      return [
        {
          pageName: r.obsidianPath.split('/').pop()?.replace('.md', '') || r.notionId,
          notionId: r.notionId,
          obsidianPath: r.obsidianPath,
          items,
        },
      ];
    });

    const vaultAdapter = this.host.getVaultAdapter();
    const duplicates = vaultAdapter.findDuplicateNotionIds(this.host.profile.syncFolder);

    const workspaceName = this.host.cachedWorkspaceName ?? null;
    const profile = this.host.profile;
    const settings = this.host.settings;

    const syncedCounts = this.host.getSyncState().getSyncedCounts();
    return {
      syncState: status.state,
      syncPhase: status.phase,
      isDiscoveringPages: this.host.isDiscoveryRunning,
      pageDiscoveryMessage: this.pageDiscoveryMessage,
      totalPages: pages.length,
      totalDatabasePages: databasePages.length,
      totalDatabases: databases.length,
      totalAttachments: attachments,
      syncProgress: this.lastSyncProgress,
      syncEtaMs: this.getSyncEtaMs(),
      lastSyncTime: status.lastSyncTime ?? syncState.getLastSyncTime(),
      lastResult: status.lastResult,
      conflicts: conflicts.length,
      errors: errors.length,
      failedMedia,
      duplicateNotionIds: duplicates.size,
      syncHistory,
      errorHistory,
      syncFolder: profile.syncFolder,
      workspaceName,
      hasToken: !!profile.notionToken,
      syncScope: profile.syncScope,
      totalMedia: attachments,
      selectedItemCount: profile.selectedItems.length,
      selectedItems: profile.selectedItems.map((item) => ({
        title: item.title,
        type: item.type,
        itemCount:
          item.type === 'database'
            ? (item.itemCount ?? itemCountMap[item.id.replace(/-/g, '')])
            : undefined,
      })),
      liveDbCounts: Object.fromEntries(this.liveDbCounts),
      activeWorkspaceName: profile.name,
      profileCount: settings.profiles.length,
      // What is really synced, for the scope card (#1978). The card used to
      // report the tree-picker's workspace reach, which is empty until the
      // picker is opened, so a whole-workspace sync said "0 pages".
      syncedPages: syncedCounts.pages,
      syncedDatabases: syncedCounts.databases,
      dbReady: !this.host.dbInitFailed,
      pluginVersion:
        (this.host as unknown as { manifest: { version: string } }).manifest?.version ?? '?',
      ...(() => {
        try {
          const cache = this.host.getDatabase().getPageCacheStore();
          return {
            pageCacheCount: cache.count(),
            pageCacheDatabases: cache.getAllDatabases().length,
            pageCacheAge: cache.getLastDiscoveryTime(),
          };
        } catch {
          return { pageCacheCount: 0, pageCacheDatabases: 0, pageCacheAge: null };
        }
      })(),
    };
  }

  getDashboardCallbacks(): DashboardCallbacks {
    const host = this.host;
    return {
      onPullChanges: () => host.pullFromNotion(),
      onSyncNow: () => host.syncNow(),
      onOpenSettings: (tab) => {
        const setting = (host.app as unknown as Record<string, unknown>).setting as
          { open: () => void; openTabById: (id: string) => void } | undefined;
        if (setting) {
          setting.open();
          setting.openTabById('n2o');
          if (tab) {
            host.getSettingTab().showTab(tab);
          }
        }
      },
      onRetryFailedMedia: () => host.retryFailedMedia(),
      onOpenNote: (obsidianPath) => {
        void host.app.workspace.openLinkText(obsidianPath, '', false);
      },
      onOpenPageInNotion: (notionId) => {
        // Notion accepts the bare 32-hex id in the path; dashes optional.
        const id = notionId.replace(/-/g, '');
        openExternalUrl(`https://www.notion.so/${id}`);
      },
      onDismissFailedMedia: async (notionId, itemId) => {
        const ss = host.getSyncState();
        const rec = ss.getByNotionId(notionId);
        const item = rec?.failedMedia?.find((m) => m.id === itemId);
        if (!rec || !item) return;
        item.dismissed = true;
        await ss.upsertRecordDurable(rec);
        this.refreshDashboards();
      },
      onCancelSync: () => {
        host.getOrchestrator().cancelSync();
        host.getStatusBar().update(host.getOrchestrator().getStatus());
        new Notice('N2O: Sync cancelled', NOTICE_SHORT);
        this.refreshDashboards();
      },
      onPreviewSync: () => host.previewSync(),
      onOpenSyncLog: async () => {
        // Sync log lives in Settings -> N2O -> Activity tab (Recent
        // Activity + Sync History + log details). Open the settings
        // modal, land on the N2O plugin tab, then tell that tab to
        // switch to its Activity sub-tab. Without the showTab call
        // the user ends up on whatever sub-tab they last had open.
        const setting = (host.app as unknown as Record<string, unknown>).setting as
          | {
              open: () => void;
              openTabById: (id: string) => void;
              activeTab?: { showTab?: (tab: string) => void };
            }
          | undefined;
        if (!setting) return;
        setting.open();
        setting.openTabById('n2o');
        // The settings tab renders asynchronously; give it a frame to
        // mount before we flip its sub-tab, otherwise showTab runs
        // against a stale activeTab state.
        window.setTimeout(() => {
          setting.activeTab?.showTab?.('Activity');
        }, 50);
      },
      onOpenTreePicker: () => {
        let pickerCache;
        try {
          pickerCache = host.getDatabase().getPageCacheStore();
        } catch {
          new Notice('N2O: Database is still loading. Please try again in a moment.');
          return;
        }
        new SyncTreePicker(
          host.app,
          host.getNotionClient(),
          host.profile.selectedItems,
          async (selected) => {
            host.profile.selectedItems = selected;
            host.profile.syncScope = 'selected';
            await host.saveSettings();
            this.refreshDashboards(true);
          },
          pickerCache,
          (onProgress) => host.runSharedDiscovery(onProgress),
          () => host.scanVaultIds(),
          {
            get: () => ({
              childPages: host.profile.syncChildPages,
              childDatabases: host.profile.syncChildDatabases,
              downloadMedia: host.profile.downloadMedia,
              archivedPages: host.profile.syncDeletedItems,
              // UI shows positively: ON = only filtered items (default).
              // Underlying profile field is inverted (linkedViewFullDatabase=false -> filtered only).
              filteredViewsOnly: !host.profile.linkedViewFullDatabase,
            }),
            set: async (key, value) => {
              if (key === 'childPages') host.profile.syncChildPages = value;
              else if (key === 'childDatabases') host.profile.syncChildDatabases = value;
              else if (key === 'downloadMedia') host.profile.downloadMedia = value;
              else if (key === 'archivedPages') host.profile.syncDeletedItems = value;
              else if (key === 'filteredViewsOnly') host.profile.linkedViewFullDatabase = !value;
              await host.saveSettings();
            },
          },
          host.cachedWorkspaceName ?? null,
          host.profile.oauthBotId ?? null,
          () => host.isDiscoveryRunning,
        ).open();
      },
      onResolveConflicts: () => {
        // Lite does not resolve conflicts in-app (#1919). A conflict leaves the
        // local file untouched with Notion's version beside it, so the only
        // action left is to sync again once the user has merged by hand.
        new Notice('N2O: Re-syncing...', NOTICE_SHORT);
        void host.syncNow();
      },
      onSetSyncScopeAll: () => {
        void (async () => {
          host.profile.syncScope = 'all';
          await host.saveSettings();
          this.refreshDashboards(true);
        })();
      },
      onStartOAuth: () => {
        host.startOAuthFlow();
      },
      getNewsletterOptIn: () => host.settings.newsletterOptIn === true,
      onSetNewsletterOptIn: (optIn) => {
        host.settings.newsletterOptIn = optIn;
        void host.saveSettings();
      },
      onValidateManualToken: async (token) => {
        const origToken = host.profile.notionToken;
        const origAuth = host.profile.authType;
        host.profile.notionToken = token;
        host.profile.authType = 'internal';
        try {
          const result = await host.testConnection();
          if (result.success) {
            await host.saveSettings();
            this.refreshDashboards(true);
            return { success: true, detail: result.detail };
          }
          host.profile.notionToken = origToken;
          host.profile.authType = origAuth;
          return { success: false, detail: result.detail };
        } catch (e) {
          host.profile.notionToken = origToken;
          host.profile.authType = origAuth;
          return { success: false, detail: getErrorMessage(e) };
        }
      },
      onPollConnectionState: () => {
        const pluginHost = host as { lastOAuthError?: string | null };
        const error = pluginHost.lastOAuthError ?? null;
        if (error) pluginHost.lastOAuthError = null; // one-shot read
        return {
          hasToken: !!host.profile.notionToken,
          workspaceName: host.cachedWorkspaceName ?? null,
          error,
        };
      },
      onScanVault: async () => {
        await host.scanVault();
        this.refreshDashboards();
      },
      onDiscoverPages: async () => {
        // runSharedDiscovery owns scene lifecycle - it refreshes the
        // dashboard on start (so the radar appears), forwards progress
        // into setPageDiscoveryMessage for the hero subtitle, and clears
        // + refreshes again on finish. Callers don't manage scan state.
        await host.runSharedDiscovery();
      },
      onOpenSyncConfig: () => {
        const tab = host.getSettingTab();
        openSyncSettings(host.app, tab);
      },
      onResetN2O: () => {
        new ResetConfirmModal(host.app, async () => {
          await host.resetN2O();
          new Notice('N2O: Reset complete. Select pages and sync to start fresh.', NOTICE_ERROR);
        }).open();
      },
      onOpenUpgrade: () => host.openUpgradeModal(),
    };
  }

  // ── View management ─────────────────────────────────────

  async openDashboard(): Promise<void> {
    const existing = this.host.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
    const existingLeaf = existing[0];
    if (existingLeaf) {
      void this.host.app.workspace.revealLeaf(existingLeaf);
      // A leaf restored in a collapsed sidebar holds a DeferredView (Obsidian
      // 1.7+) with no refresh(); it renders fresh when revealLeaf loads it.
      if (existingLeaf.view instanceof DashboardView) {
        void existingLeaf.view.refresh();
      }
      return;
    }

    const leaf = this.host.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
      void this.host.app.workspace.revealLeaf(leaf);
    }
  }

  /** Refresh dashboard sidebar panels only (no settings tab). */
  async refreshDashboardPanels(): Promise<void> {
    const dashLeaves = this.host.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
    const refreshes: Promise<void>[] = [];
    for (const leaf of dashLeaves) {
      const view = leaf.view;
      if (view && typeof (view as DashboardView).refresh === 'function') {
        refreshes.push((view as DashboardView).refresh());
      }
    }
    await Promise.all(refreshes);
  }

  /**
   * Push an OAuth/connection error directly to any open dashboard views so the
   * inline connect flow can bail out of its waiting state without waiting for
   * its next poll tick.
   */
  pushConnectError(message: string): void {
    const leaves = this.host.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof DashboardView) {
        view.showConnectError(message);
      }
    }
  }

  /** Refresh ALL UI surfaces - dashboard panels + settings tab. */
  refreshDashboards(deferred = false): void {
    if (deferred) {
      // Deferred: lets current call stack complete first (modals can close)
      window.setTimeout(() => void this.refreshDashboardPanels(), 50);
    } else {
      void this.refreshDashboardPanels();
    }
    const settingTab = this.host.getSettingTab();
    if (settingTab) {
      settingTab.refreshIfVisible();
    }
  }

  // ── Private helpers ─────────────────────────────────────

  private async loadSyncHistory(): Promise<SyncHistoryEntry[]> {
    try {
      return this.host.getSyncHistoryDB().loadHistory();
    } catch {
      return [];
    }
  }

  private loadErrorHistory(): ErrorLogEntry[] {
    try {
      return this.host.getErrorLogDB().load();
    } catch {
      return [];
    }
  }
}
