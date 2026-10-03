/**
 * N2O Sync Plugin
 *
 * Main entry point. The N2OPlugin class delegates to extracted modules:
 * - plugin/command-registration - command palette commands
 * - plugin/context-menus - right-click context menus
 * - plugin/layout-ready-handler - deferred DB init and wiring
 * - plugin/connection-manager - connection test, OAuth
 */

import { Plugin, Notice } from 'obsidian';
import { N2OSettingTab } from './ui/settings-tab';
import { getActiveProfile } from './domain/models/config-schema';
import type { N2OSettings, WorkspaceProfile } from './settings';
import {
  scanVault as scanVaultImpl,
  scanVaultIds as scanVaultIdsImpl,
} from './application/discovery/vault-scanner';
import { createEarlyComponents, createDatabaseComponents } from './plugin/plugin-bootstrap';
import {
  viewInNotionFromFrontmatter as viewInNotionFromFrontmatterImpl,
  openInNotion as openInNotionImpl,
} from './plugin/notion-links';
import { resetN2O as resetN2OImpl } from './plugin/reset-manager';
import type { BootstrapHost } from './plugin/plugin-bootstrap';
import type { PluginHost } from './plugin/plugin-host';
import { SettingsManager } from './application/settings-manager';
import type { SyncOrchestrator, SyncResult } from './application/sync/orchestrator';
import type { SyncEngine } from './application/sync/engine';
import type { NotionClient } from './infrastructure/notion/client';
import { discoverAccessibleContent as runContentDiscovery } from './plugin/connection-manager';
import type { VaultAdapter } from './infrastructure/obsidian/vault';
import type { SyncStateDB } from './infrastructure/storage/sync-state';
import type { DatabaseManager } from './infrastructure/storage/database-manager';
import type { CoreDatabase } from './infrastructure/storage/core-database';
import type { BlockCacheStore } from './infrastructure/storage/block-cache-store';
import type { FileHashIndex } from './infrastructure/storage/file-hash-index';
import type { FileIndexWatcher } from './plugin/file-index-bootstrap';
import {
  attachFileIndexWatcher,
  kickoffFileIndexRebuildIfEmpty,
} from './plugin/file-index-bootstrap';
import type { SyncHistoryDB } from './infrastructure/storage/sync-history';
import type { ErrorLogDB } from './infrastructure/storage/error-log';
import { StatusBarWidget } from './ui/status-bar';
import { DashboardView, DASHBOARD_VIEW_TYPE } from './ui/dashboard';
import { DashboardManager } from './ui/dashboard-manager';
import { DryRunPreviewModal } from './ui/dry-run-modal';
import { registerBookmarkPostProcessor } from './ui/bookmark-post-processor';
import { registerRichLinksPostProcessor } from './ui/rich-links';
import { registerBreadcrumbPostProcessor } from './ui/breadcrumb-post-processor';
import { registerSyncedEmbedPostProcessor } from './ui/synced-embed-post-processor';
import type { SyncCommandHandler } from './application/sync/sync-commands';
import { createLogger, setLogLevel } from './shared/logger';
import { getErrorMessage } from './shared/errors';
import { DataWriteQueue } from './shared/data-write-queue';
import { metaCommentHider } from './infrastructure/obsidian/meta-comment-hider';
import { eventBus } from './shared/event-bus';
import { NOTICE_ERROR, NOTICE_CRITICAL } from './shared/constants';
import { NoticeErrorBuffer } from './shared/notice-error-buffer';
import { registerCommands } from './plugin/command-registration';
import { registerContextMenus } from './plugin/context-menus';
import { handleLayoutReady } from './plugin/layout-ready-handler';
import { isProPluginActive, MSG_PRO_PLUGIN_ACTIVE } from './plugin/pro-guard';
import { installProPlugin, getProPluginStatus, handOverToPro } from './plugin/pro-installer';
import { UpgradeModal } from './ui/upgrade-modal';
import {
  testConnection as testConnectionImpl,
  startOAuthFlow as startOAuthFlowImpl,
  handleOAuthCallback as handleOAuthCallbackImpl,
  handleConnectCode as handleConnectCodeImpl,
  disconnectOAuth as disconnectOAuthImpl,
} from './plugin/connection-manager';

const log = createLogger('Main');

export default class N2OPlugin extends Plugin implements BootstrapHost, PluginHost {
  settings: N2OSettings = {} as N2OSettings;

  /** Plugin version from manifest. */
  get version(): string {
    return this.manifest.version;
  }

  /** Shorthand for the active workspace profile. */
  get profile(): WorkspaceProfile {
    return getActiveProfile(this.settings);
  }

  dbInitFailed = false;
  /**
   * True from the start of onunload. Lets the orchestrator distinguish a sync
   * that failed because we closed the DB during shutdown (benign) from a real
   * "database not initialized" bug.
   */
  unloading = false;
  private dbManager!: DatabaseManager;
  private syncHistoryDB!: SyncHistoryDB;
  private errorLogDB!: ErrorLogDB;
  private blockCacheStore!: BlockCacheStore;
  private fileHashIndex!: FileHashIndex;
  private fileIndexWatcher: FileIndexWatcher | null = null;
  private orchestrator!: SyncOrchestrator;
  private engine!: SyncEngine;
  private notionClient!: NotionClient;
  private vaultAdapter!: VaultAdapter;
  private syncState!: SyncStateDB;
  private statusBar!: StatusBarWidget;

  /** Cached workspace name from last successful Notion connection. */
  cachedWorkspaceName: string | null = null;

  /** Last OAuth failure reason (cleared on read or success). */
  lastOAuthError: string | null = null;

  /** Shared discovery lock - prevents concurrent discoveries from multiple callers. */
  activeDiscovery: Promise<void> | null = null;
  /** Whether discovery is currently running - read by the tree picker and dashboard hero. */
  get isDiscoveryRunning(): boolean {
    return this.activeDiscovery !== null;
  }

  /**
   * Minimum duration the scan scene stays visible on the hero. A small
   * workspace (a handful of shared pages) finishes in under a second,
   * which is too fast for the user to register that the plugin actually
   * scanned their workspace. Holding the shared lock for at least this
   * long keeps the radar + "Discovering pages..." copy on screen long
   * enough to read, regardless of library size. If real discovery
   * takes longer than this, the lock stays until it's done.
   */
  private static readonly DISCOVERY_MIN_VISIBLE_MS = 10_000;

  /**
   * Live progress fan-out for runSharedDiscovery. Every caller's
   * onProgress is added here; each progress tick calls all of them.
   * Late joiners (e.g. a picker opened mid-discovery) are pushed onto
   * this list AND immediately fired with `lastDiscoveryProgress` so
   * their UI reflects current state instead of waiting for the next
   * tick. Cleared at the end of each run.
   */
  private discoveryProgressListeners: Array<(msg: string) => void> = [];
  private lastDiscoveryProgress: string | null = null;

  /**
   * Scan Notion for accessible pages and databases and return the counts.
   * The settings sync tab's Refresh button uses the result, so exposing it as
   * a plugin method keeps the UI off a direct connection-manager import.
   */
  discoverAccessibleContent(onProgress?: (msg: string) => void) {
    return runContentDiscovery(this, onProgress);
  }

  /**
   * Run discovery if not already running. If discovery is in progress, returns
   * the existing promise so callers await the same operation - AND
   * subscribes the new caller's onProgress to the running run's progress
   * fan-out so their UI updates in real-time too, not just the original
   * caller's.
   */
  runSharedDiscovery(onProgress?: (msg: string) => void): Promise<void> {
    if (this.activeDiscovery) {
      // Join in-flight discovery. Add listener + fire last-known message
      // immediately so the joiner's UI isn't blank until the next tick.
      if (onProgress) {
        this.discoveryProgressListeners.push(onProgress);
        if (this.lastDiscoveryProgress) {
          try {
            onProgress(this.lastDiscoveryProgress);
          } catch {
            /* swallow */
          }
        }
      }
      return this.activeDiscovery;
    }

    // Fresh run - reset fan-out state.
    this.discoveryProgressListeners = onProgress ? [onProgress] : [];
    this.lastDiscoveryProgress = null;

    // Central progress forwarding: each tick fans out to the dashboard
    // hero AND every registered listener (picker banner, etc.). Callers
    // no longer need to wire setPageDiscoveryMessage themselves.
    const forwarded = (msg: string) => {
      this.lastDiscoveryProgress = msg;
      this.dashboardManager?.setPageDiscoveryMessage(msg);
      // Snapshot the listener list in case a listener's call mutates it
      // (e.g. a picker closes and removes itself - unlikely but cheap).
      const listeners = this.discoveryProgressListeners.slice();
      for (const listener of listeners) {
        try {
          listener(msg);
        } catch {
          /* don't let one listener break the others */
        }
      }
    };

    this.dashboardManager?.refreshDashboards();
    const startedAt = Date.now();
    this.activeDiscovery = runContentDiscovery(this, forwarded)
      .then(async () => {
        // Hold the scene for at least DISCOVERY_MIN_VISIBLE_MS so the
        // user sees what just happened. If actual discovery ran long
        // enough already, this is a no-op.
        const elapsed = Date.now() - startedAt;
        const remaining = N2OPlugin.DISCOVERY_MIN_VISIBLE_MS - elapsed;
        if (remaining > 0) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
        }
      })
      .finally(() => {
        this.activeDiscovery = null;
        this.discoveryProgressListeners = [];
        this.lastDiscoveryProgress = null;
        this.dashboardManager?.setPageDiscoveryMessage(null);
        this.dashboardManager?.refreshDashboards();
      });
    return this.activeDiscovery;
  }

  private settingTab!: N2OSettingTab;
  private dashboardManager!: DashboardManager;
  private syncCommands!: SyncCommandHandler;
  private settingsManager!: SettingsManager;

  // ── BootstrapHost implementation ──
  getSyncState(): SyncStateDB {
    return this.syncState;
  }
  getOrchestrator(): SyncOrchestrator {
    return this.orchestrator;
  }
  getStatusBar(): StatusBarWidget {
    return this.statusBar;
  }
  getDatabaseManager(): DatabaseManager {
    return this.dbManager;
  }
  getDatabase(): CoreDatabase {
    return this.dbManager.coreDb;
  }
  getSyncHistoryDB(): SyncHistoryDB {
    return this.syncHistoryDB;
  }
  getErrorLogDB(): ErrorLogDB {
    return this.errorLogDB;
  }
  getBlockCacheStore(): BlockCacheStore {
    return this.blockCacheStore;
  }
  getSettingTab(): N2OSettingTab {
    return this.settingTab;
  }
  getVaultAdapter(): VaultAdapter {
    return this.vaultAdapter;
  }
  refreshDashboards(): void {
    this.dashboardManager?.refreshDashboards();
  }

  // ── Accessor methods for extracted modules ──
  getDashboardManager(): DashboardManager {
    return this.dashboardManager;
  }
  getNotionClient(): NotionClient {
    return this.notionClient;
  }
  getEngine(): SyncEngine {
    return this.engine;
  }

  /** Store DatabaseManager reference (called by layout-ready-handler). */
  setDatabaseManager(mgr: DatabaseManager): void {
    this.dbManager = mgr;
  }

  showDryRunPreview(result: SyncResult, onSync: () => Promise<void>): void {
    new DryRunPreviewModal(this.app, result, onSync).open();
  }

  refreshOpenViews(_result: SyncResult): void {
    const dashLeaves = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
    for (const leaf of dashLeaves) {
      const view = leaf.view;
      if (view && typeof (view as DashboardView).refresh === 'function') {
        void (view as DashboardView).refresh();
      }
    }
  }

  /**
   * Serialized read-modify-write of the plugin data.json blob (#1796). See
   * DataWriteQueue: concurrent mutators used to race on the same blob, so each
   * load-modify-save is chained atomic; a failed write is now logged, never
   * swallowed, and the queue survives so later writes still run.
   */
  private readonly dataWriter = new DataWriteQueue(
    () => this.loadData() as Promise<Record<string, unknown> | null>,
    (data) => this.saveData(data),
    log,
  );

  updateData(mutator: (data: Record<string, unknown>) => void | Promise<void>): Promise<void> {
    return this.dataWriter.update(mutator);
  }

  override async onload(): Promise<void> {
    log.info('Loading N2O plugin...');

    try {
      // Initialize settings manager and load settings
      this.settingsManager = new SettingsManager({
        loadData: () => this.loadData(),
        saveData: (data) => this.saveData(data),
        updateData: (mutator) => this.updateData(mutator),
        settings: this.settings,
        getSyncState: () => this.syncState,
        getVaultAdapter: () => this.vaultAdapter,
        getNotionClient: () => this.notionClient,
        getEngine: () => this.engine,
        refreshDashboards: () => this.refreshDashboards(),
        notify: (message, duration) => new Notice(message, duration),
      });
      await this.settingsManager.loadSettings();
      this.settings = this.settingsManager.currentSettings;

      this.settingsManager.previousSyncFolder = this.profile.syncFolder;
      this.settingsManager.previousMappingsKey = JSON.stringify(this.profile.propertyMappings);
      this.settingsManager.previousFiltersKey = JSON.stringify(this.profile.databaseFilters);

      if (this.settings.debugMode) {
        setLogLevel('debug');
      }

      // Initialize components
      this.initializeComponents();

      // Register settings tab
      this.settingTab = new N2OSettingTab(this.app, this);
      this.addSettingTab(this.settingTab);

      // Register commands (extracted)
      registerCommands(this);

      // Register views
      this.registerViews();

      // Register display post-processors
      registerBookmarkPostProcessor(this);
      registerRichLinksPostProcessor(this);
      registerBreadcrumbPostProcessor(this);
      registerSyncedEmbedPostProcessor(this);

      // Add ribbon icon for sync (three-way merge)
      this.addRibbonIcon('refresh-cw', 'N2O: Sync with Notion (merge)', async () => {
        await this.syncNow();
      });

      // Register context menus (extracted)
      registerContextMenus(this);

      // Register OAuth protocol handler (obsidian://n2o-oauth-callback?session=...)
      this.registerObsidianProtocolHandler('n2o-oauth-callback', async (params) => {
        const sessionId = params.session;
        if (!sessionId) {
          const msg = 'Missing session ID.';
          this.lastOAuthError = msg;
          new Notice(`N2O: Invalid OAuth callback - ${msg}`, NOTICE_ERROR);
          this.dashboardManager.pushConnectError(msg);
          return;
        }
        const result = await handleOAuthCallbackImpl(this, sessionId);
        if (result.success) {
          this.lastOAuthError = null;
          // saveSettings() cascade handles component re-wiring + dashboard refresh
          this.settingTab?.refreshIfVisible();
        } else {
          this.lastOAuthError = result.detail;
          new Notice(`N2O: OAuth connection failed - ${result.detail}`, NOTICE_CRITICAL);
          // Direct push to any open dashboards - no wait for next poll tick.
          this.dashboardManager.pushConnectError(result.detail);
        }
      });

      // Status bar widget - kept as an internal sink for status updates from
      // sync commands, but NOT rendered in Obsidian's status bar.
      const detachedEl = createDiv();
      this.statusBar = new StatusBarWidget(detachedEl);
      if (this.settings.profiles.length > 1) {
        this.statusBar.setWorkspaceLabel(this.profile.name);
      }

      // Hide N2O metadata comments in Live Preview
      this.registerEditorExtension(metaCommentHider);

      // Pro-detection: the full N2O plugin and Lite must never sync the same
      // vault. Sync commands re-check live via guardSyncPreconditions; this
      // persistent Notice makes the standoff visible at startup too.
      if (isProPluginActive(this.app)) {
        log.warn('Full N2O plugin detected - Lite sync is disabled while it is active');
        new Notice(MSG_PRO_PLUGIN_ACTIVE, 0);
      }

      // Deferred initialization - wait for Obsidian to fully load
      this.app.workspace.onLayoutReady(async () => {
        await handleLayoutReady(this);
        await this.showUpgradeDialogOnce();
      });

      log.info('N2O plugin loaded');
    } catch (error) {
      log.error('N2O plugin failed to load', error);
      const msg = getErrorMessage(error);
      const FATAL_NOTICE_DURATION_MS = 30000;
      new Notice(
        `N2O: Plugin failed to load - ${msg}. Try restarting Obsidian or reinstalling the plugin.`,
        FATAL_NOTICE_DURATION_MS,
      );
    }
  }

  // Obsidian's Plugin.onunload is `() => void` and is not awaited, so the async
  // teardown below (await in-flight sync, close the DB) is best-effort - we still
  // await internally to give the DB the best chance to close cleanly before the
  // process moves on. The signature mismatch is inherent to the Obsidian API.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Obsidian's onunload is a synchronous () => void; the async teardown is best-effort and cannot be awaited by the host
  override async onunload(): Promise<void> {
    log.info('Unloading N2O plugin...');
    // Mark unloading FIRST so the orchestrator classifies any DB-closed error
    // from an in-flight sync as a benign shutdown cancellation, not a failure.
    this.unloading = true;

    // Stop everything that could START new work.
    this.statusBar?.destroy();
    this.fileIndexWatcher?.detach();
    this.fileIndexWatcher = null;

    // Cancel + await any IN-FLIGHT sync before tearing the database down, so a
    // running sync finishes its writes against a live DB instead of hitting a
    // closed one ("Core database not initialized" teardown race). Bounded so a
    // stuck sync can't hang unload.
    try {
      this.orchestrator?.cancelSync();
      await this.orchestrator?.awaitIdle(3000);
    } catch (err) {
      log.warn(`Error awaiting in-flight sync during unload: ${getErrorMessage(err)}`);
    }

    await this.blockCacheStore?.destroy();
    this.vaultAdapter?.clearAllSyncLocks();
    this.syncState?.close();
    await this.dbManager?.close();

    eventBus.clear();
    log.info('N2O plugin unloaded');
  }

  // ── Initialization ─────────────────────────────────────

  private initializeComponents(): void {
    const early = createEarlyComponents(this);
    this.notionClient = early.notionClient;
    this.vaultAdapter = early.vaultAdapter;
    this.syncCommands = early.syncCommands;
    this.dashboardManager = new DashboardManager(this);
  }

  private registerViews(): void {
    DashboardView.pluginRef = this.dashboardManager;
    this.registerView(DASHBOARD_VIEW_TYPE, (leaf) => new DashboardView(leaf));
  }

  /**
   * Initialize DB-dependent components. Called by layout-ready-handler
   * after the SQLite database has been opened.
   */
  initializeDatabaseComponents(): void {
    const early = {
      notionClient: this.notionClient,
      vaultAdapter: this.vaultAdapter,
      syncCommands: this.syncCommands,
    };
    const db = createDatabaseComponents(this, this.dbManager, early);
    this.syncState = db.syncState;
    this.syncHistoryDB = db.syncHistoryDB;
    this.errorLogDB = db.errorLogDB;
    this.blockCacheStore = db.blockCacheStore;
    this.fileHashIndex = db.fileHashIndex;
    this.engine = db.engine;
    this.orchestrator = db.orchestrator;

    // F-030: one-shot migration - collapse any pre-fix duplicate sync
    // records that have the same normalized notion_id but different id
    // strings (dashed vs non-dashed). Keeps the row with latest lastSyncTime.
    try {
      this.syncState.dedupeByNormalizedId();
    } catch {
      // Non-fatal - plugin continues with duplicates present; next startup
      // will try again. Future syncs also won't create NEW duplicates now
      // that upsertRecord normalizes at the boundary.
    }

    /* F-025: attach vault watcher so the hash index tracks
     * create/modify/rename/delete on media files. Cold-start rebuild
     * runs on the first sync (deferred via kick-off helper below). */
    this.fileIndexWatcher = attachFileIndexWatcher(this.app, this.fileHashIndex);
    void kickoffFileIndexRebuildIfEmpty(this.app, this.fileHashIndex);

    // Wire progress feedback from engine to status bar + dashboard
    this.engine.onProgress((message, current, total) => {
      this.statusBar?.setProgress(message);
      // Persist progress on the manager so refresh() rebuilds with the
      // real message instead of falling back to "Scanning your Notion
      // workspace." every time the timeAgo timer ticks.
      this.dashboardManager?.setSyncProgress({ message, current: current ?? 0, total: total ?? 0 });
      const dashLeaves = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
      for (const leaf of dashLeaves) {
        const view = leaf.view;
        if (view && typeof (view as DashboardView).updateSyncProgress === 'function') {
          (view as DashboardView).updateSyncProgress(message, current ?? 0, total ?? 0);
        }
      }
    });

    // Per-item live feed for the dashboard's per-DB live counts. The
    // engine fires this once per SyncResultItem during the apply phase so
    // the scope cards reflect items as they land instead of staying static
    // until the sync completes.
    this.engine.onItem((item) => {
      this.dashboardManager?.pushLiveItem(item);
    });

    // Wire fine-grained phase transitions from the pull processor into the
    // orchestrator. The orchestrator exposes phase on its SyncRunStatus so
    // the dashboard can distinguish "Discovering..." from "Writing files..."
    // instead of a single opaque "Syncing..." spinner.
    this.engine.onPhase((phase) => {
      this.orchestrator.setPhase(phase);
      // Clear stored progress when the engine reaches idle - next render
      // falls through to the post-sync 'idle' / 'success' scene copy.
      if (phase === 'idle') {
        this.dashboardManager?.setSyncProgress(null);
      }
    });

    // Wire per-item error notices. Bulk failures (rate-limit cascades,
    // permission-denied on many pages) flood the user with toasts -
    // NoticeErrorBuffer shows the first few individually and collapses
    // the rest into one summary toast after a quiet window.
    const noticeBuffer = new NoticeErrorBuffer(
      (message, duration) => new Notice(message, duration),
      NOTICE_CRITICAL,
    );
    this.engine.onError((title, error) => {
      noticeBuffer.handleError(title, error);
    });
    // Cancel any pending notice-window timers on unload (#1569).
    this.register(() => noticeBuffer.dispose());
  }

  // ── Actions (thin wrappers delegating to extracted classes) ──

  /** Check common preconditions (no Pro standoff + DB ready + Notion token). Returns error string or null. */
  guardSyncPreconditions(): string | null {
    if (isProPluginActive(this.app)) {
      return MSG_PRO_PLUGIN_ACTIVE;
    }
    if (this.dbInitFailed) {
      return 'N2O: Database failed to initialize. Restart Obsidian or reinstall the plugin.';
    }
    if (!this.profile.notionToken) {
      return 'N2O: Please set your Notion API token in settings.';
    }
    return null;
  }

  /** Resolve a file's Notion ID from sync state or frontmatter. */
  resolveNotionId(path: string): string | undefined {
    if (!this.syncState) return undefined;
    const record = this.syncState.getByObsidianPath(path);
    if (record) return record.notionId;
    const fm = this.vaultAdapter.getFrontmatter(path);
    if (fm?.notion_id && typeof fm.notion_id === 'string') return fm.notion_id;
    return undefined;
  }

  // ── Delegated sync commands ─────────────────────────────

  async pullFromNotion(): Promise<void> {
    return this.syncCommands.pullFromNotion();
  }
  async pullFile(path: string): Promise<void> {
    return this.syncCommands.pullFile(path);
  }
  async syncNow(): Promise<void> {
    return this.syncCommands.syncNow();
  }
  async previewSync(): Promise<void> {
    return this.syncCommands.previewSync();
  }
  async syncFile(path: string): Promise<void> {
    return this.syncCommands.syncFile(path);
  }

  /**
   * Unlink a file from Notion - strips N2O frontmatter and removes sync record.
   */
  async unlinkFromNotion(path: string): Promise<void> {
    return this.syncCommands.unlinkFromNotion(path);
  }

  // ── Delegated settings ──────────────────────────────────

  async loadSettings(): Promise<void> {
    await this.settingsManager.loadSettings();
    this.settings = this.settingsManager.currentSettings;
  }

  async saveSettings(): Promise<void> {
    this.settingsManager.currentSettings = this.settings;
    return this.settingsManager.saveSettings();
  }

  // ── Connection (delegated) ──────────────────────────────

  /** Open Notion page URL from a file's frontmatter `notion_url` field. */
  viewInNotionFromFrontmatter(path: string): void {
    viewInNotionFromFrontmatterImpl(this, path);
  }

  async openInNotion(path: string): Promise<void> {
    return openInNotionImpl(this, path);
  }

  async testConnection(): Promise<{ success: boolean; detail: string; workspaceName?: string }> {
    return testConnectionImpl(this);
  }

  startOAuthFlow(): void {
    return startOAuthFlowImpl();
  }

  async handleOAuthCallback(sessionId: string): Promise<{ success: boolean; detail: string }> {
    return handleOAuthCallbackImpl(this, sessionId);
  }

  /** The paste-a-code half of the connect (#2040). Same exchange, typed instead of linked. */
  async handleConnectCode(code: string): Promise<{ success: boolean; detail: string }> {
    return handleConnectCodeImpl(this, code);
  }

  async disconnectOAuth(): Promise<void> {
    return disconnectOAuthImpl(this);
  }

  /**
   * Workspace id that the active profile's persisted rows live under. Single
   * source of truth so reset, and later the store constructors, can never target
   * different workspaces (#1546). Storage is not yet partitioned per profile, so
   * every profile maps to 'default' today; when multi-workspace lands, map this
   * from the active profile in this one place and both call sites follow.
   */
  getActiveWorkspaceId(): string {
    return 'default';
  }

  async resetN2O(): Promise<void> {
    return resetN2OImpl(this);
  }

  /**
   * Open the upgrade dialog. The install engine (plugin/pro-installer.ts)
   * is injected here so ui/ never runtime-imports plugin/ (layer gate).
   */
  /**
   * Open the upgrade dialog by itself, exactly once, on the first launch after
   * Lite is installed. It holds itself open for FIRST_RUN_HOLD_MS so the reader
   * meets the message before dismissing it.
   *
   * The flag is written BEFORE the dialog opens, not after it closes: a crash
   * or a force-quit while it is up must not turn "once" into "every launch".
   */
  private async showUpgradeDialogOnce(): Promise<void> {
    const FIRST_RUN_HOLD_MS = 10000;
    if (this.settings.upgradeDialogShown) return;
    if (isProPluginActive(this.app)) return;
    this.settings.upgradeDialogShown = true;
    await this.saveSettings();
    this.openUpgradeModal(false, FIRST_RUN_HOLD_MS);
  }

  openUpgradeModal(autoInstall = false, holdMs = 0): void {
    const modal = new UpgradeModal(
      this.app,
      {
      install: async (onProgress) => {
        const result = await installProPlugin(this.app, onProgress);
        if (result.enabled) {
          // Hand the vault to the full edition once the modal has shown the
          // success state. Order matters: Lite disables itself FIRST, then
          // Pro enables, so the two onloads never overlap (shared obsidian://
          // OAuth action, and shared UI surfaces). DISABLE, not uninstall -
          // the plugin folder keeps Lite's settings and sync DBs on disk so
          // N2O Sync's first-run import can adopt them; that import offers
          // the actual removal. Raw window.setTimeout on purpose: the timer
          // must survive this plugin's own unload.
          const app = this.app;
          window.setTimeout(() => {
            modal.close();
            void handOverToPro(app);
          }, 4000);
        }
        return result;
      },
        getStatus: () => getProPluginStatus(this.app),
      },
      autoInstall,
      holdMs,
    );
    modal.open();
  }

  async scanVault(): Promise<void> {
    return scanVaultImpl({
      dbInitFailed: this.dbInitFailed,
      profile: this.profile,
      getSyncState: () => this.syncState,
      getVaultAdapter: () => this.vaultAdapter,
      saveSettings: () => this.saveSettings(),
      refreshDashboards: () => this.refreshDashboards(),
      notify: (message, duration) => new Notice(message, duration),
    });
  }

  async scanVaultIds(): Promise<Set<string>> {
    if (!this.syncState) return new Set();
    return scanVaultIdsImpl({
      dbInitFailed: this.dbInitFailed,
      profile: this.profile,
      getSyncState: () => this.syncState,
      getVaultAdapter: () => this.vaultAdapter,
      saveSettings: () => this.saveSettings(),
      refreshDashboards: () => this.refreshDashboards(),
      notify: (message, duration) => new Notice(message, duration),
    });
  }

  async retryFailedMedia(): Promise<void> {
    await this.syncCommands.retryFailedMedia();
  }
}
