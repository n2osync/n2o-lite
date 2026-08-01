/**
 * Shared YAML scalar helpers - escaping on the way out, unquoting on the way in.
 *
 * These are pure string transforms with no layer dependency, so they live in
 * shared/ where both the infrastructure adapters (builder, frontmatter parser)
 * and the application merge step can use them without crossing a layer edge.
 */

/**
 * Escape a string for safe use in YAML double-quoted values.
 * Handles newlines, backslashes, double quotes, and tabs.
 */
export function escapeYamlString(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex -- deliberately drops NUL so it cannot corrupt the emitted YAML frontmatter
      .replace(/\x00/g, '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
  );
}

/**
 * Unquote a YAML string value (strip surrounding quotes, unescape).
 */
export function unquoteYaml(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    const inner = s.slice(1, -1);
    if (s.startsWith("'")) {
      return inner.replace(/''/g, "'");
    }
    return inner
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\\\/g, '\\');
  }
  return s;
}
