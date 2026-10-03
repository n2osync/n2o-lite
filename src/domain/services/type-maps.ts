/**
 * Shared type mappings between Notion API types and N2O internal types.
 *
 * Single source of truth for:
 * - Block type mapping (Notion <-> N2O)
 * - Property type mapping (Notion -> N2O)
 * - Read-only property type detection
 */

import type { N2OBlockType } from '../models/block';
import type { N2OPropertyType } from '../models/property';

// ── Block Type Maps ─────────────────────────────────────────

/** Forward mapping: Notion API block type -> N2OBlockType */
export const NOTION_BLOCK_TYPE_MAP: Record<string, N2OBlockType> = {
  paragraph: 'paragraph',
  heading_1: 'heading1',
  heading_2: 'heading2',
  heading_3: 'heading3',
  heading_4: 'heading4',
  bulleted_list_item: 'bulletList',
  numbered_list_item: 'numberedList',
  to_do: 'todo',
  toggle: 'toggle',
  quote: 'quote',
  callout: 'callout',
  code: 'code',
  divider: 'divider',
  image: 'image',
  video: 'video',
  audio: 'audio',
  file: 'file',
  pdf: 'pdf',
  bookmark: 'bookmark',
  embed: 'embed',
  // link_preview is pull-only: the API cannot create it, so push preserves the
  // existing Notion block (SKIP_BLOCK_TYPES + a null build) rather than emitting
  // one. The auto-generated reverse entry (linkPreview -> link_preview) is unused
  // and must never be wired into block creation.
  link_preview: 'linkPreview',
  equation: 'equation',
  table: 'table',
  table_row: 'tableRow',
  column_list: 'columnList',
  column: 'column',
  child_page: 'pageLink',
  child_database: 'databaseLink',
  synced_block: 'syncedBlock',
  table_of_contents: 'tableOfContents',
  breadcrumb: 'breadcrumb',
  link_to_page: 'pageLink',
};

/** Maps a Notion property type to its N2O property type. */
export const NOTION_PROPERTY_TYPE_MAP: Record<string, N2OPropertyType> = {
  title: 'title',
  rich_text: 'text',
  number: 'number',
  select: 'select',
  multi_select: 'multiSelect',
  status: 'status',
  date: 'date',
  checkbox: 'checkbox',
  url: 'url',
  email: 'email',
  phone_number: 'phone',
  people: 'people',
  files: 'files',
  relation: 'relation',
  formula: 'formula',
  rollup: 'rollup',
  created_time: 'createdTime',
  last_edited_time: 'lastEditedTime',
  created_by: 'createdBy',
  last_edited_by: 'lastEditedBy',
  unique_id: 'uniqueId',
};

/** Notion API property types that are read-only (computed by Notion, not user-editable). */
export const NOTION_READ_ONLY_PROPERTY_TYPES: ReadonlySet<string> = new Set([
  'formula',
  'rollup',
  'created_time',
  'last_edited_time',
  'created_by',
  'last_edited_by',
  'unique_id',
]);
