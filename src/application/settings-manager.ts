/**
 * SettingsManager - Extracted from main.ts to reduce God Class size.
 *
 * Owns settings load/save, migration, validation, and
 * post-save side effects (client token, engine settings, UI refresh).
 * Communicates with the plugin via the SettingsHost interface.
 */

import type { N2OSettings } from '../settings';
import {
  DEFAULT_SETTINGS,
  getActiveProfile,
  createProfile,
  toSyncConfig,
} from '../domain/models/config-schema';
import { parseWorkspaceProfile } from '../domain/models/config-schema';
import type { SyncStateDB } from '../infrastructure/storage/sync-state';
import type { VaultAdapter } from '../infrastructure/obsidian/vault';
import type { NotionClient } from '../infrastructure/notion/client';
import type { SyncEngine } from './sync/engine';
import { createLogger, setLogLevel } from '../shared/logger';
import {
  encryptString,
  decryptString,
  getOrCreateKey,
  isCiphertext,
  type Ciphertext,
} from '../shared/token-cipher';

const log = createLogger('SettingsManager');

/**
 * Host interface - the minimal contract the plugin provides to SettingsManager.
 */
export interface SettingsHost {
  /** Read persisted data from Obsidian's plugin data store. */
  loadData(): Promise<Record<string, unknown> | null>;
  /** Write persisted data to Obsidian's plugin data store. */
  saveData(data: Record<string, unknown>): Promise<void>;
  /** Serialized read-modify-write of data.json (avoids the settings/license TOCTOU). */
  updateData(mutator: (data: Record<string, unknown>) => void | Promise<void>): Promise<void>;

  // Mutable settings reference (shared with the plugin)
  settings: N2OSettings;

  // Components (may be undefined during early init)
  getSyncState(): SyncStateDB | undefined;
  getVaultAdapter(): VaultAdapter | undefined;
  getNotionClient(): NotionClient | undefined;
  getEngine(): SyncEngine | undefined;

  // Dashboard refresh
  refreshDashboards(): void;
  /** Show a transient notification to the user. Decouples application layer from Obsidian's Notice. */
  notify(message: string, duration?: number): void;
}

/**
 * Manages settings lifecycle: load, migrate, validate, save + post-save side effects.
 */
export class SettingsManager {
  /** Tracked to detect settings changes that require re-sync. All three snapshot
   *  the ACTIVE profile's values as of the last save; previousProfileId records
   *  which profile they belong to so a profile SWITCH is not misread as a folder
   *  rename / mappings change (#1547). */
  previousSyncFolder: string = '';
  previousMappingsKey: string = '';
  previousFiltersKey: string = '';
  previousProfileId: string = '';

  constructor(private host: SettingsHost) {}

  /** Public accessor for the host's settings reference. */
  get currentSettings(): N2OSettings {
    return this.host.settings;
  }
  set currentSettings(settings: N2OSettings) {
    this.host.settings = settings;
  }

  async loadSettings(): Promise<void> {
    const data = await this.host.loadData();
    this.host.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings ?? {});
    /* Phase J: notionToken on each profile is persisted as ciphertext
     * (AES-256-GCM, key in IndexedDB, see token-cipher.ts). Decrypt
     * BEFORE migrate/validate - parseWorkspaceProfile expects a
     * string and would silently drop the ciphertext envelope to the
     * default '' value otherwise, defeating the round-trip. */
    await this.decryptProfileSecrets();
    this.migrateSettings();
    this.validateSettings();
  }

  /**
   * Decrypt notionToken on every profile. Safe to call on a fresh
   * load (plaintext tokens from pre-Phase-J data.json files pass
   * through unchanged) and on a re-load (already-decrypted tokens
   * fail the isCiphertext check and pass through).
   *
   * Failure modes (each handled, never throws):
   *   - WebCrypto / IndexedDB unavailable: treat token as missing
   *     so the user gets a clean "please re-enter token" prompt
   *     instead of a crash.
   *   - Decryption fails (wrong key after vault copy, corrupt
   *     ciphertext): same - drop the token to '' and warn.
   */
  private async decryptProfileSecrets(): Promise<void> {
    let key: CryptoKey | null = null;
    try {
      key = await getOrCreateKey();
    } catch (err) {
      log.warn(
        `Token cipher unavailable, skipping decryption: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Drop any ciphertext tokens to '' so the rest of the plugin
      // sees them as missing and surfaces the "not connected" UI.
      for (const profile of this.host.settings.profiles) {
        if (isCiphertext(profile.notionToken)) {
          (profile as unknown as { notionToken: string }).notionToken = '';
        }
      }
      return;
    }
    for (const profile of this.host.settings.profiles) {
      const stored = profile.notionToken as unknown;
      if (!stored) continue;
      if (!isCiphertext(stored)) continue; // plaintext (legacy or fresh) - leave as-is
      try {
        profile.notionToken = await decryptString(stored, key);
      } catch (err) {
        log.warn(
          `Failed to decrypt notionToken for profile "${profile.name}" ` +
            `(likely a vault copy or wiped key): ${err instanceof Error ? err.message : String(err)}. ` +
            `Token reset to empty - re-enter via Settings.`,
        );
        profile.notionToken = '';
      }
    }
  }

  /**
   * Return a deep clone of `s` with each profile's notionToken encrypted.
   * The live in-memory settings object is NOT mutated - downstream code
   * (NotionClient.setToken, connection-manager) keeps reading the
   * plaintext. Only the bytes that hit data.json are ciphertext.
   *
   * Empty tokens stay empty (no point encrypting absence). Cipher
   * unavailability falls back to plaintext storage with a warning -
   * this matches the documented threat model: defense-in-depth, not
   * a security boundary, so degrading to the pre-Phase-J behavior is
   * acceptable when WebCrypto/IndexedDB is missing.
   */
  private async encryptProfileSecrets(s: N2OSettings): Promise<N2OSettings> {
    let key: CryptoKey | null = null;
    try {
      key = await getOrCreateKey();
    } catch (err) {
      log.warn(
        `Token cipher unavailable, persisting plaintext: ${err instanceof Error ? err.message : String(err)}`,
      );
      return s;
    }
    const cloned: N2OSettings = { ...s, profiles: s.profiles.map((p) => ({ ...p })) };
    for (const profile of cloned.profiles) {
      const token = profile.notionToken;
      if (!token || isCiphertext(token)) continue;
      try {
        (profile as unknown as { notionToken: Ciphertext }).notionToken = await encryptString(
          token,
          key,
        );
      } catch (err) {
        log.warn(
          `Failed to encrypt notionToken for profile "${profile.name}", ` +
            `persisting plaintext for this save: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return cloned;
  }

  /**
   * Ensure the loaded settings have at least one workspace profile and an
   * active profile id. This is the residual safety net that keeps a fresh or
   * partially-shaped load from crashing.
   *
   * NOTE: the product is LIVE with real paying users. Any future change to the
   * stored settings shape needs a real migration here, not a deletion - do not
   * treat persisted settings as disposable. (The old v0..v6 profile-reshape
   * ladder was removed earlier; that concerned a shape no current install uses,
   * not a license to drop migrations going forward.)
   */
  migrateSettings(): void {
    const s = this.host.settings;
    if (!s.profiles || s.profiles.length === 0) {
      s.profiles = [createProfile('default', 'Notion', '')];
      s.activeProfileId = 'default';
      log.info('Initialized empty profiles array with a default profile');
    } else if (!s.profiles.find((p) => p.id === s.activeProfileId)) {
      const first = s.profiles[0];
      if (first) s.activeProfileId = first.id;
    }
  }

  /**
   * Validate settings values after load. Fix invalid values silently
   * to prevent runtime errors from corrupted or hand-edited config.
   *
   * Uses parseWorkspaceProfile() from config-schema.ts to normalize each profile.
   * The parser fills in defaults for missing fields and clamps values to valid ranges.
   * Manual fixups handle edge cases before parsing (e.g., parent traversal in paths,
   * invalid enum values, token trimming).
   */
  validateSettings(): void {
    const s = this.host.settings;

    for (let i = 0; i < s.profiles.length; i++) {
      const p = s.profiles[i];

      // Pre-fixup: correct values that would fail Zod refinements/enums
      // so safeParse succeeds with corrected values rather than rejecting.
      const rec = p as unknown as Record<string, unknown>;
      // Loosely-typed record fields are logged when a fixup fires; render them
      // safely so a non-string value never stringifies to "[object Object]".
      const safeStr = (v: unknown): string =>
        typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);

      // Sync folder: must be non-empty, no parent traversal
      if (
        !rec.syncFolder ||
        (typeof rec.syncFolder === 'string' && rec.syncFolder.includes('..'))
      ) {
        log.warn(
          `Invalid syncFolder "${safeStr(rec.syncFolder)}" in profile "${safeStr(rec.name)}", resetting to default`,
        );
        rec.syncFolder = 'Notion';
      }

      // Standalone folder: no parent traversal
      if (typeof rec.standaloneFolder === 'string' && rec.standaloneFolder.includes('..')) {
        log.warn(
          `Invalid standaloneFolder "${rec.standaloneFolder}" in profile "${safeStr(rec.name)}", resetting to default`,
        );
        rec.standaloneFolder = '_Pages';
      }

      // Notion token: trim whitespace
      if (typeof rec.notionToken === 'string' && rec.notionToken) {
        rec.notionToken = rec.notionToken.trim();
        // Only warn about ntn_ prefix for internal tokens (OAuth tokens have a different format)
        if (
          rec.notionToken &&
          rec.authType !== 'oauth' &&
          !(rec.notionToken as string).startsWith('ntn_')
        ) {
          log.warn(
            `Notion token in profile "${safeStr(rec.name)}" does not start with "ntn_" - it may be invalid`,
          );
        }
      }

      // Ensure arrays are actually arrays
      if (!Array.isArray(rec.notionPages)) rec.notionPages = [];
      if (!Array.isArray(rec.selectedItems)) rec.selectedItems = [];
      if (!Array.isArray(rec.databaseFilters)) rec.databaseFilters = [];
      if (!Array.isArray(rec.propertyMappings)) rec.propertyMappings = [];

      // Parse through validator to fill in any missing fields with defaults
      s.profiles[i] = parseWorkspaceProfile(rec);
    }

    // Ensure activeProfileId points to a valid profile
    if (!s.profiles.find((p) => p.id === s.activeProfileId)) {
      s.activeProfileId = s.profiles[0]?.id ?? '';
    }
  }

  async saveSettings(): Promise<void> {
    const s = this.host.settings;
    const profile = getActiveProfile(s);

    // Detect settings changes before saving. A profile SWITCH is not a change
    // to the active profile's settings: the previous* snapshot belongs to the
    // OLD profile, so comparing it against the NEW profile would spuriously fire
    // a folder rename (physically moving one workspace's files into another) and
    // a full timestamp invalidation. When the active profile changed, skip the
    // change detection entirely and just re-seed the snapshot below (#1547).
    const syncState = this.host.getSyncState();
    const profileSwitched =
      this.previousProfileId !== '' && this.previousProfileId !== s.activeProfileId;

    const folderChanged =
      !profileSwitched &&
      this.previousSyncFolder &&
      this.previousSyncFolder !== profile.syncFolder &&
      syncState;

    const currentMappingsKey = JSON.stringify(profile.propertyMappings);
    const currentFiltersKey = JSON.stringify(profile.databaseFilters);
    const mappingsChanged =
      !profileSwitched &&
      this.previousMappingsKey &&
      this.previousMappingsKey !== currentMappingsKey &&
      syncState;
    const filtersChanged =
      !profileSwitched &&
      this.previousFiltersKey &&
      this.previousFiltersKey !== currentFiltersKey &&
      syncState;

    /* Phase J: encrypt notionToken on every profile before persisting.
     * Build a clone of `s` so the live in-memory settings keep the
     * plaintext token that downstream callers (NotionClient.setToken,
     * connection manager, etc.) need synchronously.
     * Serialized via updateData so a concurrent license save can't clobber
     * settings (or vice versa) through a read-modify-write race on data.json. */
    await this.host.updateData(async (data) => {
      data.settings = await this.encryptProfileSecrets(s);
    });

    // Migrate files if sync folder changed
    if (folderChanged && syncState) {
      await this.migrateSyncFolder(syncState, this.previousSyncFolder, profile.syncFolder);
    }
    this.previousSyncFolder = profile.syncFolder;

    // Invalidate sync state if property mappings or filters changed
    if ((mappingsChanged || filtersChanged) && syncState) {
      const count = syncState.invalidateAllTimestamps();
      const what =
        mappingsChanged && filtersChanged
          ? 'Property mappings & filters'
          : mappingsChanged
            ? 'Property mappings'
            : 'Database filters';
      this.host.notify(
        `N2O: ${what} changed - ${count} file${count !== 1 ? 's' : ''} will re-sync on next run.`,
        8000,
      );
    }
    this.previousMappingsKey = currentMappingsKey;
    this.previousFiltersKey = currentFiltersKey;
    // Snapshot now belongs to whichever profile is active after this save.
    this.previousProfileId = s.activeProfileId;

    // Apply settings changes
    if (s.debugMode) {
      setLogLevel('debug');
    } else {
      setLogLevel('info');
    }

    // Update Notion client token
    this.host.getNotionClient()?.setToken(profile.notionToken);

    // Update engine settings
    this.host.getEngine()?.updateSettings(toSyncConfig(s));

    // Refresh all UI surfaces
    this.host.refreshDashboards();
  }

  /**
   * Migrate synced files when the sync folder changes.
   */
  private async migrateSyncFolder(
    syncState: SyncStateDB,
    oldFolder: string,
    newFolder: string,
  ): Promise<void> {
    const vaultAdapter = this.host.getVaultAdapter();
    if (!vaultAdapter) return;

    const records = syncState.getAllRecords();
    if (records.length === 0) return;

    let moved = 0;
    let failed = 0;
    for (const record of records) {
      if (!record.obsidianPath.startsWith(oldFolder + '/')) continue;
      const relativePath = record.obsidianPath.substring(oldFolder.length);
      const newPath = newFolder + relativePath;
      try {
        if (vaultAdapter.fileExists(record.obsidianPath)) {
          await vaultAdapter.moveFile(record.obsidianPath, newPath);
        }
        syncState.updatePath(record.obsidianPath, newPath);
        moved++;
      } catch {
        log.warn(`Could not migrate: ${record.obsidianPath}`);
        failed++;
      }
    }

    if (moved > 0 || failed > 0) {
      const msg =
        failed === 0
          ? `N2O: Moved ${moved} file${moved > 1 ? 's' : ''} to ${newFolder}/`
          : `N2O: Moved ${moved} file${moved > 1 ? 's' : ''}, ${failed} failed`;
      this.host.notify(msg, 8000);
      log.info(
        `Sync folder migration: ${oldFolder} -> ${newFolder} (${moved} moved, ${failed} failed)`,
      );
    }
  }
}
