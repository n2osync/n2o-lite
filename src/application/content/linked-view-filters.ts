/**
 * BasesFilterTranslator - Translates a Notion view's property_filters
 * into Obsidian Bases YAML filter expressions.
 *
 * Pure functions with no I/O - fully unit-testable.
 * Parsing logic mirrors translateViewFilters() in registry-builder.ts.
 */

import type { BasesFilterExpression } from '../../domain/models/page-registry';
import { propertyToFrontmatterKey } from '../../shared/sanitize';
import { createLogger } from '../../shared/logger';

const log = createLogger('LinkedViewFilters');

/**
 * Translate official Views API quick_filters into Bases filter expressions.
 * Quick filters use property IDs as keys with type-specific operator objects:
 *   { ">|wS": { "multi_select": { "contains": "Fitness" } } }
 *
 * @param quickFilters  - The quick_filters object from NotionViewDetail
 * @param dbProperties  - Official API database properties keyed by property name
 */
function translateOfficialViewFilters(
  quickFilters: Record<string, Record<string, Record<string, unknown>>> | null | undefined,
  dbProperties: Record<string, Record<string, unknown>>,
  pageIdToName?: (id: string) => string | undefined,
): BasesFilterExpression[] {
  if (!quickFilters || typeof quickFilters !== 'object') return [];

  const expressions: BasesFilterExpression[] = [];

  for (const [propId, typeCondition] of Object.entries(quickFilters)) {
    if (!typeCondition || typeof typeCondition !== 'object') continue;

    // Resolve property name from ID
    const encodedPropId = encodeURIComponent(propId);
    const propName = Object.keys(dbProperties).find(
      (name) => (dbProperties[name]?.['id'] as string | undefined) === encodedPropId,
    );
    if (!propName) {
      log.debug(`Official filter: property ID "${propId}" not found in schema`);
      continue;
    }

    const key = propertyToFrontmatterKey(propName);
    const schemaType = (dbProperties[propName]?.['type'] as string | undefined) ?? '';

    // typeCondition is like { "multi_select": { "contains": "Fitness" } }
    // OR { "select": { "equals": ["Quote", "Poem"] } } for multi-value
    for (const [propType, condition] of Object.entries(typeCondition)) {
      if (!condition || typeof condition !== 'object') continue;

      for (const [op, rawValue] of Object.entries(condition)) {
        // Notion's quick_filter values can be a string, boolean, or an array
        // of strings (multi-select chip with multiple options). Pre-fix this
        // dropped arrays entirely - linked-view filters like "Type IS Quote
        // OR Poem" silently became no-op.
        const values: string[] = Array.isArray(rawValue)
          ? rawValue.filter((v): v is string => typeof v === 'string' && v !== '')
          : typeof rawValue === 'string'
            ? [rawValue]
            : typeof rawValue === 'boolean'
              ? [String(rawValue)]
              : [];
        if (values.length === 0) continue;
        const value = values[0]; // primary value for relation-resolver path below
        if (value === undefined) continue;

        // Relation property: values are Notion page ids; resolve to vault titles + mark as link.
        // Without a resolver OR without any resolvable title, the filter cannot produce
        // valid Bases YAML (raw page ids never match vault content) - skip entirely.
        if (propType === 'relation' || schemaType === 'relation') {
          if (!pageIdToName) {
            log.debug(`Official filter: relation "${propName}" - no page resolver, skipping`);
            continue;
          }
          const resolvedNames = values
            .map((v) => pageIdToName(v)?.trim())
            .filter((n): n is string => n !== undefined && n !== '');
          if (resolvedNames.length === 0) {
            log.debug(
              `Official filter: relation "${propName}" - page ids ${value.substring(0, 8)}\u2026 not resolvable`,
            );
            continue;
          }
          expressions.push({ key, operator: 'contains', values: resolvedNames, valueIsLink: true });
          continue;
        }

        const basesOp = mapOfficialOperator(op, propType);
        if (!basesOp) {
          log.debug(`Official filter: unsupported "${propType}.${op}" on "${propName}"`);
          continue;
        }

        expressions.push({ key, operator: basesOp, values: [...values] });
      }
    }
  }

  // Merge same-property filters (OR logic) - preserve valueIsLink parity
  const merged = new Map<string, BasesFilterExpression>();
  for (const expr of expressions) {
    const mergeKey = `${expr.key}:${expr.operator}:${expr.valueIsLink ? 'link' : 'str'}`;
    const existing = merged.get(mergeKey);
    if (existing) {
      existing.values.push(...expr.values);
    } else {
      merged.set(mergeKey, { ...expr, values: [...expr.values] });
    }
  }
  return Array.from(merged.values());
}

/**
 * Unified filter extractor for Notion linked views (Views API).
 *
 * Reads BOTH filter sources on a view and returns their UNION:
 *   - view.filter - the user-configured permanent filter (primary)
 *   - view.quick_filters - ad-hoc filter chips added via the UI
 *
 * Previously only quick_filters was read, so linked-view .base files had no
 * filter and returned 0 rows (or all rows) for all linked views with a
 * configured filter.
 *
 * `pageIdToName`: when provided, relation-property filters resolve their
 * Notion page-id values to the matching vault page titles and emit
 * `valueIsLink: true` so Bases uses `list(note[x]).contains(link(...))`.
 */
export function extractLinkedViewFilters(
  view: {
    filter?: Record<string, unknown> | null;
    quick_filters?: Record<string, Record<string, Record<string, unknown>>> | null;
  },
  dbProperties: Record<string, Record<string, unknown>>,
  pageIdToName?: (id: string) => string | undefined,
): BasesFilterExpression[] {
  const fromConfigured = translatePermanentFilter(view.filter, dbProperties, pageIdToName);
  const fromQuick = translateOfficialViewFilters(view.quick_filters, dbProperties, pageIdToName);
  // De-dup: permanent filter wins; quick filters only add NEW keys
  const permanentKeys = new Set(fromConfigured.map((f) => `${f.key}:${f.operator}`));
  const merged = [
    ...fromConfigured,
    ...fromQuick.filter((f) => !permanentKeys.has(`${f.key}:${f.operator}`)),
  ];
  return merged;
}

/**
 * Translate the permanent filter field (view.filter) into Bases expressions.
 *
 * Notion's configured filter schema:
 *   Single:  { property: "<id>", <type>: { <op>: <value> } }
 *   Group:   { and|or: [...clauses] } - nested recursively
 *
 * We flatten AND groups (Bases top-level filter is AND), and fold OR groups
 * into the merge logic (same-key + same-operator -> multi-value OR).
 * Unsupported operators (does_not_contain, is_empty, etc.) are skipped with
 * a debug log - no crash, partial filter is better than no filter.
 */
function translatePermanentFilter(
  filter: Record<string, unknown> | null | undefined,
  dbProperties: Record<string, Record<string, unknown>>,
  pageIdToName?: (id: string) => string | undefined,
): BasesFilterExpression[] {
  if (!filter || typeof filter !== 'object') return [];

  const expressions: BasesFilterExpression[] = [];
  collectFilterClauses(filter, dbProperties, expressions, pageIdToName);

  // Merge same-property same-operator expressions into multi-value OR
  const merged = new Map<string, BasesFilterExpression>();
  for (const expr of expressions) {
    const mergeKey = `${expr.key}:${expr.operator}`;
    const existing = merged.get(mergeKey);
    if (existing) {
      for (const v of expr.values) {
        if (!existing.values.includes(v)) existing.values.push(v);
      }
    } else {
      merged.set(mergeKey, { ...expr, values: [...expr.values] });
    }
  }
  return Array.from(merged.values());
}

function collectFilterClauses(
  clause: Record<string, unknown>,
  dbProperties: Record<string, Record<string, unknown>>,
  out: BasesFilterExpression[],
  pageIdToName?: (id: string) => string | undefined,
): void {
  // Compound group
  if (Array.isArray(clause['and'])) {
    for (const sub of clause['and'] as Record<string, unknown>[]) {
      collectFilterClauses(sub, dbProperties, out, pageIdToName);
    }
    return;
  }
  if (Array.isArray(clause['or'])) {
    for (const sub of clause['or'] as Record<string, unknown>[]) {
      collectFilterClauses(sub, dbProperties, out, pageIdToName);
    }
    return;
  }

  // Leaf filter: { property: "<id>", <type>: { <op>: value } }
  const propId = clause['property'] as string | undefined;
  if (!propId) return;

  const encodedPropId = encodeURIComponent(propId);
  const propName = Object.keys(dbProperties).find(
    (name) =>
      (dbProperties[name]?.['id'] as string | undefined) === encodedPropId ||
      (dbProperties[name]?.['id'] as string | undefined) === propId,
  );
  if (!propName) {
    log.debug(`Permanent filter: property id "${propId}" not found in schema - skipping`);
    return;
  }

  const key = propertyToFrontmatterKey(propName);
  const schemaType = (dbProperties[propName]?.['type'] as string | undefined) ?? '';

  // Find the type-specific clause (exclude "property" key)
  for (const [propType, condition] of Object.entries(clause)) {
    if (propType === 'property') continue;
    if (!condition || typeof condition !== 'object') continue;
    const conditionObj = condition as Record<string, unknown>;

    for (const [op, rawValue] of Object.entries(conditionObj)) {
      const value =
        typeof rawValue === 'string'
          ? rawValue
          : typeof rawValue === 'boolean'
            ? String(rawValue)
            : typeof rawValue === 'number'
              ? String(rawValue)
              : null;
      if (value === null) continue;

      // Relation property: value is a Notion page id; resolve to vault title + mark as link.
      // Without a resolver OR without a resolvable title, the filter cannot produce
      // valid Bases YAML (raw page ids never match vault content) - skip entirely.
      if (propType === 'relation' || schemaType === 'relation') {
        if (!pageIdToName) {
          log.debug(`Permanent filter: relation "${propName}" - no page resolver, skipping`);
          continue;
        }
        const resolvedName = pageIdToName(value)?.trim();
        if (!resolvedName) {
          log.debug(
            `Permanent filter: relation "${propName}" - page id ${value.substring(0, 8)}\u2026 not resolvable`,
          );
          continue;
        }
        out.push({ key, operator: 'contains', values: [resolvedName], valueIsLink: true });
        continue;
      }

      const basesOp = mapOfficialOperator(op, propType);
      if (!basesOp) {
        log.debug(`Permanent filter: unsupported "${propType}.${op}" on "${propName}"`);
        continue;
      }
      out.push({ key, operator: basesOp, values: [value] });
    }
  }
}

/**
 * Convert a Notion view's own filter object into a Notion query filter.
 *
 * Reads the view object directly (the official Views API path), so it needs no
 * round-trip through the Bases filter vocabulary. Expressions are AND-combined;
 * within one expression `==` and `contains` are OR-combined while `!=` is
 * AND-combined.
 */
export function viewToQueryFilter(
  view: {
    filter?: Record<string, unknown> | null;
    quick_filters?: Record<string, Record<string, Record<string, unknown>>> | null;
  },
  dbProperties: Record<string, Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const clauses: Record<string, unknown>[] = [];

  const fromPermanent = rewriteFilterPropertyIds(view.filter, dbProperties);
  if (fromPermanent) clauses.push(fromPermanent);

  const fromQuick = quickFiltersToQuery(view.quick_filters, dbProperties);
  for (const c of fromQuick) clauses.push(c);

  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return { and: clauses };
}

/**
 * Walk a Notion query filter tree and rewrite `property: <id>` -> `property: <name>`.
 * Drops leaves whose property id can't be resolved against the schema.
 * Preserves and/or grouping. Returns undefined when the result has no leaves.
 */
function rewriteFilterPropertyIds(
  filter: Record<string, unknown> | null | undefined,
  dbProperties: Record<string, Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (!filter || typeof filter !== 'object') return undefined;

  if (Array.isArray(filter['and'])) {
    const rewritten = (filter['and'] as Record<string, unknown>[])
      .map((sub) => rewriteFilterPropertyIds(sub, dbProperties))
      .filter((c): c is Record<string, unknown> => c !== undefined);
    if (rewritten.length === 0) return undefined;
    if (rewritten.length === 1) return rewritten[0];
    return { and: rewritten };
  }
  if (Array.isArray(filter['or'])) {
    const rewritten = (filter['or'] as Record<string, unknown>[])
      .map((sub) => rewriteFilterPropertyIds(sub, dbProperties))
      .filter((c): c is Record<string, unknown> => c !== undefined);
    if (rewritten.length === 0) return undefined;
    if (rewritten.length === 1) return rewritten[0];
    return { or: rewritten };
  }

  const propId = filter['property'];
  if (typeof propId !== 'string') return undefined;
  const propName = resolvePropertyName(propId, dbProperties);
  if (!propName) {
    log.debug(`viewToQueryFilter: property id "${propId}" not in schema; dropping leaf`);
    return undefined;
  }
  const rewritten: Record<string, unknown> = { property: propName };
  for (const [key, value] of Object.entries(filter)) {
    if (key === 'property') continue;
    rewritten[key] = value;
  }
  return rewritten;
}

/**
 * Convert quick_filters into a list of Notion query filter clauses.
 * Multi-value chips ({op: [v1, v2]}) become an `or` group.
 */
function quickFiltersToQuery(
  quickFilters: Record<string, Record<string, Record<string, unknown>>> | null | undefined,
  dbProperties: Record<string, Record<string, unknown>>,
): Record<string, unknown>[] {
  if (!quickFilters || typeof quickFilters !== 'object') return [];

  const out: Record<string, unknown>[] = [];
  for (const [propId, typeCondition] of Object.entries(quickFilters)) {
    const propName = resolvePropertyName(propId, dbProperties);
    if (!propName) {
      log.debug(`viewToQueryFilter: quick_filter property id "${propId}" not in schema`);
      continue;
    }
    if (!typeCondition || typeof typeCondition !== 'object') continue;

    for (const [propType, condition] of Object.entries(typeCondition)) {
      if (!condition || typeof condition !== 'object') continue;
      for (const [op, rawValue] of Object.entries(condition)) {
        const values: unknown[] = Array.isArray(rawValue) ? rawValue : [rawValue];
        const usable = values.filter((v) => v !== '' && v !== null && v !== undefined);
        if (usable.length === 0) continue;
        if (usable.length === 1) {
          out.push({ property: propName, [propType]: { [op]: usable[0] } });
          continue;
        }
        out.push({
          or: usable.map((v) => ({ property: propName, [propType]: { [op]: v } })),
        });
      }
    }
  }
  return out;
}

/**
 * Notion stores property ids in two shapes depending on endpoint and
 * version: raw (`>|wS`) or URL-encoded (`%3E%7CwS`). Match against both
 * so the resolver works regardless of which side encoded it.
 */
function resolvePropertyName(
  propId: string,
  dbProperties: Record<string, Record<string, unknown>>,
): string | undefined {
  const encoded = safeEncode(propId);
  const decoded = safeDecode(propId);
  for (const name of Object.keys(dbProperties)) {
    const id = dbProperties[name]?.['id'];
    if (typeof id !== 'string') continue;
    if (id === propId) return name;
    if (encoded !== undefined && id === encoded) return name;
    if (decoded !== undefined && id === decoded) return name;
    const idDecoded = safeDecode(id);
    if (idDecoded !== undefined && idDecoded === propId) return name;
  }
  return undefined;
}

function safeEncode(s: string): string | undefined {
  try {
    return encodeURIComponent(s);
  } catch {
    return undefined;
  }
}

function safeDecode(s: string): string | undefined {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}

function mapOfficialOperator(op: string, propType: string): '==' | '!=' | 'contains' | null {
  switch (op) {
    case 'equals':
      return '==';
    case 'does_not_equal':
      return '!=';
    case 'contains':
      return propType === 'multi_select' || propType === 'relation' ? 'contains' : '==';
    case 'does_not_contain':
      return null;
    case 'is':
      return '==';
    case 'is_not':
      return '!=';
    default:
      return null;
  }
}
