/**
 * PluginBootstrap - factory functions for creating N2O plugin components.
 *
 * Extracted from main.ts to isolate component creation from plugin lifecycle.
 * All dependencies are passed via the BootstrapHost interface.
 */

import { SyncCommandHandler } from '../application/sync/sync-commands';
import { NotionClient } from '../infrastructure/notion/client';
import { NotionParser } from '../infrastructure/notion/parser';
import { ObsidianBuilder } from '../infrastructure/obsidian/builder';
import { VaultAdapter } from '../infrastructure/obsidian/vault';
import { SyncEngine } from '../application/sync/engine';
import { SyncOrchestrator } from '../application/sync/orchestrator';
import { NotionDiscovery } from '../application/discovery/discovery';
import { MediaDownloader } from '../application/media/media-downloader';
import { MediaAliasStore } from '../infrastructure/storage/media-alias-store';
import { MediaOriginStore } from '../infrastructure/storage/media-origin-store';
import { FileHashIndex } from '../infrastructure/storage/file-hash-index';
import { getSharedAttachmentFolder } from '../shared/attachment-paths';
import { Notice, requestUrl } from 'obsidian';
import { SyncStateDB } from '../infrastructure/storage/sync-state';
import { SyncHistoryDB } from '../infrastructure/storage/sync-history';
import { ErrorLogDB } from '../infrastructure/storage/error-log';
import { BlockCacheStore } from '../infrastructure/storage/block-cache-store';
import { BlockIdentityStore } from '../infrastructure/storage/block-identity-store';
import { ItemHistoryDB } from '../infrastructure/storage/item-history';
import { ConflictAuditLog } from '../application/conflict/conflict-audit';
import type { DatabaseManager } from '../infrastructure/storage/database-manager';
import { toSyncConfig } from '../domain/models/config-schema';

/**
 * Obsidian's requestUrl wrapped as the HTTP backend for the Notion client, so
 * the adapter stays decoupled from the Obsidian package (tests inject a stub
 * instead). Forwards `throwOnError` so request() can read 4xx bodies. Single
 * definition - this wrapper used to be copy-pasted in three places.
 */
const obsidianHttpFetch = (req: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  contentType?: string;
  throwOnError?: boolean;
}) =>
  requestUrl({
    url: req.url,
    method: req.method,
    headers: req.headers,
    body: req.body,
    contentType: req.contentType,
    throw: req.throwOnError,
  });

/**
 * Host interface - the minimal contract the plugin provides to the bootstrap.
 */
export interface BootstrapHost {
  readonly app: import('obsidian').App;
  readonly settings: import('../settings').N2OSettings;
  readonly profile: import('../settings').WorkspaceProfile;
  /**
   * In-flight workspace discovery promise (tree-picker cache population).
   * `null` when no discovery is running. Sync orchestrator awaits this
   * before starting so the two don't compete for the Notion rate limit.
   */
  readonly activeDiscovery: Promise<void> | null;
  /** True from the start of onunload - the orchestrator's shutdown gate reads it. */
  readonly unloading: boolean;

  saveSettings(): Promise<void>;

  // Component getters (lazy - may not be available until DB is ready)
  getSyncState(): SyncStateDB;
  getOrchestrator(): SyncOrchestrator;
  getEngine(): SyncEngine;
  getStatusBar(): import('../ui/status-bar').StatusBarWidget;
  getDatabaseManager(): DatabaseManager;
  getSyncHistoryDB(): SyncHistoryDB;
  getErrorLogDB(): ErrorLogDB;

  // Guards & helpers
  guardSyncPreconditions(): string | null;
  resolveNotionId(path: string): string | undefined;
  refreshDashboards(): void;

  // UI callbacks - decouples core from UI layer
  showDryRunPreview(
    result: import('../application/sync/orchestrator').SyncResult,
    onSync: () => Promise<void>,
  ): void;
  refreshOpenViews(result: import('../application/sync/orchestrator').SyncResult): void;
}

/** Components created before the database is available. */
export interface EarlyComponents {
  notionClient: NotionClient;
  vaultAdapter: VaultAdapter;
  syncCommands: SyncCommandHandler;
}

/** Components that require the SQLite database. */
export interface DatabaseComponents {
  syncState: SyncStateDB;
  syncHistoryDB: SyncHistoryDB;
  errorLogDB: ErrorLogDB;
  blockCacheStore: BlockCacheStore;
  itemHistoryDB: ItemHistoryDB;
  fileHashIndex: FileHashIndex;
  engine: SyncEngine;
  orchestrator: SyncOrchestrator;
}

/**
 * Create non-DB components (safe to call before database opens).
 */
export function createEarlyComponents(host: BootstrapHost): EarlyComponents {
  // Inject Obsidian's requestUrl as the HTTP backend so the Notion
  // adapter stays decoupled from the Obsidian package itself (P1 #22
  // independence-violation fix). Same pattern as MediaDownloader.
  // Tests get to inject a stub instead of mocking the obsidian module
  // globally.
  const notionClient = new NotionClient(host.profile.notionToken, obsidianHttpFetch);
  // Surface block-tree truncation to the user, cooled down so one oversized page
  // does not fire a Notice per truncated parent (#1523).
  let lastTruncationNoticeAt = 0;
  notionClient.setTruncationHandler((info) => {
    const now = Date.now();
    if (now - lastTruncationNoticeAt < 30_000) return;
    lastTruncationNoticeAt = now;
    new Notice(`N2O: ${info.detail} Split the page in Notion so it syncs fully.`, 15000);
  });
  const vaultAdapter = new VaultAdapter(host.app);

  const syncCommands = new SyncCommandHandler({
    get app() {
      return host.app;
    },
    get profile() {
      return host.profile;
    },
    getSyncState: () => host.getSyncState(),
    getOrchestrator: () => host.getOrchestrator(),
    getEngine: () => host.getEngine(),
    getVaultAdapter: () => vaultAdapter,
    getNotionClient: () => notionClient,
    getStatusBar: () => host.getStatusBar(),
    getDatabase: () => host.getDatabaseManager().coreDb,
    getSyncHistoryDB: () => host.getSyncHistoryDB(),
    getErrorLogDB: () => host.getErrorLogDB(),
    guardSyncPreconditions: () => host.guardSyncPreconditions(),
    resolveNotionId: (path) => host.resolveNotionId(path),
    saveSettings: () => host.saveSettings(),
    getSettings: () => host.settings,
    refreshDashboards: () => host.refreshDashboards(),
    showDryRunPreview: (result, onSync) => host.showDryRunPreview(result, onSync),
    refreshOpenViews: (result) => host.refreshOpenViews(result),
    notify: (message, duration) => new Notice(message, duration),
  });

  return { notionClient, vaultAdapter, syncCommands };
}

/**
 * Create DB-dependent components (called after DatabaseManager opens).
 */
export function createDatabaseComponents(
  host: BootstrapHost,
  dbManager: DatabaseManager,
  early: EarlyComponents,
): DatabaseComponents {
  const coreDb = dbManager.coreDb;
  const historyDb = dbManager.historyDb;
  const adapter = dbManager.getAdapter();
  const dataDir = dbManager.getDataDir();

  const syncState = new SyncStateDB(coreDb);
  const syncHistoryDB = new SyncHistoryDB(historyDb);
  const errorLogDB = new ErrorLogDB(historyDb);
  const blockCacheStore = new BlockCacheStore(adapter, dataDir);
  const blockIdentityStore = new BlockIdentityStore(coreDb);
  // Periodic (per-session) TTL sweep so orphaned classifications for deleted
  // Notion blocks don't accumulate without bound (#1566).
  blockIdentityStore.pruneStale();
  const itemHistoryDB = new ItemHistoryDB(historyDb);
  const mergeAuditLog = new ConflictAuditLog(historyDb);

  const parser = new NotionParser();
  const builder = new ObsidianBuilder();

  const discovery = new NotionDiscovery(early.notionClient);
  discovery.onProgress((msg) => {
    host.getStatusBar()?.setProgress(msg);
  });

  const fileHashIndex = new FileHashIndex(coreDb);
  const mediaAliasStore = new MediaAliasStore(coreDb);
  const mediaOriginStore = new MediaOriginStore(coreDb);

  // MediaDownloader fetches bytes directly (requestUrl), bypassing the Notion
  // rate limiter on purpose: media URLs point at S3, a different host from the
  // Notion REST API, so they do not share its 3 req/s budget. If media is ever
  // moved onto an API-hosted, rate-limited endpoint, route it through the
  // limiter here (#1585).
  const mediaDownloader = new MediaDownloader(
    early.vaultAdapter,
    getSharedAttachmentFolder(host.profile.syncFolder),
    requestUrl,
  );
  mediaDownloader.setFileHashIndex(fileHashIndex);
  mediaDownloader.setMediaAliasStore(mediaAliasStore);
  mediaDownloader.setMediaOriginStore(mediaOriginStore);

  const engine = new SyncEngine(
    early.notionClient,
    parser,
    builder,
    early.vaultAdapter,
    syncState,
    toSyncConfig(host.settings),
    discovery,
    mediaDownloader,
    (message, duration) => new Notice(message, duration),
  );

  engine.configure({
    blockCache: blockCacheStore,
    blockIdentityStore,
    conflictAudit: mergeAuditLog,
  });

  // Pass an awaitDiscovery getter so startSync waits for in-flight workspace
  // discovery before starting. Both share the Notion rate limit; running them
  // in parallel slows the sync without changing total work.
  const orchestrator = new SyncOrchestrator(
    engine,
    () => host.activeDiscovery,
    () => host.unloading,
  );

  return {
    syncState,
    syncHistoryDB,
    errorLogDB,
    blockCacheStore,
    itemHistoryDB,
    fileHashIndex,
    engine,
    orchestrator,
  };
}
