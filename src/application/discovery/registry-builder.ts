/**
 * RegistryBuilder - Discovery and registry construction.
 *
 * Extracted from SyncEngine to isolate discovery and registry building:
 * - Build registry from full workspace discovery (syncScope === 'all')
 * - Build registry from selected items (syncScope === 'selected')
 * - Query database items with pagination and filters
 * - Convert SyncDatabaseFilter config into Notion API filter objects
 */

import type { NotionClient } from '../../infrastructure/notion/client';
import type { VaultAdapter } from '../../infrastructure/obsidian/vault';
import type { SyncStateDB } from '../../infrastructure/storage/sync-state';
import type { SyncConfig } from '../../domain/models/sync-config';
import type { SyncDatabaseFilter } from '../../domain/models/sync-config';
import type { NotionDiscovery, DiscoveryResult } from './discovery';
import { getPageTitle, getDatabaseTitle } from '../../domain/services/notion-entity-ops';
import {
  ensureDatabaseRegistered,
  getQueryableDataSourceId,
  populateDatabaseMetadata,
  resolveDataSourceId,
} from './database-registrar';
import { readRichText } from './scan-block-refs';
import { asBlockUuid, asDataSourceId } from '../../domain/models/notion-id';
import type { NotionBlock, NotionPage } from '../../domain/models/notion-api-types';
import { PageRegistry } from './page-registry';
import type { PageRegistryEntry } from './page-registry';
import { PropertyHelper } from './property-helper';
import { sanitizeFileName } from '../../shared/sanitize';
import { getErrorMessage, NotionApiError } from '../../shared/errors';
import { createLogger } from '../../shared/logger';
import { normalizeNotionId } from '../../domain/models/notion-id';
import { isLinkedViewStub, extractDataSourceIds } from '../../domain/services/data-source-shape';
import { extractParentId } from '../../domain/services/parent-utils';
import { buildLinkedViewResolution } from './linked-view-resolver';
import { buildLinkedViewContext, deriveCoverImage, survivingEntries } from './registry-builder-helpers';

const log = createLogger('RegistryBuilder');

/**
 * Maximum BFS page-depth for `discoverChildrenFromBlocks`. Single full pass
 * walks selected pages + their children up to this depth, registering
 * nested pages, child databases, and linked views in one go.
 */
const MAX_CHILD_DISCOVERY_DEPTH = 5;

/**
 * Hard cap on how many entries `discoverChildrenFromBlocks` will register in a
 * single sync. This is a runaway-fan-out guard, NOT a limit on how much a user
 * may sync: one page can reference 88+ others, each of which can reference 50+
 * more, so an unbounded BFS over rich-text mentions would walk the API
 * exhaustively. The cap stops the BFS the moment the count is hit, emits a
 * warning, and lets already-discovered entries apply normally. Set high enough
 * not to bite a normal workspace.
 */
const MAX_DISCOVERED_PAGES = 5000;

/**
 * Block types whose children might hide nested child_page/child_database
 * refs. Used by the leaf short-circuit in `discoverChildrenFromBlocks`:
 * if a page's top-level blocks include none of these AND no direct
 * child_page/child_database, scanBlocks will register nothing - we skip
 * it. Notion sometimes lies about `has_children` for these types
 * (table, column_list, synced_block) so we keep the type check as a
 * safety net regardless of the boolean.
 */
// readRichText + MentionBearingRichText are shared from ./scan-block-refs
// (imported above) - this file used to carry a byte-identical twin copy.

const CONTAINER_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'toggle',
  'callout',
  'quote',
  'column_list',
  'column',
  'synced_block',
  'table',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggleable_heading_1',
  'toggleable_heading_2',
  'toggleable_heading_3',
  'toggleable_heading_4',
]);

/** A linked database view that could not be resolved to a real database. */
export interface UnresolvedLinkedView {
  viewId: string;
  viewTitle: string;
  pageId: string;
  pageTitle: string;
}

export class RegistryBuilder {
  /**
   * Cache of data_source_id -> its owning database block UUID (dashless), or
   * null when unresolvable. A linked view's getDatabase resolves to the SOURCE
   * database's data source, so if that data source's parent database is a
   * DIFFERENT block than the one probed, the probed block is a linked VIEW.
   * Cached because N linked views on a page share ONE source data source
   * (#1705): resolve it once, not once per block.
   */
  private sourceBlockByDataSource = new Map<string, string | null>();

  constructor(
    private notionClient: NotionClient,
    private vaultAdapter: VaultAdapter,
    private syncState: SyncStateDB,
    private discovery: NotionDiscovery,
    private propertyHelper: PropertyHelper = new PropertyHelper(),
  ) {}

  /**
   * True when a non-stub `getDatabase` response for `blockId` belongs to a
   * database hosted under a DIFFERENT block - i.e. `blockId` is a linked VIEW,
   * not an inline database. A 2025-09-03 linked view resolves to the source
   * database's data source (non-empty `data_sources`, so isLinkedViewStub
   * misses it); the data source's `parent.database_id` is the source database's
   * own block, which differs from the linked-view block. Official Views API
   * only; the ds -> source-block lookup is cached (many linked views share one
   * source data source). Returns false on any resolution failure so an
   * ambiguous block stays classified as a real database (the safe default).
   */
  private async isLinkedViewBlock(blockId: string, probedDbMeta: unknown): Promise<boolean> {
    const dsId = extractDataSourceIds(probedDbMeta)[0];
    if (!dsId) return false;
    let sourceBlock = this.sourceBlockByDataSource.get(dsId);
    if (sourceBlock === undefined) {
      try {
        const dsMeta = (await this.notionClient.getDatabase(dsId)) as {
          parent?: { database_id?: string };
        };
        const parentDb = dsMeta.parent?.database_id;
        sourceBlock = parentDb ? normalizeNotionId(parentDb) : null;
      } catch {
        sourceBlock = null;
      }
      this.sourceBlockByDataSource.set(dsId, sourceBlock);
    }
    return sourceBlock !== null && sourceBlock !== normalizeNotionId(blockId);
  }

  /**
   * Backstop: enrich any database entry that lacks `views[]` by routing it
   * through `populateDatabaseMetadata`. Runs at the end of discovery so the
   * apply phase always sees fully-resolved DB entries - `syncDatabase`
   * generates `.base` files from `entry.views[]`, and a bare entry produces
   * a degraded file. Idempotent: skips entries that already have views.
   */
  private async finalizeDatabaseMetadata(
    registry: PageRegistry,
    settings: SyncConfig,
    cancelCheck?: () => boolean,
  ): Promise<void> {
    const allDbs = registry.getAllEntries().filter((e) => e.type === 'database');
    for (const dbEntry of allDbs) {
      if (cancelCheck?.()) return;
      if (dbEntry.views && dbEntry.views.length > 0) continue;
      try {
        await populateDatabaseMetadata(registry, dbEntry, {
          notionClient: this.notionClient,
          syncFolder: settings.syncFolder,
        });
      } catch (err) {
        log.warn(`Backstop populate failed for "${dbEntry.title}": ${getErrorMessage(err)}`);
      }
    }
    // Every DB's data_source_id is resolved now, so collapse any dual-ID
    // duplicates (the same DB under its block UUID and its data_source_id) into
    // one entry, re-homing their items. Runs here, after registration, so it
    // never fights a caller that is still populating an entry (#1571).
    registry.finalizeDatabaseUnification();
  }

  /**
   * Build registry from full workspace discovery (syncScope === 'all').
   * Supports hierarchical page structure: child pages nest inside parent folders.
   */
  async buildFromDiscovery(
    registry: PageRegistry,
    settings: SyncConfig,
    errors: string[],
    emitProgress?: (msg: string) => void,
    cancelCheck?: () => boolean,
  ): Promise<{
    entries: PageRegistryEntry[];
    discoveryComplete: boolean;
    unresolvedViews: UnresolvedLinkedView[];
  }> {
    // Seed registry with all previously-synced pages for wikilink resolution.
    // Use lightweight query - only need IDs, paths, types, not JSON blobs.
    const existingRecords = this.syncState.getAllForRegistry();
    for (const rec of existingRecords) {
      const fileName = rec.obsidianPath.split('/').pop()?.replace('.md', '') ?? '';
      const folder =
        rec.obsidianPath.substring(0, rec.obsidianPath.lastIndexOf('/')) || settings.syncFolder;
      if (fileName && !registry.get(rec.notionId)) {
        registry.register({
          notionId: rec.notionId,
          title: fileName,
          type: rec.itemType as 'page' | 'database' | 'database-item',
          parentDatabaseId: rec.notionParentId,
          fileName,
          vaultPath: rec.obsidianPath,
          folder,
          lastEditedTime: rec.notionLastEdited,
        });
      }
    }

    log.info('Full workspace discovery...');

    let result: DiscoveryResult;
    try {
      result = await this.discovery.discoverAll();
    } catch (error) {
      const msg = getErrorMessage(error);
      errors.push(`Discovery failed: ${msg}`);
      return { entries: [], discoveryComplete: false, unresolvedViews: [] };
    }

    // Propagate discovery errors to sync errors
    if (result.errors.length > 0) {
      for (const err of result.errors) {
        errors.push(err);
      }
    }

    const syncFolder = settings.syncFolder;
    const entries: PageRegistryEntry[] = [];

    // Register databases as folders
    log.info(
      `Discovery returned ${result.databases.length} databases, ${result.pages.length} pages`,
    );
    for (const db of result.databases) {
      log.info(`  DB: "${db.title}" id=${db.notionId.substring(0, 12)}...`);
    }
    const dbFolders = new Map<string, string>(); // notionId -> vaultPath (folder)
    for (const db of result.databases) {
      const entry = registry.registerDatabase(db.notionId, db.title, syncFolder);
      entry.lastEditedTime = db.lastEditedTime;
      // Discovery databases already use data_source_id as their notionId.
      // The asDataSourceId casts are the documented "discovery treats this
      // notionId as the queryable id" assertion - branded so a future
      // refactor can't accidentally pass a block UUID through this path.
      entry.dataSourceId = asDataSourceId(db.notionId);
      registry.setDataSourceId(db.notionId, asDataSourceId(db.notionId));
      entries.push(entry);
      dbFolders.set(db.notionId, entry.vaultPath);

      // Register items inside the database folder
      const items = result.databaseItems.get(db.notionId) ?? [];
      for (const item of items) {
        const itemEntry = registry.registerDatabaseItem(
          item.notionId,
          item.title,
          db.notionId,
          entry.vaultPath,
        );
        itemEntry.lastEditedTime = item.lastEditedTime;
        entries.push(itemEntry);
      }
    }

    // Build parent-child tree for standalone pages
    const pageMap = new Map<string, (typeof result.pages)[0]>();
    const childPages = new Map<string, typeof result.pages>(); // parentId -> children

    for (const page of result.pages) {
      pageMap.set(page.notionId, page);
      if (page.parentType === 'page' && page.parentId) {
        const siblings = childPages.get(page.parentId) ?? [];
        siblings.push(page);
        childPages.set(page.parentId, siblings);
      }
    }

    // Recursive function to register pages in hierarchical order.
    // Parent page gets a sibling .md file; children go in a subfolder named after the parent.
    // This mirrors the database pattern: DB.base (sibling) + DB/ (folder).
    const registerPageTree = (page: (typeof result.pages)[0], folder: string): void => {
      const entry = registry.registerPage(page.notionId, page.title, folder);
      entry.lastEditedTime = page.lastEditedTime;
      if (page.parentType === 'page' && page.parentId) {
        entry.parentPageId = page.parentId.replace(/-/g, '');
      }
      entries.push(entry);

      const children = childPages.get(page.notionId) ?? [];
      for (const child of children) {
        registerPageTree(child, `${folder}/${entry.fileName}`);
      }
    };

    // Register only root-level pages (parentType === 'workspace' or parent not in our set)
    const standaloneBase =
      settings.useStandaloneFolder && settings.standaloneFolder
        ? `${syncFolder}/${settings.standaloneFolder}`
        : syncFolder;
    for (const page of result.pages) {
      if (
        page.parentType === 'workspace' ||
        (page.parentType === 'page' && !pageMap.has(page.parentId ?? ''))
      ) {
        registerPageTree(page, standaloneBase);
      }
    }

    // ── Views API discovery: detect linked views + view types + property visibility ──
    // Uses the official Views API (2025-09-03+) instead of scanning every page's blocks.
    // 11 list calls + ~53 retrieve calls vs 254+ page block fetches.
    const unresolvedViews: UnresolvedLinkedView[] = [];
    const databaseEntries = entries.filter((e) => e.type === 'database');
    if (databaseEntries.length > 0) {
      emitProgress?.('Discovering database views...');
      await this.discoverViewsViaApi(
        registry,
        settings,
        databaseEntries,
        entries,
        errors,
        cancelCheck,
      );
    }

    // Scan standalone pages for child PAGES only (linked views already discovered above).
    // discoverChildrenFromBlocks still runs for syncChildPages but linked view probes will
    // find entries already registered and skip re-probing.
    const standalonePageIds = entries.filter((e) => e.type === 'page').map((e) => e.notionId);
    if (standalonePageIds.length > 0 && settings.syncChildPages) {
      const visited = new Set(entries.map((e) => e.notionId));
      const selectedDbTitles = new Set(databaseEntries.map((e) => sanitizeFileName(e.title)));
      await this.discoverChildrenFromBlocks(
        registry,
        settings,
        entries,
        errors,
        unresolvedViews,
        standaloneBase,
        standalonePageIds,
        visited,
        selectedDbTitles,
        emitProgress ?? (() => {}),
        cancelCheck,
      );
    }

    // Reverse lookup for any views that discoverChildrenFromBlocks couldn't resolve
    if (unresolvedViews.length > 0) {
      emitProgress?.('Resolving linked views via Views API...');
      await this.resolveViewsByReverseLookup(
        registry,
        settings,
        unresolvedViews,
        entries,
        errors,
        cancelCheck,
      );
    }

    // Backstop: ensure every DB entry has views[] before render. Multiple
    // discovery paths register databases (workspace search, BFS inline,
    // linked-view source DB) and not all populate views eagerly. Idempotent.
    await this.finalizeDatabaseMetadata(registry, settings, cancelCheck);

    return {
      entries: survivingEntries(entries, registry),
      discoveryComplete: result.complete,
      unresolvedViews,
    };
  }

  /**
   * Build registry from selected items (syncScope === 'selected').
   * Handles both databases (discover all items inside) and individual pages.
   */
  async buildFromSelected(
    registry: PageRegistry,
    settings: SyncConfig,
    errors: string[],
    emitProgress: (msg: string) => void,
    cancelCheck?: () => boolean,
  ): Promise<{
    entries: PageRegistryEntry[];
    discoveryComplete: boolean;
    unresolvedViews: UnresolvedLinkedView[];
  }> {
    const entries: PageRegistryEntry[] = [];
    const unresolvedViews: UnresolvedLinkedView[] = [];
    const syncFolder = settings.syncFolder;
    // Set to true when a getAllBlockChildren call fails during BFS so the
    // run can flag discoveryComplete=false. Pull-apply gates orphan
    // detection on discoveryComplete; an incomplete BFS means we don't
    // know what content exists, so the safe move is to suppress orphan
    // deletion until the next clean discovery.
    let bfsHadFetchFailure = false;

    // Use structured selectedItems if available, fall back to legacy notionPages
    // Deduplicate by normalized ID to prevent double-processing from stale config
    const rawSelectedItems = settings.selectedItems ?? [];
    const seenSelectedIds = new Set<string>();
    const selectedItems = rawSelectedItems.filter((item) => {
      const normalizedId = normalizeNotionId(item.id);
      if (seenSelectedIds.has(normalizedId)) return false;
      seenSelectedIds.add(normalizedId);
      return true;
    });
    if (selectedItems.length > 0) {
      const selectedDatabases = selectedItems.filter((s) => s.type === 'database');
      const selectedPages = selectedItems.filter((s) => s.type === 'page');

      // Process selected databases - discover all items inside each
      // dbItemIds: items with has_children=true only - these may contain child_page/child_database
      // blocks. Items with has_children=false are leaf nodes and need no BFS scan.
      const dbItemIds: string[] = [];
      // Cumulative discovered-items counter so the dashboard can show
      // continuous progress across databases (was: single static
      // "Querying database X" message that stayed up the whole time
      // even when items were streaming in from /query pagination).
      let totalItemsDiscovered = 0;
      const cancelReturn = () => ({
        entries,
        discoveryComplete: false,
        unresolvedViews,
      });
      for (let dbIdx = 0; dbIdx < selectedDatabases.length; dbIdx++) {
        const db = selectedDatabases[dbIdx];
        if (!db) continue;
        if (cancelCheck?.()) return cancelReturn();
        emitProgress(
          `Querying "${db.title}" (${dbIdx + 1}/${selectedDatabases.length})` +
            (totalItemsDiscovered > 0 ? ` / ${totalItemsDiscovered} items so far` : ''),
        );
        try {
          const dbEntry = registry.registerDatabase(db.id, db.title, syncFolder);
          // Selected databases use data_source_id as their ID. Cast
          // through asDataSourceId so the brand survives the assignment;
          // a future refactor that accidentally fed a block UUID here
          // would now fail typecheck instead of silently mis-routing.
          dbEntry.dataSourceId = asDataSourceId(db.id);
          registry.setDataSourceId(db.id, asDataSourceId(db.id));

          entries.push(dbEntry);

          // Query all items in this database
          const items = await this.queryDatabaseItems(db.id, settings, cancelCheck);
          totalItemsDiscovered += items.length;
          // Post-query update so the dashboard sees the count climb
          // rather than waiting for the next database to start.
          emitProgress(
            `"${db.title}" / ${items.length} items` +
              ` (database ${dbIdx + 1}/${selectedDatabases.length}, ${totalItemsDiscovered} total)`,
          );
          for (const item of items) {
            const itemEntry = registry.registerDatabaseItem(
              item.notionId,
              item.title,
              db.id,
              dbEntry.vaultPath,
            );
            itemEntry.lastEditedTime = item.lastEditedTime;
            entries.push(itemEntry);
            // Only queue items that have block children - items with has_children=false
            // are leaf nodes that cannot contain child_page or child_database blocks.
            if (item.hasChildren) {
              dbItemIds.push(normalizeNotionId(item.notionId));
            }
          }
          const skipped = items.length - dbItemIds.length;
          if (skipped > 0) {
            log.debug(
              `"${db.title}": ${dbItemIds.length} items to scan for child content (${skipped} leaf nodes skipped)`,
            );
          }
        } catch (error) {
          const msg = getErrorMessage(error);
          log.error(`Failed to query database "${db.title}": ${msg}`);
          errors.push(`Database "${db.title}": ${msg}`);
        }
      }

      // Discover views for selected databases via Views API
      const selectedDbEntries = entries.filter((e) => e.type === 'database');
      if (selectedDbEntries.length > 0) {
        emitProgress('Discovering database views...');
        await this.discoverViewsViaApi(
          registry,
          settings,
          selectedDbEntries,
          entries,
          errors,
          cancelCheck,
        );
      }

      // Process selected individual pages
      const standaloneBase =
        settings.useStandaloneFolder && settings.standaloneFolder
          ? `${syncFolder}/${settings.standaloneFolder}`
          : syncFolder;
      for (const pg of selectedPages) {
        if (cancelCheck?.()) return cancelReturn();
        try {
          const page = await this.notionClient.getPage(pg.id);
          // F-029: archived/trashed pages must be omitted so the next pull
          // orphan-detects the local file. buildFromSearch already filters
          // these; the selected path has to match.
          if (page.archived === true || page.in_trash === true) {
            log.info(
              `Selected page "${pg.title}" is archived on Notion - skipping so orphan detection runs`,
            );
            continue;
          }
          const title = getPageTitle(page);
          const entry = registry.registerPage(pg.id, title, standaloneBase);
          entry.lastEditedTime = page.last_edited_time ?? undefined;
          // Parent page feeds the breadcrumb chain walk to the next ancestor.
          // The search-based path sets this in registerPageTree; the selected-
          // scope path fetches the full page here, so set it here too or the
          // chain stops one level short.
          if (page.parent?.type === 'page_id') {
            const pid = extractParentId(page.parent);
            if (pid) entry.parentPageId = pid.replace(/-/g, '');
          }
          entries.push(entry);
        } catch (error) {
          const msg = getErrorMessage(error);
          log.error(`Failed to fetch page "${pg.title}": ${msg}`);
          errors.push(`Page "${pg.title}": ${msg}`);
        }
      }

      // BFS for nested children of selected pages and database items.
      // Always includes dbItemIds so linked views inside database items are
      // detected regardless of the child-sync flags.
      const seedPageIds = [
        ...(settings.syncChildPages || settings.syncChildDatabases
          ? selectedPages.map((pg) => normalizeNotionId(pg.id))
          : []),
        ...dbItemIds,
      ];
      if (seedPageIds.length > 0 && !cancelCheck?.()) {
        const visited = new Set(entries.map((e) => e.notionId));
        const selectedDbTitles = new Set(selectedDatabases.map((db) => sanitizeFileName(db.title)));
        const beforeBfs = entries.length;
        const errorsBeforeBfs = errors.length;

        emitProgress(`Scanning ${seedPageIds.length} pages for nested content...`);
        await this.discoverChildrenFromBlocks(
          registry,
          settings,
          entries,
          errors,
          unresolvedViews,
          standaloneBase,
          seedPageIds,
          visited,
          selectedDbTitles,
          emitProgress,
          cancelCheck,
        );
        // If the BFS pushed any new errors, treat discovery as incomplete
        // so orphan detection skips the whole sync. Coarse but safe: a
        // failed getAllBlockChildren means we don't know what content
        // exists, and deleting local files based on that uncertainty
        // would compound a transient API error into permanent data loss.
        if (errors.length > errorsBeforeBfs) {
          bfsHadFetchFailure = true;
        }

        // Resolve views for any new DBs surfaced by the BFS - same Views
        // API call the explicit-selection path runs above.
        const newDbs = entries.slice(beforeBfs).filter((e) => e.type === 'database');
        if (newDbs.length > 0 && !cancelCheck?.()) {
          emitProgress(`Resolving views for ${newDbs.length} nested databases...`);
          await this.discoverViewsViaApi(registry, settings, newDbs, entries, errors, cancelCheck);
        }
      }

      // Reverse-lookup any views still unresolved (from initial DBs OR BFS).
      if (unresolvedViews.length > 0 && !cancelCheck?.()) {
        emitProgress('Resolving linked views via Views API...');
        await this.resolveViewsByReverseLookup(
          registry,
          settings,
          unresolvedViews,
          entries,
          errors,
          cancelCheck,
        );
      }

      // Backstop: ensure every DB has views[] populated before render.
      // MUST run before apply - syncDatabase reads entry.views[] at render
      // time; a bare entry produces a degraded .base.
      await this.finalizeDatabaseMetadata(registry, settings, cancelCheck);

      return {
        entries: survivingEntries(entries, registry),
        discoveryComplete: !cancelCheck?.() && !bfsHadFetchFailure,
        unresolvedViews,
      };
    }

    // Fallback: raw page IDs from notionPages[] (older config shape).
    const pageIds = this.propertyHelper.resolveIds(settings.notionPages);
    const fallbackStandaloneBase =
      settings.useStandaloneFolder && settings.standaloneFolder
        ? `${syncFolder}/${settings.standaloneFolder}`
        : syncFolder;
    if (pageIds.length === 0) {
      return { entries: [], discoveryComplete: true, unresolvedViews: [] };
    }

    for (const pageId of pageIds) {
      try {
        const page = await this.notionClient.getPage(pageId);
        const title = getPageTitle(page);
        const entry = registry.registerPage(pageId, title, fallbackStandaloneBase);
        entries.push(entry);
      } catch (error) {
        const msg = getErrorMessage(error);
        log.error(`Failed to fetch page ${pageId}: ${msg}`);
        errors.push(`Page ${pageId.substring(0, 8)}...: ${msg}`);
      }
    }

    return { entries, discoveryComplete: true, unresolvedViews };
  }

  /**
   * BFS discovery of child_page and child_database blocks inside selected pages.
   * Registers discovered child pages in a subfolder named after their parent page
   * (e.g. parent at `_Pages/Parent.md` -> children at `_Pages/Parent/Child.md`).
   * Database items' children stay flat in standaloneBase.
   *
   * @param registry - Page registry to register discovered items into
   * @param settings - Sync config with child sync flags
   * @param entries - Accumulator for newly discovered registry entries
   * @param errors - Accumulator for error messages
   * @param folder - Vault folder to register children into
   * @param seedPageIds - Initial page IDs to scan (dashless)
   * @param visited - Set of already-registered Notion IDs (dashless) for dedup
   * @param emitProgress - Progress callback
   * @param cancelCheck - Cancellation callback
   */
  /**
   * Walk seed pages' block trees and register any `child_page` /
   * `child_database` references found inside, recursing inter-page up to
   * `maxDepth` levels and intra-page (callouts, toggles, columns) up to
   * `MAX_BLOCK_NESTING` levels. Newly-registered entries are appended to
   * `entries`; the method returns nothing because the registry, entries
   * array, and `visited` set are mutated in place.
   */
  async discoverChildrenFromBlocks(
    registry: PageRegistry,
    settings: SyncConfig,
    entries: PageRegistryEntry[],
    errors: string[],
    unresolvedViews: UnresolvedLinkedView[],
    folder: string,
    seedPageIds: string[],
    visited: Set<string>,
    selectedDbTitles: Set<string>,
    emitProgress: (msg: string) => void,
    cancelCheck?: () => boolean,
    maxDepth: number = MAX_CHILD_DISCOVERY_DEPTH,
    /**
     * Shared in-memory block cache (plan smooth-jingling-sloth). When
     * supplied, every `getAllBlockChildren` call we make populates this
     * map so the apply phase can reuse the data instead of re-fetching.
     * Optional - omit to keep behaviour identical to today.
     */
    blockCache?: Map<string, NotionBlock[]>,
    /**
     * Shared in-memory page-metadata cache (plan smooth-jingling-sloth v2).
     * When supplied AND a child_page hit is present, we synthesize the
     * page registration from the cached NotionPage instead of calling
     * notionClient.getPage(). Combined with `blockCache`, this lets the
     * replay phase run zero API calls when prefetch primed both maps.
     */
    pageCache?: Map<string, NotionPage>,
  ): Promise<void> {
    const MAX_DEPTH = maxDepth;
    const MAX_BLOCK_NESTING = 5;

    // BFS queue: [pageId (dashless), depth, pageTitle]
    const queue: [string, number, string][] = seedPageIds.map((id) => {
      const entry = registry.get(id);
      return [id, 0, entry?.title ?? id.substring(0, 8)];
    });

    // Track the last real inline database discovered on the current page.
    // Used as context for "Untitled" linked views that can't be matched by title.
    let currentPageId = '';
    let currentPageTitle = '';

    // Hard-cap signal. The scan helpers set this true when entries.length
    // crosses MAX_DISCOVERED_PAGES; the outer BFS loop checks it on each
    // iteration. Without it, a runaway fan-out from rich-text mentions (one
    // page can mention 88+ others) would crawl half a workspace. With it,
    // discovery stops cleanly with whatever we have already gathered.
    let capHit = false;
    const reachedCap = (): boolean => entries.length >= MAX_DISCOVERED_PAGES;

    // Map of sanitized database title -> notionId for O(1) collision detection.
    // Only tracks databases in the sync folder (mirrors the entries.find() logic it replaces).
    const dbTitleToEntry = new Map<string, PageRegistryEntry>();
    for (const e of entries) {
      if (e.type === 'database') {
        dbTitleToEntry.set(sanitizeFileName(e.title), e);
      }
    }

    /**
     * Process a single page reference - used for both `child_page` blocks
     * (where the block ID IS the page ID) and inline page mentions in
     * rich text (where the page ID lives on `mention.page.id`). Idempotent:
     * skips if already visited or capped. The caller doesn't have to do the
     * visited/cap bookkeeping itself.
     *
     * IMPORTANT: a "page" in Notion is either a standalone page OR a row in
     * a database. When the page's parent is a database / data_source, we
     * register it as a `database-item` under the database's folder rather
     * than as a `page` under the mentioning page's folder. Without this,
     * SELFDEV's mentions of "Action", "Process", "Self-Discipline" etc.
     * land under `_Pages/SELFDEV/` even though those items belong to the
     * Tasks DB (or wherever their actual parent database lives).
     */
    const processPageRef = async (
      pageId: string,
      pageDepth: number,
      sourceLabel: string,
    ): Promise<void> => {
      if (visited.has(pageId)) return;
      visited.add(pageId);
      if (reachedCap()) {
        capHit = true;
        return;
      }
      try {
        // Hit pageCache first (plan smooth-jingling-sloth v2) - when prefetch
        // primed it, we skip the getPage round-trip. Cache miss falls through
        // to the API; populate on cold fetch so subsequent passes hit.
        const page = pageCache?.get(pageId) ?? (await this.notionClient.getPage(pageId));
        if (pageCache && !pageCache.has(pageId)) pageCache.set(pageId, page);
        const title = getPageTitle(page);

        // Inspect parent: a database row's parent is a `database_id` (legacy)
        // or `data_source_id` (Notion 2025-09-03+). When a mention points at
        // a DB row we want THAT ONE ROW - not the entire parent DB.
        //
        // The parent DB entry DOES go into `entries[]`: at apply time a
        // `database` entry only creates the folder + its sync record
        // (syncDatabase never queries rows - queryDatabaseItems runs solely
        // in discovery, gated on selection / syncChildDatabases). Without
        // the entry, rows landed as database-item records under a folder no
        // `database` record owned, and the orchestrator's stale-database
        // cleanup would purge any record that DID exist because the DB never
        // appeared among the run's database entries. Row over-pull is still
        // avoided: only the mentioned row itself is registered and synced.
        const pageParent = (
          page as {
            parent?: {
              type?: string;
              database_id?: string;
              data_source_id?: string;
              page_id?: string;
            };
          }
        ).parent;
        const parentDbId = pageParent?.database_id ?? pageParent?.data_source_id;
        if (parentDbId) {
          const normalizedDbId = normalizeNotionId(parentDbId);
          let dbEntry = registry.get(normalizedDbId);
          if (!dbEntry) {
            try {
              const dbMeta = await this.notionClient.getDatabase(normalizedDbId);
              const dbTitleArr = (dbMeta as { title?: Array<{ plain_text?: string }> }).title;
              const dbTitle =
                (Array.isArray(dbTitleArr)
                  ? dbTitleArr.map((t) => t.plain_text ?? '').join('')
                  : '') || 'Untitled Database';
              const sanitized = sanitizeFileName(dbTitle);
              const existingByTitle = dbTitleToEntry.get(sanitized);
              if (existingByTitle && existingByTitle.folder === settings.syncFolder) {
                dbEntry = existingByTitle;
                registry.registerAlias(normalizedDbId, existingByTitle.notionId);
              } else {
                // Register the DB so the row's vault path resolves AND push
                // it to entries[] so the apply phase writes its folder +
                // `database` sync record. syncDatabase pulls no rows, so
                // this cannot over-pull - only the referenced row syncs.
                dbEntry = registry.registerDatabase(normalizedDbId, dbTitle, settings.syncFolder);
                dbTitleToEntry.set(sanitized, dbEntry);
                entries.push(dbEntry);
                log.info(
                  `${sourceLabel}: registered parent DB "${dbTitle}" (${normalizedDbId.substring(0, 8)}...) for row ${pageId.substring(0, 8)}...`,
                );
              }
            } catch (err) {
              log.warn(
                `${sourceLabel}: failed to fetch parent DB ${normalizedDbId.substring(0, 8)}... for row ${pageId.substring(0, 8)}...: ${getErrorMessage(err)}`,
              );
            }
          }
          if (dbEntry) {
            const itemEntry = registry.registerDatabaseItem(
              pageId,
              title,
              dbEntry.notionId,
              dbEntry.vaultPath,
            );
            itemEntry.lastEditedTime = page.last_edited_time ?? undefined;
            entries.push(itemEntry);
            // DB rows can have child blocks; queue for further BFS so nested
            // child_page / child_database refs are found. Leaf short-circuit
            // handles empty rows.
            queue.push([pageId, pageDepth + 1, title]);
            return;
          }
        }

        // Standalone-page path: nest under the parent's subfolder when the
        // parent is a standalone page (type='page'); otherwise stay flat in
        // the sync root folder.
        const parentEntry = registry.get(currentPageId);
        const childFolder =
          parentEntry && parentEntry.type === 'page'
            ? `${parentEntry.folder}/${parentEntry.fileName}`
            : folder;
        const entry = registry.registerPage(pageId, title, childFolder);
        entry.lastEditedTime = page.last_edited_time ?? undefined;
        entries.push(entry);
        queue.push([pageId, pageDepth + 1, title]);
      } catch (error) {
        const msg = getErrorMessage(error);
        log.warn(`${sourceLabel} discovery: failed to fetch ${pageId.substring(0, 8)}...: ${msg}`);
        errors.push(`${sourceLabel} ${pageId.substring(0, 8)}...: ${msg}`);
      }
    };

    /**
     * Process a database mention from rich text. A mention is just a
     * reference to an existing database - it must NOT pull rows.
     *
     * Mirrors the contract `9d07089b` established for `processPageRef`
     * (page-mentions of DB rows): DB rows land ONLY through linked-view
     * filtered queries (the linked-view resolver path) or explicit
     * database selection, never through mention-following. Pulling
     * every row of every mentioned DB overshot the user's
     * `linkedViewFullDatabase=false` intent and pulled hundreds or
     * thousands of items the user never asked for.
     *
     * Behaviour preserved:
     *   - register the database itself (so wikilinks resolve and any
     *     linked view of it on the same page can find the DB entry)
     *   - populate canonical metadata (dataSourceId, viewType,
     *     visiblePropertyIds, coverImage, views[]) via the registrar's
     *     official Views API path
     *   - alias when a same-title DB already exists in this folder
     *   - skip linked-view stubs (data_sources=[]) cleanly
     *
     * Behaviour removed:
     *   - `queryDatabaseItems` call that pulled all rows
     *   - the for-loop that registered every row as a database-item
     *     and queued each for child-block scanning
     */
    const processDatabaseMention = async (
      databaseId: string,
      displayLabel: string,
    ): Promise<void> => {
      if (visited.has(databaseId)) return;
      visited.add(databaseId);
      if (reachedCap()) {
        capHit = true;
        return;
      }
      try {
        const db = await this.notionClient.getDatabase(databaseId);
        if (isLinkedViewStub(db)) {
          log.debug(
            `Database mention ${databaseId.substring(0, 8)}... has no data_sources - skipping`,
          );
          return;
        }
        const dbTitleArr = (db as { title?: Array<{ plain_text?: string }> }).title;
        const dbTitle =
          (Array.isArray(dbTitleArr) ? dbTitleArr.map((t) => t.plain_text ?? '').join('') : '') ||
          displayLabel ||
          'Untitled Database';
        const sanitized = sanitizeFileName(dbTitle);
        if (selectedDbTitles.has(sanitized)) {
          registry.registerAlias(databaseId, dbTitleToEntry.get(sanitized)?.notionId ?? '');
          return;
        }
        const existingByTitle = dbTitleToEntry.get(sanitized);
        if (existingByTitle && existingByTitle.folder === settings.syncFolder) {
          registry.registerAlias(databaseId, existingByTitle.notionId);
          return;
        }
        // Register the database via the shared registrar so canonical
        // metadata (dataSourceId, viewType, visiblePropertyIds, coverImage,
        // views[]) populates from the official Views API. The probed
        // `db` object is passed as `prefetchedDbMeta` so the registrar
        // doesn't re-fetch.
        const dbEntry = await ensureDatabaseRegistered(
          registry,
          databaseId,
          dbTitle,
          {
            notionClient: this.notionClient,
            syncFolder: settings.syncFolder,
            syncState: this.syncState,
          },
          db as Parameters<typeof ensureDatabaseRegistered>[4],
        );
        entries.push(dbEntry);
        dbTitleToEntry.set(sanitized, dbEntry);
        // Intentionally NO queryDatabaseItems call here. DB rows are
        // pulled ONLY through linked-view filtered queries or explicit
        // selection; mention-following must dead-end at the DB itself.
      } catch (error) {
        const msg = getErrorMessage(error);
        log.warn(`Database mention discovery: failed for ${databaseId.substring(0, 8)}...: ${msg}`);
        errors.push(`Database mention ${databaseId.substring(0, 8)}...: ${msg}`);
      }
    };

    /**
     * Recursively scan blocks for child_page, child_database, and rich-text
     * page/database mentions. Recurses into container blocks (callouts,
     * toggles, columns, synced blocks, etc.) so refs nested inside them are
     * discovered the same as top-level blocks.
     */
    const scanBlocks = async (
      blocks: NotionBlock[],
      blockNesting: number,
      pageDepth: number,
    ): Promise<void> => {
      for (const block of blocks) {
        if (cancelCheck?.() || capHit) return;
        const blockType = block.type;
        const blockId = normalizeNotionId(block.id ?? '');

        if (blockType === 'child_page' && settings.syncChildPages) {
          await processPageRef(blockId, pageDepth, 'Child page');
          if (capHit) return;
          continue;
        } else if (blockType === 'child_database') {
          if (visited.has(blockId)) continue;
          visited.add(blockId);

          // Skip if already registered by the Views API discovery step
          const existingViewsApiEntry = registry.get(blockId);
          if (existingViewsApiEntry) {
            log.info(
              `Skipping child database ${blockId.substring(0, 8)}... - already registered via Views API as "${existingViewsApiEntry.title}"`,
            );
            continue;
          }
          log.info(`Child database ${blockId.substring(0, 8)}... NOT in registry - will probe`);

          try {
            const childDb = block.child_database;
            const title = childDb?.title ?? 'Untitled Database';

            // Skip child databases that are already explicitly selected in the tree picker
            // (they use data_source IDs which differ from the block's database UUID)
            const sanitizedChildTitle = sanitizeFileName(title);
            if (selectedDbTitles.has(sanitizedChildTitle)) {
              log.info(
                `Skipping child database "${title}" (${blockId.substring(0, 8)}...) - already selected in tree picker`,
              );
              registry.registerAlias(
                blockId,
                dbTitleToEntry.get(sanitizedChildTitle)?.notionId ?? '',
              );
              continue;
            }

            // Probe FIRST, before any title-based dedup: the title-collision
            // guard now runs ONLY for real inline databases (below), because N
            // linked views of the same source DB all carry the same title
            // ("Untitled") and MUST NOT be collapsed into one entry (#1705).

            // Probe: try getDatabase to distinguish real inline DB from linked view.
            // Two flavors of linked view to detect:
            //   1. Legacy: getDatabase throws 404 (not found) or 400 (validation_error:
            //      "does not contain any data sources accessible by this API bot").
            //   2. Notion 2025-09-03: getDatabase returns 200 with `data_sources: []`.
            //      Real inline databases always own >=1 data source; an empty array
            //      means the entity is a linked view stub of one. Earlier versions of
            //      this probe missed case 2, misclassifying linked views as real DBs,
            //      then calling queryDatabase on a UUID with no schema (returns 0
            //      results), and never running reverse-lookup. SELFDEV's "Untitled"
            //      child_database hit this path: the .base file landed only because
            //      a separate fallback rescued it; the source DB rows the view
            //      actually shows were never pulled.
            let isRealDatabase = true;
            // Cache the probed dbMeta - passed into ensureDatabaseRegistered
            // below so the registrar's populateDatabaseMetadata reuses it
            // instead of issuing a second getDatabase call.
            let probedDbMeta:
              | {
                  data_sources?: { id: string }[];
                  properties?: Record<string, Record<string, unknown>>;
                }
              | undefined;
            try {
              probedDbMeta = (await this.notionClient.getDatabase(blockId)) as typeof probedDbMeta;
              // `data_sources: []` is a bare stub. A NON-empty `data_sources`
              // that points at a database hosted under a DIFFERENT block is a
              // linked view of an inline DB elsewhere (the 2025-09-03 shape) -
              // isLinkedViewStub misses it, so isLinkedViewBlock() checks the
              // source data source's parent via the official API (#1705).
              if (
                isLinkedViewStub(probedDbMeta) ||
                (await this.isLinkedViewBlock(blockId, probedDbMeta))
              ) {
                isRealDatabase = false;
              }
            } catch (probeError) {
              if (
                probeError instanceof NotionApiError &&
                (probeError.statusCode === 404 || probeError.statusCode === 400)
              ) {
                isRealDatabase = false;
              } else {
                throw probeError; // Re-throw non-probe errors (auth, rate limit, etc.)
              }
            }

            if (!isRealDatabase) {
              // Linked view: a bare stub (data_sources=[] OR 400/404) OR a view
              // of an inline DB hosted elsewhere (non-empty data_sources whose
              // source block differs). Defer to reverse-lookup
              // (resolveViewsByReverseLookup): the official Views API + shared
              // linked-view-resolver find the source DB and the SPECIFIC view
              // for THIS block, producing a per-view .base with the right view
              // type (gallery -> cards). Each block is a distinct view, so they
              // are never title-deduped - which is what collapsed N same-titled
              // linked views of one DB into a single table embed (#1705).
              log.info(
                `Linked view detected: "${title}" (${blockId.substring(0, 8)}...) - deferring to reverse-lookup`,
              );
              unresolvedViews.push({
                viewId: blockId,
                viewTitle: title,
                pageId: currentPageId,
                pageTitle: currentPageTitle,
              });
            } else if (settings.syncChildDatabases) {
              // Real inline database. Apply the title-collision guard HERE
              // (only inline DBs are deduped by title - the same DB can appear
              // with different block IDs across the tree; linked views cannot).
              const existingByTitle = dbTitleToEntry.get(sanitizeFileName(title));
              if (existingByTitle && existingByTitle.folder === settings.syncFolder) {
                log.info(
                  `Skipping duplicate database "${title}" (${blockId.substring(0, 8)}...) - already registered as ${existingByTitle.notionId.substring(0, 8)}...`,
                );
                registry.registerAlias(blockId, existingByTitle.notionId);
              } else {
                // Register through the shared registrar so canonical metadata
                // (dataSourceId, viewType, visiblePropertyIds, coverImage,
                // views[]) populates from the official Views API and the .base
                // file generates correctly.
                const dbEntry = await ensureDatabaseRegistered(
                  registry,
                  blockId,
                  title,
                  {
                    notionClient: this.notionClient,
                    syncFolder: settings.syncFolder,
                    syncState: this.syncState,
                  },
                  probedDbMeta,
                );
                entries.push(dbEntry);
                dbTitleToEntry.set(sanitizeFileName(title), dbEntry);
                // WYSIWYG: an inline database on the page IS visible to the
                // user with all its rows, so pull them.
                try {
                  const items = await this.queryDatabaseItems(
                    getQueryableDataSourceId(dbEntry),
                    settings,
                    cancelCheck,
                  );
                  let newRows = 0;
                  for (const item of items) {
                    if (registry.get(item.notionId)) continue;
                    const itemEntry = registry.registerDatabaseItem(
                      item.notionId,
                      item.title,
                      dbEntry.notionId,
                      dbEntry.vaultPath,
                    );
                    itemEntry.lastEditedTime = item.lastEditedTime;
                    entries.push(itemEntry);
                    newRows++;
                  }
                  log.info(
                    `Inline database "${dbEntry.title}" pulled ${items.length} row(s) - ${newRows} new`,
                  );
                } catch (queryErr) {
                  const msg = `Inline database "${dbEntry.title}": failed to query rows: ${getErrorMessage(queryErr)}`;
                  log.warn(msg);
                  errors.push(msg);
                }
              }
            } else {
              // Real inline database but syncChildDatabases=false - skip
              log.debug(
                `Skipping inline database "${title}" (${blockId.substring(0, 8)}...) - syncChildDatabases disabled`,
              );
            }
          } catch (error) {
            const msg = getErrorMessage(error);
            log.error(
              `Child discovery: failed to process child database ${blockId.substring(0, 8)}...: ${msg}`,
            );
            errors.push(`Child database ${blockId.substring(0, 8)}...: ${msg}`);
          }
        }

        // Inline mentions: rich-text runs of type 'mention' that point at
        // a page or database elsewhere in the workspace. Until this scan was
        // added, every wikilink the renderer emitted from a heading/paragraph
        // mention dead-ended in the vault because nothing seeded the mentioned
        // page for fetch. Now they get queued the same way child_page refs do.
        //
        // CRITICAL: mentions are followed only at pageDepth === 0 (the
        // originally-seeded pages). Following them transitively at every
        // depth turns a single-page sync into a workspace-wide BFS - SELFDEV
        // alone has 88 page mentions, each of which can mention 50+ more.
        // Structural child_page / child_database recursion still walks the
        // full tree (those represent containment, not lateral references),
        // but mentions are a one-hop follow by design.
        if ((settings.syncChildPages || settings.syncChildDatabases) && pageDepth === 0) {
          const richText = readRichText(block);
          if (richText) {
            // De-dupe within a block so the same mention appearing twice in
            // a heading doesn't double-process at the helper.
            const seenInBlock = new Set<string>();
            for (const run of richText) {
              if (cancelCheck?.() || capHit) return;
              if (run.type !== 'mention' || !run.mention) continue;
              const mentionType = run.mention.type;
              if (mentionType === 'page' && settings.syncChildPages) {
                const mentionedId = normalizeNotionId(run.mention.page?.id ?? '');
                if (!mentionedId || seenInBlock.has(mentionedId)) continue;
                seenInBlock.add(mentionedId);
                await processPageRef(mentionedId, pageDepth, 'Page mention');
              } else if (mentionType === 'database' && settings.syncChildDatabases) {
                const mentionedId = normalizeNotionId(run.mention.database?.id ?? '');
                if (!mentionedId || seenInBlock.has(mentionedId)) continue;
                seenInBlock.add(mentionedId);
                await processDatabaseMention(mentionedId, run.plain_text ?? '');
              }
            }
          }
        }

        // Recurse into container blocks (callouts, toggles, columns, etc.)
        // to find child_page/child_database blocks at deeper nesting levels
        const hasChildren = block.has_children ?? false;
        if (
          hasChildren &&
          blockType !== 'child_page' &&
          blockType !== 'child_database' &&
          blockNesting < MAX_BLOCK_NESTING
        ) {
          try {
            const childBlocks = await this.notionClient.getAllBlockChildren(blockId, blockCache);
            await scanBlocks(childBlocks, blockNesting + 1, pageDepth);
          } catch (err) {
            // Promote nested-container fetch failure from debug to warn AND
            // push to errors[]. A silent failure here means container
            // children (toggle/callout/column contents) drop out of the
            // discovered set; downstream renders may overwrite a populated
            // local file with empty body.
            const msg = getErrorMessage(err);
            log.warn(
              `Child discovery: failed to scan nested ${blockType} ${blockId.substring(0, 8)}...: ${msg}`,
            );
            errors.push(
              `Nested ${blockType} ${blockId.substring(0, 8)}... in ${currentPageTitle || currentPageId.substring(0, 8)}: ${msg}`,
            );
          }
        }
      }
    };

    while (queue.length > 0) {
      if (cancelCheck?.()) return;
      if (capHit) {
        const remaining = queue.length;
        const msg = `Discovery cap reached (${MAX_DISCOVERED_PAGES} pages); stopping with ${remaining} unprocessed seed(s)`;
        log.warn(msg);
        errors.push(msg);
        emitProgress(msg);
        return;
      }

      const entry = queue.shift();
      if (!entry) break;
      const [pageId, depth, pageTitle] = entry;
      // Reset per-page context for linked view resolution
      currentPageId = pageId;
      currentPageTitle = pageTitle;
      emitProgress(`Scanning ${pageTitle}...`);
      if (depth >= MAX_DEPTH) {
        log.warn(
          `Child discovery: skipping depth ${depth} for page ${pageId.substring(0, 8)}... (max ${MAX_DEPTH})`,
        );
        continue;
      }

      let blocks: NotionBlock[];
      try {
        blocks = await this.notionClient.getAllBlockChildren(pageId, blockCache);
      } catch (error) {
        const msg = getErrorMessage(error);
        // Push to errors[] so SyncResult surfaces the dropped page.
        // Pre-fix this swallow caused pages to silently disappear from the
        // sync set; orphan detection then deleted the local copy on the
        // next pass. Surfacing the error lets the orphan detector skip
        // affected pages and lets the dashboard show what was missed.
        log.warn(`Child discovery: failed to get children of ${pageId.substring(0, 8)}...: ${msg}`);
        errors.push(
          `Discovery: ${pageTitle || pageId.substring(0, 8)} (${pageId.substring(0, 8)}...): ${msg}`,
        );
        continue;
      }

      // LEAF SHORT-CIRCUIT: when none of the top-level blocks are container
      // blocks AND none are direct child_page/child_database refs AND none
      // carry rich-text mentions, we know scanBlocks will register nothing
      // - skip the inner walk entirely. Container blocks (toggles, callouts,
      // columns, synced) might hide refs deeper, so we only skip when ALL
      // top-level blocks are flat non-mention content. The rich-text-mention
      // check covers the SELFDEV-style case: a page that's just headings +
      // paragraphs whose only references are inline page-mention runs.
      const hasContainer = blocks.some((b) => {
        const t = b.type;
        return (
          t !== 'child_page' &&
          t !== 'child_database' &&
          (b.has_children === true || (typeof t === 'string' && CONTAINER_BLOCK_TYPES.has(t)))
        );
      });
      const hasDirectRef = blocks.some(
        (b) => b.type === 'child_page' || b.type === 'child_database',
      );
      // Mention-bearing blocks only matter at depth 0 - that's where the
      // mention scan is gated to fire. At deeper depths we'd be checking
      // for refs that scanBlocks intentionally ignores, so the short-circuit
      // can fall through to the "leaf, skip" branch on text-only pages.
      const hasMention =
        depth === 0 &&
        (settings.syncChildPages || settings.syncChildDatabases) &&
        blocks.some((b) => {
          const rt = readRichText(b);
          return Array.isArray(rt) && rt.some((r) => r.type === 'mention');
        });
      if (!hasContainer && !hasDirectRef && !hasMention) continue;

      // Scan all blocks recursively (including nested in callouts, toggles, etc.)
      await scanBlocks(blocks, 0, depth);
    }
  }

  /**
   * Query all items in a database (paginated).
   * Used by buildFromSelected when a database is selected.
   */
  async queryDatabaseItems(
    databaseId: string,
    settings: SyncConfig,
    cancelCheck?: () => boolean,
    apiFilter?: Record<string, unknown>,
  ): Promise<
    {
      notionId: string;
      title: string;
      lastEditedTime: string;
      hasChildren: boolean;
      parentDataSourceId?: string;
    }[]
  > {
    const items: {
      notionId: string;
      title: string;
      lastEditedTime: string;
      hasChildren: boolean;
      parentDataSourceId?: string;
    }[] = [];
    let cursor: string | undefined;
    let hasMore = true;
    let resolvedDataSourceId: string | undefined;

    const normalizedDbId = normalizeNotionId(databaseId);
    const filterConfig = settings.databaseFilters?.find(
      (f) => normalizeNotionId(f.databaseId) === normalizedDbId,
    );
    const notionFilter =
      apiFilter ?? (filterConfig ? this.buildNotionFilter(filterConfig) : undefined);

    const MAX_DB_PAGES = 100;
    let pages = 0;
    while (hasMore) {
      if (cancelCheck?.()) break;
      if (pages >= MAX_DB_PAGES) {
        log.warn(
          `Database query capped at ${MAX_DB_PAGES} pages (${items.length} items) for ${databaseId.substring(0, 8)}...`,
        );
        break;
      }
      const response = await this.notionClient.queryDatabase(
        databaseId,
        notionFilter,
        undefined,
        cursor,
      );
      pages++;

      for (const item of response.results) {
        // Extract data_source_id from first item's parent (cross-walk block UUID -> data_source)
        if (!resolvedDataSourceId) {
          const parent = item.parent;
          if (parent?.type === 'data_source_id') {
            const id = extractParentId(parent);
            if (id) resolvedDataSourceId = id;
          }
        }
        items.push({
          notionId: normalizeNotionId(item.id),
          title: getPageTitle(item),
          lastEditedTime: item.last_edited_time ?? '',
          // Default true: the Notion database query API does not return has_children;
          // assume items may have block children until the API provides this field.
          hasChildren: item.has_children ?? true,
          parentDataSourceId: resolvedDataSourceId,
        });
      }

      hasMore = response.has_more;
      cursor = response.next_cursor ?? undefined;
    }

    return items;
  }

  buildNotionFilter(config: SyncDatabaseFilter): Record<string, unknown> | undefined {
    if (config.conditions.length === 0) return undefined;

    const filters = config.conditions.map((c) => {
      const filter: Record<string, unknown> = {
        property: c.property,
      };
      // Build the property-type-specific filter
      const typeFilter: Record<string, unknown> = {};
      typeFilter[c.operator] = c.value;
      filter[c.propertyType] = typeFilter;
      return filter;
    });

    if (filters.length === 1) return filters[0];

    return config.match === 'or' ? { or: filters } : { and: filters };
  }

  /** Fetch database properties from the official API (cached per session). */
  private readonly dbPropsCache = new Map<string, Record<string, Record<string, unknown>>>();
  private async getDatabaseProperties(
    dbId: string,
  ): Promise<Record<string, Record<string, unknown>>> {
    const cached = this.dbPropsCache.get(normalizeNotionId(dbId));
    if (cached) return cached;
    try {
      const meta = await this.notionClient.getDatabase(dbId);
      // Widen the typed NotionPropertySchema map to the generic record the
      // linked-view resolver / cover-derivation code consumes. `as unknown` is
      // needed now that the wire type carries no blanket index signature (#1589).
      const props = (meta.properties ?? {}) as unknown as Record<string, Record<string, unknown>>;
      this.dbPropsCache.set(normalizeNotionId(dbId), props);
      return props;
    } catch (err) {
      // Returning {} means downstream filter/cover derivation will skip property
      // lookups. Log so the root cause (permissions, bad id, network) is visible.
      log.warn(
        `Failed to fetch properties for database ${dbId.substring(0, 8)}...: ${getErrorMessage(err)}`,
      );
      return {};
    }
  }

  /**
   * Discover views for all databases via the official Views API (2025-09-03+).
   * Sets viewType and visiblePropertyIds on database entries.
   * Registers linked view entries for views that live on other pages.
   */
  // Public so the multi-pass orchestrator (plan smooth-jingling-sloth) can
  // resolve views for databases discovered in pass 2.
  async discoverViewsViaApi(
    registry: PageRegistry,
    settings: SyncConfig,
    databaseEntries: PageRegistryEntry[],
    allEntries: PageRegistryEntry[],
    errors: string[],
    cancelCheck?: () => boolean,
  ): Promise<void> {
    for (const dbEntry of databaseEntries) {
      if (cancelCheck?.()) return;
      let dsId: string = getQueryableDataSourceId(dbEntry);
      let stubs: { object: string; id: string }[];
      try {
        stubs = await this.notionClient.listViewsForDataSource(dsId);
      } catch (dsErr) {
        // Block UUIDs return 400/404 from Views API - resolve the real data_source_id
        if (
          dsErr instanceof NotionApiError &&
          (dsErr.statusCode === 400 || dsErr.statusCode === 404) &&
          !dbEntry.dataSourceId
        ) {
          const resolved = await resolveDataSourceId(registry, asBlockUuid(dbEntry.notionId), {
            notionClient: this.notionClient,
            syncFolder: settings.syncFolder,
            syncState: this.syncState,
          });
          if (resolved) {
            dsId = resolved;
            dbEntry.dataSourceId = resolved;
            log.info(
              `Views API: resolved data_source_id for "${dbEntry.title}": ${resolved.substring(0, 8)}...`,
            );
            try {
              stubs = await this.notionClient.listViewsForDataSource(resolved);
            } catch (retryErr) {
              log.warn(
                `Views API: retry failed for "${dbEntry.title}": ${getErrorMessage(retryErr)}`,
              );
              continue;
            }
          } else {
            log.warn(`Views API: could not resolve data_source_id for "${dbEntry.title}"`);
            continue;
          }
        } else {
          log.warn(
            `Views API: failed to list views for "${dbEntry.title}": ${getErrorMessage(dsErr)}`,
          );
          continue;
        }
      }
      try {
        log.info(
          `Views API: "${dbEntry.title}" (${dsId.substring(0, 8)}...) -> ${stubs.length} views`,
        );
        let isFirstView = true;
        let coverResolved = false;
        // Collect every detected view - generator uses this 1:1 (no hardcoded defaults).
        // Reset on every call so repeated invocations (e.g. via buildFromSelected ->
        // discoverChildrenFromBlocks -> newlyDiscovered re-run) don't accumulate duplicates.
        dbEntry.views = [];
        const seenViewIds = new Set<string>();

        for (const stub of stubs) {
          if (cancelCheck?.()) return;
          try {
            const view = await this.notionClient.getView(stub.id);

            // Skip unsupported view types
            // Skip chart views - no meaningful Bases mapping exists. Calendar
            // views DO have a meaningful fallback (table with same filter +
            // columns; user sees the data, just not the month grid) so we
            // let them through. mapNotionViewType('calendar') -> 'table'.
            if (view.type === 'chart') continue;

            // Resolve every per-view derived field through the canonical
            // resolver - same code path as sync-page (apply-time) and
            // resolveViewsByReverseLookup. Single source of truth: filters,
            // viewType, visibleProperties, coverImage, apiFilter all come
            // from one function so divergence between discovery-time and
            // apply-time outputs is structurally impossible.
            const dbPropsForView = await this.getDatabaseProperties(dsId);
            const r = buildLinkedViewResolution(view, dbEntry, dbPropsForView, (id) => {
              const e = registry.get(normalizeNotionId(id));
              return e?.title;
            });
            const viewType = r.viewType ?? 'table';
            const visiblePropertyIds = r.visiblePropertyIds;
            const viewFilters = r.filters;
            const viewCover = r.coverImage;
            const viewName = r.viewName;

            // Inline iff the view's parent.database_id matches THIS
            // database's own block UUID (`dbEntry.notionId`). Notion echoes
            // the block UUID on view.parent - NOT the `dataSourceId` (those
            // are distinct identifiers in the 2025-09-03 API). The earlier
            // implementation compared against `dsId` and had a loose
            // fallback that classified any view whose parent was a known
            // database as inline, which leaked every linked view in the
            // workspace into dbEntry.views.
            const parentBlockIdRaw = view.parent?.database_id;
            const normalizedParentId = parentBlockIdRaw
              ? normalizeNotionId(parentBlockIdRaw)
              : undefined;
            const normalizedOwnId = normalizeNotionId(dbEntry.notionId);
            const isInlineView =
              normalizedParentId !== undefined && normalizedParentId === normalizedOwnId;

            // Record ONLY inline views on the primary dbEntry.
            // Idempotent: skip if this view id was already recorded (defensive).
            if (isInlineView && !seenViewIds.has(stub.id)) {
              seenViewIds.add(stub.id);
              dbEntry.views.push({
                id: stub.id,
                name: viewName,
                type: viewType,
                visiblePropertyIds,
                coverImage: viewCover,
                filters: viewFilters,
              });
            }

            // Set viewType + visiblePropertyIds from the first INLINE view
            // (primary layout of the database's own page).
            if (isInlineView && isFirstView) {
              dbEntry.viewType = viewType;
              dbEntry.visiblePropertyIds = visiblePropertyIds;
              isFirstView = false;
            }

            // Resolve cover image from the first INLINE view that has a
            // cover config. Linked views on other pages may have cover
            // configs specific to their context - those don't represent
            // the database's own preferred cover.
            if (isInlineView && !coverResolved && view.configuration?.cover) {
              const coverProps = await this.getDatabaseProperties(dsId);
              const derived = deriveCoverImage(view.configuration.cover, coverProps);
              dbEntry.coverImage = derived;
              coverResolved = true;
              log.info(
                `Views API: "${dbEntry.title}" cover resolved from view "${view.name}" (${view.type}): ${view.configuration.cover.type} -> ${derived}`,
              );
            }

            // Register linked views as LinkedViewContext entries (unchanged).
            const parentBlockId = view.parent?.database_id;
            if (parentBlockId) {
              const normalizedParent = normalizeNotionId(parentBlockId);
              const normalizedDb = normalizeNotionId(dsId);
              const parentEntry = registry.get(normalizedParent);
              const isInline =
                !parentEntry ||
                parentEntry.type === 'database' ||
                normalizedParent === normalizedDb;
              log.info(
                `Views API: view "${view.name}" parent=${normalizedParent.substring(0, 8)}... db=${normalizedDb.substring(0, 8)}... isInline=${isInline} parentEntry=${parentEntry?.type ?? 'none'}`,
              );

              if (!isInline && settings.syncChildDatabases) {
                // Re-use the resolver output computed at the top of the
                // loop (filters, coverImage, etc.). The linked-view and
                // inline-view branches now share one resolution per view.
                const linkedViewContext = buildLinkedViewContext({
                  sourceDb: dbEntry,
                  filters: r.filters,
                  viewType: r.viewType,
                  visiblePropertyIds: r.visiblePropertyIds,
                  parentPageId: normalizedParent,
                  parentPageTitle: '', // Unknown from Views API alone
                  coverImage: r.coverImage,
                });
                const existingByViewId = registry.get(normalizeNotionId(stub.id));
                const existingByParent =
                  !existingByViewId && parentEntry?.type === 'linked-view'
                    ? parentEntry
                    : undefined;
                const existingEntry = existingByViewId ?? existingByParent;
                if (!existingEntry) {
                  const linkedEntry = registry.registerLinkedView(
                    stub.id,
                    r.viewName,
                    dbEntry,
                    linkedViewContext,
                  );
                  allEntries.push(linkedEntry);
                  // Register parent block ID as alias so discoverChildrenFromBlocks
                  // finds it and skips re-probing the same child_database block
                  registry.registerAlias(normalizedParent, linkedEntry.notionId);
                  log.info(
                    `Views API: linked view "${r.viewName}" (${view.type}) for "${dbEntry.title}" on block ${normalizedParent.substring(0, 8)}...`,
                  );
                  // Row pull intentionally NOT done here. listViewsForDataSource
                  // returns every linked view of this DB workspace-wide; pulling
                  // rows for each one would download the full source DB once per
                  // unfiltered linked view that exists anywhere. Row sync for
                  // synced pages happens in:
                  //   - sync-page.registerAndGenerateLinkedView (apply-time, path D)
                  //   - resolveViewsByReverseLookup (discovery-time, path C)
                  // Both scope to linked views actually on pages being synced.
                } else if (existingEntry.linkedViewContext) {
                  // Unofficial API path registers linked views first without cover/view info.
                  // Enrich with Views API data (cover, viewType, filters, name).
                  if (linkedViewContext.coverImage)
                    existingEntry.linkedViewContext.coverImage = linkedViewContext.coverImage;
                  if (linkedViewContext.viewType)
                    existingEntry.linkedViewContext.viewType = linkedViewContext.viewType;
                  if (linkedViewContext.visiblePropertyIds)
                    existingEntry.linkedViewContext.visiblePropertyIds =
                      linkedViewContext.visiblePropertyIds;
                  if (linkedViewContext.filters?.length)
                    existingEntry.linkedViewContext.filters = linkedViewContext.filters;
                  // Replace "Untitled" with the derived view name from Views API.
                  // Also update fileName/vaultPath since they were built from the old title.
                  if (viewName && viewName !== existingEntry.title) {
                    const oldFileName = existingEntry.fileName;
                    const newFileName = oldFileName.replace(
                      sanitizeFileName(existingEntry.title),
                      sanitizeFileName(viewName),
                    );
                    if (newFileName !== oldFileName) {
                      existingEntry.fileName = newFileName;
                      existingEntry.vaultPath = existingEntry.vaultPath.replace(
                        oldFileName,
                        newFileName,
                      );
                    }
                    existingEntry.title = viewName;
                  }
                }
              }
            }
          } catch (viewErr) {
            log.warn(
              `Views API: failed to retrieve view ${stub.id.substring(0, 8)}...: ${getErrorMessage(viewErr)}`,
            );
          }
        }
      } catch (listErr) {
        log.warn(
          `Views API: failed to list views for "${dbEntry.title}": ${getErrorMessage(listErr)}`,
        );
      }
    }
  }

  /**
   * Reverse lookup: search ALL workspace databases via the official Views API,
   * then match each view's parent.database_id against unresolved block IDs.
   * Resolves linked views without the unofficial API or manual modal.
   */
  // Public so the multi-pass orchestrator (plan smooth-jingling-sloth) can
  // run reverse lookup on views surfaced in pass 2.
  async resolveViewsByReverseLookup(
    registry: PageRegistry,
    settings: SyncConfig,
    unresolvedViews: UnresolvedLinkedView[],
    entries: PageRegistryEntry[],
    errors: string[],
    cancelCheck?: () => boolean,
  ): Promise<void> {
    const unresolvedBlockIds = new Map<string, UnresolvedLinkedView>();
    for (const v of unresolvedViews) {
      unresolvedBlockIds.set(normalizeNotionId(v.viewId), v);
    }

    // Fetch all databases from workspace via search API
    const allDatabases: { id: string; title: string }[] = [];
    const seen = new Set<string>(
      entries.filter((e) => e.type === 'database').map((e) => e.notionId),
    );
    let hasMore = true;
    let cursor: string | undefined;

    while (hasMore) {
      if (cancelCheck?.()) return;
      try {
        const resp = (await this.notionClient.search(
          undefined,
          { property: 'object', value: 'data_source' },
          { direction: 'descending', timestamp: 'last_edited_time' },
          cursor,
        )) as {
          results: { id: string; title?: { plain_text: string }[] }[];
          has_more: boolean;
          next_cursor: string | null;
        };

        for (const result of resp.results) {
          const id = normalizeNotionId(result.id);
          if (seen.has(id)) continue;
          seen.add(id);
          const title = result.title?.map((t) => t.plain_text).join('') || 'Untitled Database';
          allDatabases.push({ id, title });
        }

        hasMore = resp.has_more;
        cursor = resp.next_cursor ?? undefined;
        if (hasMore && !cursor) break;
      } catch (err) {
        log.warn(`Reverse lookup: failed to search databases: ${getErrorMessage(err)}`);
        return;
      }
    }

    if (allDatabases.length === 0) return;
    log.info(
      `Reverse lookup: checking ${allDatabases.length} workspace databases for ${unresolvedBlockIds.size} unresolved view(s)`,
    );

    // For each database, list its views and check for parent matches
    for (const db of allDatabases) {
      if (cancelCheck?.()) return;
      if (unresolvedBlockIds.size === 0) break;

      try {
        const stubs = await this.notionClient.listViewsForDataSource(db.id);

        for (const stub of stubs) {
          if (unresolvedBlockIds.size === 0) break;

          try {
            const view = await this.notionClient.getView(stub.id);
            const parentBlockId = view.parent?.database_id;
            if (!parentBlockId) continue;

            const normalizedParent = normalizeNotionId(parentBlockId);
            const matched = unresolvedBlockIds.get(normalizedParent);
            if (!matched) continue;

            // Found a match - register the source database and linked view
            log.info(
              `Reverse lookup: view "${view.name || 'Untitled'}" on db "${db.title}" matches unresolved block ${normalizedParent.substring(0, 8)}...`,
            );

            // Register source database via the shared registrar so canonical
            // metadata (viewType, visiblePropertyIds, coverImage, views[])
            // populates from the OFFICIAL Views API. Without this, reverse-
            // lookup left entries bare and the .base generator fell back to
            // the 7-default-view template.
            let sourceDb = registry.get(db.id);
            if (!sourceDb) {
              try {
                const dbMeta = await this.notionClient.getDatabase(db.id);
                const dbTitle = getDatabaseTitle(dbMeta);
                sourceDb = await ensureDatabaseRegistered(
                  registry,
                  db.id,
                  dbTitle,
                  {
                    notionClient: this.notionClient,
                    syncFolder: settings.syncFolder,
                  },
                  dbMeta as never,
                );
                entries.push(sourceDb);
                log.info(`Reverse lookup: registered source database "${dbTitle}"`);
              } catch {
                log.warn(`Reverse lookup: failed to fetch database ${db.id.substring(0, 8)}...`);
                continue;
              }
            }

            // Resolve the view via the canonical resolver - same code
            // path as discovery (path B) and apply-time sync-page (path D).
            // Single source of truth for filters / viewType / cover /
            // apiFilter so the .base file and the row query stay aligned.
            //
            // Schema MUST be fetched via dataSourceId, not the block UUID.
            // Notion 2025-09-03's getDatabase(blockUUID) returns
            // {data_sources:[...], properties: undefined}, leaving
            // dbProperties empty - which silently drops every filter
            // because property-id -> name lookup needs the schema.
            const dbProps = await this.getDatabaseProperties(getQueryableDataSourceId(sourceDb));
            const r = buildLinkedViewResolution(view, sourceDb, dbProps, (id) => {
              const e = registry.get(normalizeNotionId(id));
              return e?.title;
            });

            // Query rows matching this view's filter via the official Views
            // API. Reverse-lookup is the authoritative path for linked-view
            // row sync, and it stays on the official API by design.
            //
            // The resolver's `apiFilter` is derived from the same filters
            // the .base file gets - WYSIWYG between Notion and Obsidian.
            // linkedViewFullDatabase opt-in still bypasses the filter
            // entirely (downloads the whole DB) for users who want it.
            try {
              // WYSIWYG: filtered view -> filtered query, unfiltered view ->
              // pull all rows (that's what the Notion view shows). Toggle
              // `linkedViewFullDatabase` overrides per-view filters and
              // forces full-DB pull even when filtered (for users who want
              // to edit beyond the filtered subset in Obsidian).
              const apiFilter = settings.linkedViewFullDatabase ? undefined : r.apiFilter;
              const items = await this.queryDatabaseItems(
                sourceDb.notionId,
                settings,
                cancelCheck,
                apiFilter,
              );
              let newRows = 0;
              for (const item of items) {
                if (registry.get(item.notionId)) continue;
                const itemEntry = registry.registerDatabaseItem(
                  item.notionId,
                  item.title,
                  sourceDb.notionId,
                  sourceDb.vaultPath,
                );
                itemEntry.lastEditedTime = item.lastEditedTime;
                entries.push(itemEntry);
                newRows++;
              }
              log.info(
                `Reverse lookup: queried ${items.length} item(s) from "${sourceDb.title}" for view "${r.viewName}"${apiFilter ? ' (filtered)' : ''} - ${newRows} new`,
              );
            } catch (queryErr) {
              // Surface in the result errors[] so the user sees a
              // visibly partial sync rather than "All caught up" with
              // the wrong row set for this linked view.
              const msg = `Reverse lookup: failed to query items for "${sourceDb.title}" view "${r.viewName}": ${getErrorMessage(queryErr)}`;
              log.warn(msg);
              errors.push(msg);
            }

            const linkedViewContext = buildLinkedViewContext({
              sourceDb,
              filters: r.filters,
              viewType: r.viewType,
              visiblePropertyIds: r.visiblePropertyIds,
              parentPageId: matched.pageId,
              parentPageTitle: matched.pageTitle,
              coverImage: r.coverImage,
            });

            const viewName = r.viewName;
            // Register with the BLOCK ID (normalizedParent), not the view ID.
            // The block renderer generates embeds using the block ID from the page content.
            const existingEntry = registry.get(normalizedParent);
            if (!existingEntry) {
              const linkedEntry = registry.registerLinkedView(
                normalizedParent,
                viewName,
                sourceDb,
                linkedViewContext,
              );
              entries.push(linkedEntry);
            }

            // Remove from unresolved
            unresolvedBlockIds.delete(normalizedParent);
            log.info(
              `Reverse lookup: resolved "${viewName}" -> "${sourceDb.title}" (${unresolvedBlockIds.size} remaining)`,
            );
          } catch (viewErr) {
            log.warn(
              `Reverse lookup: failed to get view ${stub.id.substring(0, 8)}...: ${getErrorMessage(viewErr)}`,
            );
          }
        }
      } catch (listErr) {
        log.warn(
          `Reverse lookup: failed to list views for "${db.title}": ${getErrorMessage(listErr)}`,
        );
      }
    }

    // Update the unresolvedViews array
    const resolved = unresolvedViews.filter(
      (v) => !unresolvedBlockIds.has(normalizeNotionId(v.viewId)),
    );
    if (resolved.length > 0) {
      log.info(`Reverse lookup: resolved ${resolved.length} linked view(s) via Views API`);
      unresolvedViews.length = 0;
      unresolvedViews.push(...[...unresolvedBlockIds.values()]);
    }
  }
}
