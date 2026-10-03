/**
 * MediaHandler - Orchestrates media downloads for pages and documents.
 *
 * Extracted from SyncEngine to isolate media download logic:
 * - Walk blocks recursively and download images/videos/files/PDFs
 * - Download document-level media (cover, icon, file properties)
 * - Track failed downloads for retry
 *
 * Supports parallel media downloads with configurable concurrency.
 */

import type { N2OBlock, ImageMeta } from '../../domain/models/block';
import type { N2ODocument } from '../../domain/models/document';
import type { FailedMediaItem } from '../../domain/models/sync-record';
import type { MediaDownloader, MediaDownloadResult } from './media-downloader';
import { classifyMediaFailure } from './media-failure-classifier';
import { Semaphore } from '../../shared/semaphore';
import { mapNotionSvgIconToEmoji } from '../../shared/notion-icon-map';
import { isEmbedOnlyUrl } from '../../shared/embed-providers';

export class MediaHandler {
  private semaphore: Semaphore;
  private generateThumbnails: boolean;

  constructor(
    private mediaDownloader: MediaDownloader,
    mediaConcurrency: number = 3,
    generateThumbnails: boolean = true,
  ) {
    this.semaphore = new Semaphore(mediaConcurrency);
    this.generateThumbnails = generateThumbnails;
  }

  /**
   * Walk all blocks recursively and download media (images, videos, files, PDFs).
   * Mutates block.meta to sourceType:'local' and url to local path.
   * Returns an array of block IDs where download failed (for retry tracking).
   *
   * @param blocks - Block tree to process
   * @param attachmentFolder - Target folder for downloads (parallel-safe, avoids shared state)
   * @param concurrency - Override concurrency limit
   */
  async downloadBlockMedia(
    blocks: N2OBlock[],
    attachmentFolder?: string,
    concurrency?: number,
  ): Promise<FailedMediaItem[]> {
    if (concurrency !== undefined && concurrency !== this.semaphore.getCapacity()) {
      this.semaphore = new Semaphore(concurrency);
    }

    const mediaBlocks = this.collectMediaBlocks(blocks);
    if (mediaBlocks.length === 0) {
      return [];
    }

    const results = await Promise.allSettled(
      mediaBlocks.map((block) =>
        this.semaphore.run(() => this.downloadOneBlock(block, attachmentFolder)),
      ),
    );

    const failed: FailedMediaItem[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const block = mediaBlocks[i];
      if (!result || !block) continue;
      if (result.status === 'rejected') {
        // download() catches internally, so this path is defensive: classify from
        // the raw rejection and the block's URL so it is still an honest item.
        const meta = block.meta as ImageMeta;
        const reason = String(result.reason);
        const c = classifyMediaFailure({
          url: meta.url,
          error: reason,
          sourceType: meta.sourceType === 'file' ? 'file' : 'external',
        });
        failed.push({
          id: block.id,
          mediaType: block.type,
          error: reason,
          reason: c.reason,
          statusCode: c.statusCode,
          class: c.class,
          url: meta.url,
        });
      } else if (result.status === 'fulfilled' && result.value !== null) {
        failed.push(result.value);
      }
    }
    return failed;
  }

  /**
   * Download media from document-level properties, cover, and icon.
   * Mutates doc.properties values, doc.banner, doc.icon with local paths.
   * Returns an array of failed download identifiers for retry tracking.
   *
   * @param doc - Document to process
   * @param attachmentFolder - Target folder for downloads (parallel-safe)
   */
  async downloadDocMedia(doc: N2ODocument, attachmentFolder?: string): Promise<FailedMediaItem[]> {
    const notionId = doc.notionId ?? doc.id;
    const idPrefix = notionId.replace(/-/g, '');
    const failed: FailedMediaItem[] = [];

    // Download banner image (with thumbnail generation for large rasters)
    if (doc.banner && doc.banner.includes('://') && !isEmbedOnlyUrl(doc.banner)) {
      const result = await this.mediaDownloader.download(
        doc.banner,
        `${idPrefix}-cover`,
        doc.banner.includes('amazonaws.com') ? 'file' : 'external',
        attachmentFolder,
        { generateThumbnail: this.generateThumbnails },
      );
      if (result.success) {
        doc.banner = result.localPath;
        if (result.originalPath) {
          doc.bannerOriginal = result.originalPath;
        }
      } else {
        failed.push(this.failedItem(`${idPrefix}-cover`, 'cover', result, doc.banner));
      }
    }

    // Download icon (only if it's a URL, not an emoji)
    if (doc.icon && doc.icon.includes('://') && !isEmbedOnlyUrl(doc.icon)) {
      // Try to map Notion built-in SVG icons to emoji equivalents first
      const emoji = mapNotionSvgIconToEmoji(doc.icon);
      if (emoji) {
        doc.icon = emoji;
      } else {
        const result = await this.mediaDownloader.download(
          doc.icon,
          `${idPrefix}-icon`,
          doc.icon.includes('amazonaws.com') ? 'file' : 'external',
          attachmentFolder,
        );
        if (result.success) {
          doc.icon = result.localPath;
        } else {
          failed.push(this.failedItem(`${idPrefix}-icon`, 'icon', result, doc.icon));
        }
      }
    }

    // Download files from 'files' type properties
    for (const prop of doc.properties) {
      if (prop.type === 'files' && Array.isArray(prop.value)) {
        const urls = prop.value as string[];
        for (let i = 0; i < urls.length; i++) {
          const url = urls[i];
          if (typeof url === 'string' && url.includes('://') && !isEmbedOnlyUrl(url)) {
            const downloadId = `${idPrefix}-${prop.key}-${i}`;
            const result = await this.mediaDownloader.download(
              url,
              downloadId,
              url.includes('amazonaws.com') ? 'file' : 'external',
              attachmentFolder,
              { generateThumbnail: this.generateThumbnails },
            );
            if (result.success) {
              urls[i] = result.localPath;
            } else {
              failed.push(this.failedItem(downloadId, 'file-property', result, url));
            }
          }
        }
      }
    }

    return failed;
  }

  /**
   * Check if a block is a media block that should be downloaded.
   */
  isMediaBlock(block: N2OBlock): boolean {
    return (
      block.type === 'image' ||
      block.type === 'video' ||
      block.type === 'audio' ||
      block.type === 'file' ||
      block.type === 'pdf'
    );
  }

  /**
   * Collect all media blocks from a block tree (recursive flatten).
   */
  private collectMediaBlocks(blocks: N2OBlock[]): N2OBlock[] {
    const result: N2OBlock[] = [];
    const stack = [...blocks];
    while (stack.length > 0) {
      const block = stack.pop();
      if (!block) break;
      if (this.isMediaBlock(block) && block.meta.kind === 'image') {
        const meta = block.meta;
        // Skip already-local AND skip external embed-only URLs (YouTube, Vimeo, etc.)
        // The downloader can't resolve those to files; the renderer keeps them as ![](url)
        // and Obsidian embeds them inline.
        if (
          meta.sourceType !== 'local' &&
          !(meta.sourceType === 'external' && isEmbedOnlyUrl(meta.url))
        ) {
          result.push(block);
        }
      }
      if (block.children?.length) {
        stack.push(...block.children);
      }
    }
    return result;
  }

  /**
   * Download a single media block. Returns null on success, FailedMediaItem on failure.
   */
  private async downloadOneBlock(
    block: N2OBlock,
    attachmentFolder?: string,
  ): Promise<FailedMediaItem | null> {
    const meta = block.meta as ImageMeta;
    const sourceType = meta.sourceType as 'file' | 'external';
    const result = await this.mediaDownloader.download(
      meta.url,
      block.id,
      sourceType,
      attachmentFolder,
      undefined,
      meta.originalFilename,
    );
    if (result.success) {
      meta.sourceType = 'local';
      meta.url = result.localPath;
      meta.unavailable = false;
      return null;
    }
    // Mark the block unavailable only when the failure is PERMANENT (the source
    // file is gone/forbidden), so the renderer emits the honest "unavailable at
    // source" fallback (#1780). A transient failure (timeout, 5xx, expired Notion
    // signature) keeps the retry placeholder - the bytes are expected back on the
    // next sync, so claiming "unavailable" would be a lie.
    meta.unavailable = result.failureClass === 'permanent';
    return this.failedItem(block.id, block.type, result, meta.url);
  }

  /** Build a FailedMediaItem carrying the downloader's classification (#1780). */
  private failedItem(
    id: string,
    mediaType: string,
    result: MediaDownloadResult,
    url: string,
  ): FailedMediaItem {
    return {
      id,
      mediaType,
      error: result.error ?? 'Download failed',
      reason: result.failureReason,
      statusCode: result.statusCode,
      class: result.failureClass,
      url,
    };
  }
}
