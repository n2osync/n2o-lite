/**
 * NotionId - Value object for Notion UUID identifiers.
 *
 * Eliminates ID format chaos: 3 formats (dashed, dashless, n2o- prefixed),
 * 5+ files normalizing independently, silent comparison failures.
 *
 * Single canonical representation: lowercase dashless hex.
 * Methods to produce any format needed by consumers.
 */

/** Regex for 32 hex chars (dashless UUID). */
const HEX_32 = /^[0-9a-f]{32}$/;

export class NotionId {
  /** Always lowercase, dashless, 32 hex chars. */
  private readonly raw: string;

  private constructor(raw: string) {
    this.raw = raw;
  }

  /**
   * Create a NotionId from any format:
   * - `n2o-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (composite record ID)
   * - `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (dashed UUID)
   * - `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` (dashless UUID)
   * - Notion page URLs (extracts the UUID segment)
   *
   * Returns null if the input doesn't contain a valid Notion UUID.
   */
  static from(input: string): NotionId | null {
    if (!input) return null;

    // Strip n2o- prefix
    let cleaned = input.replace(/^n2o-/, '');

    // Handle Notion URLs: extract UUID from path
    if (cleaned.includes('notion.so') || cleaned.includes('notion.site')) {
      const match = cleaned.match(/([0-9a-f]{32})/i);
      if (match && match[1] !== undefined) cleaned = match[1];
    }

    // Remove dashes and lowercase
    cleaned = cleaned.replace(/-/g, '').toLowerCase();

    // Validate: must be exactly 32 hex chars
    if (!HEX_32.test(cleaned)) return null;

    return new NotionId(cleaned);
  }

  /**
   * Create from a string from a trusted source (database, Notion API response).
   * Skips URL extraction (trusted sources store bare ids) but still asserts the
   * hex-32 shape and throws on a violation - an empty or malformed stored id must
   * fail fast, not silently produce dashes-only keys and `n2o-` API calls (#1557).
   */
  static fromTrusted(input: string): NotionId {
    const cleaned = input.replace(/^n2o-/, '').replace(/-/g, '').toLowerCase();
    if (!HEX_32.test(cleaned)) {
      throw new Error(`NotionId.fromTrusted: invalid id "${input}" (expected 32 hex chars)`);
    }
    return new NotionId(cleaned);
  }

  /** UUID with dashes: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (for Notion API calls). */
  dashed(): string {
    const r = this.raw;
    return `${r.slice(0, 8)}-${r.slice(8, 12)}-${r.slice(12, 16)}-${r.slice(16, 20)}-${r.slice(20)}`;
  }

  /** UUID without dashes: `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` (for comparison, storage keys). */
  dashless(): string {
    return this.raw;
  }

  /** Composite record ID: `n2o-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`. */
  recordId(): string {
    return `n2o-${this.dashed()}`;
  }

  /** Compare two NotionIds for equality. */
  equals(other: NotionId): boolean {
    return this.raw === other.raw;
  }

  /** Compare against a raw string in any format, including a Notion URL. */
  equalsString(other: string): boolean {
    // Delegate to from() so a URL-shaped id extracts its UUID and matches the
    // page it names, instead of silently returning false (#1560).
    const parsed = NotionId.from(other);
    return parsed !== null && this.raw === parsed.dashless();
  }

  /** Default string representation (dashed). */
  toString(): string {
    return this.dashed();
  }
}

/**
 * Normalize a Notion ID string to dashless lowercase for comparison.
 * Convenience function for code that doesn't need the full NotionId object.
 */
export function normalizeNotionId(id: string): string {
  // Delegate to from() so a URL-shaped id normalizes to its UUID and registry
  // maps keyed on this don't silently miss it (#1560). Non-UUID keys (from()
  // returns null) fall back to the plain cleaning so existing key shapes hold.
  return NotionId.from(id)?.dashless() ?? id.replace(/^n2o-/, '').replace(/-/g, '').toLowerCase();
}

/**
 * Branded type for the raw block UUID Notion uses internally for a database
 * block on a page. For databases created BEFORE Notion API 2025-09-03 this
 * is also the queryable ID; for databases created AFTER, the queryable ID
 * is a separate `DataSourceId`. Compile-time only - runtime is plain string.
 */
export type BlockUuid = string & { readonly __notionId: 'BlockUuid' };

/**
 * Branded type for the data_source_id used by Notion 2025-09-03+ for query
 * and schema endpoints (/v1/data_sources/{id}, /v1/data_sources/{id}/query).
 * For legacy databases this is the same value as the BlockUuid. Compile-time
 * only - runtime is plain string.
 */
export type DataSourceId = string & { readonly __notionId: 'DataSourceId' };

/** Tag a string as a BlockUuid. Use only with values known to be block UUIDs. */
export function asBlockUuid(s: string): BlockUuid {
  return s as BlockUuid;
}

/** Tag a string as a DataSourceId. Use only with values known to be data source IDs. */
export function asDataSourceId(s: string): DataSourceId {
  return s as DataSourceId;
}
