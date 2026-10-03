/**
 * Notion API wire-format type definitions.
 *
 * Describe the shape of HTTP responses from the Notion REST API and the
 * payloads that go back over the wire on writes. These types live in
 * `domain/models/` rather than `infrastructure/notion/` because they are
 * an external-system contract that BOTH layers reference. Keeping them
 * in infrastructure forced application code (sync-page, registry-builder,
 * etc.) to import "upward" through the layer hierarchy, which violated
 * the architectural rule. Locating them in domain inverts the import
 * direction without adding a no-op adapter.
 *
 * No I/O code in this file - just structural type definitions. Domain
 * services that operate on these types (parent-utils, notion-entity-ops)
 * also live in `domain/services/`.
 *
 * Design: fields are optional where they may be absent in read or write
 * mode, allowing the same types to represent both API responses and
 * request payloads. Only fields actually accessed by the codebase are
 * typed.
 */

// ── Rich Text ──────────────────────────────────────────

export interface NotionAnnotations {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  underline: boolean;
  code: boolean;
  color: string;
}

export interface NotionRichText {
  type: 'text' | 'mention' | 'equation';
  /** Present in API responses (read mode). */
  plain_text?: string;
  /** Present in API responses (read mode). */
  href?: string | null;
  annotations?: NotionAnnotations;
  /** Text content - present for type='text' and in write payloads. */
  text?: { content: string; link: { url: string } | null };
  /** Equation data - present for type='equation'. */
  equation?: { expression: string };
  /** Mention data - present for type='mention'. */
  mention?: NotionMention;
}

export interface NotionMention {
  type: string;
  page?: { id: string };
  database?: { id: string };
  data_source?: { id: string };
  user?: { id: string; object?: string; name?: string };
  date?: { start: string; end?: string | null; time_zone?: string | null };
  link_preview?: { url: string };
  link_mention?: {
    href: string;
    title?: string;
    icon_url?: string;
    description?: string;
    link_provider?: string;
    thumbnail_url?: string;
  };
  template_mention?: {
    type: string;
    template_mention_date?: string;
    template_mention_user?: string;
  };
}

// ── Icon & Cover ───────────────────────────────────────

export type NotionIcon =
  | { type: 'emoji'; emoji: string }
  | { type: 'external'; external: { url: string } }
  | { type: 'file'; file: { url: string; expiry_time?: string } }
  | { type: 'custom_emoji'; custom_emoji: { id: string; name?: string; url?: string } }
  | { type: 'icon'; icon: { name: string; color?: string } };

export type NotionCover =
  | { type: 'external'; external: { url: string } }
  | { type: 'file'; file: { url: string; expiry_time?: string } };

// ── Parent ─────────────────────────────────────────────

export interface NotionParent {
  type: string;
  page_id?: string;
  database_id?: string;
  data_source_id?: string;
  workspace?: boolean;
}

// ── Block Data ─────────────────────────────────────────

/**
 * Union payload type for a block's type-specific data.
 * Accessed as `block[block.type]` or via named fields on NotionBlock.
 * Only the fields relevant to the block type will be populated.
 */
export interface NotionBlockData {
  // Rich text content (paragraph, heading, list items, toggle, quote, callout, code, to_do)
  rich_text?: NotionRichText[];
  color?: string;

  // Code
  language?: string;
  caption?: NotionRichText[];

  // Callout
  icon?: NotionIcon | null;

  // To-do
  checked?: boolean;

  // Equation
  expression?: string;

  // Bookmark / embed
  url?: string;

  // Media (image, video, audio, file, pdf) - source type discriminator
  type?: string;
  file?: { url: string; expiry_time?: string };
  external?: { url: string };
  file_upload?: { id: string };
  /** Original filename as displayed in Notion UI (present on file blocks). */
  name?: string;

  // Table
  table_width?: number;
  has_column_header?: boolean;
  has_row_header?: boolean;

  // Table row
  cells?: NotionRichText[][];

  // Synced block
  synced_from?: { block_id: string } | null;

  // Heading
  is_toggleable?: boolean;

  // Child page / child database
  title?: string;

  // Link to page
  page_id?: string;
  database_id?: string;
  data_source_id?: string;

  // Numbered list item
  list_start_index?: number;
  list_format?: string;

  // Column
  width_ratio?: number;

  // Children (write-mode blocks include children inside the payload)
  children?: NotionBlock[];
}

// ── Block ──────────────────────────────────────────────

/**
 * Notion API block object - represents both read-mode (API response)
 * and write-mode (API request) blocks.
 */
export interface NotionBlock {
  /** Block ID - present in read mode, absent in write mode. */
  id?: string;
  object?: 'block';
  type: string;
  /** Whether the block has children - present in read mode. */
  has_children?: boolean;
  created_time?: string;
  last_edited_time?: string;
  parent?: NotionParent;
  archived?: boolean;

  // Block type payloads - only the one matching `type` is present.
  paragraph?: NotionBlockData;
  heading_1?: NotionBlockData;
  heading_2?: NotionBlockData;
  heading_3?: NotionBlockData;
  heading_4?: NotionBlockData;
  bulleted_list_item?: NotionBlockData;
  numbered_list_item?: NotionBlockData;
  to_do?: NotionBlockData;
  toggle?: NotionBlockData;
  quote?: NotionBlockData;
  callout?: NotionBlockData;
  code?: NotionBlockData;
  divider?: NotionBlockData;
  image?: NotionBlockData;
  video?: NotionBlockData;
  audio?: NotionBlockData;
  file?: NotionBlockData;
  pdf?: NotionBlockData;
  bookmark?: NotionBlockData;
  embed?: NotionBlockData;
  equation?: NotionBlockData;
  table?: NotionBlockData;
  table_row?: NotionBlockData;
  column_list?: NotionBlockData;
  column?: NotionBlockData;
  synced_block?: NotionBlockData;
  child_page?: NotionBlockData;
  child_database?: NotionBlockData;
  link_to_page?: NotionBlockData;
  table_of_contents?: NotionBlockData;
  breadcrumb?: NotionBlockData;

  /** Block children - injected by client's recursive fetch (read mode). */
  children?: NotionBlock[];
}

/**
 * Extract the type-specific payload from a block using its `type` field.
 * This helper quarantines the one unavoidable dynamic `block[block.type]`
 * access; the type itself carries no blanket index signature, so a typo like
 * `block.paragrph` no longer silently compiles as `unknown` (#1589).
 */
export function getBlockData(block: NotionBlock): NotionBlockData | undefined {
  return (block as unknown as Record<string, unknown>)[block.type] as NotionBlockData | undefined;
}

// ── Page ───────────────────────────────────────────────

export interface NotionPage {
  id: string;
  object?: 'page';
  url: string;
  created_time: string;
  last_edited_time: string;
  icon?: NotionIcon | null;
  cover?: NotionCover | null;
  properties: Record<string, NotionPropertyResponse>;
  parent: NotionParent;
  archived?: boolean;
  in_trash?: boolean;
  is_locked?: boolean;
  has_children?: boolean;
}

// ── Property Responses (read mode) ─────────────────────

/**
 * A single property value as returned by the Notion API in a page response.
 * The actual value is under `prop[prop.type]`.
 */
export interface NotionPropertyResponse {
  id: string;
  type: string;

  // Property type payloads - only the one matching `type` is populated.
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  number?: number | null;
  checkbox?: boolean;
  select?: { id?: string; name: string; color?: string } | null;
  multi_select?: Array<{ id?: string; name: string; color?: string }>;
  status?: { id?: string; name: string; color?: string } | null;
  date?: { start: string; end?: string | null; time_zone?: string | null } | null;
  people?: NotionUser[];
  files?: NotionFileReference[];
  relation?: Array<{ id: string }>;
  formula?: NotionFormulaResult;
  rollup?: NotionRollupResult;
  url?: string | null;
  email?: string | null;
  phone_number?: string | null;
  created_time?: string;
  last_edited_time?: string;
  created_by?: NotionUser;
  last_edited_by?: NotionUser;
  unique_id?: { prefix: string | null; number: number };
}

export interface NotionUser {
  object?: 'user';
  id: string;
  name?: string;
  type?: string;
}

export interface NotionFileReference {
  type: string;
  name?: string;
  file?: { url: string; expiry_time?: string };
  external?: { url: string };
}

export interface NotionFormulaResult {
  type: string;
  string?: string | null;
  number?: number | null;
  boolean?: boolean | null;
  date?: { start: string; end?: string | null } | null;
}

export interface NotionRollupResult {
  type: string;
  number?: number | null;
  date?: { start: string; end?: string | null } | null;
  array?: unknown[];
}

// ── Bot / User Responses ──────────────────────────────

/** Response from GET /v1/users/me when the token belongs to a bot integration. */
export interface NotionBotUserResponse {
  object: 'user';
  id: string;
  name?: string;
  type?: string;
  bot?: {
    owner?: { type: string };
    workspace_name?: string;
  };
  workspace_name?: string;
}

// ── Database ───────────────────────────────────────────

export interface NotionDatabase {
  id: string;
  object?: 'database';
  title?: NotionRichText[];
  properties?: Record<string, NotionPropertySchema>;
  parent?: NotionParent;
  url?: string;
  archived?: boolean;
  created_time?: string;
  last_edited_time?: string;
  in_trash?: boolean;
}

/** Option entry for select, multi_select, and status property schemas. */
export interface NotionPropertyOption {
  id: string;
  name: string;
  color?: string;
}

/**
 * A property schema entry as returned by the Notion database endpoint.
 * The type-specific config (e.g. select, multi_select, relation) is stored
 * in a field matching the type name.
 */
export interface NotionPropertySchema {
  id: string;
  type: string;
  name: string;

  // Type-specific configuration - only the one matching `type` is populated.
  select?: { options?: NotionPropertyOption[] };
  multi_select?: { options?: NotionPropertyOption[] };
  status?: { options?: NotionPropertyOption[] };
  relation?: { data_source_id?: string; database_id?: string };
}

// ── API Response Wrappers ──────────────────────────────

export interface NotionPaginatedResponse<T> {
  object: 'list';
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
  type?: string;
}

export type NotionSearchResponse = NotionPaginatedResponse<NotionPage | NotionDatabase>;

// ── Views API (2025-09-03+) ──────────────────────────

export interface NotionViewStub {
  object: 'view';
  id: string;
}

export interface NotionViewDetail {
  object: 'view';
  id: string;
  type: string;
  name: string;
  parent: { type: string; database_id?: string; page_id?: string };
  data_source_id: string;
  created_time: string;
  last_edited_time: string;
  url: string;
  filter: Record<string, unknown> | null;
  sorts: unknown[] | null;
  quick_filters: Record<string, Record<string, Record<string, unknown>>> | null;
  configuration: {
    type: string;
    properties?: NotionViewProperty[];
    cover?: { type: string };
    cover_size?: string;
    cover_aspect?: string;
  };
}

export interface NotionViewProperty {
  property_id: string;
  visible: boolean;
  wrap?: boolean;
}
