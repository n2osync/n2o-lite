/**
 * N2OBlock - Intermediate block format for sync engine.
 * Maps between Notion blocks and Markdown elements.
 */

export interface N2OBlock {
  /** Block identifier (Notion block ID or generated) */
  id: string;
  /** Block type */
  type: N2OBlockType;
  /** Rich text content */
  content: N2ORichText[];
  /** Nested child blocks (for toggles, lists, callouts, etc.) */
  children?: N2OBlock[];
  /** Type-specific metadata */
  meta: BlockMeta;
  /**
   * Optional block format metadata carried through the Obsidian merge
   * round-trip. In Lite the only field ever populated is blockWidth - a
   * locally-set image/media width (`![[img|300]]`) that must survive a re-pull.
   */
  format?: N2OBlockFormat;
}

export type N2OBlockType =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  // Official REST API exposes heading_4 as of Notion version 2025-09-03 (also
  // present in the unofficial RecordMap API). H5/H6 do not exist in Notion.
  | 'heading4'
  | 'bulletList'
  | 'numberedList'
  | 'todo'
  | 'toggle'
  | 'quote'
  | 'callout'
  | 'code'
  | 'divider'
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'pdf'
  | 'bookmark'
  | 'embed'
  // Notion's block-level link_preview (a connected-app live card, e.g. a GitHub
  // PR or Jira ticket). The official API exposes ONLY its URL and cannot create
  // or append these blocks, so N2O renders it as a read-only bookmark card and
  // preserves the original Notion block on push (never recreates it).
  | 'linkPreview'
  | 'equation'
  | 'table'
  | 'tableRow'
  | 'columnList'
  | 'column'
  | 'pageLink'
  | 'databaseLink'
  | 'syncedBlock'
  | 'tableOfContents'
  | 'breadcrumb'
  | 'unsupported';

/** Type-specific metadata for blocks */
export type BlockMeta =
  | ParagraphMeta
  | HeadingMeta
  | TodoMeta
  | CodeMeta
  | CalloutMeta
  | ImageMeta
  | BookmarkMeta
  | EquationMeta
  | TableMeta
  | TableRowMeta
  | SyncedBlockMeta
  | BreadcrumbMeta
  | PageLinkMeta
  | ColumnListMeta
  | ColumnMeta
  | NumberedListMeta
  | EmptyMeta;

/**
 * Optional block format metadata carried through the Obsidian merge round-trip.
 * In Lite the only field is blockWidth - a locally-set image/media width
 * (`![[img|300]]`) that must survive a re-pull; there is no enricher.
 */
export interface N2OBlockFormat {
  /** Image/media explicit width in pixels, from the `|width` embed syntax. */
  blockWidth?: number;
}

export interface EmptyMeta {
  kind: 'empty';
}

export interface ParagraphMeta {
  kind: 'paragraph';
  color?: string;
}

export interface HeadingMeta {
  kind: 'heading';
  level: 1 | 2 | 3 | 4;
  isToggleable?: boolean;
  color?: string;
}

export interface TodoMeta {
  kind: 'todo';
  checked: boolean;
  color?: string;
}

export interface CodeMeta {
  kind: 'code';
  language: string;
  caption?: string;
}

export interface CalloutMeta {
  kind: 'callout';
  calloutType: string;
  icon?: string;
  color?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
}

export interface ImageMeta {
  kind: 'image';
  url: string;
  caption?: string;
  /** 'external' | 'file' (Notion-hosted) | 'local' (vault) */
  sourceType: 'external' | 'file' | 'local';
  width?: number;
  height?: number;
  /** Original filename from Notion API (file blocks only). Used for clean local filenames. */
  originalFilename?: string;
  /**
   * Set when an external image could not be downloaded (dead source URL). The
   * renderer emits an honest fallback (link + note) instead of a broken embed;
   * see image-unavailable-marker.ts. Cleared when a later pull downloads it.
   */
  unavailable?: boolean;
}

export interface BookmarkMeta {
  kind: 'bookmark';
  url: string;
  /** Fetched page title (RecordMap enricher og:title); never the caption. */
  title?: string;
  description?: string;
  /** The user's caption - renders BELOW the card, like Notion. */
  caption?: string;
}

export interface EquationMeta {
  kind: 'equation';
  expression: string;
}

export interface TableMeta {
  kind: 'table';
  width: number;
  hasColumnHeader: boolean;
  hasRowHeader: boolean;
}

export interface TableRowMeta {
  kind: 'tableRow';
  cells: N2ORichText[][];
}

export interface SyncedBlockMeta {
  kind: 'syncedBlock';
  /** null = this IS the original. string = reference to original block ID */
  syncedFrom: string | null;
  /**
   * DERIVED (#1719): the wikilink target (vault basename) of the page the
   * original lives on, resolved by enrichSyncedReferences from the location
   * index before the markdown is built. When present, a reference renders the
   * cross-page embed `![[<syncedFromPage>#^<syncedFrom>]]`; when absent (the
   * original has not been indexed yet), it falls back to the current-file form.
   * Not round-tripped - rebuilt on every pull, like breadcrumbPath.
   */
  syncedFromPage?: string;
}

/** One segment of a breadcrumb block's ancestor chain. */
export interface BreadcrumbSegment {
  /** Ancestor display title, as Notion shows it in the breadcrumb. */
  title: string;
  /**
   * Wikilink target (vault file basename, no extension) when the ancestor is
   * a synced note in the vault. Absent when there is no note to open - a
   * database ancestor is a folder, an unsynced ancestor has no file - and the
   * renderer emits the title as plain text instead.
   */
  linkTarget?: string;
}

export interface BreadcrumbMeta {
  kind: 'breadcrumb';
  /**
   * Ancestor chain, root-first, EXCLUDING the page itself - the renderer
   * appends the page's own title from the document being built. Populated by
   * the pull pipeline via enrichBreadcrumbBlocks (see
   * domain/services/breadcrumb-path.ts) before markdown is built. Absent when
   * the chain could not be resolved (orphan page, registry not in scope); the
   * renderer then falls back to the page's own title alone.
   */
  breadcrumbPath?: BreadcrumbSegment[];
}

export interface PageLinkMeta {
  kind: 'pageLink';
  pageId: string;
  pageName?: string;
  /** True when this was an Obsidian embed/transclusion `![[note]]` rather than a plain wikilink `[[note]]` */
  isEmbed?: boolean;
}

export interface ColumnListMeta {
  kind: 'columnList';
}

export interface ColumnMeta {
  kind: 'column';
  /** Column title text (from the callout title in Obsidian) */
  title?: string;
  /** Callout type used in Obsidian rendering (default: 'column') */
  calloutType?: string;
  /** Column width ratio from Notion API (e.g. 0.5 = 50% width). Preserved for round-trip. */
  widthRatio?: number;
}

export interface NumberedListMeta {
  kind: 'numberedList';
  /** Starting index for numbered lists (default: 1). Notion `list_start_index` API field. */
  startIndex?: number;
  /** List format from Notion: 'numbers' (default), 'letters' (a,b,c), or 'roman' (i,ii,iii). */
  listFormat?: 'numbers' | 'letters' | 'roman';
  color?: string;
}

/**
 * Rich text segment with annotations.
 */
export interface N2ORichText {
  /** Plain text content */
  text: string;
  /** Text annotations */
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  code?: boolean;
  /** Text or background color */
  color?: string;
  /** Hyperlink URL */
  link?: string;
  /** Mention reference */
  mention?: N2OMention;
  /** Inline equation expression (e.g. "E = mc^2"). When set, text holds plain_text fallback. */
  equation?: string;
}

export interface N2OMention {
  type:
    'page' | 'database' | 'user' | 'date' | 'template_mention' | 'link_preview' | 'link_mention';
  id: string;
  name?: string;
  /** For date mentions */
  dateStart?: string;
  dateEnd?: string;
  /** For date mentions: IANA time zone (e.g. "America/New_York"), carried for round-trip (#1525). */
  dateTimeZone?: string;
  /** For template_mention: which template type (@today, @now, @me) */
  templateType?: 'today' | 'now' | 'me';
  /** For link_preview mentions: the preview URL */
  previewUrl?: string;
  /**
   * For `link_mention` mentions (#1724): the metadata Notion returns in the
   * OFFICIAL API for an inline link chip, so N2O renders the same chip Notion
   * shows without any live fetch or extended metadata.
   */
  linkHref?: string;
  linkTitle?: string;
  linkIcon?: string;
  linkDescription?: string;
  linkProvider?: string;
}
