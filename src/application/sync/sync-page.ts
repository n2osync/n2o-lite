/**
 * Pull sync: single page handler.
 *
 * Extracted from pull-apply-phase.ts. Exports syncPage (public) and
 * renderWithTemplate (the shared render entry point for page markdown).
 *
 * @module
 */

import type { NotionPage, NotionBlock } from '../../domain/models/notion-api-types';
import type { PageRegistry, PageRegistryEntry } from '../discovery/page-registry';
import type { SyncConfig } from '../../domain/models/sync-config';
import type { SyncRecord, FailedMediaItem } from '../../domain/models/sync-record';
import { asBlockUuid, normalizeNotionId } from '../../domain/models/notion-id';
import type { N2ODocument } from '../../domain/models/document';
import type { BlockIdentity } from '../../infrastructure/storage/block-identity-store';
import type { ApplyPhaseDeps } from './apply-phase-deps';
import { resolveBlockIdentities } from './block-identity-resolver';
import { getSyncRecordDirection } from './orchestrator';
import { resolveCoverThumbnail } from '../media/media-downloader';
import { MAX_MEDIA_RETRIES, mergeFailedMedia } from '../media/media-retry';
import { downloadMediaForDoc } from './render-from-notion';
import { mapNotionViewType } from '../content/notion-view-type';
import { buildLinkedViewContext } from '../discovery/registry-builder-helpers';
import { ensureDatabaseRegistered } from '../discovery/database-registrar';
import { resolveLinkedView } from '../discovery/linked-view-resolver';
import { syncDatabase } from './sync-database';
import { getSharedAttachmentFolder } from '../../shared/attachment-paths';
import {
  sanitizeFileName,
  fitFileNameToBudget,
  vaultRelativePathBudget,
} from '../../shared/sanitize';
import { preserveLocalFrontmatter } from '../conflict/frontmatter-merge';
import { extractParentId, extractParentContainerType } from '../../domain/services/parent-utils';
import { enrichBreadcrumbBlocks } from '../../domain/services/breadcrumb-path';
import { enrichSyncedReferences } from '../../domain/services/synced-block-index';
import { N2OError, getErrorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/logger';
import { LITE_PAGE_LIMIT } from './page-budget';
import { hashContentForChange, hashNotionBlocks } from '../../shared/hash';
import { RENDERER_VERSION } from '../../shared/renderer-version';

const log = createLogger('PullSync');

/** Block count above which a page is considered large and a warning is logged. */
const LARGE_DOCUMENT_BLOCK_THRESHOLD = 500;

/**
 * Phase 2 enrichment pass: resolve any `child_database` blocks in the
 * page and register them in the live registry so the renderer can produce
 * valid `.base` embeds.
 *
 * No-op when the block_identity store is not wired (Phase 1 fallback still
 * applies at render time). Safe to call on every sync - resolver has its
 * own TTL cache that avoids re-probing recently-resolved blocks.
 *
 */
async function enrichChildDatabaseIdentities(
  blocks: NotionBlock[],
  entry: PageRegistryEntry,
  settings: SyncConfig,
  deps: ApplyPhaseDeps,
): Promise<void> {
  if (!deps.blockIdentityStore || !deps.currentRegistry) return;

  // Walk the WHOLE block tree, not just the top level. fetchPageWithBlocks
  // returns nested children in place, and a database dropped into a column
  // layout (the classic two-databases-side-by-side page) lives under
  // column_list -> column -> child_database. A top-level-only scan missed
  // those entirely, so their rows never pulled.
  const childDbBlockIds: string[] = [];
  const collectChildDatabases = (list: NotionBlock[]): void => {
    for (const block of list) {
      if (block.type === 'child_database' && block.id) {
        childDbBlockIds.push(block.id);
      }
      if (Array.isArray(block.children) && block.children.length > 0) {
        collectChildDatabases(block.children);
      }
    }
  };
  collectChildDatabases(blocks);
  if (childDbBlockIds.length === 0) return;

  const identities = await resolveBlockIdentities(
    childDbBlockIds,
    { parentPageId: entry.notionId, parentPageTitle: entry.title },
    {
      notionClient: deps.notionClient,
      blockIdentityStore: deps.blockIdentityStore,
    },
  );

  const registry = deps.currentRegistry;
  for (const identity of identities.values()) {
    if (identity.kind === 'linked-view' && identity.databaseId) {
      // Reuse the same path the pass-2 BFS uses: build a real
      // LinkedViewContext (filters, viewType, visiblePropertyIds),
      // registerLinkedView under the source DB's _views/ folder, and pull
      // the rows the view's filter selects so the vault gets the same
      // subset the user sees in Notion.
      await registerAndGenerateLinkedView(identity, settings, deps).catch((err) => {
        log.warn(
          `Failed to inline-register linked view ${identity.stableName}: ${getErrorMessage(err)}`,
        );
      });
    } else {
      await applyIdentityToRegistry(identity, registry, settings, deps).catch((err) => {
        log.warn(`Failed to apply identity ${identity.stableName}: ${getErrorMessage(err)}`);
      });
    }
  }

  // Ensure the builder sees the (potentially updated) registry when it
  // renders. Idempotent - setter just overwrites the reference.
  deps.builder.setPageRegistry(registry);
}

/**
 * Register a linked-view identity into the registry with a complete
 * LinkedViewContext, then pull the source-DB rows the view's filter
 * selects so the vault carries the same subset the user sees in Notion.
 *
 * Mirrors registry-builder.ts's pass-2 resolution path so the two code
 * paths produce identical output when resolving the same linked view.
 */
async function registerAndGenerateLinkedView(
  identity: BlockIdentity,
  settings: SyncConfig,
  deps: ApplyPhaseDeps,
): Promise<void> {
  if (!identity.databaseId || !deps.currentRegistry) return;
  const registry = deps.currentRegistry;

  // 1. Source DB: register if not already, AND make sure it has a sync_record.
  //    The orchestrator's apply iteration captured a slice of allEntries
  //    before this code runs, so we can't enqueue the DB for syncDatabase
  //    later - we have to do it inline.
  // Single source of truth for DB registration + canonical metadata.
  // ensureDatabaseRegistered:
  //   - Reuses an existing fully-populated entry (idempotent, no API calls).
  //   - Otherwise registers and populates viewType, visiblePropertyIds,
  //     coverImage, and views[] via the OFFICIAL Views API.
  const wasNewlyRegistered = !registry.get(identity.databaseId);
  const sourceDb = await ensureDatabaseRegistered(
    registry,
    identity.databaseId,
    identity.databaseTitle ?? 'Untitled Database',
    {
      notionClient: deps.notionClient,
      syncFolder: settings.syncFolder,
    },
  );
  if (wasNewlyRegistered && !deps.syncState.getByNotionId(sourceDb.notionId)) {
    // Inline the same syncDatabase the orchestrator's diff phase would call.
    // Idempotent - second call is a no-op (existing sync record).
    const dbErrors: string[] = [];
    await syncDatabase(sourceDb, settings, dbErrors, deps);
    if (dbErrors.length > 0) {
      log.warn(
        `Inline syncDatabase for "${sourceDb.title}" reported errors: ${dbErrors.join('; ')}`,
      );
    }
  }

  // 2. Resolve the linked view via the shared resolver. Single source of
  //    truth for filter / view metadata / Bases-ready output, used by
  //    both this apply-time path and discovery (registry-builder).
  const resolution = await resolveLinkedView(asBlockUuid(identity.blockId), sourceDb, {
    notionClient: deps.notionClient,
    pageIdToTitle: (id) => registry.get(normalizeNotionId(id))?.title,
  });

  if (!resolution.ok) {
    // Hard failure - surface in BOTH the UI toast (deps.emitError) AND
    // the SyncResult.errors[] (deps.appendError) so the run is visibly
    // partial / failed in the result object too. The alternative
    // (silent empty filters + all-rows over-pull) was the root of the
    // recurring drift this resolver collapses.
    const viewLabel = identity.viewTitle ?? identity.viewType ?? 'View';
    const pageLabel = identity.parentPageTitle ?? sourceDb.title;
    const title = `Linked view "${viewLabel}" on "${pageLabel}"`;
    const detail = `Could not resolve filter (${resolution.reason}): ${resolution.message}`;
    deps.emitError(title, detail);
    deps.appendError(`${title}: ${detail}`);
    return;
  }

  // 3. Build the LinkedViewContext from resolver output. registerLinkedView
  //    is idempotent - returns an existing entry if one was already created.
  const linkedViewContext = buildLinkedViewContext({
    sourceDb,
    filters: resolution.filters,
    viewType:
      resolution.viewType ?? (identity.viewType ? mapNotionViewType(identity.viewType) : undefined),
    visiblePropertyIds: resolution.visiblePropertyIds,
    parentPageId: identity.parentPageId ?? undefined,
    parentPageTitle: identity.parentPageTitle ?? '',
    coverImage: resolution.coverImage,
  });
  const viewName = resolution.viewName || identity.viewTitle || identity.viewType || 'View';
  const viewEntry = registry.registerLinkedView(
    identity.blockId,
    viewName,
    sourceDb,
    linkedViewContext,
  );

  // 4. Pull source-DB rows matching this view's filter on the same pass.
  //    The apiFilter from the resolver is the SAME predicate as the .base
  //    filter (WYSIWYG: Notion's shown rows == Obsidian's synced rows).
  //    When the view has a filter, pull only matching rows. When the view
  //    has NO filter, pull all rows - that's what the view shows in Notion.
  //    `linkedViewFullDatabase` overrides the per-view filter and pulls all
  //    rows even when the view IS filtered (for users who want to edit
  //    beyond the filtered subset in Obsidian).
  const apiFilter = settings.linkedViewFullDatabase ? undefined : resolution.apiFilter;
  await pullDatabaseRows(sourceDb, apiFilter, settings, deps, viewEntry.title).catch((err) => {
    log.warn(`Inline row-pull for linked view "${viewName}" failed: ${getErrorMessage(err)}`);
  });
}

/**
 * Query a database (optionally filtered), register matching rows under
 * its folder, and inline-sync them so they land on the current pass.
 * Paginated, deduped against the registry. Used for both linked views
 * (with filter) and inline databases (without filter).
 *
 * `label` is just for logs - lets the caller distinguish "linked view X"
 * from "inline database Y" in the output.
 */
async function pullDatabaseRows(
  sourceDb: PageRegistryEntry,
  apiFilter: Record<string, unknown> | undefined,
  settings: SyncConfig,
  deps: ApplyPhaseDeps,
  label: string = sourceDb.title,
): Promise<void> {
  if (!deps.currentRegistry) return;
  const registry = deps.currentRegistry;

  // Paginate through queryDatabase so views with >100 matching rows still
  // sync completely. Notion's page_size cap is 100 per call.
  // Signature: queryDatabase(id, filter?, sorts?, startCursor?) - positional.
  //
  // If Notion rejects our translated filter (400), fall back to an
  // unfiltered query so the source DB's rows still land. Over-fetching is
  // the safe direction: without this, a single corner case in filter
  // translation hides the whole database.
  const queryWithFilter = async (filter: typeof apiFilter) => {
    let cursor: string | undefined;
    const items: { notionId: string; title: string; lastEditedTime: string }[] = [];
    let pageCount = 0;
    const MAX_PAGES = 50; // safety cap: 5000 rows max per linked view
    do {
      const response = await deps.notionClient.queryDatabase(
        sourceDb.notionId,
        filter,
        undefined,
        cursor,
      );
      const results = (response as { results?: NotionPage[] }).results ?? [];
      for (const page of results) {
        const titleProp = Object.values(
          (page.properties ?? {}) as Record<
            string,
            { type: string; title?: { plain_text?: string }[] }
          >,
        ).find((p) => p.type === 'title');
        const title = titleProp?.title?.[0]?.plain_text ?? 'Untitled';
        items.push({
          notionId: page.id,
          title,
          lastEditedTime: (page as { last_edited_time?: string }).last_edited_time ?? '',
        });
      }
      cursor = (response as { next_cursor?: string }).next_cursor ?? undefined;
      pageCount++;
    } while (cursor && pageCount < MAX_PAGES);
    return items;
  };

  let allItems: { notionId: string; title: string; lastEditedTime: string }[];
  try {
    allItems = await queryWithFilter(apiFilter);
  } catch (filterErr) {
    const status = (filterErr as { statusCode?: number }).statusCode;
    if (apiFilter && status === 400) {
      log.warn(
        `Filter translation produced an invalid query for "${label}" (Notion 400). Retrying without filter - Bases will filter at render time.`,
      );
      allItems = await queryWithFilter(undefined);
    } else {
      throw filterErr;
    }
  }

  let newRows = 0;
  for (const item of allItems) {
    if (registry.get(item.notionId)) continue; // dedup against mention path / other linked views
    const itemEntry = registry.registerDatabaseItem(
      item.notionId,
      item.title,
      sourceDb.notionId,
      sourceDb.vaultPath,
    );
    itemEntry.lastEditedTime = item.lastEditedTime;
    // Inline-sync each new row so it appears on this pass. Failures on a
    // single row don't abort the rest - log + continue.
    try {
      await syncPage(itemEntry, settings, deps);
      newRows++;
    } catch (rowErr) {
      log.warn(`Inline-sync of row "${item.title}" failed: ${getErrorMessage(rowErr)}`);
    }
  }
  log.info(
    `"${label}" inline-pulled ${allItems.length} row(s)${apiFilter ? ' (filtered)' : ''} - ${newRows} new`,
  );
}

/**
 * Apply a resolved BlockIdentity to the page registry so subsequent
 * rendering can produce a valid wikilink target. No-op when the entry
 * already exists - preserves any discovery-time info that may be richer
 * (e.g. data_source_id, viewType) than what the resolver captured.
 *
 * Inline databases and linked-view source DBs both route through the
 * shared registrar so canonical metadata (viewType, visiblePropertyIds,
 * coverImage, views[]) is populated via the OFFICIAL Views API. This
 * is the same code path as registry-builder's BFS - single source of
 * truth, no drift between discovery-time and apply-time registration.
 */
async function applyIdentityToRegistry(
  identity: BlockIdentity,
  registry: PageRegistry,
  settings: SyncConfig,
  deps: ApplyPhaseDeps,
): Promise<void> {
  if (registry.get(identity.blockId)) return;

  const registrarDeps = {
    notionClient: deps.notionClient,
    syncFolder: settings.syncFolder,
  };

  if (identity.kind === 'inline-database' && identity.databaseId) {
    // Inline database: the block IS the database. ensureDatabaseRegistered
    // populates canonical metadata (dataSourceId, viewType, views[]).
    const wasNewlyRegistered = !registry.get(identity.databaseId);
    const dbEntry = await ensureDatabaseRegistered(
      registry,
      identity.databaseId,
      identity.databaseTitle ?? 'Untitled Database',
      registrarDeps,
    );
    // Same inline syncDatabase the linked-view leg runs: the orchestrator's
    // apply iteration captured its entry slice before this code runs, so
    // without this the database never gets a sync record or folder - the
    // rows landed as orphan-looking notes under a folder no `database`
    // record owned, and the dashboard reported "0 databases".
    if (wasNewlyRegistered && !deps.syncState.getByNotionId(dbEntry.notionId)) {
      const dbErrors: string[] = [];
      await syncDatabase(dbEntry, settings, dbErrors, deps);
      if (dbErrors.length > 0) {
        log.warn(
          `Inline syncDatabase for "${dbEntry.title}" reported errors: ${dbErrors.join('; ')}`,
        );
      }
    }
    // WYSIWYG: an inline database on the page IS visible to the user
    // (with all its rows), so sync all rows. linkedViewFullDatabase has no
    // bearing here - it's an override for filtered linked-view behaviour.
    await pullDatabaseRows(dbEntry, undefined, settings, deps).catch((err) => {
      log.warn(
        `Inline row-pull for inline database "${dbEntry.title}" failed: ${getErrorMessage(err)}`,
      );
    });
    return;
  }

  if (identity.kind === 'linked-view' && identity.databaseId) {
    // Linked view: ensure the source database is registered + populated,
    // then register the view as a linked-view entry under _views/.
    const sourceDb = await ensureDatabaseRegistered(
      registry,
      identity.databaseId,
      identity.databaseTitle ?? 'Untitled Database',
      registrarDeps,
    );
    const viewsFolder = `${sourceDb.vaultPath}/_views`;
    registry.register({
      notionId: identity.blockId,
      title: identity.viewTitle ?? identity.viewType ?? 'View',
      type: 'linked-view',
      fileName: identity.stableName,
      vaultPath: `${viewsFolder}/${identity.stableName}`,
      folder: viewsFolder,
    });
    return;
  }

  // Unresolved: leave registry alone - renderer falls back to the
  // Phase 1 stable `Untitled Database (<id>)` embed.
}

/**
 * Render a page to markdown via the default builder.
 *
 * Exported so the conflict resolution path in sync-entry.ts can rebuild markdown
 * after downloading media (to replace expired S3 URLs with local paths).
 */
export function renderWithTemplate(
  doc: N2ODocument,
  entry: PageRegistryEntry,
  deps: ApplyPhaseDeps,
): string {
  // Breadcrumb blocks render their ancestor chain, which only the pipeline
  // can resolve (registry + sync records). Stamp it before the build so the
  // output carries the chain. Idempotent - recomputes from scratch on every
  // render.
  enrichBreadcrumbBlocks(doc, deps.currentRegistry, deps.syncState);
  // Resolve any synced-block REFERENCE on this page to the page its original
  // lives on, so the renderer emits `![[Page#^id]]` (#1719). Unresolved refs
  // (original not indexed yet) fall back to the current-file form.
  enrichSyncedReferences(doc, deps.syncState, deps.currentRegistry);

  deps.builder.resetAnchoredSyncedOriginals?.();
  const markdown = deps.builder.build(doc);

  // Index the synced-block ORIGINALS the renderer ACTUALLY anchored on this page
  // (#1719), so a reference elsewhere can resolve its target. Keyed on real
  // render output, not the doc: a page that merely references a synced block
  // carries a phantom nested copy of the original that never gets anchored, so
  // it must not misattribute the original (the Atlas hub overwrote Global Footer
  // when this indexed the doc instead). Attribute to the doc's own page id.
  const pageId = doc.notionId ?? entry.notionId;
  if (deps.syncState && pageId) {
    for (const id of deps.builder.getAnchoredSyncedOriginals?.() ?? []) {
      deps.syncState.recordSyncedBlockLocation(id, pageId);
    }
  }
  return markdown;
}

/**
 * Sync a single page (standalone or database item) to the vault.
 * Accepts optional pre-fetched data to avoid double API fetch on conflict resolution.
 */
export async function syncPage(
  entry: PageRegistryEntry,
  settings: SyncConfig,
  deps: ApplyPhaseDeps,
  prefetched?: {
    page: NotionPage;
    blocks: NotionBlock[];
    doc: N2ODocument;
    markdown: string;
  },
  options?: { detectTitleRename?: boolean },
): Promise<{ contentChanged: boolean; skippedReason?: 'page-limit' }> {
  /* ── The Lite page budget (#1918) ──
   * Enforced HERE because syncPage is the one chokepoint every written page
   * passes through, including syncSinglePage, which bypasses syncOneEntry
   * entirely. Enforcing it in the caller would leave that path uncapped.
   *
   * Before the fetch on purpose: a refused page costs no Notion request.
   *
   * EVERY note is charged, database rows included: a row is a page in Notion's
   * model and becomes a note in the vault just like a standalone page. Only
   * containers are exempt - a database is a folder and a linked view is registry
   * bookkeeping, and neither writes a note. A page that already has a sync
   * record is grandfathered and always allowed. */
  if (deps.pageBudget && (entry.type === 'page' || entry.type === 'database-item')) {
    const alreadyTracked = deps.syncState.getByNotionId(entry.notionId) !== null;
    if (!deps.pageBudget.claim(entry.notionId, alreadyTracked)) {
      log.info(
        `Page budget reached (${LITE_PAGE_LIMIT}); skipping new page "${entry.title}". Pages already synced keep syncing.`,
      );
      return { contentChanged: false, skippedReason: 'page-limit' };
    }
  }

  log.info(`Syncing page: "${entry.title}" -> ${entry.vaultPath}`);

  /* F-027: all pages (standalone + database items) share one
   * `_files/` folder at the sync-folder root, regardless of how
   * deeply nested the markdown file itself is. Obsidian's unique-
   * filename link resolver handles `![[name-hash.ext]]` across the
   * whole vault. */

  // 1. Fetch page + blocks from Notion (or use pre-fetched data)
  let doc: N2ODocument;
  let markdown: string;
  let failedMediaIds: FailedMediaItem[] = [];
  let notionPage: NotionPage | undefined;
  // Raw Notion block tree, unified across the prefetched and fetch paths, so the
  // record can store a structural content hash (stored-format parity, #1746).
  let notionRawBlocks: unknown[] = [];

  if (prefetched) {
    doc = prefetched.doc;
    notionPage = prefetched.page;
    notionRawBlocks = prefetched.blocks ?? [];
    // Resolve child_database identities against the live registry so the
    // renderer produces correct `.base` embeds for inline databases and
    // linked views. Runs against the raw Notion blocks we have in scope.
    await enrichChildDatabaseIdentities(prefetched.blocks, entry, settings, deps);
    // Use canonical parentDatabaseId from registry (data_source ID from tree picker).
    // Parser may extract a different database_id UUID from the API response.
    if (entry.parentDatabaseId) {
      doc.metadata.parentDatabaseId = entry.parentDatabaseId;
    }
    // Ensure parentId/parentType reflect the resolved parent (registry overrides API response)
    const resolvedParent = entry.parentDatabaseId ?? extractParentId(notionPage?.parent);
    if (resolvedParent) {
      doc.metadata.parentId = resolvedParent;
      doc.metadata.parentType = entry.parentDatabaseId
        ? 'database'
        : extractParentContainerType(notionPage?.parent);
    }
    // Download media even for prefetched data - blocks still have external URLs.
    // F-027: one shared _files/ folder at sync-folder root, not per-page.
    {
      const attachmentFolder = getSharedAttachmentFolder(settings.syncFolder);
      failedMediaIds = await downloadMediaForDoc(
        doc,
        attachmentFolder,
        deps.mediaHandler,
        settings.downloadMedia,
      );
    }
    // Rebuild markdown with local media paths (prefetched markdown has external URLs)
    markdown = renderWithTemplate(doc, entry, deps);
    if (settings.generateThumbnails) {
      markdown = await resolveCoverThumbnail(markdown, deps.mediaDownloader);
    }
  } else {
    // Pass discoveryBlockCache so block trees populated by the discovery
    // phase are served from cache instead of round-tripping the API again.
    const { page: fetchedPage, blocks } = await deps.notionClient.fetchPageWithBlocks(
      entry.notionId,
      deps.discoveryBlockCache ?? undefined,
      deps.discoveryPageCache ?? undefined,
    );
    notionRawBlocks = blocks ?? [];

    notionPage = fetchedPage;
    // Cache blocks so later single-page syncs can skip the Notion fetch
    const lastEdited = fetchedPage.last_edited_time;
    if (lastEdited) {
      deps.blockCache?.set(entry.notionId, blocks, lastEdited);
    }
    // Resolve child_database identities against the live registry so the
    // renderer has `.base` target entries for inline databases and linked
    // views. Must run BEFORE renderWithTemplate so the builder sees them.
    await enrichChildDatabaseIdentities(blocks, entry, settings, deps);
    doc = deps.parser.parsePage(fetchedPage, blocks);
    // Use canonical parentDatabaseId from registry (data_source ID from tree picker).
    // Parser may extract a different database_id UUID from the API response.
    if (entry.parentDatabaseId) {
      doc.metadata.parentDatabaseId = entry.parentDatabaseId;
    }
    // Ensure parentId/parentType reflect the resolved parent (registry overrides API response)
    const resolvedParent = entry.parentDatabaseId ?? extractParentId(fetchedPage.parent);
    if (resolvedParent) {
      doc.metadata.parentId = resolvedParent;
      doc.metadata.parentType = entry.parentDatabaseId
        ? 'database'
        : extractParentContainerType(fetchedPage.parent);
    }
    log.debug(`Parsed: "${doc.title}" with ${doc.blocks.length} blocks`);

    // 3. Download media (F-027: one shared _files/ folder at sync-folder root).
    {
      const attachmentFolder = getSharedAttachmentFolder(settings.syncFolder);
      failedMediaIds = await downloadMediaForDoc(
        doc,
        attachmentFolder,
        deps.mediaHandler,
        settings.downloadMedia,
      );
    }

    if (doc.blocks.length > LARGE_DOCUMENT_BLOCK_THRESHOLD) {
      log.warn(`Large page: "${entry.title}" has ${doc.blocks.length} blocks - sync may be slow`);
    }

    markdown = renderWithTemplate(doc, entry, deps);
    if (settings.generateThumbnails) {
      markdown = await resolveCoverThumbnail(markdown, deps.mediaDownloader);
    }
  }

  // 4a. Update entry path if Notion title changed (fast-poll / single-page sync only)
  // Skipped during full sync - the registry builder already assigns correct unique names.
  if (options?.detectTitleRename) {
    // Same derivation as PageRegistry.uniqueFileName (sanitize + path-budget
    // clamp, #1759) - a divergent name here would rename clamped files back
    // over the Windows path limit on every fast-poll.
    const newFileName = fitFileNameToBudget(
      sanitizeFileName(doc.title || 'Untitled'),
      entry.folder.length,
      vaultRelativePathBudget(deps.vaultAdapter.getVaultBasePath().length),
    );
    if (newFileName !== entry.fileName) {
      const newVaultPath = `${entry.folder}/${newFileName}.md`;
      log.info(`Title changed: "${entry.fileName}" -> "${newFileName}"`);
      entry.title = doc.title;
      entry.fileName = newFileName;
      entry.vaultPath = newVaultPath;
    }
  }

  // 4b. Overwrite protection
  // BUG FIX: Only trigger when sync record shows NO Notion edit since last sync
  const preExisting = deps.syncState.getByNotionId(entry.notionId);
  if (preExisting && deps.vaultAdapter.fileExists(entry.vaultPath)) {
    const notionTimestampUnchanged = preExisting.notionLastEdited === entry.lastEditedTime;
    if (notionTimestampUnchanged) {
      const localContent = await deps.vaultAdapter.readFile(entry.vaultPath);
      if (localContent !== null) {
        const localLines = localContent.split('\n').length;
        const incomingLines = markdown.split('\n').length;
        if (localLines > incomingLines + 10 && incomingLines < 20) {
          log.warn(
            `Overwrite protection: "${entry.title}" - local has ${localLines} lines, Notion has ${incomingLines}. Skipping write.`,
          );
          throw new N2OError(
            `Skipped - local file has more content (${localLines} lines) than Notion (${incomingLines} lines). Edit the page in Notion to re-sync.`,
            'OVERWRITE_PROTECTION',
          );
        }
      }
    }
  }

  // 4c. Large file warning
  if (markdown.length > 1_000_000) {
    const msg = `Large file: "${entry.title}" is ${(markdown.length / 1_000_000).toFixed(1)}MB - may impact editor performance`;
    log.warn(msg);
    deps.currentWarnings.push(msg);
  }

  // 5. Resolve existing file, rename if needed, then write
  const existingRecord = deps.syncState.getByNotionId(entry.notionId);
  const finalPath = entry.vaultPath;

  // 5a. Find the actual file on disk via frontmatter (survives renames/DB wipes)
  if (existingRecord) {
    const folder = entry.vaultPath.substring(0, entry.vaultPath.lastIndexOf('/'));
    const resolvedPath = deps.vaultAdapter.resolveFileByNotionId(
      entry.notionId,
      existingRecord.obsidianPath,
      folder || settings.syncFolder,
    );

    if (resolvedPath && resolvedPath !== finalPath) {
      // File exists at a different path - rename it to the new title-derived path
      try {
        await deps.vaultAdapter.moveFile(resolvedPath, finalPath);
        log.info(`Renamed "${resolvedPath}" -> "${finalPath}" (Notion title changed)`);
      } catch {
        log.warn(`Could not rename "${resolvedPath}" to "${finalPath}" - writing to new path`);
      }
    }
  }

  // 5b. Empty remote page guard - prevent overwriting substantial local content
  // with an empty Notion page (all blocks deleted remotely). Only applies to
  // existing files (new pages are always written, even if empty).
  const existingContent = await deps.vaultAdapter.readFile(finalPath);
  // Carry the user's Obsidian-local frontmatter (aliases, cssclasses, local
  // cover) across the pull. Without this the rebuilt-from-Notion file silently
  // drops keys the user added in Obsidian (#1508).
  if (existingContent !== null) {
    markdown = preserveLocalFrontmatter(existingContent, markdown);
  }
  if (existingContent !== null && doc.blocks.length === 0) {
    // Strip frontmatter to measure actual body content
    const bodyContent = existingContent.replace(/^---[\s\S]*?---\s*/, '').trim();
    if (bodyContent.length > 0) {
      log.warn(
        `Empty remote page guard: "${entry.title}" has 0 Notion blocks but local file has ${bodyContent.length} chars of body content - skipping overwrite`,
      );
      deps.notify(
        `N2O: "${entry.title}" is empty in Notion but has local content - skipping overwrite to prevent data loss. Edit the page in Notion to re-sync.`,
        12000,
      );
      return { contentChanged: false };
    }
  }

  // 5c. Write content to the target path (skip if unchanged - Notion blocks may be stale)
  const contentChanged = existingContent === null || existingContent !== markdown;
  let diskContent = markdown;
  if (contentChanged) {
    try {
      await deps.vaultAdapter.writeFile(finalPath, markdown);
      // Re-read to get actual disk content (Obsidian may normalize line endings)
      const reread = await deps.vaultAdapter.readFile(finalPath);
      if (reread !== null) diskContent = reread;
      log.info(`Wrote ${finalPath} (${markdown.length} chars)`);
    } catch (writeErr) {
      log.error(`Failed to write "${finalPath}": ${getErrorMessage(writeErr)}`);
      deps.notify(`N2O: Failed to write "${entry.title}" - check disk space/permissions`, 10000);
      throw writeErr;
    }
  } else {
    log.info(`Skipped write for ${finalPath} - content unchanged (Notion blocks may be stale)`);
  }

  // 5d. Safety cleanup: delete stale file at old sync-state path if it still exists
  if (existingRecord && existingRecord.obsidianPath !== finalPath) {
    if (deps.vaultAdapter.fileExists(existingRecord.obsidianPath)) {
      try {
        await deps.vaultAdapter.deleteFile(existingRecord.obsidianPath);
        log.info(
          `Cleaned up old file "${existingRecord.obsidianPath}" (page renamed to "${finalPath}")`,
        );
      } catch {
        log.warn(`Could not clean up old file: ${existingRecord.obsidianPath}`);
      }
    }
  }

  // 6. Update sync state
  // Resolve parent ID: prefer registry entry (canonical for database items),
  // fall back to Notion API page response (covers page_id parents for standalone pages)
  const resolvedParentId = entry.parentDatabaseId ?? extractParentId(notionPage?.parent);
  const now = new Date().toISOString();
  const existing = existingRecord;
  /* F-004 root-cause: entry.notionId arrives from upstream in dashed-UUID
   * form (Notion API, registry, command dispatcher). syncStateDB normalizes
   * it to the stripped form before persisting, which means any record
   * fetched back via getByNotionId returns id=`n2o-<stripped>`. If we
   * built record.id from the raw dashed form here, baseVersions.set() would
   * key the file as `n2o-<dashed>.md`, and sync-entry's later
   * baseVersions.get(existing.id) would look up `n2o-<stripped>.md` and
   * miss - causing the three-way-merge path to fall through to pull-
   * overwrite without creating a .conflict-*.md backup. Normalize here so
   * the set/get keys agree. */
  const record: SyncRecord = {
    id: existing?.id ?? `n2o-${normalizeNotionId(entry.notionId)}`,
    notionId: entry.notionId,
    obsidianPath: finalPath,
    itemType: entry.type === 'database-item' ? 'database-item' : 'page',
    notionParentId: resolvedParentId,
    notionLastEdited: entry.lastEditedTime ?? doc.metadata.lastEditedTime,
    obsidianLastModified: Date.now(),
    notionContentHash: hashContentForChange(markdown),
    // Structural hash of the raw Notion blocks (stored-format parity, #1746).
    notionBlockHash: hashNotionBlocks(notionRawBlocks),
    // Hash of actual disk content (may differ from notionContentHash if Obsidian
    // normalizes line endings). Ensures change detector matches what's really on disk.
    obsidianContentHash: hashContentForChange(diskContent),
    status: 'synced',
    syncDirection: getSyncRecordDirection(),
    lastSyncTime: now,
    attachments: [],
    failedMedia:
      failedMediaIds.length > 0
        ? mergeFailedMedia(existing?.failedMedia, failedMediaIds)
        : undefined,
    // Which renderer build produced this markdown - the pull gate re-renders
    // when a newer build would produce different output (#1628). Stamped even
    // when the write was skipped as unchanged, so an up-to-date note is not
    // re-fetched again next sync.
    rendererVersion: RENDERER_VERSION,
  };
  if (failedMediaIds.length > 0) {
    const merged = record.failedMedia ?? [];
    const exhausted = merged.filter((m) => (m.retryCount ?? 0) >= MAX_MEDIA_RETRIES).length;
    /* Items that JUST crossed the retry cap on this sync. Comparing the
     * previous record's exhausted count to the new one tells us whether
     * to fire a user-visible Notice - otherwise we'd notify every sync
     * a stuck item is still around, which is noise. */
    const previouslyExhausted = (existing?.failedMedia ?? []).filter(
      (m) => (m.retryCount ?? 0) >= MAX_MEDIA_RETRIES,
    ).length;
    const newlyExhausted = exhausted - previouslyExhausted;

    if (exhausted > 0) {
      log.warn(
        `${failedMediaIds.length} media downloads failed for "${entry.title}" - ` +
          `${exhausted} at retry cap, ${merged.length - exhausted} will retry on next sync`,
      );
      if (newlyExhausted > 0) {
        deps.notify(
          `N2O: ${newlyExhausted} media file${newlyExhausted === 1 ? '' : 's'} in "${entry.title}" ` +
            `gave up after ${MAX_MEDIA_RETRIES} retries. Open the page and use the Retry button to try again manually.`,
          12000,
        );
      }
    } else {
      log.warn(
        `${failedMediaIds.length} media downloads failed for "${entry.title}" - will retry on next sync`,
      );
    }
  }
  // Durable upsert: vault was just written above; flush sync_records to disk
  // before returning so a crash here doesn't leave vault new + DB old.
  await deps.syncState.upsertRecordDurable(record);

  return { contentChanged };
}
