/**
 * N2ODocument - The intermediate format used by the sync engine.
 * Both Notion and Obsidian adapters convert to/from this format.
 */

import type { N2OBlock } from './block';
import type { N2OProperty } from './property';
import type { N2OAttachment } from './sync-record';

export interface N2ODocument {
  /** Internal N2O identifier */
  id: string;
  /** Notion page UUID (if synced) */
  notionId?: string;
  /** Vault-relative file path (if synced) */
  obsidianPath?: string;
  /** Page/note title */
  title: string;
  /** Page icon (emoji or URL) */
  icon?: string;
  /** Page banner image URL (thumbnail path if thumbnail was generated) */
  banner?: string;
  /** Full-resolution banner image path (when thumbnail exists in `banner`) */
  bannerOriginal?: string;
  /** Database/frontmatter properties */
  properties: N2OProperty[];
  /** Content blocks */
  blocks: N2OBlock[];
  /** Child pages/sub-documents */
  children: N2ODocumentRef[];
  /** File attachments referenced in this document */
  attachments: N2OAttachment[];
  /** Document metadata */
  metadata: N2ODocumentMetadata;
}

export interface N2ODocumentRef {
  id: string;
  notionId?: string;
  obsidianPath?: string;
  title: string;
}

export interface N2ODocumentMetadata {
  createdTime: string;
  lastEditedTime: string;
  createdBy?: string;
  lastEditedBy?: string;
  /** 'page' | 'database' | 'database-item' */
  type: N2ODocumentType;
  /** Parent database ID (for database items) */
  parentDatabaseId?: string;
  /** Notion parent UUID (database or page) - written to frontmatter for recovery */
  parentId?: string;
  /** Parent kind - 'database' or 'page' */
  parentType?: 'database' | 'page';
  /** Notion page URL */
  notionUrl?: string;
}

export type N2ODocumentType = 'page' | 'database' | 'database-item';
