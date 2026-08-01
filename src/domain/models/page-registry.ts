/**
 * PageRegistryEntry + PageRegistryReader - domain-level types for the page registry.
 *
 * Lives in domain so infrastructure adapters can reference these types
 * without importing from the application layer.
 */

import type { DataSourceId } from './notion-id';

/** Translated Notion view filter for Obsidian Bases YAML. */
export interface BasesFilterExpression {
  /** Frontmatter key (kebab-case), e.g. "relationship-type" */
  key: string;
  /** Bases comparison operator */
  operator: '==' | '!=' | 'contains';
  /** Filter value(s) - OR logic within a single property */
  values: string[];
  /**
   * True when values are page names that must be wrapped with link().
   * Serialized as `list(note["key"]).contains(link("value"))` instead of
   * the plain `note["key"] contains "value"` form.
   * Used for Notion relation-type properties stored as wikilinks.
   */
  valueIsLink?: boolean;
}

/** Context carried by linked-view registry entries. */
export interface LinkedViewContext {
  /** Notion ID of the source database */
  sourceDatabaseId: string;
  /** Vault folder path of the source database (for file.inFolder filter) */
  sourceDatabaseFolder: string;
  /** Translated Bases filter expressions from the Notion view's property_filters */
  filters: BasesFilterExpression[];
  /** Detected view type from the Notion view (table/gallery -> cards/list) */
  viewType?: 'table' | 'cards' | 'list';
  /** Notion ID of the page containing this linked view - used for filename disambiguation */
  parentPageId?: string;
  /** Title of the page containing this linked view - included in .base filename for context */
  parentPageTitle?: string;
  /** Notion property IDs visible in this view (from the Views API view format) */
  visiblePropertyIds?: string[];
  /** Bases image expression for gallery cover (e.g., "note.banner", "note.media"). Derived from Views API cover config. */
  coverImage?: string;
}

export interface PageRegistryEntry {
  /** Notion page or database UUID (no dashes) */
  notionId: string;
  /** Display title */
  title: string;
  /** 'page' | 'database' | 'database-item' | 'linked-view' */
  type: 'page' | 'database' | 'database-item' | 'linked-view';
  /** Parent database Notion ID (for database items) */
  parentDatabaseId?: string;
  /** Parent PAGE Notion ID (normalized). Lets the breadcrumb resolver walk the
   *  ancestor chain via the registry alone, independent of sync-record timing. */
  parentPageId?: string;
  /** Sanitized file name (no extension) */
  fileName: string;
  /** Full vault-relative path (e.g. "Notion/My Page.md" or "Notion/DB Name/Item.md") */
  vaultPath: string;
  /** Folder this entry lives in (e.g. "Notion" or "Notion/DB Name") */
  folder: string;
  /** Notion last_edited_time (ISO string) - used for incremental sync */
  lastEditedTime?: string;
  /** Detected primary view type from the Views API (used as default for .base generation) */
  viewType?: 'table' | 'cards' | 'list';
  /**
   * Canonical data_source ID for databases (resolves block UUID -> modern
   * 2025-09-03+ API ID). Branded so the type system distinguishes it from
   * the block UUID; downstream API helpers refuse a raw `notionId` where
   * a `DataSourceId` is required, catching the data_source-vs-block-id
   * confusion that produced past linked-view-filter regressions.
   */
  dataSourceId?: DataSourceId;
  /** Context for linked-view entries - source database reference and translated filters */
  linkedViewContext?: LinkedViewContext;
  /** Notion property IDs visible in the primary view (from the Views API) */
  visiblePropertyIds?: string[];
  /** Bases image expression for gallery cover (e.g., "note.banner"). From Views API cover config. */
  coverImage?: string;
  /**
   * Every detected Notion view on this database, preserved for 1:1 generation
   * of YAML view entries in the .base file. When present and non-empty,
   * bases-generator MUST use these instead of the 7 hardcoded defaults.
   * Built during discovery via the Views API.
   */
  views?: DetectedView[];
}

/**
 * A single Notion view detected during discovery.
 * Written as one YAML view entry in the source database's .base file.
 * Invariant: one-to-one mapping from Notion view to Bases view - no data is
 * discarded, no hardcoded defaults replace detected views.
 */
export interface DetectedView {
  /** Stable Notion view id (collection_view id) */
  id: string;
  /** User-facing name from Notion (e.g. "Reading Queue", "By Priority") */
  name: string;
  /** Bases view type, already mapped from Notion (table/cards/list) */
  type: 'table' | 'cards' | 'list';
  /** Notion property IDs visible in this view (column order + visibility) */
  visiblePropertyIds?: string[];
  /** Cover image expression for cards-type views (e.g. "note.avatar") */
  coverImage?: string;
  /** Translated filter expressions from this view (quick_filters + view.filter) */
  filters?: BasesFilterExpression[];
}

/**
 * Read-only subset of PageRegistry used by infrastructure adapters.
 * Infrastructure imports this interface; the application layer implements it.
 */
export interface PageRegistryReader {
  getWikilinkTarget(notionId: string, fallbackName?: string): string;
  getAllEntries(): PageRegistryEntry[];
  isDatabaseEntry(notionId: string): boolean;
}
