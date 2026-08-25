/**
 * Content hashing utilities for change detection.
 *
 * All text-input hashes (simpleHash, djb2Hash) normalize the input first so
 * the same logical content produces the same hash regardless of platform
 * (CRLF vs LF), editor (BOM vs no-BOM), or input method (NFC vs NFD Unicode).
 * Without this, the same file moved between Windows and macOS would hash
 * differently on every cross-platform sync, causing spurious change-detection
 * pushes and false-positive twin-block matches.
 */

/**
 * Normalize text input before hashing so cross-platform / cross-editor /
 * cross-input-method variations don't change the hash for identical content.
 *
 * Steps:
 *   - Strip a leading BOM (U+FEFF) - some editors prepend, some don't.
 *   - Collapse line endings to LF (CRLF and bare CR alike).
 *   - Apply Unicode NFC. macOS often emits NFD for accented chars; Windows
 *     and Linux typically emit NFC. NFC is the canonical form per RFC 5198.
 *
 * Idempotent: normalize(normalize(s)) === normalize(s). Safe to call when
 * the input may already be partially normalized.
 *
 * Cost: O(n) string scan + one .normalize() call. Negligible for practical
 * inputs (sub-ms for a 100KB markdown file).
 */
function normalizeForHash(content: string): string {
  return content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .normalize('NFC');
}

/**
 * Fast non-cryptographic hash (dual djb2 with different seeds).
 * Produces a 16-char hex string (64 bits) for better collision resistance
 * than a single 32-bit pass. Used by bases-generator for schema hashing.
 */
export function djb2Hash(str: string): string {
  const content = normalizeForHash(str);
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    h1 = (h1 * 33) ^ c;
    h2 = (h2 * 33) ^ c;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * Compute SHA-256 hash of binary data (ArrayBuffer) as 64 hex chars.
 * Used for content-addressed media filenames.
 *
 * Requires crypto.subtle. The old dual-FNV fallback produced a DIFFERENT
 * 16-char hash for the same bytes, so if crypto was present on one run and
 * absent on another the same media got two content addresses and duplicated
 * instead of deduping. crypto.subtle is always available in Electron and
 * Node 15+, so this asserts an invariant rather than removing a live path;
 * failing loudly beats silently duplicating media (#1563).
 */
export async function sha256Binary(data: ArrayBuffer): Promise<string> {
  if (typeof window.crypto === 'undefined' || !window.crypto.subtle) {
    throw new Error('sha256Binary requires crypto.subtle, which is unavailable in this runtime');
  }
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * N2O-managed frontmatter keys. The builder writes these on every push
 * (and on the post-push writeback). They reflect Notion-side state we
 * cache for routing/display purposes, NOT user content. Including them
 * in the change-detection hash means a writeback that only refreshed
 * `updated:` or rewrote `notion_id:` flips the hash and the next change
 * detector tick spuriously re-pushes content the user did not touch.
 *
 * These are stripped by hashContentForChange() before hashing so the
 * hash reflects "did the user modify content?" rather than "did the
 * file's bytes change at all?".
 *
 * Why this list and not others: every key here is written by the N2O
 * builder OR consumed by the N2O parser as plugin metadata (see
 * frontmatter-parser.ts skipKeys). User-controlled keys like `icon`,
 * `banner`, `tags`, `aliases`, `cssclasses` are NOT stripped; those are
 * persistent vault state the user can edit.
 */
const N2O_MANAGED_FRONTMATTER_KEYS = [
  'notion_id',
  'notion_url',
  'n2o_type',
  'n2o_database',
  'n2o_parent_id',
  'n2o_parent_type',
  'n2o_cover',
  'n2o_sync_hash',
  'notion_last_edited',
  'notion_parent_hint',
  'notion_parent_hint_type',
  'created',
  'updated',
];

const N2O_FRONTMATTER_LINE = new RegExp(`^(?:${N2O_MANAGED_FRONTMATTER_KEYS.join('|')}):\\s*\\S`);

/**
 * Strip N2O-managed frontmatter lines so the hash reflects user content,
 * not plugin-managed bookkeeping that shifts on every push writeback.
 *
 * Only operates on documents starting with a `---` frontmatter block.
 * Only strips single-line scalar entries (regex requires non-whitespace
 * immediately after the colon, so a multi-line block like
 * `created:\n  - x` is left alone - its start line has whitespace after
 * the colon and won't match).
 *
 * Idempotent: running it twice on the same input produces the same
 * output as running it once.
 */
function stripN2OFrontmatter(content: string): string {
  const headerMatch = content.match(/^---\r?\n/);
  if (!headerMatch) return content;
  const headerStart = headerMatch[0].length;
  const closeRe = /\r?\n---(?:\r?\n|$)/;
  closeRe.lastIndex = headerStart;
  const remainder = content.slice(headerStart);
  const closeMatch = remainder.match(closeRe);
  if (!closeMatch || closeMatch.index === undefined) return content;

  const header = remainder.slice(0, closeMatch.index);
  const tail = remainder.slice(closeMatch.index);

  const filteredLines = header.split('\n').filter((line) => !N2O_FRONTMATTER_LINE.test(line));

  // If stripping leaves an empty frontmatter block, drop the whole block
  // (a `---\n---\n` header is uglier than no header at all and would
  // still hash differently from a doc that never had frontmatter).
  if (filteredLines.length === 0 || filteredLines.every((l) => l.trim() === '')) {
    // Skip past the closing --- and any following newline
    return remainder.slice(closeMatch.index + closeMatch[0].length);
  }

  return headerMatch[0] + filteredLines.join('\n') + tail;
}

/**
 * Hash markdown content for change detection.
 *
 * Strips N2O-managed frontmatter keys (notion_id, n2o_*, created,
 * updated, ...) before hashing so a writeback that only refreshed those
 * keys does NOT shift the hash and read as a real content change on the
 * next pass.
 *
 * Use this for any hash that gets compared across sync cycles:
 * obsidianContentHash, notionContentHash, base-version hashes, change
 * detector hashes. For content that has no frontmatter (block plain
 * text, table cell hashes, etc.), use simpleHash directly. The strip
 * is a no-op on non-frontmatter input but adds an extra regex per call.
 */
export function hashContentForChange(content: string): string {
  return simpleHash(stripN2OFrontmatter(content));
}

/** Fields that shift between two fetches of the SAME unchanged block, so they are
 *  stripped before hashing (an edit changes the CONTENT, which is kept). */
const NOTION_BLOCK_VOLATILE = new Set([
  'last_edited_time',
  'created_time',
  'last_edited_by',
  'created_by',
  'request_id',
]);

/** Canonicalize a value for a stable, key-order-independent serialization.
 *  `seen` guards against reference cycles: real Notion block trees are acyclic,
 *  but in-memory blocks decorated with parent back-refs are not, and a cycle would
 *  otherwise make JSON.stringify throw and crash the sync. A revisited node
 *  serializes to a stable sentinel instead. */
function canonicalizeBlockValue(v: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(v)) {
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    return v.map((item) => canonicalizeBlockValue(item, seen));
  }
  if (v && typeof v === 'object') {
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      if (NOTION_BLOCK_VOLATILE.has(k)) continue;
      out[k] = canonicalizeBlockValue((v as Record<string, unknown>)[k], seen);
    }
    return out;
  }
  return v;
}

/**
 * Structural content hash of a Notion block tree, for the push conflict gate (#1746).
 *
 * Serializes the blocks with sorted keys (so two fetches of the same content hash
 * equal regardless of key order) and strips only the per-block volatile timestamp/user
 * fields (which shift without a content change). Everything content-bearing - rich_text,
 * type payloads, ids, children - is kept, so ANY real edit changes the hash. It is used
 * FAIL-SAFE: a false non-match only falls through to the timestamp check (today's
 * behavior), never a silent overwrite; only a real content match lets a push proceed.
 */
export function hashNotionBlocks(blocks: unknown[]): string {
  try {
    return simpleHash(JSON.stringify(canonicalizeBlockValue(blocks ?? [], new WeakSet())));
  } catch {
    // Hashing must never crash a pull. An empty hash means "no verified hash",
    // so the push conflict gate falls through to the timestamp check (today's
    // behavior) - fail-safe, never a silent overwrite.
    return '';
  }
}

/**
 * Dual FNV-1a hash - primary hash function for sync change detection.
 * Produces a 16-char hex string (64 bits of collision resistance).
 * Uses two independent FNV-1a hashes with different offsets, combined
 * into a single string. This is the canonical implementation - used by
 * both the sync engine and the change detector.
 *
 * Birthday paradox: at 200K pages, collision probability is ~2×10^-9 per
 * sync cycle - effectively zero over any practical timeframe.
 */
export function simpleHash(content: string): string {
  const FNV_PRIME = 0x01000193;
  const FNV_OFFSET_1 = 0x811c9dc5;
  const FNV_OFFSET_2 = 0x2b821756;

  const normalized = normalizeForHash(content);

  let h1 = FNV_OFFSET_1;
  let h2 = FNV_OFFSET_2 | 0;

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    h1 = h1 ^ char;
    h1 = Math.imul(h1, FNV_PRIME);
    h2 = h2 ^ char;
    h2 = Math.imul(h2, FNV_PRIME);
  }

  const part1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const part2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return part1 + part2;
}
