/**
 * Coerce an unknown value to a display string without ever producing
 * "[object Object]".
 *
 * Primitives render as themselves; objects and arrays are JSON-encoded;
 * null, undefined, and symbols become the empty string. Use this wherever a
 * loosely-typed value (frontmatter, a parsed settings record, a caught error)
 * is logged or written to output and a bare `String(...)` or template literal
 * would otherwise stringify an object to "[object Object]".
 */
export function coerceString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null || value === undefined || typeof value === 'symbol') return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    // Unstringifiable (circular reference): fall back to empty rather than throw.
    return '';
  }
}
