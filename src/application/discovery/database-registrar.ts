/**
 * Database registrar - single source of truth for registering a Notion
 * database into the page registry and populating its canonical metadata.
 *
 * Design rules (enforced by tests/unit/database-registrar.test.ts):
 *
 *   1. Completeness - every entry returned has dataSourceId, viewType,
 *      visiblePropertyIds, and views[] populated. The official Views API
 *      is the source of truth.
 *
 *   2. Idempotence - calling twice for the same id is a no-op write
 *      (skips the API calls when the entry is already populated).
 *
 * Replaces the dual-path registration in registry-builder.ts (BFS/Views
 * API) and sync-page.ts (BlockIdentityResolver) - both routed through
 * here so the metadata never drifts.
 */

import type { NotionClient } from '../../infrastructure/notion/client';
import type { PageRegistry } from './page-registry';
import type { PageRegistryEntry } from '../../domain/models/page-registry';
import type { NotionApiError } from '../../shared/errors';
import { getErrorMessage } from '../../shared/errors';
import { mapNotionViewType } from '../content/notion-view-type';
import { extractLinkedViewFilters } from '../content/linked-view-filters';
import {
  asBlockUuid,
  asDataSourceId,
  normalizeNotionId,
  type BlockUuid,
  type DataSourceId,
} from '../../domain/models/notion-id';
import { extractDataSourceIds, isLinkedViewStub } from '../../domain/services/data-source-shape';
import { createLogger } from '../../shared/logger';
import { deriveCoverImage, deriveViewName } from './registry-builder-helpers';

const log = createLogger('DatabaseRegistrar');

/**
 * Dependencies the registrar needs.
 */
export interface RegistrarDeps {
  notionClient: Pick<
    NotionClient,
    'getDatabase' | 'listViewsForDataSource' | 'getView' | 'queryDatabase' | 'search'
  >;
  syncFolder: string;
  /**
   * Optional persisted sync-state lookup. When provided, `resolveDataSourceId`
   * checks the SyncRecord for a previously-resolved data_source_id and the
   * meta key-value store (cached brute-force result from prior sessions)
   * before making any API calls. Loose type so tests and SyncStateDB both
   * satisfy.
   */
  syncState?: {
    getByNotionId: (notionId: string) => { dataSourceId?: string } | null;
    getMeta?: (key: string) => string | null | undefined;
    setMeta?: (key: string, value: string) => void;
  };
}

/**
 * Brute-force resolve a Notion block UUID to its data_source_id by
 * iterating data_source search results and matching view.parent. Used
 * as a self-sufficient fallback when the caller doesn't provide a
 * resolver (sync-page apply phase). Same algorithm as RegistryBuilder's
 * private `resolveDataSourceId` but inlined so the registrar isn't
 * coupled to it.
 */
async function searchForDataSource(
  blockId: string,
  client: RegistrarDeps['notionClient'],
): Promise<string | undefined> {
  const normalizedBlock = normalizeNotionId(blockId);
  try {
    const resp = (await client.search(undefined, { property: 'object', value: 'data_source' })) as {
      results: { id: string }[];
    };
    for (const ds of resp.results) {
      try {
        const stubs = await client.listViewsForDataSource(ds.id);
        if (stubs.length === 0) continue;
        for (const stub of stubs) {
          try {
            const view = await client.getView(stub.id);
            if (
              view.parent?.database_id &&
              normalizeNotionId(view.parent.database_id) === normalizedBlock
            ) {
              return normalizeNotionId(ds.id);
            }
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Meta-key prefix for the cross-session brute-force cache. */
const META_KEY_PREFIX = 'ds_id:';

/**
 * Return the ID to send to /v1/data_sources/{id}/query and related
 * data-source endpoints for a given entry.
 *
 * Prefers `entry.dataSourceId` (the canonical 2025-09-03+ value) and
 * falls back to `entry.notionId` (the block UUID) when not set. The
 * fallback is correct for legacy 2022-06-28 databases where block UUID
 * == data_source_id and is the documented behavior, NOT a silent failure.
 *
 * For 2025-09-03+ databases, the fallback is ALSO triggered when an
 * entry was registered without going through `ensureDatabaseRegistered`
 * (e.g. a partially-built entry). That case is logged so the warning
 * is visible when the subsequent API call 400/404s.
 *
 * Centralizes the `entry.dataSourceId ?? entry.notionId` pattern that
 * was scattered across registry-builder and sync-database before this
 * refactor. Each site previously implemented it inline,
 * with no logging - making the failure mode invisible until 400/404.
 *
 * Returns a branded DataSourceId so downstream API calls get the
 * correct nominal type at compile time. Brand-typed even on the
 * fallback path because the legacy block UUID IS a valid data_source_id
 * in that context.
 */
export function getQueryableDataSourceId(entry: {
  dataSourceId?: string;
  notionId: string;
  title?: string;
}): DataSourceId {
  if (entry.dataSourceId) return asDataSourceId(entry.dataSourceId);
  log.debug(
    `getQueryableDataSourceId: no dataSourceId on "${entry.title ?? 'unknown'}" ` +
      `(${entry.notionId.substring(0, 8)}...) - falling back to block UUID. ` +
      `Valid for legacy 2022-06-28 databases; for 2025-09-03+ databases this ` +
      `means the entry was not registered via ensureDatabaseRegistered.`,
  );
  return asDataSourceId(entry.notionId);
}

/**
 * Resolve a Notion block UUID to its data_source_id via 5-tier lookup.
 *
 *   Tier 1: PageRegistry in-memory cache       (within-session reuse)
 *   Tier 2: SyncRecord.dataSourceId            (cross-session, registered DB)
 *   Tier 3: getDatabase API -> data_sources[0] (happy path, 2025-09-03+)
 *   Tier 4: SyncStateDB meta `ds_id:` cache    (cross-session, prior brute-force)
 *   Tier 5: brute-force search                 (legacy 2022-06-28 shape)
 *
 * Returns `undefined` when no resolution succeeds. Callers MUST handle
 * this case explicitly. The function never returns the block UUID as a
 * fallback - the legacy `?? entry.notionId` pattern silently sent block
 * UUIDs to /v1/data_sources/{id}/query and got back 400/404 errors that
 * were misdiagnosed as "linked view not found." Returning undefined
 * forces the caller to log and skip rather than corrupt downstream state.
 *
 * Successful resolutions are written back to the in-memory registry
 * cache (Tier 1) and, when produced by brute-force, persisted to the
 * meta cache (Tier 4) so future sessions skip the 600+ API call slog.
 */
export async function resolveDataSourceId(
  registry: PageRegistry,
  blockUuid: BlockUuid,
  deps: RegistrarDeps,
): Promise<DataSourceId | undefined> {
  const normalized = normalizeNotionId(blockUuid);

  // Tier 1: in-memory cache
  const cached = registry.getDataSourceId(normalized);
  if (cached) return asDataSourceId(cached);

  // Tier 2: persisted sync record for this block
  if (deps.syncState) {
    const record = deps.syncState.getByNotionId(normalized);
    if (record?.dataSourceId) {
      const id = asDataSourceId(record.dataSourceId);
      registry.setDataSourceId(normalized, id);
      return id;
    }
  }

  // Tier 3: getDatabase happy path. Treat linked-view stubs (data_sources=[])
  // as "no resolution" - the caller is asking about a block that's a view of
  // a database elsewhere; the data_source_id of the SOURCE database is not
  // discoverable from this block alone.
  try {
    const db = await deps.notionClient.getDatabase(normalized);
    if (!isLinkedViewStub(db)) {
      const ids = extractDataSourceIds(db);
      const first = ids[0];
      if (first !== undefined) {
        registry.setDataSourceId(normalized, first);
        return first;
      }
    }
  } catch {
    // 400/404 = legacy shape or missing access; fall through to meta cache + brute-force
  }

  // Tier 4: persisted brute-force result from a prior session
  if (deps.syncState?.getMeta) {
    const metaCached = deps.syncState.getMeta(`${META_KEY_PREFIX}${normalized}`);
    if (metaCached) {
      const id = asDataSourceId(metaCached);
      registry.setDataSourceId(normalized, id);
      return id;
    }
  }

  // Tier 5: brute-force search (last resort, slow). Persist the result
  // to the meta cache so subsequent sessions hit Tier 4.
  const resolved = await searchForDataSource(normalized, deps.notionClient);
  if (resolved) {
    const branded = asDataSourceId(resolved);
    registry.setDataSourceId(normalized, branded);
    if (deps.syncState?.setMeta) {
      deps.syncState.setMeta(`${META_KEY_PREFIX}${normalized}`, resolved);
    }
    return branded;
  }

  return undefined;
}

/**
 * True when the entry already has every canonical field set. Used by
 * `ensureDatabaseRegistered` to short-circuit redundant API calls.
 */
function isFullyPopulated(entry: PageRegistryEntry): boolean {
  return (
    entry.type === 'database' &&
    !!entry.dataSourceId &&
    !!entry.viewType &&
    !!entry.views &&
    entry.views.length > 0
  );
}

/**
 * Register a Notion database in the registry and populate its canonical
 * metadata via the official Views API.
 *
 * - Reuses the existing entry if already fully populated (idempotent).
 * - Falls back to a bare entry (title + folder only) if the database
 *   cannot be retrieved - caller decides whether to retry or skip.
 */
export async function ensureDatabaseRegistered(
  registry: PageRegistry,
  blockId: string,
  title: string,
  deps: RegistrarDeps,
  /**
   * Optional pre-fetched `getDatabase` response. Callers that already
   * called the endpoint (e.g. the BFS probe distinguishing real DBs
   * from linked-view stubs) pass it here so we don't re-fetch.
   */
  prefetchedDbMeta?: {
    data_sources?: { id: string }[];
    properties?: Record<string, Record<string, unknown>>;
  },
): Promise<PageRegistryEntry> {
  const normalizedId = normalizeNotionId(blockId);
  const existing = registry.get(normalizedId);
  if (existing && existing.type === 'database' && isFullyPopulated(existing)) {
    return existing;
  }

  const entry = registry.registerDatabase(normalizedId, title, deps.syncFolder);
  await populateDatabaseMetadata(registry, entry, deps, prefetchedDbMeta);
  return entry;
}

/**
 * Populate canonical metadata on a database entry via the official
 * Views API. Sets:
 *   - dataSourceId  (from getDatabase.data_sources[0])
 *   - viewType      (from the first inline view)
 *   - visiblePropertyIds (from the first inline view)
 *   - coverImage    (from the first inline view that has a cover config)
 *   - views[]       (every inline view, in Notion's order)
 *
 * Idempotent: if `entry.views` is already populated, the function
 * returns without making API calls.
 *
 * If `getDatabase` fails (e.g. the integration doesn't have access to
 * this DB), the function returns silently - entry stays as a bare
 * registry entry. Callers can still wikilink to it.
 */
export async function populateDatabaseMetadata(
  registry: PageRegistry,
  entry: PageRegistryEntry,
  deps: RegistrarDeps,
  prefetchedDbMeta?: {
    data_sources?: { id: string }[];
    properties?: Record<string, Record<string, unknown>>;
  },
): Promise<void> {
  if (entry.views && entry.views.length > 0) return;

  // Resolve data_source_id from the pre-fetched dbMeta when available,
  // otherwise call getDatabase. The block-UUID we registered under may
  // differ from the data_source_id in the 2025-09-03 API.
  //
  // 2025-09-03 split the response shape: /databases/{id} returns
  // `data_sources[]` (no properties), /data_sources/{id} returns
  // properties (no data_sources). When we resolve via the database
  // endpoint, follow up with a /data_sources/{ds_id} fetch so we
  // recover both halves.
  let dsId = entry.dataSourceId;
  let dbProperties: Record<string, Record<string, unknown>> = {};
  if (!dsId) {
    try {
      const dbMeta =
        prefetchedDbMeta ??
        ((await deps.notionClient.getDatabase(entry.notionId)) as {
          data_sources?: { id: string }[];
          properties?: Record<string, Record<string, unknown>>;
        });
      if (dbMeta) {
        dbProperties = dbMeta.properties ?? {};
        const firstDs = extractDataSourceIds(dbMeta)[0];
        if (firstDs) {
          dsId = firstDs;
          entry.dataSourceId = firstDs;
          registry.setDataSourceId(entry.notionId, firstDs);
        }
      }
    } catch (err) {
      log.warn(`getDatabase failed for "${entry.title}" - continuing: ${getErrorMessage(err)}`);
    }
  }

  // If we resolved a data_source_id but don't yet have properties, fetch
  // the data source explicitly to recover them. /v1/data_sources/{id} on
  // 2025-09-03 returns the full property schema. Filter rendering needs
  // the property map (extractLinkedViewFilters references property names).
  if (dsId && Object.keys(dbProperties).length === 0) {
    try {
      const dsMeta = (await deps.notionClient.getDatabase(dsId)) as {
        properties?: Record<string, Record<string, unknown>>;
      };
      if (dsMeta?.properties) {
        dbProperties = dsMeta.properties;
      }
    } catch (err) {
      log.warn(`getDataSource follow-up failed for "${entry.title}": ${getErrorMessage(err)}`);
    }
  }

  // Fallback: when the legacy /databases/ endpoint returns the 2022-06-28
  // shape, dbMeta has no `data_sources` array. Try listViewsForDataSource
  // with the block UUID first (Notion sometimes accepts it), and if that
  // 400/404s, ask the caller's resolver to brute-force the mapping.
  // Cast to DataSourceId here is the documented "this block UUID may also
  // serve as the queryable id on legacy DBs" fallback - the brand exists
  // to catch silent confusions, not to forbid this intentional reuse.
  if (!dsId) {
    dsId = asDataSourceId(entry.notionId);
  }
  if (!dsId) return;

  // Fetch view stubs. If the first attempt fails with 400/404, try the
  // brute-force data_source_id resolver and retry once.
  let stubs: { object: string; id: string }[];
  try {
    stubs = await deps.notionClient.listViewsForDataSource(dsId);
    // dsId is confirmed valid here, so persist it onto the entry (registrar
    // contract rule #1: every database entry carries a data_source_id).
    // This is the ONLY place it gets set when the entry was registered under
    // a data_source_id directly - e.g. a linked view whose source resolved
    // to a data_source_id rather than the parent database block. In that
    // case getDatabase returns the data_source itself (properties, but no
    // `data_sources[]`), so the data_sources[] path above leaves dsId unset
    // and we reach the notionId fallback. Without this, resolveLinkedView
    // received a sourceDb with no dataSourceId and failed with
    // "no-data-source" even though the views were perfectly listable.
    if (!entry.dataSourceId) {
      entry.dataSourceId = dsId;
      registry.setDataSourceId(entry.notionId, dsId);
    }
  } catch (err) {
    const status = (err as NotionApiError).statusCode;
    if (status !== 400 && status !== 404) {
      log.warn(`listViewsForDataSource failed (${status}) for "${entry.title}"`);
      return;
    }
    // Brute-force resolve block_id -> data_source_id via the centralized
    // resolver. It checks Tier 4 (persistent meta cache) before running
    // brute-force search (Tier 5), so the 600+ API call slog runs at most
    // once per block UUID per workspace.
    const resolved = await resolveDataSourceId(registry, asBlockUuid(entry.notionId), deps);
    if (!resolved) {
      log.warn(`Could not resolve data_source_id for "${entry.title}"`);
      return;
    }
    try {
      stubs = await deps.notionClient.listViewsForDataSource(resolved);
      dsId = resolved;
      entry.dataSourceId = resolved;
      registry.setDataSourceId(entry.notionId, resolved);
    } catch (retryErr) {
      log.warn(
        `listViewsForDataSource retry failed for "${entry.title}": ${getErrorMessage(retryErr)}`,
      );
      return;
    }
  }

  entry.views = [];
  let coverResolved = false;
  let primarySet = false;
  for (const stub of stubs) {
    let view;
    try {
      view = await deps.notionClient.getView(stub.id);
    } catch {
      continue;
    }
    if (view.type === 'chart') continue;

    const viewType = mapNotionViewType(view.type);
    const visibleProps = view.configuration?.properties
      ?.filter((p) => p.visible)
      .map((p) => p.property_id);
    const visiblePropertyIds = visibleProps && visibleProps.length > 0 ? visibleProps : undefined;
    const viewName = deriveViewName(view.name, view.type);
    const filters = extractLinkedViewFilters(view, dbProperties, (id) => {
      const e = registry.get(normalizeNotionId(id));
      return e?.title;
    });
    const coverImage = view.configuration?.cover
      ? deriveCoverImage(view.configuration.cover, dbProperties)
      : undefined;

    // Inline iff the view's parent.database_id matches THIS database's
    // own block UUID. Linked views (parent on another page) are NOT
    // recorded on dbEntry.views[] - they get their own entries via
    // ensureLinkedViewRegistered.
    const parentBlockId = view.parent?.database_id;
    const isInline =
      parentBlockId !== undefined &&
      normalizeNotionId(parentBlockId) === normalizeNotionId(entry.notionId);
    if (!isInline) continue;

    entry.views.push({
      id: stub.id,
      name: viewName,
      type: viewType,
      visiblePropertyIds,
      coverImage,
      filters,
    });

    if (!primarySet) {
      entry.viewType = viewType;
      entry.visiblePropertyIds = visiblePropertyIds;
      primarySet = true;
    }
    if (!coverResolved && coverImage) {
      entry.coverImage = coverImage;
      coverResolved = true;
    }
  }
}
