/**
 * Minimal interface for storage classes that need to read/write SQLite
 * via a managed database wrapper. Extracted so leaf stores (e.g.
 * PageCacheStore, BlockCacheStore) can depend on this small surface
 * instead of importing the concrete CoreDatabase class - which itself
 * imports those stores, creating a source-level cycle that breaks
 * `madge --circular`.
 *
 * Concrete classes (CoreDatabase, HistoryDatabase) implement this
 * structurally; no `implements` keyword is required.
 */

import type { Database } from 'sql.js';

export interface DatabaseRef {
  /** Get the underlying sql.js Database handle. */
  getDb(): Database;
  /** Mark the backing storage as dirty so a debounced flush will persist
   *  the binary to disk. */
  markDirty(): void;
}
