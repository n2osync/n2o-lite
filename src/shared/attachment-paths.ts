/**
 * Canonical vault paths for N2O attachments.
 *
 * F-027 - architectural shift from per-page `_files/` subdirectories
 * to a single shared `_files/` folder at the sync-folder root. All
 * media (images, PDFs, videos, audio, generic files) live in one
 * place. Content-addressed filenames (`<base>-<hash8>.<ext>`) keep
 * collisions impossible, and Obsidian's unique-filename link resolver
 * lets any note reference any attachment via `![[name-hash.ext]]`
 * regardless of which folder hierarchy the note sits in.
 *
 * Pre-F-027 the plugin wrote attachments into one folder per page
 * (e.g. `Notion/_Pages/_files/`, `Notion/SomeDB/_files/`). This bit
 * users with cross-note media references - if Page A owned the file,
 * syncing Page B would try to move the file into Page B's folder and
 * break Page A. The shared location removes that failure mode by
 * construction.
 */

/** Build the canonical vault-relative path for the shared `_files/` folder. */
export function getSharedAttachmentFolder(syncFolder: string): string {
  return `${syncFolder}/_files`;
}

/**
 * Return true if the given vault path is inside the shared attachment
 * folder. Used by orphan cleanup to locate the single folder to scan.
 */
export function isInAttachmentFolder(path: string, syncFolder: string): boolean {
  return path.startsWith(`${syncFolder}/_files/`);
}

/**
 * Legacy per-page `_files/` folder path. Still accepted by the
 * orphan-cleanup scan so existing users don't lose access to
 * attachments that were written under the old layout - but new
 * writes always land in the shared folder.
 */
export function isLegacyFilesFolder(path: string): boolean {
  return path.includes('/_files/');
}
