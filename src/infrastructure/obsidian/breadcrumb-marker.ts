/**
 * Marker that anchors a breadcrumb block's line in markdown.
 *
 * The renderer emits ONE line per breadcrumb block:
 *
 *   %% n2o:breadcrumb %% [[Ancestor]] / [[Parent]] / Page Title
 *
 * The marker is the round-trip anchor. The visible chain after it is DERIVED
 * content, rebuilt by the pull pipeline on every render (see
 * domain/services/breadcrumb-path.ts): the parser keys on the marker, emits a
 * breadcrumb block, and discards the chain text; push-block-builder then
 * sends `breadcrumb: {}` and Notion derives its own path.
 *
 * It uses N2O's `%% n2o:... %%` comment convention (same as the caption
 * marker) so reading view hides the span natively. In Live Preview,
 * meta-comment-hider.ts hides just the marker and keeps the chain visible -
 * BREADCRUMB_LINE_PREFIX_RE there is kept in sync with this string, pinned by
 * tests/unit/hider-regex-renderer-emission.test.ts.
 */

/** The literal marker the renderer writes at the start of a breadcrumb line. */
export const BREADCRUMB_MARKER = '%% n2o:breadcrumb %%';

/** Matches a whole breadcrumb line: the marker plus an optional visible chain. */
export const BREADCRUMB_LINE_RE = /^\s*%% n2o:breadcrumb %%(?:\s.*)?$/;

/**
 * Matches the legacy `<!-- breadcrumb -->` line that renderers before the
 * marker form wrote. The parser keeps reading it as a breadcrumb block so
 * already-pulled files stay intact between the plugin update and the
 * renderer-fingerprint re-render sweep that rewrites them to the new form.
 */
export const LEGACY_BREADCRUMB_LINE_RE = /^\s*<!-- breadcrumb -->\s*$/;
