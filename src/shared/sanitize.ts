/**
 * File name, property key sanitization utilities, and Notion URL helpers.
 */

/** Build the canonical Notion page URL for a given ID (with or without dashes). */
export function notionPageUrl(notionId: string): string {
  return `https://notion.so/${notionId.replace(/-/g, '')}`;
}

/** Characters forbidden in file names across all platforms */
const FORBIDDEN_FILE_CHARS = /[\\/:*?"<>|#^[\]]/g;

/** Control characters */
// eslint-disable-next-line no-control-regex -- deliberately strips C0/C1 control characters from file names so they cannot break the vault path
const CONTROL_CHARS = /[\x00-\x1f\x80-\x9f]/g;

/** Windows reserved device names (case-insensitive) */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i;

/** Potentially dangerous file extensions to block */
const BLOCKED_EXTENSIONS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.scr',
  '.msi',
  '.dll',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.wsf',
  '.wsh',
  '.ps1',
  '.pif',
  '.com',
  '.hta',
  '.cpl',
  '.inf',
  '.reg',
]);

/**
 * Normalize line endings to Unix-style `\n`.
 * Handles Windows `\r\n` and old Mac `\r` line endings.
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Per-name budget. NTFS/HFS+ cap a name at 255 UTF-16 chars, ext4/APFS at 255
 * UTF-8 BYTES, all including the extension. 200 chars / 240 bytes keeps every
 * platform safe with headroom for ".md" and " (n)" uniqueness suffixes (#1758).
 * The sharper limit is the 260-char absolute-path cap on stock Windows, which
 * a per-name budget cannot fully protect - hence the headroom.
 */
const MAX_FILENAME_CHARS = 200;
const MAX_FILENAME_BYTES = 240;

const UTF8 = new TextEncoder();

/**
 * Sanitize a Notion page title into a valid Obsidian file name.
 * Handles Windows/macOS/Linux restrictions.
 */
export function sanitizeFileName(title: string): string {
  return buildFileName(title, MAX_FILENAME_CHARS, MAX_FILENAME_BYTES);
}

/**
 * True when `fileName` is a lossy-but-unrenamed rendering of `title`: the
 * uncapped sanitization of the title, cut at ANY length. Deliberately
 * cap-agnostic - files on disk were named under whatever cap their pull ran
 * with (100 chars before #1758), and a cap change must never make them look
 * user-renamed, or the push guard would push the lossy filename as the title.
 * Consequence: a manual rename to a strict prefix of the original title also
 * counts as unrenamed and keeps the original title.
 */
export function isFileNameDerivedFromTitle(fileName: string, title: string): boolean {
  if (!fileName || !title) return false;
  const full = buildFileName(title, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  return full === fileName || full.startsWith(fileName);
}

/**
 * Cut a sanitized name to maxChars and re-strip what the cut can expose: a
 * dangling high surrogate and a trailing dot/space/hyphen (#1564). Shared by
 * the sanitizer's cap and the registry's path-budget clamp (#1759) so the two
 * never drift.
 */
function truncateFileName(name: string, maxChars: number): string {
  return name
    .substring(0, maxChars)
    .replace(/[\uD800-\uDBFF]$/, '')
    .replace(/[\s.-]+$/, '');
}

/** Never clamp below this - a folder chain this deep cannot be fixed by shortening the name. */
const MIN_CLAMPED_FILENAME = 12;
/** Room reserved for a possible " (n)" uniqueness suffix added after clamping. */
const UNIQUE_SUFFIX_RESERVE = 5;

/**
 * The vault-relative path budget for generated files. Stock Windows caps the
 * ABSOLUTE path at 260 chars (LongPathsEnabled is off by default), so the
 * relative budget is what remains after the vault root and a separator. Other
 * platforms allow kilobyte-scale paths; 500 keeps them sane without clamping
 * anything realistic (#1759).
 */
export function vaultRelativePathBudget(
  vaultBasePathLength: number,
  isWindows: boolean = typeof process !== 'undefined' &&
    (process as { platform?: string }).platform === 'win32',
): number {
  if (!isWindows) return 500;
  return Math.max(MIN_CLAMPED_FILENAME + '/.md'.length, 259 - vaultBasePathLength - 1);
}

/**
 * Shorten an already-sanitized filename so `${folder}/${name}.md` fits the
 * relative-path budget, reserving room for a " (n)" uniqueness suffix (#1759).
 * When even the floor cannot fit (the folder chain itself is too deep), the
 * floor-length name is returned and the write surfaces its own error.
 */
export function fitFileNameToBudget(
  fileName: string,
  folderLength: number,
  budget: number,
): string {
  const available = budget - folderLength - '/.md'.length - UNIQUE_SUFFIX_RESERVE;
  if (fileName.length <= available) return fileName;
  return truncateFileName(fileName, Math.max(MIN_CLAMPED_FILENAME, available)) || 'Untitled';
}

function buildFileName(title: string, maxChars: number, maxBytes: number): string {
  let name = title
    .normalize('NFC')
    .replace(FORBIDDEN_FILE_CHARS, '-')
    .replace(CONTROL_CHARS, '')
    .replace(/-{2,}/g, '-')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s.\u002D]+|[\s.\u002D]+$/g, '')
    .substring(0, maxChars);

  // Byte cap: ext4/APFS limit names to 255 UTF-8 BYTES, so multi-byte titles
  // (CJK, emoji) can need trimming well before the char cap (#1758).
  while (name.length > 0 && UTF8.encode(name).length > maxBytes) {
    name = name.substring(0, name.length - 1);
  }

  name = truncateFileName(name, name.length);

  if (!name) {
    name = 'Untitled';
  }

  // Prevent directory traversal via ".." segments
  if (name === '..' || name.includes('..')) {
    name = name.replace(/\.\./g, '_');
  }

  // Prevent writing into hidden/config directories (e.g. .obsidian)
  if (name.startsWith('.')) name = '_' + name;

  // Prevent Windows reserved device names. Test the base name BEFORE the first
  // dot: Windows treats "CON.txt" as the reserved CON device, not a normal file,
  // so the extension must not let it slip past the guard (#1516).
  if (WINDOWS_RESERVED.test(name.split('.')[0] ?? '')) {
    name = `_${name}`;
  }

  return name;
}

/**
 * Convert a Notion property name to a YAML-safe frontmatter key.
 * e.g., "Due Date" -> "due-date", "Status" -> "status"
 */
export function propertyToFrontmatterKey(notionPropName: string): string {
  let key = notionPropName
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');

  if (!key) {
    // All-special-character names strip to empty. A fixed 'prop' fallback makes
    // every such property collide and overwrite each other in frontmatter, so
    // derive a stable per-name suffix - distinct names get distinct keys.
    let h = 0;
    for (const ch of notionPropName) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
    key = `prop-${h.toString(36)}`;
  }

  return key;
}

/**
 * Extract a Notion page ID (32-char hex) from a URL or raw UUID string.
 * Supports:
 *   - Full URLs: https://www.notion.so/workspace/Page-Title-abc123def456...
 *   - Short URLs: https://notion.so/abc123def456...
 *   - Raw UUIDs: abc123de-f456-7890-abcd-ef1234567890
 *   - Raw hex (no dashes): abc123def4567890abcdef1234567890
 * Returns the 32-char hex ID (no dashes) or null if no valid ID found.
 */
export function extractNotionPageId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Match a 32-char hex string (with optional dashes in UUID format)
  const uuidWithDashes = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
  const hex32 = /\b([0-9a-f]{32})\b/i;

  // Try UUID with dashes first
  const dashMatch = trimmed.match(uuidWithDashes);
  if (dashMatch) {
    return (dashMatch[1] ?? '').replace(/-/g, '').toLowerCase();
  }

  // Try 32-char hex (often the last segment of a Notion URL)
  const hexMatch = trimmed.match(hex32);
  if (hexMatch) {
    return (hexMatch[1] ?? '').toLowerCase();
  }

  // Try extracting from Notion URL - the ID is the last 32 hex chars of the path
  const urlMatch = trimmed.match(/([0-9a-f]{32})(?:\?|$)/i);
  if (urlMatch) {
    return (urlMatch[1] ?? '').toLowerCase();
  }

  return null;
}

/**
 * Generate a unique file name by appending a counter suffix if the name already exists.
 * Uses case-insensitive comparison to prevent collisions on Windows/macOS.
 */
export function makeUniqueName(baseName: string, existingNames: Set<string>): string {
  // Build a lowercase set for case-insensitive comparison
  const lowerSet = new Set<string>();
  for (const name of existingNames) {
    lowerSet.add(name.toLowerCase());
  }

  if (!lowerSet.has(baseName.toLowerCase())) {
    return baseName;
  }

  let counter = 1;
  let candidate: string;
  do {
    candidate = `${baseName} (${counter})`;
    counter++;
  } while (lowerSet.has(candidate.toLowerCase()));

  return candidate;
}

/**
 * Extract the file extension from a URL, stripping query params and fragments.
 * Returns the extension with dot (e.g. ".png") or ".bin" as fallback.
 */
export function extractFileExtension(url: string): string {
  try {
    // Strip query params and fragment
    const path = (url.split('?')[0] ?? url).split('#')[0] ?? '';
    const lastSegment = path.split('/').pop() ?? '';
    const dotIndex = lastSegment.lastIndexOf('.');
    if (dotIndex > 0) {
      const ext = lastSegment.substring(dotIndex).toLowerCase();
      // Sanity check - extension should be 2-5 chars (e.g. .png, .jpeg, .webp)
      if (ext.length >= 2 && ext.length <= 6 && /^\.[a-z0-9]+$/.test(ext)) {
        // Block potentially dangerous executable extensions
        if (BLOCKED_EXTENSIONS.has(ext)) {
          return '.bin';
        }
        return ext;
      }
    }
  } catch {
    // Fall through to default
  }
  return '.bin';
}

/**
 * Extract the original filename from a URL, stripping query params.
 * Returns the filename without extension, or "file" as fallback.
 */
export function extractFileName(url: string): string {
  try {
    const path = (url.split('?')[0] ?? url).split('#')[0] ?? '';
    const lastSegment = path.split('/').pop() ?? '';
    const dotIndex = lastSegment.lastIndexOf('.');
    const name = dotIndex > 0 ? lastSegment.substring(0, dotIndex) : lastSegment;
    if (name) {
      return sanitizeFileName(decodeURIComponent(name));
    }
  } catch {
    // Fall through to default
  }
  return 'file';
}
