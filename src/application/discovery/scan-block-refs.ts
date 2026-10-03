/**
 * scan-block-refs - pure block-tree walker for finding nested page/database refs.
 *
 * Used by:
 *   1. PrefetchCoordinator (BFS expansion) - walks blocks already cached
 *      to discover child_page / child_database IDs that need fetching too.
 *   2. scanCachedBlocksForChildren - the replay-side no-API discovery
 *      variant of registry-builder's discoverChildrenFromBlocks.
 *
 * No API calls, no registry mutations, no side effects. Just an in-memory
 * recursive walk over the block tree (using `block.children` attachments
 * populated by `getAllBlockChildrenRecursive`).
 */

import type { NotionBlock } from '../../domain/models/notion-api-types';
import { normalizeNotionId } from '../../domain/models/notion-id';
import { sanitizeFileName } from '../../shared/sanitize';

export interface ScanBlockRefsOptions {
  syncChildPages: boolean;
  syncChildDatabases: boolean;
  /**
   * Sanitized DB titles already explicitly selected by the user.
   * child_database blocks matching one of these are filtered out so
   * the same DB isn't registered twice (the explicit selection wins
   * because it has a known data_source_id).
   */
  selectedDbTitles?: Set<string>;
}

export interface BlockRef {
  /**
   * - `child_page` / `child_database`: the block ID (which IS the page/db ID for these block types).
   * - `mention_page` / `mention_database`: the mentioned entity's ID, NOT the block ID.
   *   Mentions are inline rich-text references that point at another page or database
   *   somewhere in the workspace, so the ID lives on `rich_text[i].mention.{page|database}.id`.
   */
  blockId: string;
  type: 'child_page' | 'child_database' | 'mention_page' | 'mention_database';
  /**
   * Best-effort title. For child_*  blocks the API includes it; for mentions the only
   * cheap source is `rich_text[i].plain_text`, which is the rendered display name and
   * sufficient for human-readable logging. Real titles get filled in when the apply
   * phase fetches the page.
   */
  title: string;
}

/**
 * Recursively walk `blocks` and collect every child_page and child_database
 * block reference. Container blocks (callouts, toggles, columns, synced
 * blocks, etc.) are recursed via `block.children` - which the recursive
 * fetcher (`getAllBlockChildrenRecursive`) attaches up to depth 10.
 *
 * Returns refs in document order. Caller dedupes against its own visited
 * set since this helper has no notion of "already discovered."
 */
export function scanBlocksForChildRefs(
  blocks: NotionBlock[],
  opts: ScanBlockRefsOptions,
): BlockRef[] {
  const refs: BlockRef[] = [];
  walk(blocks);
  return refs;

  function walk(bs: NotionBlock[]): void {
    for (const block of bs) {
      const blockType = block.type;
      const rawId = block.id ?? '';
      const blockId = normalizeNotionId(rawId);
      if (!blockId) continue;

      if (blockType === 'child_page' && opts.syncChildPages) {
        const childPage = (block as { child_page?: { title?: string } }).child_page;
        refs.push({ blockId, type: 'child_page', title: childPage?.title ?? '' });
        // child_page blocks should not be recursed into here - the page's
        // own content is fetched separately when the ref is registered.
        continue;
      }

      if (blockType === 'child_database' && opts.syncChildDatabases) {
        const childDb = (block as { child_database?: { title?: string } }).child_database;
        const title = childDb?.title ?? 'Untitled Database';
        const sanitized = sanitizeFileName(title);
        if (!opts.selectedDbTitles?.has(sanitized)) {
          refs.push({ blockId, type: 'child_database', title });
        }
        // child_database has no traversable block tree - the actual rows
        // come from /databases/{id}/query, queried separately.
        continue;
      }

      // Inline mentions: rich-text runs of type 'mention' that point at a
      // page or database elsewhere in the workspace. Until this scan was
      // added, every wikilink the renderer emitted from a heading/paragraph
      // mention dead-ended in the vault because nothing seeded the mentioned
      // page for fetch. Now they get queued the same way child_page refs do.
      // Gated by the same flags - page mentions follow `syncChildPages`,
      // database mentions follow `syncChildDatabases`.
      const richText = readRichText(block);
      if (richText) {
        for (const run of richText) {
          if (run.type !== 'mention' || !run.mention) continue;
          const mentionType = run.mention.type;
          if (mentionType === 'page' && opts.syncChildPages) {
            const id = normalizeNotionId(run.mention.page?.id ?? '');
            if (id) refs.push({ blockId: id, type: 'mention_page', title: run.plain_text ?? '' });
          } else if (mentionType === 'database' && opts.syncChildDatabases) {
            const id = normalizeNotionId(run.mention.database?.id ?? '');
            if (id)
              refs.push({ blockId: id, type: 'mention_database', title: run.plain_text ?? '' });
          }
        }
      }

      // Container blocks: recurse into attached children. We skip when
      // `block.children` is missing (caller fed us blocks fetched
      // non-recursively). For our usage (cache populated by
      // getAllBlockChildrenRecursive) children are always attached.
      const children = (block as { children?: NotionBlock[] }).children;
      if (Array.isArray(children) && children.length > 0) {
        walk(children);
      }
    }
  }
}

/**
 * Pull the rich_text array off a block. Notion stores it under a key matching
 * the block's `type`: paragraph.rich_text, heading_1.rich_text, callout.rich_text,
 * etc. Returns `undefined` for block types that don't carry rich text (image,
 * column, divider, etc.) so the caller skips cleanly.
 */
export function readRichText(block: NotionBlock): MentionBearingRichText[] | undefined {
  const t = block.type;
  if (!t) return undefined;
  const inner = (block as unknown as Record<string, { rich_text?: unknown }>)[t];
  const rt = inner?.rich_text;
  if (!Array.isArray(rt)) return undefined;
  return rt as MentionBearingRichText[];
}

/**
 * Minimal shape of a Notion rich-text run we care about for mention extraction.
 * The official Notion typing tree carries dozens of fields per variant; we only
 * read three. Cast through this rather than depending on `@notionhq/client`.
 */
export interface MentionBearingRichText {
  type: 'text' | 'mention' | 'equation' | (string & {});
  plain_text?: string;
  mention?: {
    type:
      'page' | 'database' | 'user' | 'date' | 'link_preview' | 'template_mention' | (string & {});
    page?: { id?: string };
    database?: { id?: string };
  };
}
