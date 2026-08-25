/**
 * Wikilink resolution - resolves wikilink names to Notion page IDs via sync state.
 * Extracted from ObsidianParser for modularity.
 */

import type { SyncStateDB } from '../storage/sync-state';
import { createLogger } from '../../shared/logger';

const log = createLogger('WikilinkResolver');

/** Cached path mappings for wikilink resolution. */
export type PathMapping = { notionId: string; obsidianPath: string };

/**
 * Resolve a wikilink name to a Notion page ID using sync state.
 *
 * Resolution order:
 * 1. Exact path match - if name contains '/' (e.g. "Projects/Alice")
 * 2. Filename match - scan all records for matching filename
 *
 * Logs a warning on ambiguity (multiple filename matches).
 */
export function resolveWikilinkToNotionId(
  name: string,
  syncState: SyncStateDB | null,
  resolveCache: PathMapping[] | null,
): { notionId: string | undefined; updatedCache: PathMapping[] | null } {
  if (!syncState) return { notionId: undefined, updatedCache: resolveCache };

  // Lazily cache all records once per parse() call - avoids O(n) DB scan per wikilink
  let cache = resolveCache;
  if (!cache) {
    cache = syncState.getAllPathMappings();
  }

  // Obsidian resolves links case-insensitively, and case-insensitive
  // filesystems (Windows/macOS) make case-variant links routine. Match on
  // lowercase, with an exact-case tiebreak when several case variants exist so
  // a relation written as "alice" still resolves to "Alice.md" (#1506).
  const withExt = `${name}.md`;
  const withExtLower = withExt.toLowerCase();

  // 1. Path-qualified wikilink: "Folder/Page" -> "Folder/Page.md"
  if (name.includes('/')) {
    const direct = syncState.getByObsidianPath(withExt);
    if (direct) return { notionId: direct.notionId, updatedCache: cache };
    const suffixMatches = cache.filter((r) => r.obsidianPath.toLowerCase().endsWith(withExtLower));
    if (suffixMatches.length > 0) {
      const exact = suffixMatches.find((r) => r.obsidianPath.endsWith(withExt));
      const chosen = exact ?? suffixMatches[0];
      if (chosen) return { notionId: chosen.notionId, updatedCache: cache };
    }
  }

  // 2. Filename match (case-insensitive)
  const nameLower = name.toLowerCase();
  const matches: { notionId: string; path: string; fileName: string }[] = [];
  for (const record of cache) {
    const fileName = record.obsidianPath.split('/').pop()?.replace('.md', '') ?? '';
    if (fileName.toLowerCase() === nameLower) {
      matches.push({ notionId: record.notionId, path: record.obsidianPath, fileName });
    }
  }

  const only = matches[0];
  if (matches.length === 1 && only) {
    return { notionId: only.notionId, updatedCache: cache };
  }
  if (matches.length > 1) {
    // Prefer an exact-case match when the ambiguity is only case variants.
    const chosen = matches.find((m) => m.fileName === name) ?? matches[0];
    if (chosen) {
      log.warn(
        `Ambiguous relation: "${name}" matches ${matches.length} files: ${matches.map((m) => m.path).join(', ')}. Using ${chosen.path}. Use path-qualified wikilink (e.g. [[Folder/${name}]]) to disambiguate.`,
      );
      return { notionId: chosen.notionId, updatedCache: cache };
    }
  }

  return { notionId: undefined, updatedCache: cache };
}
