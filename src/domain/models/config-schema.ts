/**
 * config-schema.ts - Hand-written types and validators as the single source of truth
 * for all config types.
 *
 * Every settings type (WorkspaceProfile, N2OSettings, SyncConfig) is defined here
 * as a TypeScript interface with corresponding parse/validate functions.
 *
 * Defaults are embedded in the parse functions, so parsing an empty object
 * produces the same defaults as the old Zod-based constants.
 */

// ── Reusable union types ──────────────────────────────────

export type SyncScope = 'all' | 'selected';
export type AuthType = 'internal' | 'oauth';

// ── SelectedSyncItem ────────────────────────────────────

export interface SelectedSyncItem {
  id: string;
  title: string;
  type: 'database' | 'page';
  /** For databases: number of child pages at last expand/save. */
  itemCount?: number;
}

// ── FilterCondition / DatabaseFilter ────────────────────

export interface FilterCondition {
  property: string;
  propertyType: string;
  operator: string;
  value: string | boolean | number;
}

export interface DatabaseFilter {
  databaseId: string;
  databaseName: string;
  conditions: FilterCondition[];
  match: 'and' | 'or';
}

// ── PropertyMapping / SyncPropertyMapping ───────────────

export interface PropertyMapping {
  databaseId: string;
  databaseName: string;
  mappings: Record<
    string,
    {
      frontmatterKey: string;
      excluded: boolean;
      format?: 'auto' | 'iso' | 'human' | 'tags';
    }
  >;
}

/** Alias -- SyncPropertyMapping is the same shape as PropertyMapping. */
export type SyncPropertyMapping = PropertyMapping;

// ── Sync-side aliases (same shapes, different names for decoupling) ──

/** SyncSelectedItem is structurally identical to SelectedSyncItem. */
export type SyncSelectedItem = SelectedSyncItem;

export type SyncFilterCondition = FilterCondition;

export type SyncDatabaseFilter = DatabaseFilter;

// ── WorkspaceProfile ────────────────────────────────────

export interface WorkspaceProfile {
  /** UUID, generated on creation. */
  id: string;
  /** User-facing label ("Work", "Personal"). */
  name: string;
  /** Notion integration token (internal) or OAuth access token. */
  notionToken: string;

  /** Authentication method: 'internal' (manual token) or 'oauth' (browser flow). */
  authType: AuthType;
  /** Notion bot ID returned during OAuth (used for identification). */
  oauthBotId: string;
  /** Notion workspace ID returned during OAuth. */
  oauthWorkspaceId: string;

  /** Cached from Notion API. */
  workspaceName?: string;
  /** Owner name from OAuth (the user who authorized the integration). */
  workspaceOwnerName?: string;
  /** Owner email from OAuth. */
  workspaceOwnerEmail?: string;

  // Sync Scope
  syncScope: SyncScope;
  selectedItems: SelectedSyncItem[];
  notionPages: string[];

  // Folders
  syncFolder: string;
  useStandaloneFolder: boolean;
  standaloneFolder: string;

  // Filters & Mapping
  databaseFilters: DatabaseFilter[];
  propertyMappings: PropertyMapping[];

  // Sync Behavior
  createConflictNotes: boolean;
  downloadMedia: boolean;
  generateThumbnails: boolean;
  /**
   * #1756: when an image upload fails on the Notion plan's size cap, re-encode
   * a copy under the cap and retry once (the vault original never changes).
   * Off = the upload failure surfaces as a plain warning (#1750).
   */
  autoOptimizeOversizedImages: boolean;
  /** How file-property images are rendered: 'inline' (body embeds), 'frontmatter' (YAML only), 'hidden' (excluded). */
  filePropertyRenderMode: 'inline' | 'frontmatter' | 'hidden';
  /**
   * Auto-tidy subsystem master flag. When enabled, the plugin performs
   * vault-hygiene passes after each sync:
   *   - move embedded media files into the page's `_files/` folder
   *     with a content-addressed name (F-026)
   *   - (future) filename sanitization, orphan cleanup, etc.
   * Defaults to true; users who curate media manually can opt out.
   */
  autoOrganize: boolean;
  syncDeletedItems: boolean;
  syncChildPages: boolean;
  syncChildDatabases: boolean;
  /** When true, linked views download the full source database. When false (default), only filtered items. */
  linkedViewFullDatabase: boolean;
  /**
   * Render Notion column layouts as multi-column blocks in the synced
   * markdown. Defaults to true: multi-column rendering has always been
   * on, so existing profiles (where this field is missing) must read as
   * true - defaulting to false would silently flatten their columns.
   */
  enableMultiColumnLayout?: boolean;

  // Performance
}

// ── N2OSettings ─────────────────────────────────────────

export interface N2OSettings {
  // Multi-workspace
  profiles: WorkspaceProfile[];
  activeProfileId: string;

  // ── Global settings (NOT per-workspace) ──
  debugMode: boolean;

  /**
   * Newsletter opt-in, chosen via the checkbox in the connect flow (default
   * false - unchecked). Sent to the license server with the OAuth token
   * exchange; the server subscribes the account's email only when true.
   * Additive optional field: absent in the full edition's data.json, which
   * ignores it - safe for the Lite-to-Pro settings handover.
   */
  newsletterOptIn?: boolean;

  /** Internal version number for settings migration. */
  settingsVersion: number;

  // ── Growth flags ──
  /** True after the first sync that synced 10+ pages (to prevent repeat celebration notices). */
  firstSyncCelebrated: boolean;
  /** True after the user has been shown the Enhanced Metadata pre-sync prompt. */
  dismissedMetadataPrompt: boolean;
  /**
   * True once the welcome note has been written (#1973). Written on the first
   * successful sync and never again - the README promises Lite does not nag.
   */
  welcomeNoteWritten?: boolean;
  /**
   * True once the upgrade dialog has auto-opened. It opens ONCE, on the first
   * launch after install, and never again on its own. Every launch would be a
   * modal blocking the app, which is what gets a listed plugin reported.
   */
  upgradeDialogShown?: boolean;

  // ── Update check ──
  /** ISO timestamp of last GitHub release check. */
  lastUpdateCheck?: string;
  /** Version string the user dismissed (don't show banner again for this version). */
  dismissedUpdateVersion?: string;
}

// ── SyncConfig ──────────────────────────────────────────

export interface SyncConfig {
  // Scope & selection
  syncScope: SyncScope;
  selectedItems: SyncSelectedItem[];
  notionPages: string[];

  // Folders
  syncFolder: string;
  useStandaloneFolder: boolean;
  standaloneFolder: string;

  // Sync behavior
  createConflictNotes: boolean;
  downloadMedia: boolean;
  generateThumbnails: boolean;
  /** #1756: re-encode + retry oversized image uploads under the plan cap. */
  autoOptimizeOversizedImages: boolean;
  /** F-026: auto-organize pass runs after sync to move embedded media into _files/. */
  autoOrganize: boolean;
  filePropertyRenderMode: 'inline' | 'frontmatter' | 'hidden';
  syncDeletedItems: boolean;
  syncChildPages: boolean;
  syncChildDatabases: boolean;
  linkedViewFullDatabase: boolean;
  /**
   * Render Notion column layouts as multi-column callouts. Optional so
   * existing profiles (missing the field) read as enabled; consumers treat
   * `undefined` as true. When false, columns are flattened into stacked blocks.
   */
  enableMultiColumnLayout?: boolean;

  // Filters & property mappings
  databaseFilters: SyncDatabaseFilter[];
  propertyMappings: PropertyMapping[];

  // Performance
}

// ── Default values for WorkspaceProfile ─────────────────

const WORKSPACE_PROFILE_DEFAULTS: Omit<WorkspaceProfile, 'id' | 'name'> = {
  notionToken: '',
  authType: 'internal',
  oauthBotId: '',
  oauthWorkspaceId: '',
  syncScope: 'selected',
  selectedItems: [],
  notionPages: [],
  syncFolder: 'Notion',
  useStandaloneFolder: true,
  standaloneFolder: '_Pages',
  databaseFilters: [],
  propertyMappings: [],
  createConflictNotes: true,
  downloadMedia: true,
  generateThumbnails: true,
  /* #1756: ON by default - the only alternative when the plan cap rejects an
   * image is that it never reaches Notion at all. */
  autoOptimizeOversizedImages: true,
  filePropertyRenderMode: 'inline' as const,
  /* Auto-tidy: move embedded media into _files/ on each sync. Defaults
   * ON so fresh installs keep the vault clean by default; users who
   * curate media layout manually can toggle off. */
  autoOrganize: true,
  syncDeletedItems: false,
  /* syncChildPages / syncChildDatabases default to FALSE (opt-in).
   * When the user picks ONE page in the tree picker, recursion would
   * silently turn that into a multi-hundred-page pull on deep trees.
   * Users who want recursive descent enable these flags explicitly.
   * See docs/reports/audits/2026-04-23-qa-session-findings.md#f-001 */
  syncChildPages: false,
  syncChildDatabases: false,
  linkedViewFullDatabase: false,
  enableMultiColumnLayout: true,
};

// ── Parse / validate functions ──────────────────────────

/** Element guard: keep only non-null objects (drops nulls/primitives) (#1561). */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ── Per-element sanitizers for persisted object arrays ──
//
// These repair what they can and drop only entries with no usable id.
// Dropping a repairable entry would silently shrink the user's sync scope
// and orphan files on the next selected-scope pull, so the bias is:
// bad field -> default it, missing id -> the entry couldn't sync anyway.

/** Sanitize one selectedItems entry. Null when there is no usable id. */
function parseSelectedItem(raw: unknown): SelectedSyncItem | null {
  if (!isObject(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
  const item: SelectedSyncItem = {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : '',
    // 'page' keeps a type-corrupted entry inside the sync scope; the old
    // pass-through made it match NEITHER type check and scoped it out.
    type: enumGuard(raw.type, ['database', 'page'] as const, 'page'),
  };
  if (typeof raw.itemCount === 'number' && Number.isFinite(raw.itemCount)) {
    item.itemCount = raw.itemCount;
  }
  return item;
}

/** Sanitize one FilterCondition. Null drops the condition (loosens the
 *  filter, so a corrupt condition pulls more pages rather than fewer). */
function parseFilterCondition(raw: unknown): FilterCondition | null {
  if (!isObject(raw)) return null;
  if (
    typeof raw.property !== 'string' ||
    typeof raw.propertyType !== 'string' ||
    typeof raw.operator !== 'string'
  )
    return null;
  const value = raw.value;
  if (typeof value !== 'string' && typeof value !== 'boolean' && typeof value !== 'number')
    return null;
  return { property: raw.property, propertyType: raw.propertyType, operator: raw.operator, value };
}

/**
 * Copy any key the parser does not know about from the stored object onto the
 * parsed one.
 *
 * `parseWorkspaceProfile` builds a fresh object from an explicit field list, so
 * without this a key it does not name is dropped from `data.json` on the next
 * save. That matters because settings are real user data: a field this build
 * has no opinion about (one written by a newer build, or by the full edition
 * before a handover) must survive a load/save cycle untouched rather than be
 * silently deleted. Known fields always win; unknown ones ride along.
 */
function carryUnknownKeys<T extends object>(raw: Record<string, unknown>, parsed: T): T {
  const out = parsed as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(key in out)) out[key] = raw[key];
  }
  return parsed;
}

/** Sanitize one databaseFilters entry. Null when there is no database id. */
function parseDatabaseFilter(raw: unknown): DatabaseFilter | null {
  if (!isObject(raw)) return null;
  if (typeof raw.databaseId !== 'string' || raw.databaseId.length === 0) return null;
  return {
    databaseId: raw.databaseId,
    databaseName: typeof raw.databaseName === 'string' ? raw.databaseName : '',
    // A non-array here crashed buildNotionFilter (config.conditions.length).
    conditions: Array.isArray(raw.conditions)
      ? raw.conditions.map(parseFilterCondition).filter((c): c is FilterCondition => c !== null)
      : [],
    match: enumGuard(raw.match, ['and', 'or'] as const, 'and'),
  };
}

/** Sanitize one propertyMappings entry. Null when there is no database id. */
function parsePropertyMapping(raw: unknown): PropertyMapping | null {
  if (!isObject(raw)) return null;
  if (typeof raw.databaseId !== 'string' || raw.databaseId.length === 0) return null;
  const mappings: PropertyMapping['mappings'] = {};
  if (isObject(raw.mappings)) {
    for (const [key, val] of Object.entries(raw.mappings)) {
      if (!isObject(val) || typeof val.frontmatterKey !== 'string') continue;
      const entry: PropertyMapping['mappings'][string] = {
        frontmatterKey: val.frontmatterKey,
        excluded: typeof val.excluded === 'boolean' ? val.excluded : false,
      };
      if (
        val.format === 'auto' ||
        val.format === 'iso' ||
        val.format === 'human' ||
        val.format === 'tags'
      ) {
        entry.format = val.format;
      }
      mappings[key] = entry;
    }
  }
  return {
    databaseId: raw.databaseId,
    databaseName: typeof raw.databaseName === 'string' ? raw.databaseName : '',
    mappings,
  };
}

/** Helper: return value if it's one of the allowed strings, else fallback. */
function enumGuard<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value))
    return value as T;
  return fallback;
}

/**
 * Parse a raw object into a WorkspaceProfile, filling defaults for missing fields.
 * Requires `id` and `name` in the input.
 */
export function parseWorkspaceProfile(raw: Record<string, unknown>): WorkspaceProfile {
  const d = WORKSPACE_PROFILE_DEFAULTS;
  const parsed: WorkspaceProfile = {
    id: typeof raw.id === 'string' ? raw.id : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    notionToken: typeof raw.notionToken === 'string' ? raw.notionToken : d.notionToken,

    authType: enumGuard(raw.authType, ['internal', 'oauth'] as const, d.authType),
    oauthBotId: typeof raw.oauthBotId === 'string' ? raw.oauthBotId : d.oauthBotId,
    oauthWorkspaceId:
      typeof raw.oauthWorkspaceId === 'string' ? raw.oauthWorkspaceId : d.oauthWorkspaceId,

    workspaceName: typeof raw.workspaceName === 'string' ? raw.workspaceName : undefined,
    workspaceOwnerName:
      typeof raw.workspaceOwnerName === 'string' ? raw.workspaceOwnerName : undefined,
    workspaceOwnerEmail:
      typeof raw.workspaceOwnerEmail === 'string' ? raw.workspaceOwnerEmail : undefined,

    syncScope: enumGuard(raw.syncScope, ['all', 'selected'] as const, d.syncScope),
    // Field-level sanitize (#1561, deepened): repair bad fields, drop only
    // id-less entries, so one corrupted entry can't crash downstream and a
    // repairable one never falls out of the sync scope.
    selectedItems: Array.isArray(raw.selectedItems)
      ? raw.selectedItems.map(parseSelectedItem).filter((x): x is SelectedSyncItem => x !== null)
      : [...d.selectedItems],
    notionPages: Array.isArray(raw.notionPages)
      ? (raw.notionPages as unknown[]).filter((x): x is string => typeof x === 'string')
      : [...d.notionPages],

    syncFolder:
      typeof raw.syncFolder === 'string' && raw.syncFolder && !raw.syncFolder.includes('..')
        ? raw.syncFolder
        : d.syncFolder,
    useStandaloneFolder:
      typeof raw.useStandaloneFolder === 'boolean'
        ? raw.useStandaloneFolder
        : d.useStandaloneFolder,
    // Reject an empty standaloneFolder too - it would write pages to the vault
    // root instead of the intended subfolder (#1561).
    standaloneFolder:
      typeof raw.standaloneFolder === 'string' &&
      raw.standaloneFolder.length > 0 &&
      !raw.standaloneFolder.includes('..')
        ? raw.standaloneFolder
        : d.standaloneFolder,

    databaseFilters: Array.isArray(raw.databaseFilters)
      ? raw.databaseFilters.map(parseDatabaseFilter).filter((x): x is DatabaseFilter => x !== null)
      : [...d.databaseFilters],
    propertyMappings: Array.isArray(raw.propertyMappings)
      ? raw.propertyMappings
          .map(parsePropertyMapping)
          .filter((x): x is PropertyMapping => x !== null)
      : [...d.propertyMappings],

    createConflictNotes:
      typeof raw.createConflictNotes === 'boolean'
        ? raw.createConflictNotes
        : d.createConflictNotes,
    downloadMedia: typeof raw.downloadMedia === 'boolean' ? raw.downloadMedia : d.downloadMedia,
    generateThumbnails:
      typeof raw.generateThumbnails === 'boolean' ? raw.generateThumbnails : d.generateThumbnails,
    autoOptimizeOversizedImages:
      typeof raw.autoOptimizeOversizedImages === 'boolean'
        ? raw.autoOptimizeOversizedImages
        : d.autoOptimizeOversizedImages,
    autoOrganize: typeof raw.autoOrganize === 'boolean' ? raw.autoOrganize : d.autoOrganize,
    filePropertyRenderMode: enumGuard(
      raw.filePropertyRenderMode,
      ['inline', 'frontmatter', 'hidden'] as const,
      d.filePropertyRenderMode,
    ),
    syncDeletedItems:
      typeof raw.syncDeletedItems === 'boolean' ? raw.syncDeletedItems : d.syncDeletedItems,
    syncChildPages: typeof raw.syncChildPages === 'boolean' ? raw.syncChildPages : d.syncChildPages,
    syncChildDatabases:
      typeof raw.syncChildDatabases === 'boolean' ? raw.syncChildDatabases : d.syncChildDatabases,
    linkedViewFullDatabase:
      typeof raw.linkedViewFullDatabase === 'boolean'
        ? raw.linkedViewFullDatabase
        : d.linkedViewFullDatabase,
    enableMultiColumnLayout:
      typeof raw.enableMultiColumnLayout === 'boolean'
        ? raw.enableMultiColumnLayout
        : d.enableMultiColumnLayout,

    // Clamp both at parse time (#1559). A corrupted data.json with
  };

  return carryUnknownKeys(raw, parsed);
}

/**
 * Parse a raw object into N2OSettings, filling defaults for missing fields.
 */
export function parseN2OSettings(raw?: Record<string, unknown>): N2OSettings {
  const r = raw ?? {};
  return {
    // Drop profiles that parse to an empty id: an id-less profile can't be
    // referenced by activeProfileId or synced, and two of them would both
    // fabricate '' and collide into one. Failing the parse for those is safer
    // than inventing an id (#1589). An empty result is backfilled with the
    // default profile by the settings loader.
    profiles: Array.isArray(r.profiles)
      ? (r.profiles as Record<string, unknown>[])
          .map((p) => parseWorkspaceProfile(p))
          .filter((p) => p.id !== '')
      : [],
    activeProfileId: typeof r.activeProfileId === 'string' ? r.activeProfileId : '',

    // Global settings
    debugMode: typeof r.debugMode === 'boolean' ? r.debugMode : false,
    newsletterOptIn: typeof r.newsletterOptIn === 'boolean' ? r.newsletterOptIn : false,

    settingsVersion: typeof r.settingsVersion === 'number' ? r.settingsVersion : 6,

    // Growth flags
    firstSyncCelebrated: typeof r.firstSyncCelebrated === 'boolean' ? r.firstSyncCelebrated : false,
    dismissedMetadataPrompt:
      typeof r.dismissedMetadataPrompt === 'boolean' ? r.dismissedMetadataPrompt : false,
    welcomeNoteWritten: typeof r.welcomeNoteWritten === 'boolean' ? r.welcomeNoteWritten : false,
    upgradeDialogShown: typeof r.upgradeDialogShown === 'boolean' ? r.upgradeDialogShown : false,

    // Update check - preserved only when present so they stay optional (#1549).
    // Dropping dismissedUpdateVersion here made the update banner reappear every
    // load once persisted data is routed through this parser.
    ...(typeof r.lastUpdateCheck === 'string' ? { lastUpdateCheck: r.lastUpdateCheck } : {}),
    ...(typeof r.dismissedUpdateVersion === 'string'
      ? { dismissedUpdateVersion: r.dismissedUpdateVersion }
      : {}),
  };
}

// ── Defaults, profile constructors, and derived config ──────────────
// Pure transforms over the schema types above. They live here, not in
// src/settings.ts, so application/ui/plugin code reaches them through the
// domain model instead of importing back up into a root module.

/**
 * Default values for a new workspace profile.
 * Produced by parsing a minimal object through the parse function.
 */
export const DEFAULT_PROFILE: Omit<WorkspaceProfile, 'id' | 'name' | 'notionToken'> = (() => {
  const parsed = parseWorkspaceProfile({ id: '__tmp__', name: '__tmp__', notionToken: '' });
  const { id, name, notionToken, ...rest } = parsed;
  return rest;
})();

/**
 * Default N2OSettings.
 * Produced by parsing an empty object through the parse function.
 */
export const DEFAULT_SETTINGS: N2OSettings = parseN2OSettings({});

/** Create a new profile with defaults. */
export function createProfile(id: string, name: string, token: string): WorkspaceProfile {
  return { ...DEFAULT_PROFILE, id, name, notionToken: token, authType: 'internal' };
}

/** Create a new OAuth profile from token exchange data. */
export function createOAuthProfile(
  id: string,
  name: string,
  accessToken: string,
  botId: string,
  workspaceId: string,
): WorkspaceProfile {
  return {
    ...DEFAULT_PROFILE,
    id,
    name,
    notionToken: accessToken,
    authType: 'oauth',
    oauthBotId: botId,
    oauthWorkspaceId: workspaceId,
    workspaceName: name,
  };
}

/**
 * Get the active workspace profile from settings.
 * Falls back to the first profile if activeProfileId is invalid.
 *
 * Guaranteed non-undefined: ~200 call sites (plugin.profile, every settings
 * tab) dereference the result directly, so returning undefined on an empty
 * profiles array would just relocate the crash. An empty array is an invariant
 * violation (the default profile guarantees at least one), so we fail fast with
 * a clear message instead.
 */
export function getActiveProfile(settings: N2OSettings): WorkspaceProfile {
  const profile =
    settings.profiles.find((p) => p.id === settings.activeProfileId) ?? settings.profiles[0];
  if (!profile) {
    throw new Error('N2O settings contain no workspace profiles (expected at least one)');
  }
  return profile;
}

/**
 * Build a clean SyncConfig from the active profile + global flags.
 *
 * This replaces the previous `flattenSettings()` which copied 33 per-workspace
 * fields into a top-level mirror on N2OSettings. That mirror was a textbook
 * twin-path: every new per-workspace setting required edits in three places
 * (WorkspaceProfile, N2OSettings legacy block, flattenSettings) and the
 * "kept for backward compat" comment had outlived its usefulness now that
 * there are zero pre-multi-workspace users.
 *
 * The engine and other sync-side modules now consume SyncConfig directly,
 * which is the canonical "what does sync need to know" shape. N2OSettings
 * holds only the multi-workspace data (profiles, activeProfileId) and the
 * GENUINELY global fields (license, device, debug, growth flags, bases).
 */
export function toSyncConfig(settings: N2OSettings): SyncConfig {
  const profile = getActiveProfile(settings);
  return {
    syncScope: profile.syncScope,
    selectedItems: profile.selectedItems,
    notionPages: profile.notionPages,
    syncFolder: profile.syncFolder,
    useStandaloneFolder: profile.useStandaloneFolder,
    standaloneFolder: profile.standaloneFolder,
    createConflictNotes: profile.createConflictNotes,
    downloadMedia: profile.downloadMedia,
    generateThumbnails: profile.generateThumbnails,
    autoOptimizeOversizedImages: profile.autoOptimizeOversizedImages,
    autoOrganize: profile.autoOrganize,
    filePropertyRenderMode: profile.filePropertyRenderMode,
    syncDeletedItems: profile.syncDeletedItems,
    syncChildPages: profile.syncChildPages,
    syncChildDatabases: profile.syncChildDatabases,
    linkedViewFullDatabase: profile.linkedViewFullDatabase,
    enableMultiColumnLayout: profile.enableMultiColumnLayout,
    databaseFilters: profile.databaseFilters,
    propertyMappings: profile.propertyMappings,
  };
}
