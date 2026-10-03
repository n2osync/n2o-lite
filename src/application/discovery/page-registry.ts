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
 * The names a database carries when nothing has told us what it is called:
 * Notion returns an empty title for an unnamed database, and both the
 * registry and the block walk substitute "Untitled Database" for it.
 */
const FALLBACK_DATABASE_TITLES = new Set(['', 'untitled', 'untitled database']);

/**
 * True when a database title is a placeholder rather than a name the user
 * gave the database. Any real title outranks one of these.
 */
function isFallbackDatabaseTitle(title: string): boolean {
  return FALLBACK_DATABASE_TITLES.has(title.trim().toLowerCase());
}

/**
 * `path` re-rooted from `oldPath` to `newPath`, or undefined when `path` does
 * not sit under `oldPath`.
 *
 * Matches on segment boundaries, never on a bare prefix: renaming
 * "Untitled Database" must not drag "Untitled Database 2" along with it.
 */
function rehomePath(path: string, oldPath: string, newPath: string): string | undefined {
  if (path === oldPath) return newPath;
  if (path.startsWith(`${oldPath}/`)) return `${newPath}${path.slice(oldPath.length)}`;
  return undefined;
}

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
      /* The refresh runs one way, same as the alias path below. A second
       * registration of the same id frequently has no name for the database (a
       * block walk over an untitled child_database, a row's parent lookup that
       * failed), and letting that placeholder land wiped the real title the
       * entry was holding. That downgrade then read as an upgrade to the alias
       * path, which asked for a fresh folder name and collided with the name
       * the folder was already using, so a correctly named folder became
       * "Reading List (1)" and every row moved under it (#2139).
       *
       * When the held title IS still the placeholder, a real title arriving
       * here upgrades the folder too, through the same one-way path the alias
       * branch uses. A bare title assignment closed the gate instead: the held
       * title stopped reading as fallback, so the alias-path upgrade refused
       * forever after, and the user shipped a correctly titled database living
       * in a folder still called "Untitled Database". */
      if (existing.type === 'database') this.upgradeFallbackDatabaseTitle(existing, title);
      if (!isFallbackDatabaseTitle(title)) existing.title = title;
      return existing;
    }

    /* The same database arrives under its block UUID and under its
     * data_source_id, and when the link is ALREADY resolved there is nothing
     * left to reconcile: answer with the entry we hold rather than minting a
     * twin (#1977).
     *
     * The twin is not free. "Todo List" is taken in that folder, so it is born
     * as "Todo List (1)", and every row of the database is already registered
     * under the original, so nothing is ever written into the folder that name
     * implies. What the user then sees is an empty "Todo List (1)" sitting in
     * `_orphaned`, put there by the run that noticed the phantom had no owner,
     * and counted as one of their pages lost. Two false statements about a sync
     * that went perfectly.
     *
     * Only an id we can PROVE names a database we already have is folded in.
     * A title match is not that proof, which is why it is not used here: it
     * cannot tell one database's dual id from two different databases sharing a
     * title in one folder, and collapsing those was #1571. An unresolved dual
     * id still falls through to a distinct entry and is reconciled later by
     * finalizeDatabaseUnification(). */
    const twin = this.findDatabaseByDataSource(notionId);
    if (twin) {
      this.registerAlias(notionId, twin.notionId);
      this.upgradeFallbackDatabaseTitle(twin, title);
      log.debug(
        `Database ${notionId.substring(0, 8)}... is the data source of "${twin.title}" - reusing its entry`,
      );
      return twin;
    }

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
   * The registered database whose resolved data source is `dataSourceId`, when
   * that database is keyed by something else (its block UUID). Returns
   * undefined for an id that is nobody's data source, and for the entry keyed
   * by the data source id itself - that one is a plain `entries` hit.
   */
  private findDatabaseByDataSource(dataSourceId: string): PageRegistryEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.type !== 'database') continue;
      const entryId = this.normalizeId(entry.notionId);
      if (entryId === dataSourceId) continue;
      const resolved = entry.dataSourceId ?? this.dataSourceIds.get(entryId);
      if (resolved && this.normalizeId(resolved) === dataSourceId) return entry;
    }
    return undefined;
  }

  /**
   * Take a real title from a second registration of a database we already
   * hold, when the one we hold is still sitting on a placeholder (#2139).
   *
   * The scenario: a user's "Reading List" is first seen by a path that has no
   * name for it (a row's parent lookup that failed, a block walk over an
   * untitled child_database), so it is registered as "Untitled Database" and
   * their folder is called that. The registration that DOES carry the real
   * title arrives later under the other half of the dual id, and since #1977
   * it is answered with this same entry instead of minting a twin for
   * finalizeDatabaseUnification to reconcile. That made this the one return
   * path that never refreshes the title, so the placeholder folder name stuck
   * for good.
   *
   * The upgrade runs one way only. A data-source stub frequently reads
   * "Untitled" while the block-UUID entry holds the real name, so refreshing
   * unconditionally would rename a correct folder to a placeholder.
   */
  private upgradeFallbackDatabaseTitle(entry: PageRegistryEntry, title: string): void {
    if (!isFallbackDatabaseTitle(entry.title) || isFallbackDatabaseTitle(title)) return;
    entry.title = title;
    /* The entry's own name is excluded from the collision check: it is renaming
     * itself, so the name it is about to give up cannot be what blocks it. A
     * database really called "Untitled Database?" sanitizes to the name the
     * placeholder folder already carries, and without the exclusion the upgrade
     * moved a correctly named folder to "Untitled Database (1)". */
    this.renameDatabaseFolder(entry, this.uniqueFileName(title, entry.folder, entry.fileName));
  }

  /**
   * Point a database entry at a new folder name: free the name it is giving
   * up, track the one it takes, and carry EVERY entry already registered under
   * the old folder across with it.
   *
   * Shared by finalizeDatabaseUnification's cleanest-name adoption and the
   * alias path in registerDatabase, so neither can rename a database folder
   * while leaving anything addressing a folder that no longer exists.
   *
   * "Everything under it" is the whole rule, not just the rows sitting directly
   * in the folder. A linked view lives one level deeper, in `<db>/_views`, and
   * moving only database-items left it writing its .base under the old name:
   * the folder became "Reading List" while a ghost "Untitled Database" stayed
   * behind holding nothing but _views. A database nested in the folder, and its
   * own rows, were stranded the same way.
   */
  private renameDatabaseFolder(entry: PageRegistryEntry, fileName: string): void {
    const oldPath = entry.vaultPath;
    if (entry.fileName !== fileName) {
      this.usedNames.get(entry.folder)?.delete(entry.fileName);
      entry.fileName = fileName;
      entry.vaultPath = `${entry.folder}/${fileName}`;
    }
    this.trackName(entry.folder, entry.fileName);
    if (entry.vaultPath === oldPath) return;

    this.rehomeSubtree(oldPath, entry.vaultPath, entry.notionId);
  }

  /**
   * Move every entry registered under `oldPath` to the same place under
   * `newPath`: rows, linked views, nested databases and their rows alike.
   * Shared by renameDatabaseFolder and the dropped-member fold-in of
   * finalizeDatabaseUnification, so no rename site can regrow the narrow
   * only-direct-rows shape that stranded linked views under a ghost folder.
   */
  private rehomeSubtree(oldPath: string, newPath: string, ownerId: string): void {
    for (const item of this.entries.values()) {
      const folder = rehomePath(item.folder, oldPath, newPath);
      if (folder === undefined) continue;
      // Only a row sitting DIRECTLY in the folder belongs to this database. A
      // row one level deeper belongs to the database nested there, which is
      // travelling with us and keeps its own children.
      if (item.type === 'database-item' && item.folder === oldPath) {
        item.parentDatabaseId = ownerId;
      }
      item.folder = folder;
      item.vaultPath = rehomePath(item.vaultPath, oldPath, newPath) ?? item.vaultPath;
      // A linked view's .base filters on the source database folder, so that
      // path moves too or the view renders empty against a folder that is gone.
      const context = item.linkedViewContext;
      if (context) {
        const source = rehomePath(context.sourceDatabaseFolder, oldPath, newPath);
        if (source !== undefined) context.sourceDatabaseFolder = source;
      }
    }
    this.rehomeUsedNames(oldPath, newPath);
  }

  /**
   * Carry the per-folder used-name buckets across with the subtree.
   *
   * Uniqueness is measured per folder, so a name tracked under the old path is
   * measuring a folder nobody addresses any more, and the folder that DOES
   * hold those files looks empty. Nothing went wrong while the rename only ran
   * in finalizeDatabaseUnification, after every registration; the fallback-title
   * upgrade made it fire mid-registration, so a row arriving afterwards asked
   * an empty set whether "Dune" was free, was told yes, and took the vaultPath
   * a row that moved with the folder was already holding. Two entries, one
   * path, and whichever writes second wins.
   *
   * The folder's own bucket is keyed by the old vaultPath itself, so it moves
   * on the same `path === oldPath` arm rehomePath already has, and lands under
   * the new vaultPath with the rows still in it.
   *
   * Arriving names are UNIONED into whatever the destination already tracks,
   * never dropped on top of it: two folders becoming one is exactly the
   * finalize case, and the survivor is already tracking its own rows by then.
   */
  private rehomeUsedNames(oldPath: string, newPath: string): void {
    // Collect before mutating: a rename can touch several keys, and rewriting
    // the map underneath its own iterator is undefined territory.
    const moves: Array<[string, string]> = [];
    for (const folder of this.usedNames.keys()) {
      const rehomed = rehomePath(folder, oldPath, newPath);
      if (rehomed === undefined || rehomed === folder) continue;
      moves.push([folder, rehomed]);
    }
    for (const [from, to] of moves) {
      const names = this.usedNames.get(from);
      if (!names) continue;
      this.usedNames.delete(from);
      const destination = this.usedNames.get(to);
      if (!destination) {
        this.usedNames.set(to, names);
        continue;
      }
      for (const name of names) destination.add(name);
    }
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
      this.renameDatabaseFolder(canonical, cleanName);

      // Rows pointing at any dropped member re-parent onto the survivor,
      // wherever they sit.
      for (const item of this.entries.values()) {
        if (item.type !== 'database-item') continue;
        if (memberIds.has(this.normalizeId(item.parentDatabaseId ?? ''))) {
          item.parentDatabaseId = canonical.notionId;
        }
      }
      // The DROPPED members' subtrees travel whole, same rule as
      // renameDatabaseFolder: linked views and nested databases included. The
      // survivor's own subtree already travelled with it inside
      // renameDatabaseFolder above. A member registered under a DIFFERENT
      // parent folder used to leave its _views behind here, because this loop
      // kept the old only-direct-rows shape.
      for (const oldPrefix of oldPaths) {
        if (oldPrefix === canonical.vaultPath) continue;
        this.rehomeSubtree(oldPrefix, canonical.vaultPath, canonical.notionId);
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
   *
   * `excludeName` is the name the CALLER already holds in that folder. A rename
   * must not be blocked by the name it is giving up, or an entry collides with
   * itself and takes a " (n)" suffix nothing later removes. Omit it when naming
   * something new.
   */
  private uniqueFileName(title: string, folder: string, excludeName?: string): string {
    // Clamp BEFORE uniquing so the " (n)" suffix cannot push the path back
    // over the budget (#1759). sync-page's detectTitleRename derives names
    // through the same fitFileNameToBudget - keep them in lockstep.
    const sanitized = fitFileNameToBudget(
      sanitizeFileName(title || 'Untitled'),
      folder.length,
      this.relativePathBudget,
    );
    const tracked = this.usedNames.get(folder) ?? new Set<string>();
    // Case-insensitive, matching how makeUniqueName compares.
    const usedInFolder =
      excludeName === undefined
        ? tracked
        : new Set([...tracked].filter((n) => n.toLowerCase() !== excludeName.toLowerCase()));
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
