/**
 * Synced-block reference resolver (Epic #1719).
 *
 * A Notion synced block comes in two flavors: an ORIGINAL (holds the content,
 * `syncedFrom == null`) and a REFERENCE (points at the original's id via
 * `syncedFrom`). A reference on another page can only render a working embed if
 * we know which page the original lives on.
 *
 * The location index (`syncedBlockId -> page`) is populated by the renderer as
 * it ANCHORS each original it truly renders (builder.getAnchoredSyncedOriginals,
 * consumed in renderWithTemplate) - NOT by walking the doc, because a page that
 * merely references a synced block carries a phantom nested copy of the original
 * that is never anchored and must not misattribute it. This module reads that
 * index back to stamp the cross-page target on each reference.
 */

import type { N2OBlock } from '../models/block';
import type { N2ODocument } from '../models/document';
import type { PageRegistryReader } from '../models/page-registry';

/** Minimal reader the resolver uses to look up an original's page. */
export interface SyncedBlockPageReader {
  getSyncedBlockPage(blockId: string): string | null;
}

/**
 * Stamp `meta.syncedFromPage` on every synced-block REFERENCE whose original is
 * known: look the original's page up in the index, map it to a wikilink target
 * via the registry, and record the target so the renderer can emit the
 * cross-page embed `![[Page#^id]]`. References whose original is not indexed yet
 * are left unstamped and fall back to the current-file form (self-heals next
 * pull). Rebuilt on every pull, like enrichBreadcrumbBlocks - never round-tripped.
 */
export function enrichSyncedReferences(
  doc: N2ODocument,
  pages: SyncedBlockPageReader | null,
  registry: PageRegistryReader | null,
): void {
  if (!pages || !registry) return;
  resolveRefs(doc.blocks, pages, registry);
}

function resolveRefs(
  blocks: N2OBlock[] | undefined,
  pages: SyncedBlockPageReader,
  registry: PageRegistryReader,
): void {
  if (!blocks) return;
  for (const block of blocks) {
    if (
      block.type === 'syncedBlock' &&
      block.meta.kind === 'syncedBlock' &&
      block.meta.syncedFrom
    ) {
      const pageNotionId = pages.getSyncedBlockPage(block.meta.syncedFrom);
      if (pageNotionId) {
        const target = registry.getWikilinkTarget(pageNotionId, '');
        if (target) block.meta.syncedFromPage = target;
      }
    }
    resolveRefs(block.children, pages, registry);
  }
}
