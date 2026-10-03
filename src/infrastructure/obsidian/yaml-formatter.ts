/**
 * YAML formatting utilities for Obsidian frontmatter generation.
 */

/** YAML boolean literals that must be quoted to avoid type coercion. */
const YAML_BOOLEANS = new Set([
  'true',
  'false',
  'yes',
  'no',
  'on',
  'off',
  'null',
  '~',
  'True',
  'False',
  'Yes',
  'No',
  'On',
  'Off',
  'Null',
  'TRUE',
  'FALSE',
  'YES',
  'NO',
  'ON',
  'OFF',
  'NULL',
]);

/** Pattern matching ISO date strings that YAML would interpret as dates. */
const YAML_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Format an ISO date string as human-readable text.
 * Includes time component only if the original string contains 'T'.
 */
export function formatDateHuman(isoDate: string): string {
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return isoDate;

  const hasTime = isoDate.includes('T');
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  };
  if (hasTime) {
    options.hour = 'numeric';
    options.minute = '2-digit';
  }
  return date.toLocaleDateString('en-US', options);
}

/**
 * Check if a string needs quoting in YAML (special chars, booleans, numbers, dates).
 */
export function needsYamlQuoting(value: string): boolean {
  if (value.length === 0) return true;
  // YAML booleans and null
  if (YAML_BOOLEANS.has(value)) return true;
  // Looks like a number
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value)) return true;
  if (value === '.inf' || value === '-.inf' || value === '.nan') return true;
  // Looks like a date
  if (YAML_DATE_RE.test(value)) return true;
  // Special characters
  return (
    value.includes('\n') ||
    value.includes('\r') ||
    value.includes('\t') ||
    value.includes(':') ||
    value.includes('"') ||
    value.includes("'") ||
    value.includes('#') ||
    value.includes('[') ||
    value.includes(']') ||
    value.includes('{') ||
    value.includes('}') ||
    value.includes('\\') ||
    value.includes('!') ||
    value.includes('@') ||
    value.includes('`') ||
    value.includes('%') ||
    value.includes('&') ||
    value.includes('*') ||
    value.includes('|') ||
    value.includes('>') ||
    value.includes(',') ||
    value.startsWith(' ') ||
    value.endsWith(' ')
  );
}
