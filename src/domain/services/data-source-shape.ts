/**
 * Pure helpers for inspecting the `data_sources[]` shape on a Notion
 * `getDatabase` response (API version 2025-09-03+). No HTTP, no caching.
 *
 * Three shapes a 200 response can have:
 *   - `data_sources: [{ id }, ...]` - real database, the first id is the
 *     queryable data_source_id used by /v1/data_sources/{id}/query
 *   - `data_sources: []` - linked-view stub: the entity is a view of a
 *     database hosted elsewhere, NOT a real inline database
 *   - missing `data_sources` field - legacy 2022-06-28 shape, the block
 *     UUID itself is queryable
 *
 * Replaces hand-rolled `(db as { data_sources?: unknown[] }).data_sources`
 * checks scattered across database-registrar, block-identity-resolver,
 * and registry-builder.
 */

import { asDataSourceId, normalizeNotionId, type DataSourceId } from '../models/notion-id';

interface DataSourcesShape {
  data_sources?: unknown;
}

/**
 * True when the response is a 200 with explicitly empty `data_sources: []`.
 *
 * On the 2025-09-03 API this signals the entity is a linked-view stub
 * (a saved view of a database hosted elsewhere), NOT a real inline
 * database. Earlier code that ignored this flag created a fake stable
 * name and emitted a wikilink to a `.base` file the bases generator
 * never produced.
 *
 * Returns false for: non-empty data_sources (real DB), missing field
 * (legacy 2022-06-28 shape), null/undefined/non-object inputs.
 */
export function isLinkedViewStub(db: unknown): boolean {
  if (!db || typeof db !== 'object') return false;
  const ds = (db as DataSourcesShape).data_sources;
  return Array.isArray(ds) && ds.length === 0;
}

/**
 * Extract the data_source_id values from a getDatabase response.
 *
 * Returns an empty array when `data_sources` is missing (legacy shape)
 * or malformed. IDs are normalized to dashless lowercase via the
 * canonical `normalizeNotionId` so callers can compare directly.
 */
export function extractDataSourceIds(db: unknown): DataSourceId[] {
  if (!db || typeof db !== 'object') return [];
  const ds = (db as DataSourcesShape).data_sources;
  if (!Array.isArray(ds)) return [];
  const ids: DataSourceId[] = [];
  for (const entry of ds) {
    if (entry && typeof entry === 'object' && 'id' in entry) {
      const id = (entry as { id: unknown }).id;
      if (typeof id === 'string' && id.length > 0) {
        ids.push(asDataSourceId(normalizeNotionId(id)));
      }
    }
  }
  return ids;
}
