/**
 * Shared low-level canvas image helpers plus the #1756 optimizer ladder.
 * Decoding and encoding run on createImageBitmap + OffscreenCanvas, both
 * available in Obsidian's Chromium runtime (absent in the Node test env,
 * where tests install the canvas stub from tests/helpers/canvas-stub.ts).
 */

/** Long-edge cap (px) for the downsampled probe canvas. */
const PROBE_MAX_EDGE = 64;

/** Extensions the optimizer ladder will re-encode. */
const OPTIMIZABLE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.avif']);

/** Quality steps tried at full scale before any downscaling. */
const QUALITY_LADDER = [0.85, 0.8, 0.7, 0.6, 0.5];

/** First downscale factor, and the per-step multiplier after it. */
const DOWNSCALE_FACTOR = 0.8;

/** Fixed encode quality during the downscale loop. */
const DOWNSCALE_QUALITY = 0.75;

/** The downscale loop stops before the scaled long edge drops below this. */
const MIN_LONG_EDGE_PX = 1200;

/** One decode/draw/encode pass through an OffscreenCanvas. */
export interface CanvasEncodeRequest {
  /** Source image bytes. */
  data: ArrayBuffer;
  /** Mime type of the source bytes, used for decoding. */
  mime: string;
  /** Output encoding. */
  targetType: 'image/jpeg' | 'image/webp';
  /** Output encoder quality (0-1). */
  quality: number;
  /** Output scale factor; output dims = round(source dims * scale). Defaults to 1. */
  scale?: number;
}

/** Successful canvas encode: re-encoded bytes plus the output dimensions. */
export interface CanvasEncodeResult {
  data: ArrayBuffer;
  width: number;
  height: number;
}

/** Result of probing an image: intrinsic dimensions and transparency. */
export interface ImageProbe {
  width: number;
  height: number;
  hasAlpha: boolean;
}

/** Winning rung of the optimizer ladder. */
export interface OptimizeResult {
  data: ArrayBuffer;
  ext: string;
  mime: string;
  width: number;
  height: number;
  quality: number;
}

/** Signature of canvasEncode, for dependency injection in tests. */
export type EncodeFn = typeof canvasEncode;

/** Signature of probeImage, for dependency injection in tests. */
export type ProbeFn = typeof probeImage;

/** Map a normalized extension to the mime type used for decoding. */
function mimeFromExt(ext: string): string {
  return ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
}

/**
 * Decode an image, draw it onto an OffscreenCanvas at the requested scale,
 * and re-encode it as JPEG or WebP.
 * Returns null on any failure (bad bytes, unavailable 2d context, encoder error).
 */
export async function canvasEncode(req: CanvasEncodeRequest): Promise<CanvasEncodeResult | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([req.data], { type: req.mime }));
    try {
      const scale = req.scale ?? 1;
      const width = Math.round(bitmap.width * scale);
      const height = Math.round(bitmap.height * scale);
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: req.targetType, quality: req.quality });
      return { data: await blob.arrayBuffer(), width, height };
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

/**
 * Decode an image once and report its intrinsic dimensions and whether it has
 * any transparent pixel. The alpha scan runs on a downsampled canvas (long
 * edge capped at 64px) so probing stays cheap on large images.
 * Returns null on any failure.
 */
export async function probeImage(data: ArrayBuffer, mime: string): Promise<ImageProbe | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([data], { type: mime }));
    try {
      const longEdge = Math.max(bitmap.width, bitmap.height);
      const scale = longEdge > PROBE_MAX_EDGE ? PROBE_MAX_EDGE / longEdge : 1;
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, width, height);
      const pixels = ctx.getImageData(0, 0, width, height).data;
      let hasAlpha = false;
      for (let i = 3; i < pixels.length; i += 4) {
        if ((pixels[i] ?? 255) < 255) {
          hasAlpha = true;
          break;
        }
      }
      return { width: bitmap.width, height: bitmap.height, hasAlpha };
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

/**
 * Re-encode an image until it fits under targetBytes (#1756).
 *
 * Images with transparency go to WebP, opaque ones to JPEG. The ladder first
 * walks qualities 0.85 to 0.5 at full size; if none fit, it downscales by 0.8
 * per step at quality 0.75, giving up once the scaled long edge would drop
 * below 1200px. A null encode result skips that rung instead of aborting.
 * Returns null for ineligible extensions, unprobeable data, or when no rung fits.
 */
export async function optimizeImage(
  data: ArrayBuffer,
  ext: string,
  targetBytes: number,
  deps?: { encode?: EncodeFn; probe?: ProbeFn },
): Promise<OptimizeResult | null> {
  const encode = deps?.encode ?? canvasEncode;
  const probe = deps?.probe ?? probeImage;

  let normExt = ext.toLowerCase();
  if (!normExt.startsWith('.')) normExt = `.${normExt}`;
  if (!OPTIMIZABLE_EXTS.has(normExt)) return null;

  const mime = mimeFromExt(normExt);
  const probed = await probe(data, mime);
  if (!probed) return null;

  const targetType = probed.hasAlpha ? 'image/webp' : 'image/jpeg';
  const outExt = probed.hasAlpha ? '.webp' : '.jpg';

  for (const quality of QUALITY_LADDER) {
    const result = await encode({ data, mime, targetType, quality });
    if (result && result.data.byteLength <= targetBytes) {
      return {
        data: result.data,
        ext: outExt,
        mime: targetType,
        width: result.width,
        height: result.height,
        quality,
      };
    }
  }

  const longEdge = Math.max(probed.width, probed.height);
  let scale = DOWNSCALE_FACTOR;
  while (Math.round(longEdge * scale) >= MIN_LONG_EDGE_PX) {
    const result = await encode({ data, mime, targetType, quality: DOWNSCALE_QUALITY, scale });
    if (result && result.data.byteLength <= targetBytes) {
      return {
        data: result.data,
        ext: outExt,
        mime: targetType,
        width: result.width,
        height: result.height,
        quality: DOWNSCALE_QUALITY,
      };
    }
    scale *= DOWNSCALE_FACTOR;
  }

  return null;
}
