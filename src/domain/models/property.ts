/**
 * N2OProperty - Intermediate property format.
 * Maps between Notion database properties and Obsidian YAML frontmatter.
 */

export interface N2OProperty {
  /** Property name (display name) */
  name: string;
  /** Sanitized key for YAML frontmatter */
  key: string;
  /** Property type */
  type: N2OPropertyType;
  /** Property value */
  value: N2OPropertyValue;
  /** Notion property ID (for API writes) */
  notionPropertyId?: string;
  /** Whether this property is read-only (formula, rollup, created_time, etc.) */
  readOnly?: boolean;
}

export type N2OPropertyType =
  | 'title'
  | 'text'
  | 'number'
  | 'select'
  | 'multiSelect'
  | 'status'
  | 'date'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'phone'
  | 'people'
  | 'files'
  | 'relation'
  | 'formula'
  | 'rollup'
  | 'createdTime'
  | 'lastEditedTime'
  | 'createdBy'
  | 'lastEditedBy'
  | 'uniqueId';

export type N2OPropertyValue =
  string | number | boolean | null | string[] | N2ODateValue | N2ORelationValue[] | N2OFormulaValue;

export interface N2ODateValue {
  start: string;
  end?: string;
  timeZone?: string;
}

export interface N2ORelationValue {
  id: string;
  name?: string;
}

export interface N2OFormulaValue {
  type: 'string' | 'number' | 'boolean' | 'date';
  value: string | number | boolean | null;
}

/**
 * Database schema definition - describes the shape of a Notion database.
 */
export interface N2ODatabaseSchema {
  /** Database Notion ID */
  notionId: string;
  /** Database title */
  title: string;
  /** Property definitions */
  properties: N2OPropertyDefinition[];
}

export interface N2OPropertyDefinition {
  name: string;
  key: string;
  type: N2OPropertyType;
  notionPropertyId: string;
  /** Available options for select/multi-select/status */
  options?: N2OSelectOption[];
  /** Related database ID for relation properties */
  relationDatabaseId?: string;
}

export interface N2OSelectOption {
  id: string;
  name: string;
  color?: string;
}
