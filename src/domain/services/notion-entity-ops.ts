/**
 * Domain-level semantic operations on Notion wire-format entities.
 *
 * Replaces inline field access patterns scattered across application
 * code. Pre-Phase-H, application files reached deep into Notion's
 * wire shape:
 *
 *   const title = page.properties[key]?.title?.[0]?.plain_text;
 *   const ref   = block.child_page?.title;
 *   const ms    = block.paragraph?.rich_text?.flatMap(...);
 *
 * Each access encoded knowledge of Notion's API shape into application
 * code. When Notion rotated property layouts (e.g. the data_source_id
 * vs database_id transition), every site needed independent updates -
 * the F-004 / data-source duplication regressions are direct evidence.
 *
 * These helpers consolidate that knowledge into one module. Application
 * code now asks semantic questions ("what is this page's title?") and
 * the wire-format response shape is encapsulated here.
 *
 * Pure functions, no I/O, no state. Lives in domain/services/ alongside
 * parent-utils.ts because the operations are stateless transforms over
 * external-system contract types (which themselves live in
 * domain/models/notion-api-types.ts).
 */

import type {
  NotionPage,
  NotionBlock,
  NotionDatabase,
  NotionRichText,
  NotionPropertyResponse,
  NotionViewDetail,
} from '../models/notion-api-types';

// ── Page ───────────────────────────────────────────────

/**
 * Extract the title text from a NotionPage's `title`-typed property.
 * Returns 'Untitled' when no title property is present or empty.
 *
 * Replaces `PropertyHelper.extractTitle()` and the inline pattern
 * `page.properties[k]?.title?.[0]?.plain_text` scattered across
 * registry-builder, sync-tree-picker, and discovery.
 */
export function getPageTitle(page: NotionPage): string {
  const properties = page.properties;
  if (!properties) return 'Untitled';
  for (const prop of Object.values(properties)) {
    if (prop.type === 'title') {
      const titleArray = prop.title;
      if (titleArray && titleArray.length > 0) {
        return titleArray.map((t) => t.plain_text ?? '').join('');
      }
    }
  }
  return 'Untitled';
}

// ── Database ───────────────────────────────────────────

/**
 * Extract the database title from a NotionDatabase metadata object.
 * Concatenates the `title` rich-text array.
 *
 * Consolidates `extractDatabaseTitle()` that was duplicated at
 * application/discovery/discovery.ts:18 and
 * application/sync/block-identity-resolver.ts:113. Both inline
 * implementations had subtle differences in fallback strings; this
 * version standardizes on 'Untitled Database'.
 */
export function getDatabaseTitle(db: NotionDatabase): string {
  return db.title?.map((t) => t.plain_text ?? '').join('') || 'Untitled Database';
}

// ── Rich Text ──────────────────────────────────────────

/**
 * Concatenate plain_text from a rich_text array. Returns empty string
 * for null / undefined / empty input.
 */
export function getPlainText(richText: NotionRichText[] | undefined | null): string {
  if (!richText || richText.length === 0) return '';
  return richText.map((rt) => rt.plain_text ?? '').join('');
}

/**
 * Normalized representation of a Notion mention. Captures the
 * essential information (what type of entity is being mentioned and
 * its id) without forcing callers to know which sub-shape Notion uses
 * (page.id vs database.id vs data_source.id).
 */
export interface MentionRef {
  type: 'page' | 'database' | 'data_source' | 'user' | 'date' | 'link_preview' | 'template_mention';
  id?: string;
}

/**
 * Extract a normalized mention reference from a single rich-text
 * segment. Returns null if the segment is not a mention or if the
 * mention type is unrecognised.
 */
export function getMentionRef(rt: NotionRichText): MentionRef | null {
  if (rt.type !== 'mention' || !rt.mention) return null;
  const m = rt.mention;
  switch (m.type) {
    case 'page':
      return { type: 'page', id: m.page?.id };
    case 'database':
      return { type: 'database', id: m.database?.id };
    case 'data_source':
      return { type: 'data_source', id: m.data_source?.id };
    case 'user':
      return { type: 'user', id: m.user?.id };
    case 'date':
      return { type: 'date' };
    case 'link_preview':
      return { type: 'link_preview' };
    case 'template_mention':
      return { type: 'template_mention' };
    default:
      return null;
  }
}

// ── Block ──────────────────────────────────────────────

/**
 * Container block types that may have nested children. Used by BFS
 * discovery to decide which blocks to recurse into. Centralised here
 * so a future block-type addition (e.g. a new layout primitive) only
 * needs to update this set.
 */
export const CONTAINER_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'toggle',
  'callout',
  'column',
  'column_list',
  'synced_block',
  'quote',
]);

/** True when the given block type may contain nested children. */
export function isContainerBlockType(type: string): boolean {
  return CONTAINER_BLOCK_TYPES.has(type);
}

/**
 * Extract the rich_text array from a block's type-specific payload,
 * regardless of which block type carries it. Returns undefined for
 * blocks that don't have rich_text (image, divider, table, etc.).
 *
 * Replaces the inline pattern `block.paragraph?.rich_text` etc that
 * application code was using at ~10 sites with a single conditional.
 */
export function getBlockRichText(block: NotionBlock): NotionRichText[] | undefined {
  // Dynamic index access is the documented pattern for Notion blocks
  // (see api-types.ts). Block-data-bearing types are: paragraph,
  // heading_*, list items, toggle, quote, callout, code, to_do.
  const data = (block as unknown as Record<string, unknown>)[block.type] as
    { rich_text?: NotionRichText[] } | undefined;
  return data?.rich_text;
}

/**
 * Walk a block's rich text and return every page/database/data_source
 * mention. Used by discovery to find inline page/database references.
 * Returns [] for blocks without rich text.
 */
export function getBlockMentions(block: NotionBlock): MentionRef[] {
  const rt = getBlockRichText(block);
  if (!rt) return [];
  const out: MentionRef[] = [];
  for (const segment of rt) {
    const ref = getMentionRef(segment);
    if (ref) out.push(ref);
  }
  return out;
}

/**
 * Return the child page id from a child_page block, or null when
 * the block is not a child_page or has no id.
 *
 * Per Notion's wire format the block's own `id` IS the child page id
 * (the type-specific `child_page.title` payload doesn't carry the id).
 */
export function getChildPageId(block: NotionBlock): string | null {
  if (block.type !== 'child_page' || !block.id) return null;
  return block.id;
}

/**
 * Return the child database id from a child_database block, or null
 * when not that type. Same rule as getChildPageId: the block's id
 * IS the child database id.
 */
export function getChildDatabaseId(block: NotionBlock): string | null {
  if (block.type !== 'child_database' || !block.id) return null;
  return block.id;
}

/**
 * Return the link target {type, id} from a link_to_page block, or null
 * when not a link_to_page. The block payload carries either page_id
 * or database_id depending on what the link points to.
 */
export function getLinkTarget(
  block: NotionBlock,
): { type: 'page' | 'database'; id: string } | null {
  if (block.type !== 'link_to_page') return null;
  const data = block.link_to_page;
  if (!data) return null;
  if (data.page_id) return { type: 'page', id: data.page_id };
  if (data.database_id) return { type: 'database', id: data.database_id };
  return null;
}

// ── Property ───────────────────────────────────────────

/**
 * Get the text content from a 'title'-typed property. Returns ''
 * for non-title properties or empty title arrays.
 */
export function getTitlePropertyText(prop: NotionPropertyResponse): string {
  if (prop.type !== 'title') return '';
  return getPlainText(prop.title);
}

// ── View ───────────────────────────────────────────────

/**
 * Map Notion's view type strings to the canonical labels N2O uses for
 * .base files. Returns null for unmapped types (e.g. 'chart' which
 * N2O does not support).
 *
 * Centralised so a future Notion view type only adds a single line
 * here instead of being scattered across linked-view-resolver and
 * registry-builder.
 */
export function getViewTypeLabel(view: NotionViewDetail): string | null {
  const t = view.type;
  switch (t) {
    case 'table':
      return 'table';
    case 'gallery':
      return 'gallery';
    case 'list':
      return 'list';
    case 'board':
      return 'board';
    case 'timeline':
      return 'timeline';
    case 'calendar':
      return 'calendar';
    default:
      return null; // 'chart' and unknown types
  }
}

/**
 * Extract visible property IDs from a view's configuration. Used by
 * the .base generator to render the columns the user actually sees in
 * Notion. Returns [] when the view config has no properties array.
 */
export function getViewVisiblePropertyIds(view: NotionViewDetail): string[] {
  const props = view.configuration?.properties;
  if (!props || props.length === 0) return [];
  return props.filter((p) => p.visible).map((p) => p.property_id);
}
