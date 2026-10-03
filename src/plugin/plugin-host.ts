/**
 * Per-consumer host interfaces for N2OPlugin (interface segregation).
 *
 * Each handler types its `plugin` parameter against the ONE interface named
 * after it, so a handler can only see the slice of the plugin it actually
 * uses, and widening one consumer's surface never widens the others. The
 * composed `PluginHost` at the bottom exists solely for main.ts's
 * `implements` clause, which keeps every slice honest at compile time.
 *
 * This file replaces the old single wide PluginHost (60 members, every
 * consumer saw everything). The narrow-host pattern matches the hosts that
 * already live with their consumers: SyncCommandHost (sync-command-types)
 * and BootstrapHost (plugin-bootstrap).
 *
 * Maintenance contract:
 *   - N2OPlugin in main.ts declares `implements PluginHost`. Adding a member
 *     to any slice without implementing it on the class is a compile error.
 *   - When a handler needs a new plugin member, add it to THAT handler's
 *     interface only. The TypeScript error at the call site is the signal.
 *   - A member used by nobody outside main.ts does not belong here at all
 *     (getDatabaseManager was removed on this basis - BootstrapHost declares
 *     its own needs).
 *   - Interfaces live HERE, not in consumer files, so this module imports
 *     nothing from plugin/ or ui/ logic files and can never join an import
 *     cycle (type-only cycles still trip madge - that is why this file
 *     exists in the first place).
 */

import type { App, EventRef, PluginManifest } from 'obsidian';
import type {
  N2OSettings,
  WorkspaceProfile,
  SelectedSyncItem,
} from '../domain/models/config-schema';
import type { SyncStateDB } from '../infrastructure/storage/sync-state';
import type { CoreDatabase } from '../infrastructure/storage/core-database';
import type { SyncHistoryDB } from '../infrastructure/storage/sync-history';
import type { NotionClient } from '../infrastructure/notion/client';
import type { SyncOrchestrator } from '../application/sync/orchestrator';
import type { DatabaseManager } from '../infrastructure/storage/database-manager';
import type { DashboardManager } from '../ui/dashboard-manager';
import type { SettingTabLike } from '../ui/setting-tab-like';

/**
 * Consumed by plugin/command-registration.ts (palette commands): the sync
 * triggers, the services commands poke, and addCommand itself.
 */
export interface CommandHost {
  readonly app: App;
  addCommand(command: import('obsidian').Command): import('obsidian').Command;
  dbInitFailed: boolean;
  readonly profile: WorkspaceProfile;
  getSyncState(): SyncStateDB;
  getSettingTab(): SettingTabLike;
  getDashboardManager(): DashboardManager;
  pullFromNotion(): Promise<void>;
  syncNow(): Promise<void>;
  previewSync(): Promise<void>;
  scanVault(): Promise<void>;
  pullFile(path: string): Promise<void>;
  syncFile(path: string): Promise<void>;
  openInNotion(path: string): Promise<void>;
}

/**
 * Consumed by plugin/context-menus.ts (per-file actions from the file menu
 * and editor menu).
 */
export interface FileActionHost {
  readonly app: App;
  registerEvent(eventRef: EventRef): void;
  readonly profile: WorkspaceProfile;
  getSyncState(): SyncStateDB;
  pullFile(path: string): Promise<void>;
  syncFile(path: string): Promise<void>;
  unlinkFromNotion(path: string): Promise<void>;
  viewInNotionFromFrontmatter(path: string): void;
  openInNotion(path: string): Promise<void>;
  resolveNotionId(path: string): string | undefined;
}

/**
 * Consumed by plugin/layout-ready-handler.ts (deferred initialization once
 * Obsidian's layout is ready). The widest slice - it wires everything up.
 */
export interface InitHost {
  readonly app: App;
  dbInitFailed: boolean;
  readonly profile: WorkspaceProfile;
  cachedWorkspaceName: string | null;
  setDatabaseManager(mgr: DatabaseManager): void;
  initializeDatabaseComponents(): void;
  getDatabase(): CoreDatabase;
  getDashboardManager(): DashboardManager;
  testConnection(): Promise<{ success: boolean; detail: string; workspaceName?: string }>;
  runSharedDiscovery(onProgress?: (msg: string) => void): Promise<void>;
}

/**
 * Consumed by plugin/connection-manager.ts (Notion token + OAuth flows).
 */
export interface ConnectionHost {
  readonly profile: WorkspaceProfile;
  settings: N2OSettings;
  readonly version: string;
  saveSettings(): Promise<void>;
  cachedWorkspaceName: string | null;
  getNotionClient(): NotionClient;
  getDatabase(): CoreDatabase;
  getDashboardManager(): DashboardManager;
  runSharedDiscovery(onProgress?: (msg: string) => void): Promise<void>;
}

/**
 * Consumed by the settings tab family: ui/settings-tab.ts owns it, and
 * ui/settings-helpers.ts threads it to every sub-tab through the shared ctx.
 */
export interface SettingsTabHost {
  readonly app: App;
  readonly manifest: PluginManifest;
  readonly version: string;
  settings: N2OSettings;
  readonly profile: WorkspaceProfile;
  saveSettings(): Promise<void>;
  cachedWorkspaceName: string | null;
  readonly isDiscoveryRunning: boolean;
  getDatabase(): CoreDatabase;
  getOrchestrator(): SyncOrchestrator;
  getSyncHistoryDB(): SyncHistoryDB;
  getNotionClient(): NotionClient;
  resetN2O(): Promise<void>;
  scanVaultIds(): Promise<Set<string>>;
  openUpgradeModal(autoInstall?: boolean, holdMs?: number): void;
  /* The connection tab drives connection-manager flows and the sync tab
   * triggers discovery, so this slice includes the ConnectionHost members
   * those flows need (it is structurally assignable to ConnectionHost). */
  getDashboardManager(): DashboardManager;
  runSharedDiscovery(onProgress?: (msg: string) => void): Promise<void>;
  discoverAccessibleContent(
    onProgress?: (msg: string) => void,
  ): Promise<{ pageCount: number; dbCount: number; items: SelectedSyncItem[] } | null>;
  testConnection(): Promise<{ success: boolean; detail: string; workspaceName?: string }>;
  disconnectOAuth(): Promise<void>;
}

/**
 * The composed surface main.ts implements. Nothing should consume this type
 * except the `implements` clause on N2OPlugin - handlers take their own
 * slice above.
 */
export interface PluginHost
  extends CommandHost, FileActionHost, InitHost, ConnectionHost, SettingsTabHost {}
