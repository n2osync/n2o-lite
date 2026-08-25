/**
 * Linked-view resolver - single source of truth for resolving a Notion
 * linked-view block (a saved view of a database, embedded on a page) to
 * its filters, view metadata, and Notion query payload.
 *
 * Replaces three near-identical implementations that diverged independently:
 *
 *   - registry-builder.discoverViewsViaApi linked-view branch (B)
 *   - registry-builder.resolveViewsByReverseLookup per-match (C)
 *   - sync-page.registerAndGenerateLinkedView (D)
 *
 * Plus an orphan canonical attempt that never had callers:
 *   - database-registrar.ensureLinkedViewRegistered (deleted in this commit)
 *
 * Algorithm (Notion API 2025-09-03+):
 *   1. The source DB must already have a resolved data_source_id.
 *      The caller is responsible (use ensureDatabaseRegistered first).
 *   2. Fetch the schema via /v1/data_sources/{dsId} - returns property
 *      definitions. The legacy /v1/databases/{block_uuid} returns
 *      data_sources[] but no `properties`, so its empty schema would
 *      defeat property-id -> name resolution in the filter translator.
 *   3. listViewsForDataSource(dsId) -> all view stubs (inline + linked).
 *   4. For each stub, getView(stub.id) until one whose
 *      view.parent.database_id matches the linked-view block UUID:
 *      that is the view embedded at our block.
 *   5. Translate filters via extractLinkedViewFilters (official Views API
 *      shape covers `view.filter` AND `view.quick_filters`) for the
 *      .base YAML.
 *   6. In parallel, derive the Notion query filter via viewToQueryFilter
 *      reading the SAME view object directly. No round-trip through
 *      Bases vocabulary, so operators Bases can't express (date ranges,
 *      is_empty, etc.) still get pushed to Notion. Both pipelines read
 *      the same source, so the .base filter and the row pull stay
 *      aligned (WYSIWYG between Notion and Obsidian).
 *
 * Failure variants are explicit. Callers route them into SyncResult.errors
 * via deps.emitError(...) so a sync that could not honor a linked view's
 * filter is visibly partial - it does NOT silently degrade to "All caught
 * up" with the wrong row set.
 *
 * @module
 */

import type { NotionClient } from '../../infrastructure/notion/client';
import type { NotionViewDetail } from '../../domain/models/notion-api-types';
import type { PageRegistryEntry, BasesFilterExpression } from '../../domain/models/page-registry';
import { normalizeNotionId, type BlockUuid } from '../../domain/models/notion-id';
import { extractLinkedViewFilters, viewToQueryFilter } from '../content/linked-view-filters';
import { mapNotionViewType } from '../content/notion-view-type';
import { deriveCoverImage, deriveViewName } from './registry-builder-helpers';
import { getErrorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/logger';

const log = createLogger('LinkedViewResolver');

/**
 * Notion-side dependencies the resolver needs. Pick subset of NotionClient
 * so the resolver is testable with a minimal mock.
 */
export interface LinkedViewResolverDeps {
  notionClient: Pick<NotionClient, 'listViewsForDataSource' | 'getView' | 'getDatabase'>;
  /**
   * Resolves a Notion page ID to its vault title for relation-property
   * filters. Without it, relation filters silently drop (per the
   * filter-translator contract). Optional because some callers don't
   * have a registry yet.
   */
  pageIdToTitle?: (id: string) => string | undefined;
}

/** Successful resolution. `filters: []` is valid - it means the Notion view legitimately has no filter. */
export interface LinkedViewResolution {
  ok: true;
  /** Raw view object from the Views API (callers may need view.id, view.parent, etc.). */
  view: NotionViewDetail;
  /** Human-readable view name (Notion's name, or capitalised type fallback). */
  viewName: string;
  /** Mapped Bases view type. */
  viewType: 'table' | 'cards' | 'list' | undefined;
  /** Translated Bases filter expressions, ready for the .base YAML. Empty array is valid. */
  filters: BasesFilterExpression[];
  /** Visible property IDs from view.configuration. */
  visiblePropertyIds: string[] | undefined;
  /** Bases image expression for gallery/cards covers. */
  coverImage: string | undefined;
  /**
   * Notion query filter object derived from `filters`, ready to pass to
   * queryDatabase. Undefined when `filters` is empty (no filter on this
   * view). Same logical predicate as the .base filter, by construction.
   */
  apiFilter: Record<string, unknown> | undefined;
  /** Schema map (property name -> type/id). Useful for downstream rendering. */
  dbProperties: Record<string, Record<string, unknown>>;
}

/** Failure to resolve. Distinguishes hard failures from "view has no filter". */
interface LinkedViewResolutionFailure {
  ok: false;
  reason:
    | 'no-data-source' // sourceDb has no resolved dataSourceId
    | 'schema-fetch-failed' // /v1/data_sources/{id} threw or returned no properties
    | 'list-views-failed' // listViewsForDataSource raised
    | 'no-matching-view'; // none of the stubs had parent.database_id == blockUuid
  /** Human-readable, one-line, no Notion-side detail; safe for sync errors[]. */
  message: string;
}

export type LinkedViewResolutionResult = LinkedViewResolution | LinkedViewResolutionFailure;

/**
 * Resolve a Notion linked-view block to filters + Bases-ready metadata.
 *
 * Hard failures route to LinkedViewResolutionFailure; callers MUST surface
 * them via deps.emitError or push into a SyncResult errors[] array. Empty
 * filters on a successfully-resolved view are NOT a failure.
 */
export async function resolveLinkedView(
  blockUuid: BlockUuid,
  sourceDb: PageRegistryEntry,
  deps: LinkedViewResolverDeps,
): Promise<LinkedViewResolutionResult> {
  const blockNorm = normalizeNotionId(blockUuid);

  if (!sourceDb.dataSourceId) {
    return {
      ok: false,
      reason: 'no-data-source',
      message: `Source database "${sourceDb.title}" has no resolved data_source_id; cannot list views.`,
    };
  }
  const dsId = sourceDb.dataSourceId;

  // Schema must come from /v1/data_sources/{id}, NOT /v1/databases/{block_uuid}.
  // Earlier code that fetched via the block UUID got data_sources[] but NO
  // `properties`, which caused extractLinkedViewFilters to silently drop
  // every quick_filter (property IDs could not be resolved to names).
  let dbProperties: Record<string, Record<string, unknown>> = {};
  try {
    const schema = (await deps.notionClient.getDatabase(dsId)) as {
      properties?: Record<string, Record<string, unknown>>;
    };
    dbProperties = schema.properties ?? {};
    if (Object.keys(dbProperties).length === 0) {
      return {
        ok: false,
        reason: 'schema-fetch-failed',
        message: `Schema for data_source ${dsId.substring(0, 8)} returned no properties; cannot translate filters.`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'schema-fetch-failed',
      message: `Could not fetch schema for data_source ${dsId.substring(0, 8)}: ${getErrorMessage(err)}`,
    };
  }

  let stubs: { object: string; id: string }[];
  try {
    stubs = await deps.notionClient.listViewsForDataSource(dsId);
  } catch (err) {
    return {
      ok: false,
      reason: 'list-views-failed',
      message: `Could not list views for data_source ${dsId.substring(0, 8)}: ${getErrorMessage(err)}`,
    };
  }

  for (const stub of stubs) {
    let view: NotionViewDetail;
    try {
      view = await deps.notionClient.getView(stub.id);
    } catch (err) {
      // A single getView failure is not the resolver's failure; skip and
      // continue. If NO view matches at the end we return no-matching-view.
      log.debug(`getView(${stub.id.substring(0, 8)}) failed: ${getErrorMessage(err)}`);
      continue;
    }

    const parentDbId = view.parent?.database_id;
    if (!parentDbId) continue;
    if (normalizeNotionId(parentDbId) !== blockNorm) continue;

    return {
      ok: true,
      ...buildLinkedViewResolution(view, sourceDb, dbProperties, deps.pageIdToTitle),
    };
  }

  return {
    ok: false,
    reason: 'no-matching-view',
    message: `No view among ${stubs.length} on data_source ${dsId.substring(0, 8)} has parent.database_id matching block ${blockNorm.substring(0, 8)}.`,
  };
}

/**
 * Pure transform: given a Views API `view` already fetched by the caller,
 * produce the resolution payload (filters, viewType, apiFilter, etc.).
 *
 * Used by:
 *   - resolveLinkedView (this module) once it has matched a view
 *   - registry-builder.discoverViewsViaApi linked-view branch (path B),
 *     which iterates listViewsForDataSource for inline + linked views in
 *     a single pass and already holds the view object
 *   - registry-builder.resolveViewsByReverseLookup (path C), same thing
 *
 * The function never fails: the caller has chosen this view, so we just
 * compute the derived fields. Filter list may be empty - that's a valid
 * "view with no filter," not a failure.
 */
export function buildLinkedViewResolution(
  view: NotionViewDetail,
  sourceDb: PageRegistryEntry,
  dbProperties: Record<string, Record<string, unknown>>,
  pageIdToTitle?: (id: string) => string | undefined,
): Omit<LinkedViewResolution, 'ok'> {
  const filters = extractLinkedViewFilters(view, dbProperties, pageIdToTitle);
  const visibleProps = view.configuration?.properties
    ?.filter((p) => p.visible)
    .map((p) => p.property_id);
  const visiblePropertyIds = visibleProps && visibleProps.length > 0 ? visibleProps : undefined;
  const coverImage = view.configuration?.cover
    ? deriveCoverImage(view.configuration.cover, dbProperties)
    : undefined;
  const viewType = mapNotionViewType(view.type);
  const viewName = deriveViewName(view.name, view.type);
  const apiFilter = viewToQueryFilter(view, dbProperties);

  // sourceDb argument is intentionally unused but kept in the signature
  // so callers thread the right entry through (and so future fields that
  // need it - e.g. relation resolution by sourceDb folder - have a path).
  void sourceDb;

  return {
    view,
    viewName,
    viewType,
    filters,
    visiblePropertyIds,
    coverImage,
    apiFilter,
    dbProperties,
  };
}
