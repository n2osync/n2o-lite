/**
 * Bootstrap wiring for the FileHashIndex.
 *
 * Responsibilities:
 *  - Lazy cold-start rebuild: if the index is empty, walk the vault's
 *    media files once and populate. Runs in the background off
 *    layout-ready so startup isn't blocked.
 *  - Subscribe to Obsidian vault events to keep the index fresh:
 *      create -> hash + record
 *      modify -> re-hash + update
 *      rename -> update path (content unchanged)
 *      delete -> forget
 *
 * Lives in plugin/ (not application/) because it drives the Obsidian App
 * directly and wires runtime infrastructure - it is bootstrap glue, so the
 * layer boundary that keeps application/ free of runtime infrastructure and
 * direct Obsidian calls holds (#1584). The FileHashIndex class itself stays
 * platform-agnostic (pure SQL) and unit-testable without an Obsidian runtime.
 */

import { TFile } from 'obsidian';
import type { App, TAbstractFile, EventRef } from 'obsidian';
import type { FileHashIndex } from '../infrastructure/storage/file-hash-index';
import { shouldIndex } from '../infrastructure/storage/file-hash-index';
import { sha256Binary } from '../shared/hash';
import { createLogger } from '../shared/logger';
import { getErrorMessage } from '../shared/errors';

const log = createLogger('FileIndexBootstrap');

/** Max bytes we're willing to hash in a single file. Skip absurdly large files. */
const MAX_HASH_SIZE = 2 * 1024 * 1024 * 1024; // 2 GiB

/**
 * Hash one file's bytes and record in the index. No-op if the file is
 * missing, too big, or not a media type. Safe to call repeatedly - the
 * upsert overwrites.
 */
async function hashAndRecord(app: App, file: TFile, index: FileHashIndex): Promise<void> {
  if (!shouldIndex(file.path)) return;
  if (file.stat.size > MAX_HASH_SIZE) {
    log.warn(`Skipping ${file.path} - exceeds ${MAX_HASH_SIZE / 1024 / 1024} MB limit`);
    return;
  }
  try {
    const data = await app.vault.readBinary(file);
    const hash = await sha256Binary(data);
    index.record(file.path, hash, file.stat.size, file.stat.mtime);
  } catch (err) {
    log.debug(`Failed to hash ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Walk every media file in the vault and hash-index it. Runs serially
 * to keep memory flat - hashing is IO-bound so concurrency gains are
 * small. Returns the count of files indexed.
 */
async function rebuildFileIndex(app: App, index: FileHashIndex): Promise<number> {
  const all = app.vault.getFiles().filter((f) => shouldIndex(f.path));
  log.info(`Cold-start rebuild: hashing ${all.length} media files`);
  let indexed = 0;
  for (const file of all) {
    await hashAndRecord(app, file, index);
    indexed++;
  }
  log.info(`Cold-start rebuild complete: ${indexed} files indexed`);
  return indexed;
}

/**
 * F-025: run a one-time vault walk to populate the file hash index
 * if it's empty. Deferred off the hot path - runs asynchronously
 * without blocking layout-ready. Subsequent sessions see count > 0
 * and skip the walk; the watcher keeps the index fresh after that.
 */
export async function kickoffFileIndexRebuildIfEmpty(
  app: App,
  index: FileHashIndex | undefined,
): Promise<void> {
  try {
    if (!index) return;
    if (index.count() > 0) return;
    log.info('File hash index empty - running cold-start rebuild in background');
    const indexed = await rebuildFileIndex(app, index);
    log.info(`File hash index cold-start complete: ${indexed} files`);
  } catch (err) {
    log.warn(`File hash index cold-start failed: ${getErrorMessage(err)}`);
  }
}

/** Handle to the subscription so callers can detach (on unload / reset). */
export interface FileIndexWatcher {
  detach(): void;
}

/**
 * Subscribe to Obsidian vault events. Returns a handle whose detach()
 * unregisters every listener - call on plugin unload.
 */
export function attachFileIndexWatcher(app: App, index: FileHashIndex): FileIndexWatcher {
  const refs: EventRef[] = [];

  const onCreate = async (file: TAbstractFile) => {
    /* Obsidian emits 'create' for folders too; filter via shouldIndex. */
    if (!(file instanceof TFile)) return;
    const tf = file;
    if (!shouldIndex(tf.path)) return;
    await hashAndRecord(app, tf, index);
  };
  const onModify = async (file: TAbstractFile) => {
    if (!(file instanceof TFile)) return;
    const tf = file;
    if (!shouldIndex(tf.path)) return;
    await hashAndRecord(app, tf, index);
  };
  const onDelete = (file: TAbstractFile) => {
    if (!shouldIndex(file.path)) return;
    index.forget(file.path);
  };
  const onRename = (file: TAbstractFile, oldPath: string) => {
    /* Handle both cases: renamed into a tracked ext, or out of it. */
    const newTracked = shouldIndex(file.path);
    const oldTracked = shouldIndex(oldPath);
    if (oldTracked && newTracked) {
      index.rename(oldPath, file.path);
    } else if (oldTracked && !newTracked) {
      index.forget(oldPath);
    } else if (!oldTracked && newTracked && file instanceof TFile) {
      void hashAndRecord(app, file, index);
    }
  };

  refs.push(app.vault.on('create', onCreate));
  refs.push(app.vault.on('modify', onModify));
  refs.push(app.vault.on('delete', onDelete));
  refs.push(app.vault.on('rename', onRename));

  log.debug('File-index watcher attached');

  return {
    detach: () => {
      for (const ref of refs) app.vault.offref(ref);
      log.debug('File-index watcher detached');
    },
  };
}
