/**
 * Shared utilities for extracting parent information from Notion page responses.
 *
 * Pure functions over Notion's wire-format `NotionParent` shape. Lives in
 * domain/services/ because the operations are stateless transforms with
 * no I/O - they're domain logic over an external-system contract type.
 *
 * Consolidates logic that was duplicated between:
 * - NotionParser (private instance methods getParentId, getParentType, etc.)
 * - pull-apply-phase.ts (exported free functions extractParentId, extractParentContainerType)
 */

import type { NotionParent } from '../models/notion-api-types';

/**
 * Extract the parent ID from a Notion parent object.
 * Covers database_id, data_source_id (bases), and page_id parents.
 * Returns the ID with hyphens stripped (matches Notion SDK convention).
 */
export function extractParentId(parent: NotionParent | undefined): string | undefined {
  if (!parent) return undefined;
  if (parent.type === 'database_id') return parent.database_id?.replace(/-/g, '');
  if (parent.type === 'data_source_id') return parent.data_source_id?.replace(/-/g, '');
  if (parent.type === 'page_id') return parent.page_id?.replace(/-/g, '');
  return undefined;
}

/**
 * Extract the parent container type from a Notion parent object.
 * Returns 'database' for database_id/data_source_id parents,
 * 'page' for page_id parents, undefined for workspace/unknown.
 */
export function extractParentContainerType(
  parent: NotionParent | undefined,
): 'database' | 'page' | undefined {
  if (!parent) return undefined;
  if (parent.type === 'database_id' || parent.type === 'data_source_id') return 'database';
  if (parent.type === 'page_id') return 'page';
  return undefined;
}

/**
 * Determine the N2ODocument item type from a Notion parent object.
 * A page whose parent is a database is a 'database-item'; all others are 'page'.
 */
export function getItemTypeFromParent(parent: NotionParent | undefined): 'page' | 'database-item' {
  return extractParentContainerType(parent) === 'database' ? 'database-item' : 'page';
}
