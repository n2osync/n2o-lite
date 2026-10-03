/**
 * OrphanDetector - detects and cleans up orphaned pages and attachments.
 *
 * Extracted from PullSyncProcessor to isolate orphan detection logic from pull orchestration.
 * Self-contained: all state is passed via method parameters.
 */

import type { VaultAdapter } from '../../infrastructure/obsidian/vault';
import type { SyncStateDB } from '../../infrastructure/storage/sync-state';
import type { SyncConfig } from '../../domain/models/sync-config';
import type { PageRegistry } from '../discovery/page-registry';
import type { PageRegistryEntry } from '../discovery/page-registry';
import type { SyncResultCounts, SyncResultItem } from '../sync/orchestrator';
import { createLogger } from '../../shared/logger';
import { normalizeNotionId } from '../../domain/models/notion-id';

const log = createLogger('OrphanDetector');

/**
 * Detect orphaned pages in sync state that are no longer in the registry.
 */
export async function detectOrphans(
  registryEntries: PageRegistryEntry[],
  _registry: PageRegistry,
  settings: SyncConfig,
  counts: SyncResultCounts,
  items: SyncResultItem[],
  syncState: SyncStateDB,
  vaultAdapter: VaultAdapter,
  options?: { dryRun?: boolean },
): Promise<void> {
  const registryIds = new Set(registryEntries.map((e) => normalizeNotionId(e.notionId)));
  // Use lightweight query - orphan detection only needs IDs, paths, and status
  const allOrphanData = syncState.getAllOrphanCheckData();
  const orphanFolder = `${settings.syncFolder}/_orphaned`;

  // F-029: at scope='selected', narrow orphan checks to the user's selection
  // envelope (directly-selected items + children of selected databases).
  // Otherwise we would flag every record that happens to be outside the
  // user's selection - not what the user wants.
  const inSelectedScope = settings.syncScope === 'selected';
  const selectedIds = inSelectedScope
    ? new Set((settings.selectedItems ?? []).map((i) => normalizeNotionId(i.id)))
    : null;
  const selectedDbIds = inSelectedScope
    ? new Set(
        (settings.selectedItems ?? [])
          .filter((i) => i.type === 'database')
          .map((i) => normalizeNotionId(i.id)),
      )
    : null;

  for (const record of allOrphanData) {
    const normalizedRecId = normalizeNotionId(record.notionId);
    if (inSelectedScope && selectedIds && selectedDbIds) {
      const normalizedParent = record.notionParentId
        ? normalizeNotionId(record.notionParentId)
        : null;
      const inScope =
        selectedIds.has(normalizedRecId) ||
        (normalizedParent !== null && selectedDbIds.has(normalizedParent));
      if (!inScope) {
        // F-034: record is out of scope. If its vault file is also gone,
        // it's a zombie (user un-selected + locally deleted). Safe to GC - // no file to move, no user intent to preserve. Keeps dashboard
        // counts honest and prevents surprise re-sync if the page is
        // re-selected later with a now-stale path.
        if (!vaultAdapter.fileExists(record.obsidianPath)) {
          log.info(`Zombie record GC: ${record.obsidianPath} (out of scope + file missing)`);
          syncState.deleteRecord(record.id);
        }
        continue;
      }
    }
    if (!registryIds.has(normalizedRecId) && record.status !== 'deleted') {
      counts.orphaned++;
      const fileName = record.obsidianPath.split('/').pop() ?? '';
      items.push({
        notionId: record.notionId,
        title: fileName.replace('.md', ''),
        vaultPath: record.obsidianPath,
        status: 'orphaned',
      });

      if (options?.dryRun) continue;

      // Fetch full record only when we need to mutate it (move/delete)
      const fullRecord = syncState.getByNotionId(record.notionId);
      if (!fullRecord) continue;

      try {
        let newPath = `${orphanFolder}/${fileName}`;
        // Avoid filename collisions - append counter if target already exists
        if (vaultAdapter.fileExists(newPath)) {
          const baseName = fileName.replace(/\.md$/, '');
          let counter = 1;
          const MAX_COLLISION_ATTEMPTS = 1000;
          while (vaultAdapter.fileExists(`${orphanFolder}/${baseName} (${counter}).md`)) {
            counter++;
            if (counter > MAX_COLLISION_ATTEMPTS) {
              log.warn(`Too many collisions for orphan: ${fileName} - using timestamp suffix`);
              newPath = `${orphanFolder}/${baseName} (${Date.now()}).md`;
              break;
            }
          }
          if (counter <= MAX_COLLISION_ATTEMPTS) {
            newPath = `${orphanFolder}/${baseName} (${counter}).md`;
          }
        }
        if (vaultAdapter.fileExists(fullRecord.obsidianPath)) {
          await vaultAdapter.moveFile(fullRecord.obsidianPath, newPath);
          log.info(`Moved orphan to ${newPath}`);
        }
        // BUG FIX: Only mark as 'deleted' AFTER moveFile succeeds
        fullRecord.obsidianPath = newPath;
        fullRecord.status = 'deleted';
        syncState.upsertRecord(fullRecord);

        // If user wants orphans fully deleted, trash the moved file
        if (settings.syncDeletedItems) {
          try {
            await vaultAdapter.deleteFile(newPath);
            syncState.deleteRecord(fullRecord.id);
            log.info(`Trashed orphan: ${newPath}`);
          } catch {
            log.warn(`Could not trash orphan: ${newPath} (kept in _orphaned)`);
          }
        }
      } catch {
        // BUG FIX: Do NOT mark as 'deleted' if moveFile fails - leave record unchanged
        log.warn(`Could not move orphan: ${fullRecord.obsidianPath} - record left as-is`);
      }
    }
  }
}

/**
 * Remove attachment files in _files/ folders that are no longer referenced
 * by any markdown file in the sync folder.
 * Reads files one at a time to avoid memory spikes on large vaults.
 */
export async function cleanOrphanedAttachments(
  settings: SyncConfig,
  syncState: SyncStateDB,
  vaultAdapter: VaultAdapter,
): Promise<void> {
  const syncFolder = settings.syncFolder;

  /* 1. Collect all _files/ references from every markdown file in the
   * sync folder. F-015: we used to skip files whose mtime predated the
   * last sync as an optimization, but that also skipped contributing
   * their references to the set - so any attachment referenced only by
   * unchanged notes got deleted. A future optimization could maintain a
   * persistent markdown-path -> referenced-filenames index, but the simple
   * read-everything loop is correct and runs only when orphans are
   * detected (infrequent for most users). */
  const allMarkdownFiles = vaultAdapter.getMarkdownFiles(syncFolder);
  const referencedFiles = new Set<string>();

  for (const file of allMarkdownFiles) {
    const content = await vaultAdapter.readFile(file.path);
    if (!content) continue;
    // Collect _files/ references (body embeds like `_files/photo.jpg`)
    const fileMatches = content.matchAll(/_files\/[^\s\])>"]+/g);
    for (const match of fileMatches) {
      const fileName = match[0].split('/').pop();
      if (fileName) referencedFiles.add(fileName);
    }
    // Collect frontmatter property references (banner, bannerOriginal, cover, coverOriginal, icon).
    // The value is either a quoted string (which may contain spaces, e.g.
    // `cover: "my photo.jpg"`) or a bare unquoted token. The old pattern used a
    // single `[^\s"]+` group, which truncated a quoted value at the first space
    // (`"my photo.jpg"` -> `my`), so the real attachment was not seen as
    // referenced and got deleted as an orphan (#1460). Match both shapes and
    // reduce to the filename so a path-style value resolves too.
    const fmMatches = content.matchAll(
      /^(?:banner|bannerOriginal|cover|coverOriginal|icon|n2o_cover):\s*(?:"([^"]+)"|([^\s"]+))\s*$/gm,
    );
    for (const match of fmMatches) {
      const raw = match[1] ?? match[2];
      const fileName = raw?.split('/').pop();
      if (fileName) referencedFiles.add(fileName);
    }
    // Collect wikilink embeds (![[filename]])
    const wikiMatches = content.matchAll(/!\[\[([^\]|]+)/g);
    for (const match of wikiMatches) {
      const linkTarget = (match[1] ?? '').split('/').pop();
      if (linkTarget) referencedFiles.add(linkTarget);
    }
  }

  // 2. Scan all _files/ folders and delete unreferenced files
  //    Pre-check: skip folders where no files were orphaned this sync
  let cleaned = 0;
  const folders = findFilesFolders(syncFolder, vaultAdapter, allMarkdownFiles);
  // Build list of folders to scan: _files/ folders + their _thumbs/ subfolders
  const foldersToScan: string[] = [];
  for (const folder of folders) {
    foldersToScan.push(folder);
    const thumbsFolder = `${folder}/_thumbs`;
    if (vaultAdapter.fileExists(thumbsFolder)) {
      foldersToScan.push(thumbsFolder);
    }
  }
  for (const folder of foldersToScan) {
    const files = vaultAdapter.getFilesInFolder(folder);
    for (const file of files) {
      const fileName = file.path.split('/').pop() ?? '';
      // Skip media manifest files
      if (fileName === '.n2o-media.json') continue;
      if (!referencedFiles.has(fileName)) {
        // Metadata pre-check: skip recently created attachments
        // that may not be referenced yet (within a 60s grace period)
        const attachMtime = file.stat?.mtime ?? 0;
        if (attachMtime > 0 && Date.now() - attachMtime < 60_000) {
          log.debug(
            `Skipping recent attachment: ${file.path} (created ${Math.round((Date.now() - attachMtime) / 1000)}s ago)`,
          );
          continue;
        }
        try {
          await vaultAdapter.deleteFile(file.path);
          cleaned++;
          log.debug(`Cleaned orphaned attachment: ${file.path}`);
        } catch {
          log.warn(`Could not clean orphaned attachment: ${file.path}`);
        }
      }
    }
  }

  if (cleaned > 0) {
    log.info(`Cleaned ${cleaned} orphaned attachment(s)`);
  }
}

/**
 * Find all _files/ folders under a given root folder.
 * Accepts pre-scanned file list to avoid redundant vault scan.
 */
function findFilesFolders(
  rootFolder: string,
  vaultAdapter: VaultAdapter,
  existingFiles?: { path: string }[],
): string[] {
  const result: string[] = [];
  const allFiles = existingFiles ?? vaultAdapter.getMarkdownFiles(rootFolder);
  const folders = new Set<string>();
  for (const file of allFiles) {
    const dir = file.path.substring(0, file.path.lastIndexOf('/'));
    folders.add(dir);
  }
  for (const dir of folders) {
    const filesFolder = `${dir}/_files`;
    if (vaultAdapter.fileExists(filesFolder)) {
      result.push(filesFolder);
    }
  }
  const rootFiles = `${rootFolder}/_files`;
  if (vaultAdapter.fileExists(rootFiles) && !result.includes(rootFiles)) {
    result.push(rootFiles);
  }
  return result;
}
