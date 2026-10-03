/**
 * Property renderer - builds individual frontmatter property lines.
 */

import type { N2OProperty, N2ORelationValue } from '../../domain/models/property';
import type { PageRegistryReader } from '../../domain/models/page-registry';
import { needsYamlQuoting, formatDateHuman } from './yaml-formatter';
import { coerceString } from '../../shared/coerce';
import { escapeYamlString } from '../../shared/yaml';

/**
 * Format a media value for frontmatter: extract plain filename for local paths, keep URLs as-is.
 * Obsidian frontmatter doesn't render ![[embed]] syntax - use plain filenames instead.
 */
export function formatMediaValue(value: string): string {
  if (!value.includes('://')) {
    return value.split('/').pop() ?? value;
  }
  return value;
}

/**
 * Resolve a Notion page ID to a wikilink target using the registry.
 * Falls back to the provided name or raw ID.
 */
function resolveWikilink(
  pageRegistry: PageRegistryReader | null,
  notionId: string,
  fallbackName?: string,
): string {
  if (pageRegistry) {
    return pageRegistry.getWikilinkTarget(notionId, fallbackName);
  }
  return fallbackName ?? notionId;
}

/**
 * Build a single frontmatter property line.
 */
export function buildFrontmatterProperty(
  prop: N2OProperty,
  pageRegistry: PageRegistryReader | null,
  customKey?: string,
  format?: string,
): string | null {
  const key = customKey || prop.key;
  const value = prop.value;

  if (value === null || value === undefined) return null;

  // Skip title property (already used as filename)
  if (prop.type === 'title') return null;

  // Formula/rollup: extract the inner value to avoid [object Object]
  if (prop.type === 'formula' && typeof value === 'object' && 'type' in value && 'value' in value) {
    const inner = value as { type: string; value: unknown };
    if (inner.value === null || inner.value === undefined) return null;
    // Preserve native types (number/boolean) without quoting
    if (typeof inner.value === 'number' || typeof inner.value === 'boolean') {
      return `${key}: ${inner.value}`;
    }
    const strVal = coerceString(inner.value);
    if (needsYamlQuoting(strVal)) {
      return `${key}: "${escapeYamlString(strVal)}"`;
    }
    return `${key}: ${strVal}`;
  }
  if (prop.type === 'rollup') {
    if (typeof value === 'object' && !Array.isArray(value)) {
      return `${key}: ${JSON.stringify(value)}`;
    }
  }

  // Relation values -> resolve to wikilinks
  if (prop.type === 'relation' && Array.isArray(value)) {
    if (value.length === 0) return null;
    const items = (value as N2ORelationValue[]).map((rel) => {
      const target = resolveWikilink(pageRegistry, rel.id, rel.name);
      return `  - "[[${escapeYamlString(target)}]]"`;
    });
    return `${key}:\n${items.join('\n')}`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    // Multi-select as Obsidian tags - kebab-case, always uses 'tags' as key
    if (format === 'tags') {
      const tagItems = (value as string[]).map((v) => {
        const tag = String(v).toLowerCase().replace(/\s+/g, '-');
        return `  - "${escapeYamlString(tag)}"`;
      });
      return `tags:\n${tagItems.join('\n')}`;
    }
    // For files properties, render plain filenames (no embed syntax in YAML)
    if (prop.type === 'files') {
      const items = (value as string[])
        .map((v) => `  - "${escapeYamlString(formatMediaValue(String(v)))}"`)
        .join('\n');
      return `${key}:\n${items}`;
    }
    const items = value.map((v) => `  - "${escapeYamlString(coerceString(v))}"`).join('\n');
    return `${key}:\n${items}`;
  }

  if (typeof value === 'boolean') {
    return `${key}: ${value}`;
  }

  if (typeof value === 'number') {
    return `${key}: ${value}`;
  }

  if (typeof value === 'object' && 'start' in value) {
    // Date value
    const dateVal = value as { start: string; end?: string };

    if (format === 'human') {
      const startHuman = formatDateHuman(dateVal.start);
      if (dateVal.end) {
        const endHuman = formatDateHuman(dateVal.end);
        return `${key}: "${startHuman} \u2013 ${endHuman}"`;
      }
      return `${key}: "${startHuman}"`;
    }

    if (format === 'iso') {
      // Preserve full ISO string as-is
      if (dateVal.end) {
        return `${key}:\n  start: "${dateVal.start}"\n  end: "${dateVal.end}"`;
      }
      return `${key}: "${dateVal.start}"`;
    }

    // Auto (default) - same as current behavior
    if (dateVal.end) {
      return `${key}:\n  start: "${dateVal.start}"\n  end: "${dateVal.end}"`;
    }
    return `${key}: "${dateVal.start}"`;
  }

  // Timestamp string properties with format (createdTime, lastEditedTime)
  if (
    (prop.type === 'createdTime' || prop.type === 'lastEditedTime') &&
    typeof value === 'string'
  ) {
    if (format === 'human') {
      return `${key}: "${formatDateHuman(value)}"`;
    }
    // iso and auto - output as-is (already ISO)
    return `${key}: "${value}"`;
  }

  // String value
  const strValue = coerceString(value);
  if (needsYamlQuoting(strValue)) {
    return `${key}: "${escapeYamlString(strValue)}"`;
  }
  return `${key}: ${strValue}`;
}
