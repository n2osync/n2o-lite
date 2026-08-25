/**
 * Marker that anchors an image whose download failed (an external URL that is
 * dead at the source, so there is nothing to localize into `_files/`).
 *
 * The renderer emits ONE line per unavailable image:
 *
 *   %% n2o:image-unavailable %% [Caption or url](url) (image unavailable)
 *
 * Rather than a bare `![](dead-url)` - which Obsidian shows as a broken image
 * icon, ambiguous between a dead link and a slow load - this renders a plain
 * clickable link to the source plus an explicit note, so the user sees what
 * the image was and where it came from and can recover it. It is the honest
 * fallback for the case Layer 1 (download + retry, media-handler.ts) cannot
 * fix because the source itself is gone.
 *
 * The marker is the round-trip anchor: the parser keys on it, reads the
 * `[caption](url)` link back into an external ImageMeta (marked unavailable),
 * and push-block-builder sends the external image URL to Notion unchanged - so
 * a dead image survives a round-trip as the same external image block, exactly
 * as Notion itself stores it. The visible `(image unavailable)` note is
 * cosmetic and rebuilt on every render.
 *
 * Uses N2O's `%% n2o:... %%` comment convention (same as the breadcrumb and
 * caption markers) so reading view hides the marker span natively. In Live
 * Preview, meta-comment-hider.ts hides just the marker and keeps the link
 * visible - IMAGE_UNAVAILABLE_PREFIX_RE there is kept in sync with this string,
 * pinned by tests/unit/hider-regex-renderer-emission.test.ts.
 */

/** The literal marker the renderer writes at the start of the fallback line. */
export const IMAGE_UNAVAILABLE_MARKER = '%% n2o:image-unavailable %%';

/**
 * Matches the fallback line and captures the link's text and URL. The link
 * carries the round-trip data (url, and caption when the text differs from the
 * url); anything after the link on the line is a cosmetic note and ignored.
 */
export const IMAGE_UNAVAILABLE_LINE_RE =
  /^\s*%% n2o:image-unavailable %%\s*\[([^\]]*)\]\(([^)]+)\)/;
