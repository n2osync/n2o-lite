/**
 * Shared "Notion page -> markdown" rendering primitives.
 *
 * Before F-021 the pull path (`sync-page.ts`) inlined ~20 lines of media
 * download orchestration, duplicated between its prefetched and
 * non-prefetched branches.
 *
 * The fix: extract a shared core so one implementation serves N callers. This
 * module is that shared core. New paths that need "download this doc's
 * media" should import from here instead of hand-assembling the sequence.
 */
import type { N2ODocument } from '../../domain/models/document';
import type { FailedMediaItem } from '../../domain/models/sync-record';
import type { MediaHandler } from '../media/media-handler';

/**
 * Download media for a parsed doc (block-level + doc-level).
 *
 * Mutates the doc: media blocks with `sourceType: 'file'` flip to
 * `'local'` with a real vault path once the bytes are on disk, and
 * the builder downstream emits `![[filename]]` wikilinks instead of
 * the `![image - download pending]()` placeholder.
 *
 * No-op when either `downloadMedia` is false or `mediaHandler` is null
 * - the caller keeps control of both knobs.
 */
export async function downloadMediaForDoc(
  doc: N2ODocument,
  attachmentFolder: string,
  mediaHandler: MediaHandler | null,
  downloadMedia: boolean,
): Promise<FailedMediaItem[]> {
  if (!downloadMedia || !mediaHandler) return [];
  const failed: FailedMediaItem[] = [];
  const blockFailed = await mediaHandler.downloadBlockMedia(doc.blocks, attachmentFolder);
  failed.push(...blockFailed);
  const docFailed = await mediaHandler.downloadDocMedia(doc, attachmentFolder);
  failed.push(...docFailed);
  return failed;
}
