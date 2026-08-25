/**
 * Preserve a user's Obsidian-local frontmatter across a pull.
 *
 * A pull rebuilds the whole file from Notion state, so any frontmatter key the
 * user added in Obsidian (aliases, cssclasses, a local cover) is dropped on the
 * next pull because the builder reconstructs frontmatter from Notion alone
 * (#1508). This merges those local-only keys back into the freshly built
 * markdown, using the RAW existing lines so YAML formatting (list layout,
 * quoting) is preserved verbatim.
 *
 * Scope is a fixed allowlist of keys the builder never emits. We deliberately do
 * NOT preserve arbitrary unknown keys: a Notion property that was deleted in
 * Notion also disappears from the rebuilt frontmatter, and blindly carrying over
 * "unknown" keys would resurrect that deleted property. The allowlist keys are
 * unambiguously user-owned - N2O writes icon/banner/tags/properties, never these.
 */

import { escapeYamlString, unquoteYaml } from '../../shared/yaml';

/**
 * Keys the builder never emits, so a value on disk can only be user-authored.
 * `aliases` is the one exception: the builder emits the note's real Notion
 * title as an alias when the filename is lossy (#1757), so alias preservation
 * merges the user's entries with the N2O-owned one instead of picking a side.
 */
const LOCAL_ONLY_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  'aliases',
  'cssclasses',
  'cssclass',
  'cover',
  'coverOriginal',
  'position',
]);

/** Matches a leading `---\n...\n---` YAML frontmatter block. */
const FRONTMATTER_BLOCK = /^---\n([\s\S]*?)\n---/;

interface TopLevelEntry {
  key: string;
  /** The full raw text for this key including any indented continuation lines. */
  raw: string;
}

/**
 * Split YAML frontmatter text into top-level entries, keeping each key's raw
 * lines (including indented list items / continuations) intact.
 */
function splitTopLevelEntries(yaml: string): TopLevelEntry[] {
  const entries: TopLevelEntry[] = [];
  let current: TopLevelEntry | null = null;

  for (const line of yaml.split('\n')) {
    // A top-level key starts at column 0 (no leading whitespace, not a list item
    // or comment) and has the shape `key:` or `key: value`.
    const isContinuation = /^[\s-]/.test(line);
    const keyMatch = isContinuation ? null : line.match(/^([^\s#][^:]*):(?:\s.*)?$/);
    if (keyMatch) {
      if (current) entries.push(current);
      current = { key: (keyMatch[1] ?? '').trim(), raw: line };
    } else if (current) {
      current.raw += `\n${line}`;
    }
  }
  if (current) entries.push(current);
  return entries;
}

/** Parse the item values out of a raw `aliases:` entry (block list, inline list, or single scalar). */
function parseAliasItems(raw: string): string[] {
  const lines = raw.split('\n');
  const firstLine = lines[0] ?? '';
  const inline = firstLine.match(/^aliases:\s*\[(.*)\]\s*$/);
  if (inline) {
    return (inline[1] ?? '')
      .split(',')
      .map((s) => unquoteYaml(s.trim()))
      .filter((s) => s.length > 0);
  }
  const items: string[] = [];
  for (const line of lines.slice(1)) {
    const m = line.match(/^\s+-\s+(.*)$/);
    if (m) items.push(unquoteYaml((m[1] ?? '').trim()));
  }
  if (items.length === 0) {
    const scalar = firstLine.match(/^aliases:\s+(\S.*)$/);
    if (scalar) items.push(unquoteYaml((scalar[1] ?? '').trim()));
  }
  return items;
}

function renderAliases(items: string[]): string {
  return `aliases:\n${items.map((a) => `  - "${escapeYamlString(a)}"`).join('\n')}`;
}

/**
 * Merge a user's local-only frontmatter keys from `existingContent` into
 * `newMarkdown`. Returns `newMarkdown` unchanged when there is nothing to
 * preserve (no existing frontmatter, no new frontmatter block, or the new
 * frontmatter already carries the key).
 */
export function preserveLocalFrontmatter(existingContent: string, newMarkdown: string): string {
  const existingBlock = existingContent.match(FRONTMATTER_BLOCK);
  if (!existingBlock) return newMarkdown;
  const newBlock = newMarkdown.match(FRONTMATTER_BLOCK);
  if (!newBlock) return newMarkdown;

  const existingEntries = splitTopLevelEntries(existingBlock[1] ?? '');
  const newEntries = splitTopLevelEntries(newBlock[1] ?? '');
  const newKeys = new Set(newEntries.map((e) => e.key));

  // The alias N2O itself wrote on the previous pull is the one matching the
  // previous notion_title_org value - it belongs to N2O, not the user, and
  // must not be resurrected once the title changes.
  const titleEntry = existingEntries.find((e) => e.key === 'notion_title_org');
  const ownAlias = titleEntry
    ? unquoteYaml(titleEntry.raw.slice(titleEntry.raw.indexOf(':') + 1).trim())
    : null;
  const existingAliasEntry = existingEntries.find((e) => e.key === 'aliases');
  const userAliases = existingAliasEntry
    ? parseAliasItems(existingAliasEntry.raw).filter((a) => a !== ownAlias)
    : [];

  // When both sides carry aliases, union them: the new build's entries first,
  // then the user's own.
  let mergedYaml = newBlock[1] ?? '';
  const newAliasEntry = newEntries.find((e) => e.key === 'aliases');
  if (newAliasEntry && userAliases.length > 0) {
    const newItems = parseAliasItems(newAliasEntry.raw);
    const merged = [...newItems, ...userAliases.filter((a) => !newItems.includes(a))];
    mergedYaml = mergedYaml.replace(newAliasEntry.raw, () => renderAliases(merged));
  }

  const toPreserve: string[] = [];
  for (const e of existingEntries) {
    if (!LOCAL_ONLY_FRONTMATTER_KEYS.has(e.key) || newKeys.has(e.key)) continue;
    if (e.key === 'aliases' && ownAlias !== null) {
      // Keep only the user's entries; drop the stale N2O-owned alias.
      if (userAliases.length > 0) toPreserve.push(renderAliases(userAliases));
      continue;
    }
    toPreserve.push(e.raw);
  }

  if (toPreserve.length === 0 && mergedYaml === (newBlock[1] ?? '')) return newMarkdown;

  const injection = toPreserve.length > 0 ? `\n${toPreserve.join('\n')}` : '';
  const mergedBlock = `---\n${mergedYaml}${injection}\n---`;
  // Function replacer so `$` in frontmatter values isn't treated as a
  // replacement pattern ($&, $1, ...).
  return newMarkdown.replace(FRONTMATTER_BLOCK, () => mergedBlock);
}
