/**
 * Pure helpers shared between registry-builder.ts and database-registrar.ts.
 *
 * Lives in its own module to break the circular import that would
 * otherwise form (registry-builder uses these; database-registrar uses
 * these; Phase 3 routes registry-builder through database-registrar).
 *
 * No I/O, no logging - just data transforms. Adding logic here means
 * adding a single test against this file rather than testing through
 * the discovery flow.
 */

import type {
  PageRegistryEntry,
  LinkedViewContext,
  BasesFilterExpression,
} from '../../domain/models/page-registry';
import { propertyToFrontmatterKey } from '../../shared/sanitize';

/**
 * The entries the apply phase should act on: only ids the registry still
 * answers with themselves, and each of them once.
 *
 * Two things leave a copy behind in this array, which is built alongside the
 * registry rather than by it. Unification drops a duplicate database and
 * aliases its id to the survivor, and the copy in the array keeps the
 * collision-suffixed path it was registered under. A caller that re-registers a
 * database already known under its other id is handed the entry that exists and
 * pushes a second reference to it. Either way the apply phase ends up creating
 * a folder for a name nothing is ever written into (#1977).
 */
export function survivingEntries<T extends PageRegistryEntry>(
  entries: T[],
  registry: { get(notionId: string): PageRegistryEntry | undefined },
): T[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (registry.get(entry.notionId)?.notionId !== entry.notionId) return false;
    if (seen.has(entry.notionId)) return false;
    seen.add(entry.notionId);
    return true;
  });
}

/**
 * Derive a human-readable view name from the Views API response.
 * Prefers the custom name; falls back to capitalised view type.
 */
export function deriveViewName(
  viewName: string | undefined | null,
  viewType: string | undefined | null,
): string {
  if (viewName && viewName !== 'Untitled') return viewName;
  if (viewType) return viewType.charAt(0).toUpperCase() + viewType.slice(1);
  return 'View';
}

/**
 * Derive a Bases image expression from the Views API cover configuration.
 * Maps Notion's cover types to Bases note property references.
 */
export function deriveCoverImage(
  coverConfig: { type: string; property_id?: string } | undefined,
  dbProperties?: Record<string, Record<string, unknown>>,
): string | undefined {
  if (!coverConfig) return undefined;
  switch (coverConfig.type) {
    case 'page_content':
      return 'note.n2o_cover';
    case 'page_cover':
      return 'note.banner';
    case 'property': {
      if (!dbProperties) return 'note.banner';
      if (coverConfig.property_id) {
        const entry = Object.entries(dbProperties).find(
          ([, v]) => v['id'] === coverConfig.property_id,
        );
        if (entry) return `note.${propertyToFrontmatterKey(entry[0])}`;
      }
      const filesKey = Object.keys(dbProperties).find(
        (k) => (dbProperties[k]?.['type'] as string) === 'files',
      );
      return filesKey ? `note.${propertyToFrontmatterKey(filesKey)}` : 'note.banner';
    }
    case 'none':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Assemble the LinkedViewContext handed to the linked-view renderer.
 */
export function buildLinkedViewContext(input: {
  sourceDb: PageRegistryEntry;
  filters: BasesFilterExpression[];
  viewType: 'table' | 'cards' | 'list' | undefined;
  visiblePropertyIds: string[] | undefined;
  parentPageId: string | undefined;
  parentPageTitle: string;
  coverImage: string | undefined;
}): LinkedViewContext {
  return {
    sourceDatabaseId: input.sourceDb.notionId,
    sourceDatabaseFolder: input.sourceDb.vaultPath,
    filters: input.filters,
    viewType: input.viewType,
    parentPageId: input.parentPageId,
    parentPageTitle: input.parentPageTitle,
    visiblePropertyIds: input.visiblePropertyIds,
    coverImage: input.coverImage,
  };
}
