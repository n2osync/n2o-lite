/**
 * MediaDownloader - Downloads images, files, videos, PDFs from Notion's expiring S3 URLs.
 * Uses Obsidian's requestUrl for HTTP and VaultAdapter.writeBinary() for storage.
 *
 * Filename format: {original-name}-{sha256_8hex}.{ext}
 * - Content-addressed: same content -> same hash -> natural dedup
 * - Different content -> different hash -> no collisions
 * - Persistent manifest (.n2o-media.json) enables cross-session skip optimization
 */

import { canvasEncode, probeImage } from './image-optimizer';
import {
  classifyMediaFailure,
  extractStatusCode,
  type MediaFailureClass,
} from './media-failure-classifier';
import type { VaultAdapter } from '../../infrastructure/obsidian/vault';
import type { FileHashIndex } from '../../infrastructure/storage/file-hash-index';
import type { MediaAliasStore } from '../../infrastructure/storage/media-alias-store';
import type { MediaOriginStore } from '../../infrastructure/storage/media-origin-store';
import { extractFileExtension, extractFileName, sanitizeFileName } from '../../shared/sanitize';
import { sha256Binary } from '../../shared/hash';
import { N2OError, getErrorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/logger';

const log = createLogger('MediaDownloader');

/** Timeout for individual media downloads (ms). */
const MEDIA_DOWNLOAD_TIMEOUT_MS = 120_000;

/** Minimum file size to trigger thumbnail generation (512 KB). */
const THUMB_THRESHOLD = 512 * 1024;

/** Maximum thumbnail width in pixels. */
const MAX_THUMB_WIDTH = 800;

/** Extensions that should never be thumbnailed (animated/vector formats). */
const THUMB_SKIP_EXTS = new Set(['.gif', '.svg', '.ico', '.bmp']);

/** Allowed URL schemes for media downloads (SSRF protection). */
const ALLOWED_SCHEMES = new Set(['https:', 'http:']);

/** Manifest filename stored in each _files folder. */
const MANIFEST_FILENAME = '.n2o-media.json';

/** Current manifest format version. */
const MANIFEST_VERSION = 1;

/** Manifest entry for a single block's media file. */
interface ManifestEntry {
  hash: string;
  fileName: string;
}

/** On-disk manifest format. */
interface ManifestData {
  version: number;
  entries: Record<string, ManifestEntry>;
}

/**
 * Validate a URL for safe media download.
 * Rejects non-HTTP schemes and private/loopback IP ranges.
 */
function validateMediaUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new N2OError(`Invalid media URL: ${url}`, 'ATTACHMENT_ERROR');
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new N2OError(
      `Blocked media URL scheme: ${parsed.protocol} (only http/https allowed)`,
      'ATTACHMENT_ERROR',
    );
  }

  // Block decimal IP encoding (e.g. http://2130706433 = 127.0.0.1).
  // A purely-numeric hostname is a decimal IP - reject it outright.
  const host = parsed.hostname;
  if (/^\d+$/.test(host)) {
    throw new N2OError(`Blocked media URL: decimal IP encoding (${host})`, 'ATTACHMENT_ERROR');
  }

  // Normalize: strip IPv6 bracket wrapper and lowercase
  const normalized = host.replace(/^\[|]$/g, '').toLowerCase();

  // Block private/loopback/link-local/CGNAT addresses
  if (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '0.0.0.0' ||
    normalized === '::' ||
    normalized.startsWith('10.') ||
    normalized.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(normalized) ||
    /^169\.254\./.test(normalized) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(normalized) ||
    normalized.endsWith('.local') ||
    // IPv6-mapped IPv4: block ::ffff: prefixed private ranges
    /^::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.0\.0\.0)/.test(
      normalized,
    )
  ) {
    throw new N2OError(`Blocked media URL: private/loopback address (${host})`, 'ATTACHMENT_ERROR');
  }
}

/** Map Content-Type MIME types to file extensions. */
const MIME_TO_EXT: Record<string, string> = {
  // Images
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/tiff': '.tiff',
  'image/heic': '.heic',
  // Video
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'video/x-msvideo': '.avi',
  'video/mpeg': '.mpeg',
  'video/x-ms-asf': '.wmv',
  'video/ogg': '.ogv',
  // Audio
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/flac': '.flac',
  'audio/aac': '.aac',
  // Documents
  'application/pdf': '.pdf',
};

/**
 * Derive file extension from Content-Type header.
 * Returns extension with dot (e.g. ".jpg") or null if unknown.
 */
function extFromContentType(contentType: string | undefined): string | null {
  if (!contentType) return null;
  // Content-Type can have params: "image/jpeg; charset=utf-8"
  const mime = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return MIME_TO_EXT[mime] ?? null;
}

/**
 * Detect file extension from magic bytes (file signature).
 * Last-resort fallback when Content-Type header is missing or `application/octet-stream`.
 */
export function extFromMagicBytes(data: ArrayBuffer): string | null {
  const bytes = new Uint8Array(data);
  if (bytes.length < 4) return null;

  // ── Images ──
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return '.png';
  // GIF: 47 49 46 38
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38)
    return '.gif';
  // BMP: 42 4D
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return '.bmp';
  // TIFF little-endian: 49 49 2A 00
  if (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00)
    return '.tiff';
  // TIFF big-endian: 4D 4D 00 2A
  if (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
    return '.tiff';

  // ── RIFF container: WebP, WAV, AVI ──
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    // WebP: RIFF....WEBP
    if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
      return '.webp';
    // WAV: RIFF....WAVE
    if (bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45)
      return '.wav';
    // AVI: RIFF....AVI\x20
    if (bytes[8] === 0x41 && bytes[9] === 0x56 && bytes[10] === 0x49 && bytes[11] === 0x20)
      return '.avi';
  }

  // ── ISOBMFF container (MP4/MOV/M4A): ....ftyp at offset 4 ──
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);
    if (brand === 'qt  ') return '.mov';
    if (brand.startsWith('M4A') || brand.startsWith('M4B')) return '.m4a';
    return '.mp4'; // isom, iso2, mp41, mp42, avc1, M4V, etc.
  }

  // ── Audio ──
  // OGG: 4F 67 67 53 ("OggS")
  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53)
    return '.ogg';
  // FLAC: 66 4C 61 43 ("fLaC")
  if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43)
    return '.flac';

  // ── Documents ──
  // PDF: 25 50 44 46 ("%PDF")
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)
    return '.pdf';

  return null;
}

/** Options for download behavior. */
/** Minimal HTTP GET function type - decouples MediaDownloader from Obsidian's requestUrl. */
export type HttpGetFn = (params: { url: string; method: string }) => Promise<{
  arrayBuffer: ArrayBuffer;
  headers?: Record<string, string>;
}>;

export interface DownloadOptions {
  /** Generate a thumbnail (large rasters only). Applies to covers and file-property images. */
  generateThumbnail?: boolean;
}

export interface MediaDownloadResult {
  success: boolean;
  /** Vault-relative local path (e.g. "Notion/Bookshelf/_files/photo-a1b2c3d4.png") */
  localPath: string;
  /** Just the filename (e.g. "photo-a1b2c3d4.png") */
  fileName: string;
  /** Full-resolution original path (set when a thumbnail was generated) */
  originalPath?: string;
  /** Error message if download failed */
  error?: string;
  /** HTTP status recovered from the failing response, when there was one (#1780). */
  statusCode?: number;
  /** Whether retrying can help: 'permanent' vs 'transient' (#1780). Set on failure only. */
  failureClass?: MediaFailureClass;
  /** Plain-words, user-facing failure reason (#1780). Set on failure only. */
  failureReason?: string;
}

export class MediaDownloader {
  /** URL-to-{data, contentType} cache for same-sync-session dedup */
  private downloadCache = new Map<string, { data: ArrayBuffer; contentType?: string }>();
  /**
   * In-flight downloads keyed by cacheKey(url). Two blocks referencing the
   * SAME source (the same image twice on one page) download concurrently, and
   * before this map they raced the same content-addressed target path: both
   * saw fileExists=false, the second createBinary threw "already exists", and
   * that block rendered as an empty ![caption]() placeholder forever (#1645).
   * The second caller now AWAITS the first download instead of racing it.
   */
  private inFlight = new Map<string, Promise<{ data: ArrayBuffer; contentType?: string }>>();
  /** Running total of bytes held in downloadCache (sum of data.byteLength). */
  private downloadCacheBytes = 0;
  /** Content-addressed manifest: blockId -> { hash, fileName } */
  private manifest = new Map<string, ManifestEntry>();
  /** Tracks which folders' manifests have been loaded this session */
  private loadedFolders = new Set<string>();
  /** Bytes downloaded this sync session (for disk space awareness) */
  private sessionBytes = 0;
  /** Threshold to warn about large downloads (100 MB) */
  private static readonly LARGE_DOWNLOAD_THRESHOLD = 100 * 1024 * 1024;
  /**
   * Maximum cache entries before evicting oldest.
   *
   * The byte cap below is the real safety bound; this entry-count cap
   * is just a defensive upper limit for tiny-file workloads where the
   * byte cap may never trigger.
   */
  private static readonly MAX_CACHE_ENTRIES = 200;
  /**
   * Maximum total bytes held in the URL->ArrayBuffer cache. The
   * pre-fix code only bounded the entry count, so 200 large items
   * (e.g., a synced-media batch with several 50MB videos) could push
   * memory past 1GB and OOM on resource-constrained machines.
   * 200MB is generous enough that typical sync sessions hit the entry
   * cap before the byte cap, while still putting a hard ceiling on
   * worst-case memory.
   */
  private static readonly MAX_CACHE_BYTES = 200 * 1024 * 1024;
  /**
   * Skip caching individual items larger than this. Above this size
   * the item dominates the cache, evicts every other entry, and is
   * unlikely to be re-downloaded inside the same sync session anyway
   * (each large file usually has only one Notion block referencing
   * it). Returning the bytes to the current caller still works; we
   * just don't keep them around.
   */
  private static readonly MAX_CACHE_ITEM_BYTES = 25 * 1024 * 1024;

  /**
   * Optional content-hash index (F-025 dedup). When set, every download's
   * SHA256 is checked against the index before writing - if any vault
   * file already has the same bytes, the existing path is reused and the
   * write is skipped. Prevents push->writeback from duplicating files the
   * user placed outside `_files/`.
   */
  private fileHashIndex: FileHashIndex | null = null;

  /**
   * Optional alias store (#1756). When a downloaded file's hash misses the
   * F-025 index but matches an optimized-upload alias, the pull reuses the
   * vault ORIGINAL the alias points at instead of writing Notion's optimized
   * copy as a new file.
   */
  private mediaAliasStore: MediaAliasStore | null = null;

  /**
   * Optional origin store. Every EXTERNAL image that localizes records
   * (content hash -> source URL) here, so a later push of those bytes can
   * re-emit the original external link instead of uploading a copy.
   */
  private mediaOriginStore: MediaOriginStore | null = null;

  constructor(
    private vaultAdapter: VaultAdapter,
    private attachmentFolder: string,
    private httpGet: HttpGetFn,
  ) {}

  /** Wire the file-hash index for vault-wide dedup (F-025). */
  setFileHashIndex(index: FileHashIndex | null): void {
    this.fileHashIndex = index;
  }

  /** Wire the optimized-upload alias store (#1756). */
  setMediaAliasStore(store: MediaAliasStore | null): void {
    this.mediaAliasStore = store;
  }

  /** Wire the external-origin store so push can relink instead of re-uploading. */
  setMediaOriginStore(store: MediaOriginStore | null): void {
    this.mediaOriginStore = store;
  }

  /**
   * Update the attachment folder path (when settings change).
   */
  setAttachmentFolder(folder: string): void {
    this.attachmentFolder = folder;
  }

  /** Clear download cache between sync runs to free memory. */
  clearCache(): void {
    this.downloadCache.clear();
    this.downloadCacheBytes = 0;
    this.manifest.clear();
    this.loadedFolders.clear();
    this.sessionBytes = 0;
  }

  /**
   * Insert into downloadCache while holding both the entry-count and
   * byte-budget caps. Skips caching items larger than MAX_CACHE_ITEM_BYTES
   * (those items still get returned to the current caller; we just don't
   * persist them across the session).
   */
  private cacheDownload(key: string, data: ArrayBuffer, contentType?: string): void {
    const size = data.byteLength;
    if (size > MediaDownloader.MAX_CACHE_ITEM_BYTES) return;

    // Evict by FIFO until we're under both caps. Map iteration order is
    // insertion order, so keys().next() gives us the oldest entry.
    while (
      (this.downloadCache.size >= MediaDownloader.MAX_CACHE_ENTRIES ||
        this.downloadCacheBytes + size > MediaDownloader.MAX_CACHE_BYTES) &&
      this.downloadCache.size > 0
    ) {
      const oldest = this.downloadCache.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.downloadCache.get(oldest);
      this.downloadCache.delete(oldest);
      if (evicted) this.downloadCacheBytes -= evicted.data.byteLength;
    }

    // After eviction the cache may still not fit this single item if
    // the item is huge (close to MAX_CACHE_BYTES). The MAX_CACHE_ITEM_BYTES
    // guard at the top makes that impossible in practice but keep the
    // accounting honest.
    if (this.downloadCacheBytes + size > MediaDownloader.MAX_CACHE_BYTES) return;

    this.downloadCache.set(key, { data, contentType });
    this.downloadCacheBytes += size;
  }

  /** Get total bytes downloaded this session. */
  getSessionBytes(): number {
    return this.sessionBytes;
  }

  /**
   * Load the manifest for a folder from disk.
   * Called lazily on first download to that folder.
   */
  private async loadManifest(folder: string): Promise<void> {
    if (this.loadedFolders.has(folder)) return;
    this.loadedFolders.add(folder);

    const manifestPath = `${folder}/${MANIFEST_FILENAME}`;
    try {
      const content = await this.vaultAdapter.readFile(manifestPath);
      if (!content) return;
      const data = JSON.parse(content) as ManifestData;
      if (data.version !== MANIFEST_VERSION || !data.entries) return;
      for (const [blockId, entry] of Object.entries(data.entries)) {
        this.manifest.set(blockId, entry);
      }
      log.debug(`Loaded manifest: ${manifestPath} (${Object.keys(data.entries).length} entries)`);
    } catch {
      // Missing or corrupt - start fresh for this folder
      log.debug(`No manifest found for ${folder} - starting fresh`);
    }
  }

  /**
   * Save manifests for all loaded folders to disk.
   * Call before clearCache() to persist cross-session skip data.
   */
  async saveAllManifests(): Promise<void> {
    // Group manifest entries by folder (derived from fileName -> folder mapping)
    // Since we track loaded folders, write one manifest per folder
    for (const folder of this.loadedFolders) {
      await this.saveManifest(folder);
    }
  }

  /**
   * Save manifest for a specific folder.
   */
  private async saveManifest(folder: string): Promise<void> {
    const manifestPath = `${folder}/${MANIFEST_FILENAME}`;
    // Collect entries whose fileName exists in this folder
    const entries: Record<string, ManifestEntry> = {};
    for (const [blockId, entry] of this.manifest) {
      // Check if the file belongs to this folder
      const filePath = `${folder}/${entry.fileName}`;
      if (this.vaultAdapter.fileExists(filePath)) {
        entries[blockId] = entry;
      }
    }
    if (Object.keys(entries).length === 0) return;

    const data: ManifestData = { version: MANIFEST_VERSION, entries };
    try {
      await this.vaultAdapter.writeFile(manifestPath, JSON.stringify(data, null, 2));
      log.debug(`Saved manifest: ${manifestPath} (${Object.keys(entries).length} entries)`);
    } catch {
      log.warn(`Failed to save manifest: ${manifestPath}`);
    }
  }

  /** Strip query params from URL for cache key (S3 URLs have expiring tokens). */
  private cacheKey(url: string): string {
    try {
      return new URL(url).origin + new URL(url).pathname;
    } catch {
      return url;
    }
  }

  /**
   * The raw HTTP fetch with timeout. Extracted so concurrent callers of the
   * same source share ONE flight via the inFlight map (#1645). Throws on
   * timeout or an empty body; download()'s catch turns that into the failure
   * result for every awaiting caller.
   */
  private async fetchUrl(
    url: string,
    baseName: string,
    sourceType: 'file' | 'external',
  ): Promise<{ data: ArrayBuffer; contentType?: string }> {
    log.info(`Downloading: ${baseName} from ${sourceType} source`);
    let timeoutId: number;
    const response = await Promise.race([
      this.httpGet({ url, method: 'GET' }),
      new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(
          () =>
            reject(
              new Error(
                `Media download timed out after ${MEDIA_DOWNLOAD_TIMEOUT_MS / 1000}s: ${baseName}`,
              ),
            ),
          MEDIA_DOWNLOAD_TIMEOUT_MS,
        );
      }),
    ]).finally(() => window.clearTimeout(timeoutId));

    if (!response.arrayBuffer) {
      throw new Error('Empty response body');
    }
    return { data: response.arrayBuffer, contentType: response.headers?.['content-type'] };
  }

  /**
   * Download a file from a URL and save it to the attachment folder.
   * Uses content-addressed filenames: {baseName}-{sha256_8hex}.{ext}
   *
   * @param url - The source URL (Notion S3 or external)
   * @param blockId - The Notion block ID (used for manifest keying)
   * @param sourceType - 'file' (Notion-hosted) or 'external'
   * @param attachmentFolder - Override attachment folder for this download (parallel-safe)
   * @param options - Download options (e.g. thumbnail generation)
   * @param originalFilename - Original filename from Notion API (used for clean local names)
   */
  async download(
    url: string,
    blockId: string,
    sourceType: 'file' | 'external',
    attachmentFolder?: string,
    options?: DownloadOptions,
    originalFilename?: string,
  ): Promise<MediaDownloadResult> {
    const folder = attachmentFolder ?? this.attachmentFolder;
    let ext = extractFileExtension(url);
    let baseName: string;
    if (originalFilename) {
      // Use the original filename from Notion API - split into name + extension
      const dotIdx = originalFilename.lastIndexOf('.');
      if (dotIdx > 0) {
        baseName = sanitizeFileName(originalFilename.substring(0, dotIdx));
        const origExt = originalFilename.substring(dotIdx).toLowerCase();
        // Use original extension if it looks valid
        if (origExt.length >= 2 && origExt.length <= 6 && /^\.[a-z0-9]+$/.test(origExt)) {
          ext = origExt;
        }
      } else {
        baseName = sanitizeFileName(originalFilename);
      }
    } else {
      baseName = extractFileName(url);
    }

    const fullBlockId = blockId.replace(/-/g, '');

    // Load manifest for this folder (lazy, once per folder per session)
    await this.loadManifest(folder);

    // Check manifest: blockId -> { hash, fileName }
    const manifestEntry = this.manifest.get(fullBlockId);
    if (manifestEntry) {
      const cachedPath = `${folder}/${manifestEntry.fileName}`;
      if (this.vaultAdapter.fileExists(cachedPath)) {
        // Manifest hit + file exists -> skip entirely
        if (options?.generateThumbnail) {
          const thumbResult = await this.findOrMigrateThumb(cachedPath);
          if (thumbResult) {
            log.debug(`Manifest hit + thumbnail: ${cachedPath}`);
            return {
              success: true,
              localPath: thumbResult,
              fileName: thumbResult.split('/').pop() ?? thumbResult,
              originalPath: cachedPath,
            };
          }
          // File exists but no thumbnail - try generating one
          const cachedExt = cachedPath.substring(cachedPath.lastIndexOf('.'));
          if (!THUMB_SKIP_EXTS.has(cachedExt)) {
            const existingData = await this.vaultAdapter.readBinary(cachedPath);
            if (existingData && existingData.byteLength > THUMB_THRESHOLD) {
              const newThumb = await this.generateThumbnail(existingData, cachedPath, cachedExt);
              if (newThumb) {
                log.info(`Generated thumbnail for manifest-cached file: ${cachedPath}`);
                return {
                  success: true,
                  localPath: newThumb.path,
                  fileName: newThumb.path.split('/').pop() ?? newThumb.path,
                  originalPath: cachedPath,
                };
              }
            }
          }
        }
        log.debug(`Manifest hit: ${cachedPath}`);
        return { success: true, localPath: cachedPath, fileName: manifestEntry.fileName };
      }
      // Manifest entry exists but file is gone - fall through to re-download
    }

    try {
      // SSRF protection: validate URL before downloading
      validateMediaUrl(url);

      const key = this.cacheKey(url);
      const cached = this.downloadCache.get(key);
      let data: ArrayBuffer;
      let contentType: string | undefined;

      if (cached) {
        log.debug(`Using cached download for block ${fullBlockId.substring(0, 8)}`);
        data = cached.data;
        contentType = cached.contentType;
      } else {
        // Share one fetch across concurrent callers of the same source (#1645):
        // the first caller creates the flight, the rest await it.
        let flight = this.inFlight.get(key);
        if (!flight) {
          flight = (async () => {
            try {
              const r = await this.fetchUrl(url, baseName, sourceType);
              this.cacheDownload(key, r.data, r.contentType);
              return r;
            } finally {
              this.inFlight.delete(key);
            }
          })();
          this.inFlight.set(key, flight);
        } else {
          log.debug(`Awaiting in-flight download for block ${fullBlockId.substring(0, 8)}`);
        }
        const r = await flight;
        data = r.data;
        contentType = r.contentType;
      }

      // If URL-based extension is unreliable (.bin fallback), fix from Content-Type or magic bytes
      if (ext === '.bin') {
        if (contentType) {
          const ctExt = extFromContentType(contentType);
          if (ctExt) {
            ext = ctExt;
            log.debug(`Fixed extension from Content-Type: ${ext}`);
          }
        }
        // Magic byte fallback
        if (ext === '.bin') {
          const magicExt = extFromMagicBytes(data);
          if (magicExt) {
            ext = magicExt;
            log.debug(`Fixed extension from magic bytes: ${ext}`);
          }
        }
        if (ext === '.bin') {
          log.warn(`Could not determine file type for ${url} - saving as .bin`);
        }
      }

      // Content-addressed filename: {baseName}-{sha256}.{ext}
      const contentHash = await sha256Binary(data);

      /* Origin seeding: runs BEFORE the dedup/alias short-circuits below so
       * a dedup-hit external image still remembers where it came from. URL
       * stored verbatim (query strings included). */
      if (sourceType === 'external' && this.mediaOriginStore) {
        try {
          this.mediaOriginStore.record(contentHash, url, Date.now());
        } catch (originErr) {
          log.warn(`Could not record media origin for ${url}: ${getErrorMessage(originErr)}`);
        }
      }

      /* F-025 vault-wide dedup. Before writing a content-addressed
       * copy into `_files/`, ask the file-hash index whether ANY vault
       * path already has these bytes. If the user dropped the file at
       * vault root and embedded it, the push uploaded those bytes;
       * the writeback sees the same block and (without dedup) would
       * write a second copy into `_files/`. The index lets us keep
       * the user's original path and skip the write. */
      if (this.fileHashIndex) {
        const existing = this.fileHashIndex.findByHash(contentHash);
        if (existing && this.vaultAdapter.fileExists(existing.path)) {
          const existingName = existing.path.split('/').pop() ?? existing.path;
          log.info(
            `Dedup hit (F-025): reusing "${existing.path}" instead of writing "${folder}/${baseName}-${contentHash.substring(0, 8)}${ext}"`,
          );
          this.manifest.set(fullBlockId, { hash: contentHash, fileName: existingName });
          return { success: true, localPath: existing.path, fileName: existingName };
        }

        /* #1756 alias fallback: these bytes are an auto-optimized copy N2O
         * itself uploaded. Resolve the ORIGINAL through the alias
         * (optimized-hash -> original-hash) and the live hash index, so the
         * pull keeps the untouched full-quality file instead of orphaning it
         * behind a duplicate. Self-validating: if the original was edited,
         * moved AND re-hashed, or deleted, findByHash misses and the pull
         * degrades to a normal content-addressed write below. */
        const alias = this.mediaAliasStore?.get(contentHash);
        if (alias) {
          const original = this.fileHashIndex.findByHash(alias.originalHash);
          if (original && this.vaultAdapter.fileExists(original.path)) {
            const originalName = original.path.split('/').pop() ?? original.path;
            log.info(
              `Alias hit (#1756): reusing original "${original.path}" for optimized bytes ${contentHash.substring(0, 8)}`,
            );
            this.manifest.set(fullBlockId, { hash: contentHash, fileName: originalName });
            return { success: true, localPath: original.path, fileName: originalName };
          }
          log.debug(
            `Alias for ${contentHash.substring(0, 8)} no longer resolves - writing the optimized copy normally`,
          );
        }
      }

      // Use the documented 8-hex short hash, not the full 64-hex digest. A deep
      // sync folder + long base name + 64 hex chars can blow past Windows'
      // 260-char MAX_PATH and fail the write. Content dedup is guarded by the
      // file-hash index on the FULL hash, so shortening the filename is safe
      // (#1517). The manifest below still stores the full contentHash.
      const fileName = `${baseName}-${contentHash.substring(0, 8)}${ext}`;
      const localPath = `${folder}/${fileName}`;

      // Skip write if file already exists (same content already on disk)
      if (!this.vaultAdapter.fileExists(localPath)) {
        try {
          await this.vaultAdapter.writeBinary(localPath, data);
        } catch (writeErr) {
          // The path is content-addressed, so a concurrent writer that beat us
          // here wrote the SAME bytes - losing that race is success, not
          // failure. Before this guard the loser's block stayed un-localized
          // and rendered as an empty ![caption]() placeholder (#1645). Only
          // treat it as won-by-someone-else when the file really exists now;
          // a genuine write failure (disk full, permissions) still throws.
          if (!this.vaultAdapter.fileExists(localPath)) throw writeErr;
          log.debug(`Concurrent write race on ${localPath} - same content already landed`);
        }
        this.sessionBytes += data.byteLength;
        /* Record in the hash index so future downloads of this same
         * content (cross-session or cross-page) also dedup. */
        this.fileHashIndex?.record(localPath, contentHash, data.byteLength, Date.now());
      }

      // Update manifest
      this.manifest.set(fullBlockId, { hash: contentHash, fileName });

      // Warn on large individual files (>50MB)
      if (data.byteLength > 50 * 1024 * 1024) {
        log.warn(
          `Large attachment: ${localPath} is ${(data.byteLength / 1024 / 1024).toFixed(0)}MB`,
        );
      }

      if (this.sessionBytes > MediaDownloader.LARGE_DOWNLOAD_THRESHOLD) {
        log.warn(
          `Large sync session: ${(this.sessionBytes / 1024 / 1024).toFixed(0)}MB downloaded - check available disk space`,
        );
      }

      // Generate thumbnail for cover images (large rasters only)
      if (
        options?.generateThumbnail &&
        data.byteLength > THUMB_THRESHOLD &&
        !THUMB_SKIP_EXTS.has(ext)
      ) {
        const thumbResult = await this.generateThumbnail(data, localPath, ext);
        if (thumbResult) {
          return {
            success: true,
            localPath: thumbResult.path,
            fileName: thumbResult.path.split('/').pop() ?? thumbResult.path,
            originalPath: localPath,
          };
        }
      }

      return { success: true, localPath, fileName };
    } catch (error) {
      const msg = getErrorMessage(error);
      const statusCode = extractStatusCode(error);
      // Classify at the point that still holds the raw error (its .status), the
      // URL, and the source host, so the dashboard and note can tell the user
      // whether this is fixable or gone (#1780).
      const classification = classifyMediaFailure({ url, error: msg, statusCode, sourceType });
      log.error(
        `Failed to download ${url}: ${msg} [${classification.class}${statusCode !== undefined ? ` ${statusCode}` : ''}]`,
      );
      const errFileName = `${baseName}.bin`;
      const errPath = `${folder}/${errFileName}`;
      return {
        success: false,
        localPath: errPath,
        fileName: errFileName,
        error: msg,
        statusCode,
        failureClass: classification.class,
        failureReason: classification.reason,
      };
    }
  }

  /**
   * Find an existing thumbnail in the new (_thumbs/) or old (flat) location.
   * If found in the old location, migrates it to _thumbs/ subfolder.
   * Returns the thumb path if found/migrated, or null if no thumbnail exists.
   */
  private async findOrMigrateThumb(originalPath: string): Promise<string | null> {
    const dir = originalPath.substring(0, originalPath.lastIndexOf('/'));
    const baseName = originalPath.substring(originalPath.lastIndexOf('/') + 1);
    const thumbName = baseName.replace(/\.[^.]+$/, '.thumb.jpg');

    // Check new location first (_thumbs/ subfolder)
    const newThumbPath = `${dir}/_thumbs/${thumbName}`;
    if (this.vaultAdapter.fileExists(newThumbPath)) {
      return newThumbPath;
    }

    // Check old location (flat alongside original in _files/)
    const oldThumbPath = `${dir}/${thumbName}`;
    if (this.vaultAdapter.fileExists(oldThumbPath)) {
      // Migrate to _thumbs/ subfolder
      try {
        await this.vaultAdapter.moveFile(oldThumbPath, newThumbPath);
        log.info(`Migrated thumbnail to _thumbs/: ${thumbName}`);
        return newThumbPath;
      } catch {
        log.warn(`Failed to migrate thumbnail ${thumbName} - using old location`);
        return oldThumbPath;
      }
    }

    return null;
  }

  /**
   * Generate a thumbnail for a cover image.
   * Resizes to MAX_THUMB_WIDTH using OffscreenCanvas (available in Obsidian's Chromium runtime).
   * Returns null if the image is already small enough or on any error (fallback to original).
   */
  private async generateThumbnail(
    data: ArrayBuffer,
    originalPath: string,
    ext: string,
  ): Promise<{ path: string } | null> {
    try {
      const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
      const probed = await probeImage(data, mimeType);
      if (!probed) {
        log.warn(`Thumbnail generation failed for ${originalPath} - using original`);
        return null;
      }
      if (probed.width <= MAX_THUMB_WIDTH) return null;

      const encoded = await canvasEncode({
        data,
        mime: mimeType,
        targetType: 'image/jpeg',
        quality: 0.85,
        scale: MAX_THUMB_WIDTH / probed.width,
      });
      if (!encoded) {
        log.warn(`Thumbnail generation failed for ${originalPath} - using original`);
        return null;
      }
      const thumbData = encoded.data;

      const dir = originalPath.substring(0, originalPath.lastIndexOf('/'));
      const baseName = originalPath.substring(originalPath.lastIndexOf('/') + 1);
      const thumbName = baseName.replace(/\.[^.]+$/, '.thumb.jpg');
      const thumbPath = `${dir}/_thumbs/${thumbName}`;
      await this.vaultAdapter.writeBinary(thumbPath, thumbData);
      this.sessionBytes += thumbData.byteLength;
      log.info(
        `Generated thumbnail: ${thumbPath} (${thumbData.byteLength} bytes, ${MAX_THUMB_WIDTH}px wide)`,
      );

      return { path: thumbPath };
    } catch {
      log.warn(`Thumbnail generation failed for ${originalPath} - using original`);
      return null;
    }
  }

  /**
   * Generate or find a thumbnail for a cover image already on disk.
   * Used by n2o_cover to avoid loading full-size images in gallery cards.
   * Returns the thumbnail vault-relative path, or null if skipped
   * (small file, GIF/SVG, or generation failed).
   */
  async generateThumbnailForCover(originalPath: string): Promise<string | null> {
    const existing = await this.findOrMigrateThumb(originalPath);
    if (existing) return existing;

    const ext = originalPath.substring(originalPath.lastIndexOf('.')).toLowerCase();
    if (THUMB_SKIP_EXTS.has(ext)) return null;

    const data = await this.vaultAdapter.readBinary(originalPath);
    if (!data || data.byteLength <= THUMB_THRESHOLD) return null;

    const result = await this.generateThumbnail(data, originalPath, ext);
    return result?.path ?? null;
  }
}

// ── Cover Thumbnail Resolution ────────────────────────────

const N2O_COVER_RE = /^n2o_cover: "(.+)"$/m;

/**
 * Replace n2o_cover frontmatter path with a thumbnail for faster gallery rendering.
 * Only affects the YAML frontmatter value, not body image embeds.
 */
export async function resolveCoverThumbnail(
  markdown: string,
  mediaDownloader: MediaDownloader,
): Promise<string> {
  const match = markdown.match(N2O_COVER_RE);
  if (!match) return markdown;

  const originalPath = match[1];
  if (originalPath === undefined) return markdown;
  const thumbPath = await mediaDownloader.generateThumbnailForCover(originalPath);
  if (!thumbPath) return markdown;

  return markdown.replace(`n2o_cover: "${originalPath}"`, `n2o_cover: "${thumbPath}"`);
}
