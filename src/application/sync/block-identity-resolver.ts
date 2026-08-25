/**
 * BlockIdentityResolver - classifies a `child_database` block into
 * one of: inline-database, linked-view, or unresolved.
 *
 * Runs during sync-page's pre-parse pass so the renderer can produce
 * a correct `.base` embed without depending on discovery having covered
 * the block. See:
 *
 * Probe chain (first success wins):
 *   1. Cache (BlockIdentityStore) - within TTL, skip all API calls
 *   2. Official /v1/databases/{blockId} - 200 means inline database
 *   3. Official /v1/views/{blockId} - 200 means linked view (modern API)
 *   4. Reverse lookup via the official Views API - matches the block UUID
 *      against each data source's views' parent.database_id
 *   5. Fallback - classify as 'unresolved', use id-prefix stable name
 *
 * Every classification is persisted to `block_identity`. Later pulls
 * skip the probe chain entirely for blocks already cached.
 *
 * @module
 */

import { isLinkedViewStub } from '../../domain/services/data-source-shape';
import type { NotionClient } from '../../infrastructure/notion/client';
import type {
  BlockIdentityStore,
  BlockIdentity,
} from '../../infrastructure/storage/block-identity-store';
import { getDatabaseTitle } from '../../domain/services/notion-entity-ops';
import { NotionApiError, getErrorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/logger';
import { sanitizeFileName } from '../../shared/sanitize';

const log = createLogger('BlockIdentityResolver');

/** Dependencies for resolving block identity. */
export interface ResolverDeps {
  notionClient: NotionClient;
  blockIdentityStore: BlockIdentityStore;
}

/** Per-page context carried through a single resolution cycle. */
export interface ResolverContext {
  /** Notion ID of the page hosting the block being resolved. */
  parentPageId: string;
  /** Title of the parent page (used in stable names for linked views). */
  parentPageTitle: string;
}

/** Normalize a Notion UUID to its dashless form (consistent Map keying). */
function normalize(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

/** Treat 400/404 as "probe says this isn't what we tried to look up". */
function isProbeMiss(err: unknown): boolean {
  return err instanceof NotionApiError && (err.statusCode === 400 || err.statusCode === 404);
}

/**
 * Brute-force find the data source + view metadata for a linked-view
 * block UUID. Iterates workspace data sources (search), lists each one's
 * views, then getView each, returning the first view whose
 * `parent.database_id` matches the target block UUID.
 *
 * Used when the official `getView(blockId)` probe fails because the
 * block UUID is NOT a view id (typical for child_database stubs that
 * Notion creates for linked views).
 *
 * Returns null when no view matches. Caller falls through to the next
 * probe.
 */
async function reverseLookupView(
  blockId: string,
  client: Pick<NotionClient, 'search' | 'listViewsForDataSource' | 'getView'>,
): Promise<{
  sourceDataSourceId: string;
  viewType: string | null;
  viewTitle: string | null;
} | null> {
  const normalizedBlock = normalize(blockId);
  const resp = (await client.search(undefined, { property: 'object', value: 'data_source' })) as {
    results: { id: string }[];
  };

  for (const ds of resp.results) {
    let stubs: { object: string; id: string }[];
    try {
      stubs = await client.listViewsForDataSource(ds.id);
    } catch {
      continue;
    }
    for (const stub of stubs) {
      let view: import('../../domain/models/notion-api-types').NotionViewDetail;
      try {
        view = await client.getView(stub.id);
      } catch {
        continue;
      }
      const parentBlockId = view.parent?.database_id;
      if (!parentBlockId) continue;
      if (normalize(parentBlockId) !== normalizedBlock) continue;
      return {
        sourceDataSourceId: ds.id,
        viewType: view.type ?? null,
        viewTitle: view.name ?? null,
      };
    }
  }
  return null;
}

/**
 * Deterministic filename for the `.base` embed.
 *
 * Inline databases use their title.
 * Linked views use "<ViewType> - <ParentPageTitle> (<idPrefix>)" - matches
 *   the convention already used by the full-discovery path for linked
 *   view `.base` files under each database's `_views/` folder.
 * Unresolved blocks use "Untitled Database (<idPrefix>)".
 *
 * All names go through sanitizeFileName so they're guaranteed to be
 * valid Obsidian filenames on Windows/macOS/Linux.
 */
function computeStableName(params: {
  kind: BlockIdentity['kind'];
  blockId: string;
  databaseTitle?: string | null;
  viewType?: string | null;
  parentPageTitle?: string | null;
}): string {
  const idPrefix = normalize(params.blockId).substring(0, 8);
  if (params.kind === 'inline-database') {
    const title = params.databaseTitle || 'Untitled Database';
    return sanitizeFileName(title);
  }
  if (params.kind === 'linked-view') {
    const viewTypeLabel = params.viewType
      ? params.viewType.charAt(0).toUpperCase() + params.viewType.slice(1)
      : 'View';
    const parentTitle = params.parentPageTitle || 'Untitled';
    return sanitizeFileName(`${viewTypeLabel} - ${parentTitle} (${idPrefix})`);
  }
  return sanitizeFileName(`Untitled Database (${idPrefix})`);
}

/**
 * Resolve a single block's identity. Persists the result and returns
 * the classification. Never throws - all probe failures degrade to
 * the 'unresolved' classification with a stable fallback name.
 */
export async function resolveBlockIdentity(
  blockId: string,
  ctx: ResolverContext,
  deps: ResolverDeps,
): Promise<BlockIdentity> {
  const normalizedId = normalize(blockId);
  const now = Date.now();

  // 1. Cache hit
  const cached = deps.blockIdentityStore.getFresh(normalizedId, now);
  if (cached) {
    log.debug(`Cache hit for ${normalizedId.substring(0, 8)}... (${cached.kind})`);
    return cached;
  }

  // 2. Official getDatabase probe - inline database vs linked-view stub
  //
  // Two shapes to detect:
  //   - 200 + non-empty data_sources           -> real inline database
  //   - 200 + data_sources: []                  -> linked-view stub (new
  //     Notion 2025-09-03 surface). Real DBs always own >=1 data source;
  //     an empty array means the entity is a linked view of one. Earlier
  //     versions misclassified this as an inline DB, gave it a fake stable
  //     name, and the renderer emitted a wikilink to a file the bases
  //     generator never produced.
  //   - 404 / 400 (NotionApiError isProbeMiss)  -> linked view (legacy)
  //     The getView probe below handles both linked-view shapes.
  try {
    const db = await deps.notionClient.getDatabase(blockId);
    if (!isLinkedViewStub(db)) {
      const dbTitle = getDatabaseTitle(db);
      const identity: BlockIdentity = {
        blockId: normalizedId,
        kind: 'inline-database',
        databaseId: normalizedId,
        databaseTitle: dbTitle,
        viewType: null,
        viewTitle: null,
        parentPageId: normalize(ctx.parentPageId),
        parentPageTitle: ctx.parentPageTitle,
        stableName: computeStableName({
          kind: 'inline-database',
          blockId: normalizedId,
          databaseTitle: dbTitle,
        }),
        resolvedAt: now,
        source: 'official-api',
      };
      deps.blockIdentityStore.upsert(identity);
      log.info(`Resolved ${normalizedId.substring(0, 8)}... as inline-database "${dbTitle}"`);
      return identity;
    }
    log.debug(
      `Block ${normalizedId.substring(0, 8)}... has data_sources=[] - falling through to getView probe (likely linked-view stub)`,
    );
  } catch (err) {
    if (!isProbeMiss(err)) {
      log.warn(
        `getDatabase probe failed for ${normalizedId.substring(0, 8)}... (non-404/400): ${getErrorMessage(err)}`,
      );
      // Non-probe error (auth, rate limit, network) - fall through to other probes
    }
  }

  // 3. Official getView probe - modern linked view
  try {
    const view = await deps.notionClient.getView(blockId);
    const sourceDbId = view.parent?.database_id ? normalize(view.parent.database_id) : null;
    let sourceDbTitle: string | null = null;
    if (sourceDbId) {
      try {
        const db = await deps.notionClient.getDatabase(sourceDbId);
        sourceDbTitle = getDatabaseTitle(db);
      } catch (dbErr) {
        log.debug(
          `Could not fetch source DB title for ${sourceDbId.substring(0, 8)}...: ${getErrorMessage(dbErr)}`,
        );
      }
    }
    const viewType = view.type ?? null;
    const viewTitle = view.name ?? null;
    const identity: BlockIdentity = {
      blockId: normalizedId,
      kind: 'linked-view',
      databaseId: sourceDbId,
      databaseTitle: sourceDbTitle,
      viewType,
      viewTitle,
      parentPageId: normalize(ctx.parentPageId),
      parentPageTitle: ctx.parentPageTitle,
      stableName: computeStableName({
        kind: 'linked-view',
        blockId: normalizedId,
        viewType,
        parentPageTitle: ctx.parentPageTitle,
      }),
      resolvedAt: now,
      source: 'views-api',
    };
    deps.blockIdentityStore.upsert(identity);
    log.info(
      `Resolved ${normalizedId.substring(0, 8)}... as linked-view "${viewTitle ?? viewType}" of "${sourceDbTitle ?? sourceDbId?.substring(0, 8)}..."`,
    );
    return identity;
  } catch (err) {
    if (!isProbeMiss(err)) {
      log.debug(
        `getView probe failed for ${normalizedId.substring(0, 8)}...: ${getErrorMessage(err)}`,
      );
    }
  }

  // 4. Reverse lookup via official Views API. List all data sources in
  //    the workspace, list each one's views, and find the view whose
  //    parent.database_id matches our block UUID. That view's source DB
  //    IS the linked-view's target. Slow (N data_sources * M views) but
  //    runs once per block, then result is cached. Needed because
  //    getView(blockId) only works when blockId IS a view id, which it
  //    usually isn't.
  try {
    const matched = await reverseLookupView(blockId, deps.notionClient);
    if (matched) {
      let sourceDbTitle: string | null = null;
      try {
        const db = await deps.notionClient.getDatabase(matched.sourceDataSourceId);
        sourceDbTitle = getDatabaseTitle(db);
      } catch (dbErr) {
        log.debug(
          `Could not fetch source DB title for ${matched.sourceDataSourceId.substring(0, 8)}...: ${getErrorMessage(dbErr)}`,
        );
      }
      const identity: BlockIdentity = {
        blockId: normalizedId,
        kind: 'linked-view',
        databaseId: normalize(matched.sourceDataSourceId),
        databaseTitle: sourceDbTitle,
        viewType: matched.viewType,
        viewTitle: matched.viewTitle,
        parentPageId: normalize(ctx.parentPageId),
        parentPageTitle: ctx.parentPageTitle,
        stableName: computeStableName({
          kind: 'linked-view',
          blockId: normalizedId,
          viewType: matched.viewType,
          parentPageTitle: ctx.parentPageTitle,
        }),
        resolvedAt: now,
        source: 'views-api',
      };
      deps.blockIdentityStore.upsert(identity);
      log.info(
        `Resolved ${normalizedId.substring(0, 8)}... as linked-view via reverse-lookup -> "${sourceDbTitle ?? matched.sourceDataSourceId.substring(0, 8)}..."`,
      );
      return identity;
    }
  } catch (err) {
    log.debug(
      `Reverse-lookup failed for ${normalizedId.substring(0, 8)}...: ${getErrorMessage(err)}`,
    );
  }

  // 5. Fallback - unresolved, but with a stable name so the renderer
  //    still has something valid to emit.
  //
  // Do NOT persist this identity. Why: if the FIRST sync hits a transient
  // failure (slow network, rate limit), we'd cache 'unresolved' for 7
  // days. Every subsequent sync would cache-hit on the poisoned entry and
  // never re-probe - even after pass-2 BFS successfully resolves the
  // linked view in the page-registry. The renderer would then keep
  // emitting the dead "Untitled Database (xxxxxxxx).base" fallback forever.
  //
  // By returning the fallback identity *without* upserting, the next
  // call retries all four probes. Successful resolutions still cache
  // (probes 2/3/4 above each call upsert on success), so this only
  // affects the negative-cache path.
  const identity: BlockIdentity = {
    blockId: normalizedId,
    kind: 'unresolved',
    databaseId: null,
    databaseTitle: null,
    viewType: null,
    viewTitle: null,
    parentPageId: normalize(ctx.parentPageId),
    parentPageTitle: ctx.parentPageTitle,
    stableName: computeStableName({ kind: 'unresolved', blockId: normalizedId }),
    resolvedAt: now,
    source: 'fallback',
  };
  log.debug(
    `Unresolved ${normalizedId.substring(0, 8)}... \u2192 fallback "${identity.stableName}" (NOT cached - next call will retry)`,
  );
  return identity;
}

/**
 * Resolve identities for every `child_database` block on a page in one
 * pass. Checks the cache for all blocks first, then probes the uncached
 * ones in parallel.
 *
 * @param blockIds normalized (dashless) block UUIDs
 * @returns map blockId -> resolved identity
 */
export async function resolveBlockIdentities(
  blockIds: string[],
  ctx: ResolverContext,
  deps: ResolverDeps,
): Promise<Map<string, BlockIdentity>> {
  const results = new Map<string, BlockIdentity>();
  if (blockIds.length === 0) return results;

  const normalized = blockIds.map(normalize);

  // Fast path: check cache for every block first
  const now = Date.now();
  const uncached: string[] = [];
  for (const id of normalized) {
    const cached = deps.blockIdentityStore.getFresh(id, now);
    if (cached) {
      results.set(id, cached);
    } else {
      uncached.push(id);
    }
  }

  if (uncached.length === 0) return results;

  // Resolve remaining blocks in parallel. Each resolveBlockIdentity call
  // will also re-check the cache (harmless double-check, cheap).
  const resolved = await Promise.all(uncached.map((id) => resolveBlockIdentity(id, ctx, deps)));
  for (const identity of resolved) {
    results.set(identity.blockId, identity);
  }
  return results;
}
