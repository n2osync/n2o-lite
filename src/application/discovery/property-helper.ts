/**
 * PropertyHelper - Database schema parsing and property remapping.
 *
 * Extracted from SyncEngine to isolate property-related logic:
 * - Parse Notion database response into N2OPropertyDefinition[]
 * - Remap frontmatter properties to Notion names/types for push
 * - Resolve page IDs from user-configured URLs
 *
 * Page title extraction moved to domain/services/notion-entity-ops.ts
 * as `getPageTitle()` in Phase H step 3.
 */

import type {
  N2OProperty,
  N2OPropertyDefinition,
  N2OPropertyType,
  N2OPropertyValue,
} from '../../domain/models/property';
import { coerceString } from '../../shared/coerce';
import type { NotionDatabase } from '../../domain/models/notion-api-types';
import { NOTION_PROPERTY_TYPE_MAP } from '../../domain/services/type-maps';
import { extractNotionPageId, propertyToFrontmatterKey } from '../../shared/sanitize';
import { createLogger } from '../../shared/logger';

const log = createLogger('PropertyHelper');

/** Notion API type -> N2O type mapping. */
// Property type mapping is the single source of truth in type-maps.ts (NOTION_PROPERTY_TYPE_MAP)

/** Property types that cannot be written via the Notion API. */
const READ_ONLY_TYPES = new Set<string>([
  'formula',
  'rollup',
  'createdTime',
  'lastEditedTime',
  'createdBy',
  'lastEditedBy',
  'uniqueId',
]);

/**
 * Coerce a property value when its inferred type differs from the database schema type.
 * Frontmatter inference is best-effort; the schema is authoritative.
 */
function coerceValue(
  value: N2OPropertyValue,
  fromType: N2OPropertyType,
  toType: N2OPropertyType,
): N2OPropertyValue {
  if (fromType === toType) return value;

  // text -> number: parse string to number
  if (toType === 'number' && typeof value === 'string') {
    const n = Number(value);
    return isNaN(n) ? null : n;
  }

  // text -> checkbox: parse string to boolean
  if (toType === 'checkbox' && typeof value === 'string') {
    return value.toLowerCase() === 'true' || value === '1';
  }

  // text -> multiSelect: wrap single string in array
  if (toType === 'multiSelect' && typeof value === 'string') {
    return [value];
  }

  // number/boolean -> text: stringify
  if (toType === 'text' && (typeof value === 'number' || typeof value === 'boolean')) {
    return String(value);
  }

  // multiSelect -> select: take first element
  if (toType === 'select' && Array.isArray(value)) {
    return value.length > 0 ? coerceString(value[0]) : null;
  }

  return value;
}

export class PropertyHelper {
  /**
   * Parse a Notion database response's properties into N2OPropertyDefinition[].
   * Reuses the same type mapping as NotionParser.mapPropertyType().
   */
  parseSchema(dbResponse: NotionDatabase): N2OPropertyDefinition[] {
    const properties = dbResponse.properties;
    if (!properties) return [];

    const defs: N2OPropertyDefinition[] = [];
    for (const [name, propConfig] of Object.entries(properties)) {
      const notionType = propConfig.type;
      const n2oType = NOTION_PROPERTY_TYPE_MAP[notionType] ?? 'text';

      const def: N2OPropertyDefinition = {
        name,
        key: propertyToFrontmatterKey(name),
        type: n2oType,
        notionPropertyId: propConfig.id ?? '',
      };

      // Extract options for select/multi-select/status
      if (notionType === 'select' && propConfig.select) {
        def.options = propConfig.select.options?.map((o) => ({
          id: o.id,
          name: o.name,
          color: o.color,
        }));
      } else if (notionType === 'multi_select' && propConfig.multi_select) {
        def.options = propConfig.multi_select.options?.map((o) => ({
          id: o.id,
          name: o.name,
          color: o.color,
        }));
      } else if (notionType === 'status' && propConfig.status) {
        def.options = propConfig.status.options?.map((o) => ({
          id: o.id,
          name: o.name,
          color: o.color,
        }));
      }

      // Extract relation database ID (v2025-09-03 uses data_source_id, fallback to database_id)
      if (notionType === 'relation' && propConfig.relation) {
        def.relationDatabaseId =
          propConfig.relation.data_source_id ?? propConfig.relation.database_id;
      }

      defs.push(def);
    }

    return defs;
  }

  /**
   * Remap properties parsed from Obsidian frontmatter to use correct Notion names and types.
   * The ObsidianParser infers property names (kebab-cased) and types (guessed from values).
   * The database schema has the actual Notion property names, types, and read-only status.
   *
   * Returns `{ properties, dropped }`. `dropped` lists user-editable
   * properties the caller should surface as potential data loss - they
   * matched a frontmatter key but no column with that key exists in
   * the current schema (Notion column renamed or deleted between pulls,
   * F-018). Read-only-type skips are NOT considered data loss and are
   * not reported.
   */
  remapForPush(
    parsedProps: N2OProperty[],
    schema: N2OPropertyDefinition[],
  ): { properties: N2OProperty[]; dropped: Array<{ name: string; key: string; reason: string }> } {
    // Build lookup: kebab-key -> schema definition
    const schemaByKey = new Map<string, N2OPropertyDefinition>();
    for (const def of schema) {
      schemaByKey.set(def.key, def);
    }

    const result: N2OProperty[] = [];
    const dropped: Array<{ name: string; key: string; reason: string }> = [];

    for (const prop of parsedProps) {
      const schemaDef = schemaByKey.get(prop.key);
      if (!schemaDef) {
        /* No matching schema property - would cause Notion 400 if pushed.
         * This is the F-018 silent-drop path. Report to caller so the
         * user sees which frontmatter edit couldn't round-trip. */
        const reason = `No column named "${prop.name}" (key="${prop.key}") in the current database schema - column may have been renamed or deleted.`;
        log.warn(`Dropped property on push: ${reason}`);
        dropped.push({ name: prop.name, key: prop.key, reason });
        continue;
      }

      // Skip read-only properties (expected, not data loss)
      if (READ_ONLY_TYPES.has(schemaDef.type)) {
        log.debug(`Skipping read-only property "${schemaDef.name}" (${schemaDef.type})`);
        continue;
      }

      result.push({
        ...prop,
        name: schemaDef.name, // Original Notion property name
        type: schemaDef.type, // Correct Notion property type
        value: coerceValue(prop.value, prop.type, schemaDef.type),
        notionPropertyId: schemaDef.notionPropertyId,
        readOnly: false,
      });
    }

    return { properties: result, dropped };
  }

  /**
   * Extract valid Notion page IDs from the configured page list.
   */
  resolveIds(notionPages: string[]): string[] {
    const ids: string[] = [];
    for (const entry of notionPages) {
      const id = extractNotionPageId(entry);
      if (id) {
        ids.push(id);
      } else {
        log.warn(`Could not extract page ID from: ${entry}`);
      }
    }
    return ids;
  }
}
