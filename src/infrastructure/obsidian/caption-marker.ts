/**
 * Hidden marker that tags an italic line as a block caption (#1515).
 *
 * The builder emits `*caption*` followed by this marker line after a code block
 * or local media embed. The parser only pulls a following italic line into a
 * caption when this marker is present, so a user's genuine italic paragraph
 * written right after code/media is not silently swallowed as a caption.
 *
 * It uses N2O's `%% n2o:... %%` comment convention (same as colored blocks and
 * columns) so Obsidian hides it in reading view and the CM6 hider collapses it
 * in Live Preview. META_COMMENT_LINE_RE in meta-comment-hider.ts is kept in
 * sync with this string.
 */

/** The literal marker line the builder writes. */
export const CAPTION_MARKER = '%% n2o:cap %%';

/** Matches a standalone caption-marker line (tolerates trailing whitespace). */
export const CAPTION_MARKER_RE = /^%% n2o:cap %%\s*$/;
