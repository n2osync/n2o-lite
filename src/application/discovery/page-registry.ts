/**
 * PageRegistry - Maps every Notion page/database ID to its planned vault path.
 * Built during Pass 1 (discovery), consumed during Pass 2 (rendering).
 * The ObsidianBuilder uses this to resolve mentions and page links to [[wikilinks]].
 */

import { sanitizeFileName, makeUniqueName, fitFileNameToBudget } from '../../shared/sanitize';
import { createLogger } from '../../shared/logger';
import type {
  PageRegistryEntry,
  PageRegistryReader,
  LinkedViewContext,
} from '../../domain/models/page-registry';
import { asDataSourceId, type DataSourceId } from '../../domain/models/notion-id';

export type { PageRegistryEntry } from '../../domain/models/page-registry';

const log = createLogger('PageRegistry');

/**
 * Fallback vault-relative path budget when the orchestrator has not supplied
 * the real one (vaultRelativePathBudget from the actual vault root length).
 * Assumes a ~60-80 char vault root under the stock-Windows 260-char cap.
 */
const DEFAULT_RELATIVE_PATH_BUDGET = 200;

/** Warn when registry grows beyond this many entries (memory concern). */
const SIZE_WARNING_THRESHOLD = 5000;

/**
 * Canonical linked-view base filename derivation (PURE function).
 *
 * This is the SINGLE source of truth for linked-view filenames. Both the
 * registrar (so the .base file gets written at the right path) and the
 * block renderer (so the `![[...base]]` wikilink points at that path)
 * MUST derive the filename from THIS function. Divergent logic in either
 * place produces broken embeds (raw `![[...base]]` text in Obsidian).
 *
 * @returns filename WITHOUT `.base` extension
 */
export function deriveLinkedViewBaseName(
  viewTitle: string,
  parentPageTitle: string,
  viewBlockId: string,
): string {
  const safeViewName = sanitizeFileName(viewTitle || 'View');
  const safeParentTitle = sanitizeFileName(parentPageTitle || 'Page');
  // Use the dashless form of the ID so the short-id is stable whether
  // the block-id comes in dashed or dashless form.
  const normalizedId = viewBlockId.replace(/-/g, '');
  const shortId = normalizedId.substring(0, 8);
  return `${safeViewName} - ${safeParentTitle} (${shortId})`;
}

export class PageRegistry implements PageRegistryReader {
  private entries = new Map<string, PageRegistryEntry>();
  /** Track used names per folder to ensure uniqueness */
  private usedNames = new Map<string, Set<string>>();
  /** Aliases: viewId -> canonicalId (for linked database views) */
  private aliases = new Map<string, string>();
  /** Maps block UUID -> data_source_id for databases (resolves the dual ID namespace) */
  private dataSourceIds = new Map<string, string>();
  /** Vault-relative path budget filenames are clamped to fit (#1759). */
  private relativePathBudget = DEFAULT_RELATIVE_PATH_BUDGET;

  /**
   * Supply the real relative-path budget (vaultRelativePathBudget over the
   * actual vault root length). Call before registering entries.
   */
  setRelativePathBudget(budget: number): void {
    this.relativePathBudget = budget;
  }

  /** Normalize Notion UUIDs to dashless format for consistent Map keying. */
  private normalizeId(id: string): string {
    // Only strip dashes from UUID-formatted strings (8-4-4-4-12 hex pattern)
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return id.replace(/-/g, '');
    }
    return id;
  }

  /**
   * Register a page or database in the registry.
   */
  register(entry: PageRegistryEntry): void {
    // Normalize notionId for consistent Map keying (dashed vs dashless)
    entry.notionId = this.normalizeId(entry.notionId);
    // Backstop warn: the filename clamp cannot help when the folder chain
    // itself blows the budget - the write will surface its own error (#1759).
    if (entry.vaultPath.length > this.relativePathBudget) {
      log.warn(
        `Path too long (${entry.vaultPath.length} chars, budget ${this.relativePathBudget}): "${entry.title}" - may fail on Windows`,
      );
    }
    this.entries.set(entry.notionId, entry);
    this.trackName(entry.folder, entry.fileName);
    if (this.entries.size === SIZE_WARNING_THRESHOLD) {
      log.warn(
        `Registry reached ${SIZE_WARNING_THRESHOLD} entries - large workspace may increase memory usage`,
      );
    }
    log.debug(`Registered: "${entry.title}" -> ${entry.vaultPath}`);
  }

  /**
   * Register a standalone page (not in a database).
   */
  registerPage(notionId: string, title: string, syncFolder: string): PageRegistryEntry {
    notionId = this.normalizeId(notionId);
    // If already registered (e.g. seeded from sync state), reuse stable path
    const existing = this.entries.get(notionId);
    if (existing) {
      existing.title = title;
      return existing;
    }

    const fileName = this.uniqueFileName(title, syncFolder);
    const entry: PageRegistryEntry = {
      notionId,
      title,
      type: 'page',
      fileName,
      vaultPath: `${syncFolder}/${fileName}.md`,
      folder: syncFolder,
    };
    this.register(entry);
    return entry;
  }

  /**
   * Register a database as a folder.
   */
  registerDatabase(notionId: string, title: string, syncFolder: string): PageRegistryEntry {
    notionId = this.normalizeId(notionId);
    // If already registered (e.g. seeded from sync state), reuse stable path
    const existing = this.entries.get(notionId);
    if (existing) {
      existing.title = title;
      return existing;
    }

    // Register a distinct entry per Notion ID. The dual-ID case (the SAME
    // database seen under both its block UUID and its data_source_id) is
    // reconciled later by finalizeDatabaseUnification(), once every entry's
    // data_source_id is resolved - unlike a title match, which cannot tell one
    // DB's dual ID apart from two different DBs that share a title in one folder
    // (the latter used to silently collapse into one, #1571).
    const folderName = this.uniqueFileName(title || 'Untitled Database', syncFolder);
    const entry: PageRegistryEntry = {
      notionId,
      title,
      type: 'database',
      fileName: folderName,
      vaultPath: `${syncFolder}/${folderName}`,
      folder: syncFolder,
    };
    this.register(entry);
    return entry;
  }

  /**
   * Register a database item (page inside a database folder).
   */
  registerDatabaseItem(
    notionId: string,
    title: string,
    parentDatabaseId: string,
    databaseFolder: string,
  ): PageRegistryEntry {
    notionId = this.normalizeId(notionId);
    // If already registered (e.g. seeded from sync state), reuse stable path
    const existing = this.entries.get(notionId);
    if (existing) {
      existing.title = title;
      existing.parentDatabaseId = parentDatabaseId;
      return existing;
    }

    const fileName = this.uniqueFileName(title, databaseFolder);
    const entry: PageRegistryEntry = {
      notionId,
      title,
      type: 'database-item',
      parentDatabaseId,
      fileName,
      vaultPath: `${databaseFolder}/${fileName}.md`,
      folder: databaseFolder,
    };
    this.register(entry);
    return entry;
  }

  /**
   * Register a linked database view as its own first-class entry.
   * Creates a per-context .base file with filters from the Notion view.
   *
   * Uses fileName: {sourceDb.fileName}-{sanitize(viewTitle)} so each linked view
   * gets a unique .base file (e.g. "PEOPLE-Class-mates") distinct from the source DB.
   */
  registerLinkedView(
    viewBlockId: string,
    viewTitle: string,
    sourceDb: PageRegistryEntry,
    context: LinkedViewContext,
  ): PageRegistryEntry {
    const normalizedId = this.normalizeId(viewBlockId);
    const existing = this.entries.get(normalizedId);
    if (existing) return existing;

    // Canonical filename derivation - MUST match block-renderer's wikilink
    // construction so the `![[...base]]` embed resolves. See deriveLinkedViewBaseName.
    const baseName = deriveLinkedViewBaseName(
      viewTitle,
      context.parentPageTitle ?? '',
      viewBlockId,
    );
    const viewsFolder = `${sourceDb.vaultPath}/_views`;
    const fileName = this.uniqueFileName(baseName, viewsFolder);
    const entry: PageRegistryEntry = {
      notionId: normalizedId,
      title: viewTitle,
      type: 'linked-view',
      fileName,
      vaultPath: `${viewsFolder}/${fileName}`,
      folder: viewsFolder,
      linkedViewContext: context,
      coverImage: context.coverImage,
    };
    this.register(entry);
    return entry;
  }

  /**
   * Register an alias (e.g. linked view ID) that resolves to a canonical entry.
   * Does not overwrite existing primary entries.
   */
  /**
   * Store the data_source_id for a database block UUID.
   *
   * Accepts a `DataSourceId`-branded value so callers must explicitly
   * acknowledge they're passing a data_source_id (not a block UUID).
   * The normalized form is what we persist; we re-brand on get() so
   * the brand survives the Map round-trip.
   */
  setDataSourceId(blockUuid: string, dataSourceId: DataSourceId): void {
    this.dataSourceIds.set(this.normalizeId(blockUuid), this.normalizeId(dataSourceId));
  }

  /** Get the data_source_id for a database, or undefined. Re-brands the stored string. */
  getDataSourceId(notionId: string): DataSourceId | undefined {
    const value = this.dataSourceIds.get(this.normalizeId(notionId));
    return value === undefined ? undefined : asDataSourceId(value);
  }

  /**
   * Collapse the dual-ID representation of a database into one entry (#1571).
   *
   * The same DB can be registered under its block UUID (blocks/BFS path) and its
   * data_source_id (discovery/search path). Registration keeps them distinct
   * because the linkage isn't known yet; this runs ONCE after discovery, when
   * every entry's data_source_id has been resolved, and merges entries that
   * share a data source. Two genuinely different databases never share a data
   * source, so they are never merged - fixing the old title-based collapse.
   *
   * The survivor is the block-UUID-keyed entry (its notionId is what inline-view
   * parent checks compare against), and it adopts the cleanest folder name so a
   * transient "DB (1)" suffix doesn't stick. Items under the dropped entry are
   * re-homed to the survivor's folder.
   */
  finalizeDatabaseUnification(): void {
    const groups = new Map<string, PageRegistryEntry[]>();
    for (const entry of this.entries.values()) {
      if (entry.type !== 'database') continue;
      // Identity = the resolved data source; fall back to the entry's own id when
      // no data source was resolved (so an un-enriched DB is its own group).
      const dsRaw = entry.dataSourceId ?? this.dataSourceIds.get(entry.notionId);
      const key = this.normalizeId(dsRaw ?? entry.notionId);
      const bucket = groups.get(key);
      if (bucket) bucket.push(entry);
      else groups.set(key, [entry]);
    }

    for (const group of groups.values()) {
      if (group.length < 2) continue;
      // Prefer a block-UUID-keyed entry (one whose id is NOT its own data source)
      // as canonical; the data_source-keyed entry is a pure alias target. Its id
      // is what inline-view parent checks compare against, so it must survive.
      const canonical =
        group.find(
          (e) => this.normalizeId(e.dataSourceId ?? '') !== this.normalizeId(e.notionId),
        ) ?? group[0];
      // group.length >= 2 is guaranteed above, so group[0] is always present;
      // this guard just narrows the type for the rest of the block.
      if (!canonical) continue;
      const memberIds = new Set(group.map((e) => this.normalizeId(e.notionId)));
      const oldPaths = new Set(group.map((e) => e.vaultPath));

      // Survivor adopts the cleanest (non-"(n)") folder name so a transient
      // collision suffix doesn't stick.
      const cleanName =
        group.map((e) => e.fileName).find((n) => !/ \(\d+\)$/.test(n)) ?? canonical.fileName;
      if (canonical.fileName !== cleanName) {
        this.usedNames.get(canonical.folder)?.delete(canonical.fileName);
        canonical.fileName = cleanName;
        canonical.vaultPath = `${canonical.folder}/${cleanName}`;
      }
      this.trackName(canonical.folder, canonical.fileName);

      // Re-home EVERY item registered under any member (by parent id or by the
      // member's pre-merge folder path - covers the survivor's own items whose
      // folder just changed via the rename, and the dropped members' items).
      for (const item of this.entries.values()) {
        if (item.type !== 'database-item') continue;
        const oldPrefix = item.folder;
        if (
          !memberIds.has(this.normalizeId(item.parentDatabaseId ?? '')) &&
          !oldPaths.has(oldPrefix)
        )
          continue;
        item.parentDatabaseId = canonical.notionId;
        if (oldPaths.has(oldPrefix) && oldPrefix !== canonical.vaultPath) {
          item.folder = canonical.vaultPath;
          if (item.vaultPath.startsWith(`${oldPrefix}/`)) {
            item.vaultPath = `${canonical.vaultPath}${item.vaultPath.slice(oldPrefix.length)}`;
          }
        }
      }

      // Fold each non-canonical member into the survivor.
      for (const dup of group) {
        if (dup.notionId !== canonical.notionId) this.mergeDatabaseInto(canonical, dup);
      }
    }
  }

  /** Carry over metadata the survivor lacks, free the dropped entry's folder
   *  name (unless the survivor adopted it), drop the entry, and alias its id (and
   *  anything aliased to it) to the survivor. Item re-homing is done by the caller. */
  private mergeDatabaseInto(canonical: PageRegistryEntry, dup: PageRegistryEntry): void {
    if (!canonical.dataSourceId && dup.dataSourceId) canonical.dataSourceId = dup.dataSourceId;
    if (!canonical.lastEditedTime && dup.lastEditedTime)
      canonical.lastEditedTime = dup.lastEditedTime;
    if (!canonical.viewType && dup.viewType) canonical.viewType = dup.viewType;
    if (!canonical.coverImage && dup.coverImage) canonical.coverImage = dup.coverImage;
    if ((!canonical.views || canonical.views.length === 0) && dup.views?.length)
      canonical.views = dup.views;
    if (!canonical.visiblePropertyIds && dup.visiblePropertyIds)
      canonical.visiblePropertyIds = dup.visiblePropertyIds;

    if (dup.fileName !== canonical.fileName) this.usedNames.get(dup.folder)?.delete(dup.fileName);
    this.entries.delete(dup.notionId);
    this.aliases.set(dup.notionId, canonical.notionId);
    for (const [alias, target] of this.aliases) {
      if (target === dup.notionId) this.aliases.set(alias, canonical.notionId);
    }
    log.debug(
      `Unified DB "${dup.title}" (${dup.notionId.substring(0, 8)}...) into ${canonical.notionId.substring(0, 8)}... (shared data source)`,
    );
  }

  registerAlias(aliasId: string, canonicalId: string): void {
    const normalizedAlias = this.normalizeId(aliasId);
    const normalizedCanonical = this.normalizeId(canonicalId);
    // Don't overwrite a real entry with an alias
    if (this.entries.has(normalizedAlias)) return;
    this.aliases.set(normalizedAlias, normalizedCanonical);
    log.debug(
      `Alias: ${normalizedAlias.substring(0, 8)}... -> ${normalizedCanonical.substring(0, 8)}...`,
    );
  }

  /**
   * Resolve an ID through aliases if no direct entry exists.
   */
  private resolveAlias(normalizedId: string): PageRegistryEntry | undefined {
    const canonicalId = this.aliases.get(normalizedId);
    if (canonicalId) {
      return this.entries.get(canonicalId);
    }
    return undefined;
  }

  /**
   * Get the wikilink target for a Notion ID.
   * Returns the sanitized filename (no extension) for use in [[wikilinks]].
   * Falls back to the provided fallback name or the raw ID.
   */
  getWikilinkTarget(notionId: string, fallbackName?: string): string {
    const normalized = this.normalizeId(notionId);
    const entry = this.entries.get(normalized) ?? this.resolveAlias(normalized);
    if (entry) {
      return entry.fileName;
    }
    // Use a human-readable fallback instead of leaking raw Notion IDs.
    // Run through sanitizeFileName so the wikilink target matches the file
    // Obsidian would actually find - same rule as registered entries (which
    // store entry.fileName from sanitizeFileName via uniqueFileName). Without
    // this, Notion titles with double spaces / forbidden chars produce
    // wikilinks that point to filenames that don't exist on disk.
    if (fallbackName) {
      const sanitized = sanitizeFileName(fallbackName);
      // Apply the same collision suffixing registered entries get. Without it
      // an unregistered fallback whose sanitized name matches a DIFFERENT
      // registered page's file resolves the wikilink to that other page - a
      // silently wrong link. Suffixing yields a dangling link instead, which
      // is correct. Compare against every registered fileName because Obsidian
      // resolves [[name]] by basename across the whole vault, not per-folder (#1574).
      const usedFileNames = new Set<string>();
      for (const e of this.entries.values()) {
        usedFileNames.add(e.fileName);
      }
      return makeUniqueName(sanitized, usedFileNames);
    }
    const shortId = normalized.substring(0, 8);
    log.warn(`Unresolved wikilink target: ${notionId} (not in registry)`);
    return `Unknown Page (${shortId})`;
  }

  /**
   * Check whether a Notion ID refers to a database or linked-view entry.
   */
  isDatabaseEntry(notionId: string): boolean {
    const normalized = this.normalizeId(notionId);
    const type = (this.entries.get(normalized) ?? this.resolveAlias(normalized))?.type;
    return type === 'database' || type === 'linked-view';
  }

  /**
   * Get the full vault path for a Notion ID.
   */
  getVaultPath(notionId: string): string | undefined {
    const normalized = this.normalizeId(notionId);
    return (this.entries.get(normalized) ?? this.resolveAlias(normalized))?.vaultPath;
  }

  /**
   * Get a registry entry by Notion ID.
   */
  get(notionId: string): PageRegistryEntry | undefined {
    const normalized = this.normalizeId(notionId);
    return this.entries.get(normalized) ?? this.resolveAlias(normalized);
  }

  /**
   * Get all entries.
   */
  getAllEntries(): PageRegistryEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Get set of used names in a folder (for external uniqueness checks).
   */
  usedNamesInFolder(folder: string): Set<string> {
    return this.usedNames.get(folder) ?? new Set();
  }

  /**
   * Number of registered entries.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Number of aliases registered.
   */
  get aliasCount(): number {
    return this.aliases.size;
  }

  /**
   * Generate a unique sanitized filename within a folder.
   */
  private uniqueFileName(title: string, folder: string): string {
    // Clamp BEFORE uniquing so the " (n)" suffix cannot push the path back
    // over the budget (#1759). sync-page's detectTitleRename derives names
    // through the same fitFileNameToBudget - keep them in lockstep.
    const sanitized = fitFileNameToBudget(
      sanitizeFileName(title || 'Untitled'),
      folder.length,
      this.relativePathBudget,
    );
    const usedInFolder = this.usedNames.get(folder) ?? new Set<string>();
    const result = makeUniqueName(sanitized, usedInFolder);
    if (result !== sanitized) {
      log.warn(
        `Name collision: "${sanitized}" already used in "${folder}" -> assigned "${result}". Used names: ${JSON.stringify([...usedInFolder].filter((n) => n.toLowerCase().includes(sanitized.toLowerCase().substring(0, 10))))}`,
      );
    }
    return result;
  }

  /**
   * Track a filename as used in a folder.
   */
  private trackName(folder: string, name: string): void {
    if (!this.usedNames.has(folder)) {
      this.usedNames.set(folder, new Set());
    }
    // Non-null guaranteed: usedNames.set(folder, ...) above ensures entry exists
    (this.usedNames.get(folder) as Set<string>).add(name);
  }
}
