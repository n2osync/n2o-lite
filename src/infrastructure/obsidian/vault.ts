/**
 * VaultAdapter - Interface to the Obsidian vault for N2O sync.
 * Provides file operations with sync-lock support.
 */

import { TFile, TFolder } from 'obsidian';
import type { App } from 'obsidian';
import { parseSimpleYaml } from './frontmatter-parser';

/**
 * Duration (ms) to hold sync lock after a write to prevent watcher feedback loops.
 *
 * Known latency tradeoff (#1585): the lock is released lazily on expiry, so a
 * genuine user edit made within this window of a sync write is ignored by the
 * watcher and not auto-pushed immediately. It is not lost - the next full sync
 * (or the user's next edit after the window) picks it up. The window is a
 * deliberate balance: long enough to swallow the write-back the watcher would
 * otherwise mistake for a user edit, short enough that real edits are rarely
 * caught by it.
 */
const SYNC_LOCK_TIMEOUT_MS = 10_000;

/** Counter for generating unique lock tokens. */
let lockTokenCounter = 0;

interface SyncLockEntry {
  /** Unique token for the lock holder - prevents wrong-caller release. */
  token: number;
  /** Timestamp when the lock expires (lazy expiry, no timers). */
  expiresAt: number;
}

/** Default TTL (ms) for the markdown file list cache. */
const MD_FILES_CACHE_TTL_MS = 5_000;

export class VaultAdapter {
  /** Files currently being written by sync - watcher should ignore these. */
  private syncLocks = new Map<string, SyncLockEntry>();

  /** Cached result of app.vault.getMarkdownFiles() with timestamp for TTL. */
  private mdFilesCache: { files: TFile[]; timestamp: number } | null = null;

  /**
   * Frontmatter captured at write time, keyed by path (#1518). metadataCache
   * updates asynchronously after a write, so an immediate getFrontmatter can
   * miss notion_id and churn a rebuild. This bridges the gap; entries are
   * dropped once metadataCache catches up (see getFrontmatter).
   */
  private writtenFrontmatter = new Map<string, Record<string, unknown>>();
  /** Lazy-built index: normalizedNotionId -> vaultPath for fast fallback lookups. */
  private notionIdIndex: Map<string, string> | null = null;

  constructor(private app: App) {}

  /**
   * Read a markdown file and return its raw content.
   */
  async readFile(path: string): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) return null;
    return this.app.vault.cachedRead(file);
  }

  /**
   * Write content to a file. Creates the file if it doesn't exist.
   * Acquires sync lock to prevent watcher loops.
   */
  async writeFile(path: string, content: string): Promise<void> {
    this.acquireSyncLock(path);
    try {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing && existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      } else {
        await this.ensureFolder(path);
        await this.app.vault.create(path, content);
      }
      this.captureWrittenFrontmatter(path, content);
      this.invalidateMarkdownFilesCache();
      this.invalidateNotionIdIndex();
    } finally {
      // Lock stays held until SYNC_LOCK_TIMEOUT_MS expires (lazy expiry, no timers)
    }
  }

  /**
   * Record the frontmatter of freshly written content so getFrontmatter can
   * answer correctly before metadataCache updates (#1518). Clears any prior
   * entry when the written content has no frontmatter block.
   */
  private captureWrittenFrontmatter(path: string, content: string): void {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (match) {
      this.writtenFrontmatter.set(path, parseSimpleYaml(match[1] ?? ''));
    } else {
      this.writtenFrontmatter.delete(path);
    }
  }

  /**
   * Delete a file (move to Obsidian trash).
   */
  async deleteFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file) {
      // Lock is intentionally held until SYNC_LOCK_TIMEOUT_MS expires (lazy expiry,
      // no timers). No try/finally needed - the watcher checks expiry on each event.
      this.acquireSyncLock(path);
      await this.app.fileManager.trashFile(file);
      this.writtenFrontmatter.delete(path);
      this.invalidateMarkdownFilesCache();
      this.invalidateNotionIdIndex();
    }
  }

  /**
   * Rename or move a file.
   */
  async moveFile(oldPath: string, newPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(oldPath);
    if (file) {
      this.acquireSyncLock(oldPath);
      this.acquireSyncLock(newPath);
      await this.ensureFolder(newPath);
      await this.app.fileManager.renameFile(file, newPath);
      const moved = this.writtenFrontmatter.get(oldPath);
      if (moved) {
        this.writtenFrontmatter.delete(oldPath);
        this.writtenFrontmatter.set(newPath, moved);
      }
      this.invalidateMarkdownFilesCache();
      this.invalidateNotionIdIndex();
    }
  }

  /**
   * Write binary content (images, attachments).
   */
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    // Lock is intentionally held until SYNC_LOCK_TIMEOUT_MS expires (lazy expiry,
    // no timers). No try/finally needed - the watcher checks expiry on each event.
    this.acquireSyncLock(path);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing && existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, data);
    } else {
      await this.ensureFolder(path);
      await this.app.vault.createBinary(path, data);
    }
  }

  /**
   * Check if a path is currently locked by sync (should be ignored by watcher).
   * Uses lazy expiry - no timers, just checks timestamp on read.
   */
  isSyncLocked(path: string): boolean {
    const entry = this.syncLocks.get(path);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.syncLocks.delete(path);
      return false;
    }
    return true;
  }

  /**
   * Acquire a sync lock for a path. Returns a token for explicit release.
   * Overwrites any existing lock (last writer wins - safe because sync is sequential per file).
   */
  acquireSyncLock(path: string): number {
    const token = ++lockTokenCounter;
    this.syncLocks.set(path, { token, expiresAt: Date.now() + SYNC_LOCK_TIMEOUT_MS });
    return token;
  }

  /**
   * Manually acquire the sync lock for a path (marks the write as N2O's own).
   * Alias for acquireSyncLock for backwards compatibility.
   */
  setSyncLock(path: string): void {
    this.acquireSyncLock(path);
  }

  /**
   * Release the sync lock for a path immediately.
   * Clears the lock so the watcher can see the file again without waiting for expiry.
   */
  clearSyncLock(path: string): void {
    this.syncLocks.delete(path);
  }

  /**
   * Immediately release the sync lock for a path.
   * Use after a write completes and you need the next pass to see the file immediately.
   */
  releaseSyncLock(path: string): void {
    this.syncLocks.delete(path);
  }

  /**
   * Clear all sync locks. Called on plugin unload.
   * No timers to cancel - uses lazy expiry.
   */
  clearAllSyncLocks(): void {
    this.syncLocks.clear();
  }

  /**
   * Get all markdown files in a folder (recursive).
   * Results are cached for 5 seconds to avoid repeated vault scans within a sync cycle.
   */
  getMarkdownFiles(folder?: string): TFile[] {
    const now = Date.now();
    if (!this.mdFilesCache || now - this.mdFilesCache.timestamp > MD_FILES_CACHE_TTL_MS) {
      this.mdFilesCache = { files: this.app.vault.getMarkdownFiles(), timestamp: now };
    }
    const allFiles = this.mdFilesCache.files;
    if (!folder) return allFiles;
    const prefix = folder.endsWith('/') ? folder : folder + '/';
    return allFiles.filter((f) => f.path.startsWith(prefix));
  }

  /**
   * Invalidate the markdown file list cache.
   * Call at the end of a sync cycle or when files are created/deleted.
   */
  invalidateMarkdownFilesCache(): void {
    this.mdFilesCache = null;
  }

  /**
   * Read frontmatter for a file using MetadataCache.
   */
  getFrontmatter(path: string): Record<string, unknown> | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      this.writtenFrontmatter.delete(path);
      return null;
    }
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (fm) {
      // metadataCache caught up - the write-through fallback is no longer needed.
      this.writtenFrontmatter.delete(path);
      return fm;
    }
    // metadataCache lags a just-written file (#1518): fall back to the
    // frontmatter captured at write time so an immediate notion_id lookup
    // doesn't miss and trigger rebuild churn / a false not-found.
    return this.writtenFrontmatter.get(path) ?? null;
  }

  /**
   * Update frontmatter for a file using Obsidian's processFrontMatter API.
   */
  async updateFrontmatter(
    path: string,
    updater: (fm: Record<string, unknown>) => void,
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) return;

    this.acquireSyncLock(path);
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      updater(fm);
    });
  }

  /**
   * Ensure all parent folders exist for a given path.
   * Pass a file path - the last segment is treated as a filename and stripped.
   * Pass a folder path ending with '/' - the full path is created.
   */
  async ensureFolder(filePath: string): Promise<void> {
    const parts = filePath.split('/');
    parts.pop(); // Remove filename
    if (parts.length === 0) return;

    // Create folders level-by-level to handle missing intermediate directories
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        try {
          await this.app.vault.createFolder(current);
        } catch (e) {
          // Folder may have been created concurrently (TOCTOU race) - ignore
          if (!this.app.vault.getAbstractFileByPath(current)) throw e;
        }
      }
    }
  }

  /**
   * Read binary content from a file (images, attachments).
   */
  async readBinary(path: string): Promise<ArrayBuffer | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) return null;
    return this.app.vault.readBinary(file);
  }

  /**
   * Resolve a wikilink target to a vault-relative file path.
   * Uses Obsidian's metadataCache which knows about all files and link resolution rules.
   */
  resolveLink(linkPath: string, sourcePath: string): string | null {
    const file = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
    return file?.path ?? null;
  }

  /**
   * Get the modification time (mtime) for a file, or null if it doesn't exist.
   */
  getFileMtime(path: string): number | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile)) return null;
    return file.stat.mtime;
  }

  /**
   * Check if a file exists.
   */
  fileExists(path: string): boolean {
    return this.app.vault.getAbstractFileByPath(path) !== null;
  }

  /**
   * Get all files (any type) in a folder, non-recursive.
   */
  getFilesInFolder(folderPath: string): TFile[] {
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return [];
    return folder.children.filter((f): f is TFile => f instanceof TFile);
  }

  /**
   * Find a file by its notion_id frontmatter when the expected path may be stale.
   * Fast path: check expectedPath first (O(1) MetadataCache lookup).
   * Medium path: check lazy-built notionId index (O(1) after first build).
   * Slow path: rebuild index from all markdown files in scopeFolder (O(n), only on cache miss).
   * Returns the actual vault path, or null if no file has this notion_id.
   */
  resolveFileByNotionId(
    notionId: string,
    expectedPath: string,
    scopeFolder: string,
  ): string | null {
    const normalizedId = notionId.replace(/-/g, '');

    // Fast path: expected file exists and has matching notion_id
    const fm = this.getFrontmatter(expectedPath);
    if (fm) {
      const fmId = typeof fm.notion_id === 'string' ? fm.notion_id.replace(/-/g, '') : null;
      if (fmId === normalizedId) return expectedPath;
    }

    // Medium path: check the lazy-built index
    if (this.notionIdIndex) {
      const indexedPath = this.notionIdIndex.get(normalizedId);
      if (indexedPath) {
        // Verify the indexed path is still valid (file may have been deleted/moved)
        const indexedFm = this.getFrontmatter(indexedPath);
        if (indexedFm) {
          const fmId =
            typeof indexedFm.notion_id === 'string' ? indexedFm.notion_id.replace(/-/g, '') : null;
          if (fmId === normalizedId) return indexedPath;
        }
        // Stale entry - invalidate index to force rebuild
        this.notionIdIndex = null;
      }
    }

    // Slow path: build (or rebuild) index from all files, then look up
    this.notionIdIndex = new Map();
    const files = this.getMarkdownFiles(scopeFolder);
    for (const file of files) {
      const fileFm = this.getFrontmatter(file.path);
      if (!fileFm?.notion_id || typeof fileFm.notion_id !== 'string') continue;
      const fmId = fileFm.notion_id.replace(/-/g, '');
      this.notionIdIndex.set(fmId, file.path);
    }

    return this.notionIdIndex.get(normalizedId) ?? null;
  }

  /**
   * Invalidate the notionId->path index (call after writes/renames that change frontmatter).
   */
  invalidateNotionIdIndex(): void {
    this.notionIdIndex = null;
  }

  /**
   * Create a folder (and any missing parents) in the vault.
   */
  async createFolder(folderPath: string): Promise<void> {
    // Append a dummy filename so ensureFolder creates the full path
    await this.ensureFolder(`${folderPath}/_`);
  }

  /**
   * Find all duplicate notion_ids in the sync folder.
   * Returns a map of normalizedNotionId -> list of file paths (only entries with 2+ files).
   */
  findDuplicateNotionIds(syncFolder: string): Map<string, string[]> {
    const idToPaths = new Map<string, string[]>();
    const files = this.getMarkdownFiles(syncFolder);

    for (const file of files) {
      const fm = this.getFrontmatter(file.path);
      if (!fm?.notion_id || typeof fm.notion_id !== 'string') continue;
      const normalizedId = fm.notion_id.replace(/-/g, '');
      const paths = idToPaths.get(normalizedId);
      if (paths) {
        paths.push(file.path);
      } else {
        idToPaths.set(normalizedId, [file.path]);
      }
    }

    // Prune entries with only one file
    for (const [id, paths] of idToPaths) {
      if (paths.length < 2) idToPaths.delete(id);
    }

    return idToPaths;
  }

  /**
   * Strip N2O sync-identity keys from a file, turning it into a plain local file.
   * Preserves n2o_parent_id and n2o_parent_type so push can resolve where to create the page.
   * If the file was synced before n2o_parent_id existed, backfillParentId writes it.
   */
  async unlinkFromNotion(
    path: string,
    backfillParentId?: string,
    backfillParentType?: 'database' | 'page',
  ): Promise<void> {
    await this.updateFrontmatter(path, (fm) => {
      delete fm.notion_id;
      delete fm.n2o_type;
      delete fm.n2o_database;
      delete fm.notion_url;
      // Backfill n2o_parent_id for files synced before this field was introduced
      if (!fm.n2o_parent_id && backfillParentId) {
        fm.n2o_parent_id = backfillParentId;
        if (backfillParentType) {
          fm.n2o_parent_type = backfillParentType;
        }
      }
    });
  }

  /**
   * Get the absolute vault path on disk.
   */
  getVaultBasePath(): string {
    return (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? '';
  }
}
