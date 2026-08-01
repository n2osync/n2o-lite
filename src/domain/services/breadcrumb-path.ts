/**
 * Breadcrumb ancestor-chain resolution.
 *
 * Notion's breadcrumb block renders the page's ancestor chain, which only the
 * sync pipeline can reconstruct: the page registry knows titles and vault
 * file names, sync records know parent linkage for anything synced before.
 * These are pure, stateless transforms over those two read surfaces - no I/O,
 * no adapter imports - so they live in domain/services/ next to parent-utils.
 *
 * The pull pipeline calls enrichBreadcrumbBlocks on every parsed document
 * BEFORE ObsidianBuilder.build runs (sync-page's renderWithTemplate, the
 * sync-entry hash-tiebreaker builds, and fetchAndRenderPage), stamping each
 * breadcrumb block's meta with the resolved chain. The renderer turns that
 * into `%% n2o:breadcrumb %% [[Ancestor]] / Page Title`; the parser discards
 * the visible chain on the way back (it is derived content, rebuilt here on
 * every pull).
 */

import type { N2OBlock, BreadcrumbSegment } from '../models/block';
import type { N2ODocument } from '../models/document';
import type { PageRegistryEntry } from '../models/page-registry';
import { normalizeNotionId } from '../models/notion-id';

/**
 * Registry read surface the resolver needs. Structurally satisfied by
 * PageRegistry (application/discovery) without importing it - domain stays
 * import-free above its own layer.
 */
export interface BreadcrumbRegistryReader {
  get(notionId: string): PageRegistryEntry | undefined;
}

/**
 * Sync-record read surface the resolver needs. Structurally satisfied by
 * SyncStateDB.getByNotionId (returns a SyncRecord, which carries both fields).
 */
export interface BreadcrumbSyncRecordReader {
  getByNotionId(notionId: string): { notionParentId?: string; obsidianPath: string } | null;
}

/**
 * Hard cap on chain length. Notion hierarchies rarely exceed a handful of
 * levels; the cap bounds the walk if persisted parent pointers ever form a
 * chain longer than any real workspace (the visited set already stops cycles).
 */
const MAX_BREADCRUMB_DEPTH = 10;

/**
 * Walk parent pointers upward from `startParentId` and return the ancestor
 * chain root-first. Each step resolves through the registry when possible
 * (real titles, wikilink targets for page/database-item entries) and falls
 * back to the sync record (vault path basename) for ancestors outside the
 * current sync scope. Stops at the first ancestor neither source knows -
 * an unnamed segment would be worse than a shorter chain.
 */
export function resolveBreadcrumbPath(
  startParentId: string | undefined,
  registry: BreadcrumbRegistryReader | null,
  syncState: BreadcrumbSyncRecordReader | null,
): BreadcrumbSegment[] {
  const segments: BreadcrumbSegment[] = [];
  const visited = new Set<string>();
  let id: string | undefined = startParentId;

  while (id && segments.length < MAX_BREADCRUMB_DEPTH) {
    const key = normalizeNotionId(id);
    if (visited.has(key)) break;
    visited.add(key);

    const entry = registry?.get(id);
    if (entry) {
      const segment: BreadcrumbSegment = { title: entry.title || 'Untitled' };
      // Only pages and database items are .md notes a wikilink can open.
      // Databases are folders and linked views are .base files - both render
      // as plain text.
      if (entry.type === 'page' || entry.type === 'database-item') {
        segment.linkTarget = entry.fileName;
      }
      segments.unshift(segment);
      // Prefer the registry's own parent linkage (parentPageId for pages,
      // parentDatabaseId for database items) so the walk does not depend on a
      // sync record existing yet - that timing gap dropped the top level of the
      // chain on a fresh pull. Sync records fill in for anything the registry
      // does not cover.
      id =
        entry.parentPageId ??
        entry.parentDatabaseId ??
        syncState?.getByNotionId(entry.notionId)?.notionParentId;
      continue;
    }

    const record = syncState?.getByNotionId(id) ?? null;
    if (!record) break;
    const base = record.obsidianPath.split('/').pop() ?? '';
    // A note record's basename doubles as title and wikilink target (they are
    // the same string by construction). A database record points at a folder
    // or .base file - name only, nothing to link to.
    const segment: BreadcrumbSegment = base.endsWith('.md')
      ? { title: base.slice(0, -3), linkTarget: base.slice(0, -3) }
      : { title: base.replace(/\.base$/, '') };
    if (!segment.title) break;
    segments.unshift(segment);
    id = record.notionParentId;
  }

  return segments;
}

/**
 * Stamp every breadcrumb block in the document with its resolved ancestor
 * chain (see BreadcrumbMeta.breadcrumbPath). Idempotent: recomputes from
 * scratch each call, so re-running on an already-enriched document just
 * refreshes the chain. When nothing resolves (orphan page, no registry) the
 * meta is still normalized to kind 'breadcrumb' without a path - the renderer
 * falls back to the page's own title and never emits a raw comment.
 */
export function enrichBreadcrumbBlocks(
  doc: N2ODocument,
  registry: BreadcrumbRegistryReader | null,
  syncState: BreadcrumbSyncRecordReader | null,
): void {
  let path: BreadcrumbSegment[] | null = null;
  const walk = (blocks: N2OBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'breadcrumb') {
        // Resolve lazily, once - every breadcrumb on a page shares one chain.
        if (path === null) {
          path = resolveBreadcrumbPath(doc.metadata.parentId, registry, syncState);
        }
        block.meta =
          path.length > 0 ? { kind: 'breadcrumb', breadcrumbPath: path } : { kind: 'breadcrumb' };
      }
      if (block.children?.length) walk(block.children);
    }
  };
  walk(doc.blocks);
}
