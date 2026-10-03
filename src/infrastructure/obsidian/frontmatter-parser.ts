/**
 * Frontmatter parser - YAML frontmatter parsing, property extraction, icon/title handling.
 * Extracted from ObsidianParser for modularity.
 */

import type { N2OProperty, N2OPropertyValue, N2ORelationValue } from '../../domain/models/property';
import type { SyncStateDB } from '../storage/sync-state';
import { mapNotionSvgFilenameToEmoji } from '../../shared/notion-icon-map';
import { isFileNameDerivedFromTitle } from '../../shared/sanitize';
import { unquoteYaml } from '../../shared/yaml';
import { resolveWikilinkToNotionId } from './wikilink-resolver';
import type { PathMapping } from './wikilink-resolver';

/** Dependencies needed for frontmatter property parsing (wikilink resolution). */
export interface FrontmatterParserDeps {
  syncState: SyncStateDB | null;
  resolveCache: PathMapping[] | null;
  updateResolveCache: (cache: PathMapping[] | null) => void;
}

/**
 * Simple YAML parser for frontmatter.
 */
export function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;
  let currentObject: Record<string, string> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue; // bounds-safe (noUncheckedIndexedAccess)
    // Array item
    if (line.match(/^\s+-\s+/) && currentKey) {
      const value = line.replace(/^\s+-\s+/, '').trim();
      if (!currentArray) currentArray = [];
      currentArray.push(unquoteYaml(value));
      result[currentKey] = currentArray;
      continue;
    }

    // Sub-object key (but not inside an active array context)
    const subMatch = line.match(/^\s+(\w[\w-]*):\s*(.*)/);
    if (subMatch && currentKey && !currentArray) {
      if (!currentObject) currentObject = {};
      currentObject[subMatch[1] ?? ''] = unquoteYaml((subMatch[2] ?? '').trim());
      result[currentKey] = currentObject;
      continue;
    }

    // Top-level key-value. Key regex avoids leading `-` (YAML array item) and
    // `#` (comment), and accepts Unicode and dot/special chars.
    const kvMatch = line.match(/^([^\s\-#:][^:]*?)\s*:\s*(.*)/);
    if (kvMatch) {
      currentArray = null;
      currentObject = null;
      currentKey = kvMatch[1] ?? ''; // mandatory group; narrows currentKey to string
      const rawValue = (kvMatch[2] ?? '').trim();

      // Block scalar: `key: |` (literal) or `key: >` (folded), with an optional
      // chomping indicator. Consume the indented block below as the value instead
      // of storing the bare `|`/`>` glyph and mis-parsing its lines (#1588).
      const blockMatch = rawValue.match(/^([|>])[+-]?$/);
      if (blockMatch) {
        const literal = blockMatch[1] === '|';
        const blockLines: string[] = [];
        let indent: number | null = null;
        while (i + 1 < lines.length) {
          const next = lines[i + 1];
          if (next === undefined) break; // bounds-safe (noUncheckedIndexedAccess)
          if (next.trim() === '') {
            blockLines.push('');
            i++;
            continue;
          }
          const m = next.match(/^(\s+)/);
          if (!m) break; // a non-indented line ends the block
          if (indent === null) indent = (m[1] ?? '').length;
          blockLines.push(next.slice(indent));
          i++;
        }
        while (blockLines.length && blockLines[blockLines.length - 1] === '') blockLines.pop();
        result[currentKey] = literal ? blockLines.join('\n') : blockLines.join(' ');
        continue;
      }

      if (rawValue === '') {
        result[currentKey] = null;
      } else if (rawValue === 'true') {
        result[currentKey] = true;
      } else if (rawValue === 'false') {
        result[currentKey] = false;
      } else if (/^-?\d+$/.test(rawValue)) {
        // Only coerce when the number re-serializes to the exact original text.
        // Otherwise it's a numeric-LOOKING string (leading-zero zip/id, or an
        // int past 2^53) that would round-trip corrupted to Notion (#1512).
        const n = parseInt(rawValue, 10);
        result[currentKey] = String(n) === rawValue ? n : unquoteYaml(rawValue);
      } else if (/^-?\d+\.\d+$/.test(rawValue)) {
        // Same guard: '1.10' -> 1.1, high-precision -> rounding both lose data.
        const n = parseFloat(rawValue);
        result[currentKey] = String(n) === rawValue ? n : unquoteYaml(rawValue);
      } else {
        result[currentKey] = unquoteYaml(rawValue);
      }
    }
  }

  return result;
}

/**
 * Convert frontmatter key-value pairs into N2OProperty array.
 */
export function parseFrontmatterToProperties(
  frontmatter: Record<string, unknown> | null,
  deps: FrontmatterParserDeps,
): N2OProperty[] {
  if (!frontmatter) return [];

  const properties: N2OProperty[] = [];
  const skipKeys = new Set([
    // `title` is the page title (extractTitle reads it); inferring it as a text
    // property too would push a duplicate property to Notion (#1521).
    'title',
    'notion_title_org',
    'notion_id',
    'notion_url',
    'n2o_type',
    'n2o_database',
    'n2o_sync_hash',
    'n2o_parent_id',
    'n2o_parent_type',
    'n2o_cover',
    'notion_parent_hint',
    'notion_parent_hint_type',
    'notion_last_edited',
    'created',
    'updated', // N2O metadata (Notion read-only created_time / last_edited_time)
    'icon',
    'banner',
    'bannerOriginal',
    'cover',
    'coverOriginal',
    'aliases',
    'cssclasses',
    'position',
  ]);

  for (const [key, value] of Object.entries(frontmatter)) {
    if (skipKeys.has(key)) continue;
    if (value === null || value === undefined) continue;

    const prop = inferProperty(key, value, deps);
    if (prop) properties.push(prop);
  }

  return properties;
}

/**
 * Infer the N2OProperty type from a frontmatter key-value pair.
 */
export function inferProperty(
  key: string,
  value: unknown,
  deps: FrontmatterParserDeps,
): N2OProperty | null {
  if (typeof value === 'boolean') {
    return { name: key, key, type: 'checkbox', value };
  }
  if (typeof value === 'number') {
    return { name: key, key, type: 'number', value };
  }
  if (Array.isArray(value)) {
    // Check if relation values ([[wikilinks]])
    const arr: unknown[] = value;
    const isRelations = arr.every(
      (v) => typeof v === 'string' && v.startsWith('[[') && v.endsWith(']]'),
    );
    if (isRelations) {
      const relations: N2ORelationValue[] = arr.flatMap((v) => {
        if (typeof v !== 'string') return [];
        const name = v.slice(2, -2);
        if (!name) return [];
        const { notionId, updatedCache } = resolveWikilinkToNotionId(
          name,
          deps.syncState,
          deps.resolveCache,
        );
        deps.updateResolveCache(updatedCache);
        return [{ id: notionId ?? '', name }];
      });
      if (relations.length === 0)
        return {
          name: key,
          key,
          type: 'multiSelect',
          value: value.map(String) as N2OPropertyValue,
        };
      return { name: key, key, type: 'relation', value: relations };
    }
    return { name: key, key, type: 'multiSelect', value: value.map(String) as N2OPropertyValue };
  }
  if (typeof value === 'object' && value !== null && 'start' in value) {
    return { name: key, key, type: 'date', value: value as { start: string; end?: string } };
  }
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) {
      return { name: key, key, type: 'url', value };
    }
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return { name: key, key, type: 'email', value };
    }
    if (/^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]*)?$/.test(value)) {
      return { name: key, key, type: 'date', value: { start: value } };
    }
    return { name: key, key, type: 'text', value };
  }
  return null;
}

/**
 * Extract the page title from frontmatter or file path.
 */
export function extractTitle(
  filePath: string,
  frontmatter: Record<string, unknown> | null,
): string {
  const rawTitle = frontmatter?.title;
  if (typeof rawTitle === 'string' || typeof rawTitle === 'number') return String(rawTitle);
  const fileName = (filePath.split('/').pop() ?? '').replace(/\.md$/, '');
  // The filename is a lossy rendering of the real Notion title (sanitized
  // chars, capped length - under ANY historical cap, hence the cap-agnostic
  // check). While the filename is still derived from the stored original, the
  // user has not renamed the file, so the original is the title - never push
  // the lossy filename in its place (#1757). A rename to anything else wins,
  // and the record refreshes on the next pull.
  const stored = frontmatter?.notion_title_org;
  if (typeof stored === 'string' && isFileNameDerivedFromTitle(fileName, stored)) {
    return stored;
  }
  return fileName;
}

/**
 * Normalize icon value - migrate legacy SVG filenames to emoji equivalents.
 * If the value looks like a Notion SVG filename (*.svg), attempt to map it.
 */
export function normalizeIcon(icon: string | undefined): string | undefined {
  if (!icon) return undefined;
  if (/\.svg$/i.test(icon)) {
    return mapNotionSvgFilenameToEmoji(icon) ?? icon;
  }
  return icon;
}
