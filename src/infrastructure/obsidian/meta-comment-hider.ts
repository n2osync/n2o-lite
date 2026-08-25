/**
 * CM6 StateField that hides N2O metadata comments and blanks spacer
 * paragraphs in Live Preview.
 *
 * Matches lines like:
 *   %% n2o:{"id":"abc","color":"gray_background"} %%
 *   <!-- n2o:{"id":"abc"} -->
 *   > %% n2o:{...} %%          (inside callouts - any depth of `> `)
 *   &nbsp;                     (spacer paragraph - entity hidden, line kept)
 *   %% n2o:breadcrumb %% ...   (breadcrumb line - marker hidden, chain kept)
 *
 * Uses StateField (not ViewPlugin) because replace-decorations that collapse
 * lines to zero height must be part of editor state - ViewPlugin decorations
 * cause a scroll-jump feedback loop with CM6's height estimator.
 *
 * Only active in Live Preview mode - Source Mode shows comments as-is.
 * Purely visual: all sync paths read raw file content via vault.cachedRead().
 */

import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { StateField, type EditorState, type Range } from '@codemirror/state';
import { editorLivePreviewField } from 'obsidian';

/**
 * Regex matching a full line containing an N2O metadata comment,
 * optionally nested inside blockquote markers (`> `).
 */
// The `cap` alternative hides the caption marker from caption-marker.ts
// (CAPTION_MARKER). Keep the two in sync.
export const META_COMMENT_LINE_RE =
  /^(?:>\s*)*(?:%% n2o:(?:\{.*\}|cap) %%|<!-- n2o:(?:\{.*\}|cap) -->)\s*$/;

/**
 * Spacer paragraph line (#1626/#1666): the renderer emits a lone `&nbsp;`
 * entity for Notion's empty spacer paragraphs. Reading view renders the
 * entity as an invisible one-line spacer; Live Preview's CM6 does not render
 * HTML entities and shows it as literal raw-HTML-tinted text. The field below
 * hides the entity but keeps the line, so LP shows one blank line of height -
 * the same render as reading view. The capture group is the prefix (quote
 * markers / indent) that stays visible. Keep in sync with the renderer's
 * spacer form (block-renderer.ts, case 'paragraph') and the parser's
 * spacer mapping (block-parser.ts).
 */
export const SPACER_LINE_RE = /^((?:>\s*)*[ \t]*)&nbsp;[ \t]*$/;

/**
 * Breadcrumb line: `%% n2o:breadcrumb %% [[Ancestor]] / Page Title`. The
 * field below hides ONLY the marker span (plus its one trailing space) and
 * keeps the visible chain on the same line - the Live Preview twin of
 * reading view's native `%% %%`-comment stripping. A marker-only line
 * (unresolved breadcrumb) collapses whole, like a meta comment. The capture
 * group is the prefix (quote markers / indent) that stays visible. Keep in
 * sync with BREADCRUMB_MARKER in breadcrumb-marker.ts and the renderer's
 * emission (block-renderer.ts, case 'breadcrumb') - pinned by
 * tests/unit/hider-regex-renderer-emission.test.ts.
 */
export const BREADCRUMB_LINE_PREFIX_RE = /^((?:>\s*)*[ \t]*)%% n2o:breadcrumb %% ?/;

/**
 * Image-unavailable line: `%% n2o:image-unavailable %% [Caption](url) (image
 * unavailable)`. Hide ONLY the marker span (plus its one trailing space) and
 * keep the visible link on the same line - the Live Preview twin of reading
 * view's native `%% %%`-comment stripping. The capture group is the prefix
 * (quote markers / indent) that stays visible. Keep in sync with
 * IMAGE_UNAVAILABLE_MARKER in image-unavailable-marker.ts and the renderer's
 * emission (block-renderer.ts, case 'image') - pinned by
 * tests/unit/hider-regex-renderer-emission.test.ts.
 */
export const IMAGE_UNAVAILABLE_LINE_PREFIX_RE = /^((?:>\s*)*[ \t]*)%% n2o:image-unavailable %% ?/;

/** Parse a meta-comment line (any `> ` nesting depth); null if not one. */
export function parseCommentMeta(lineText: string): { color?: string; type?: string } | null {
  const m = lineText.match(/^(?:>\s*)*(?:%% n2o:(\{.*\}) %%|<!-- n2o:(\{.*\}) -->)\s*$/);
  if (!m) return null;
  try {
    return JSON.parse((m[1] ?? m[2]) as string) as { color?: string; type?: string };
  } catch {
    return null;
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  // Only hide in Live Preview - not Source Mode
  if (!state.field(editorLivePreviewField)) {
    return Decoration.none;
  }

  // Collected unsorted and sorted by Decoration.set: the block-color loop can
  // paint a line the outer loop later decorates (a spacer inside a colored
  // block), which would violate RangeSetBuilder's ordered-add requirement.
  const ranges: Range<Decoration>[] = [];
  const doc = state.doc;

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);

    // Spacer paragraph (#1666): hide the `&nbsp;` entity text but KEEP the
    // line - an empty LP line renders at one line height, matching the
    // spacer's reading-view render.
    const spacer = SPACER_LINE_RE.exec(line.text);
    if (spacer) {
      const from = line.from + (spacer[1] ?? '').length;
      if (from < line.to) ranges.push(Decoration.replace({}).range(from, line.to));
      continue;
    }

    // Breadcrumb line: hide the marker span, keep the chain. When nothing
    // follows the marker there is no chain to keep - collapse the whole
    // line (with its newline) so no phantom blank line remains.
    const bc = BREADCRUMB_LINE_PREFIX_RE.exec(line.text);
    if (bc) {
      const markerFrom = line.from + (bc[1] ?? '').length;
      const markerTo = line.from + bc[0].length;
      if (markerTo >= line.to) {
        ranges.push(
          Decoration.replace({}).range(line.from, line.to < doc.length ? line.to + 1 : line.to),
        );
      } else {
        ranges.push(Decoration.replace({}).range(markerFrom, markerTo));
      }
      continue;
    }

    // Image-unavailable line: hide the marker span, keep the visible link.
    const iu = IMAGE_UNAVAILABLE_LINE_PREFIX_RE.exec(line.text);
    if (iu) {
      const markerFrom = line.from + (iu[1] ?? '').length;
      const markerTo = line.from + iu[0].length;
      if (markerTo >= line.to) {
        ranges.push(
          Decoration.replace({}).range(line.from, line.to < doc.length ? line.to + 1 : line.to),
        );
      } else {
        ranges.push(Decoration.replace({}).range(markerFrom, markerTo));
      }
      continue;
    }

    if (!META_COMMENT_LINE_RE.test(line.text)) continue;
    // Swallow ONE fully blank line BEFORE a top-level comment: the renderer
    // blank-separates comments from headings, tables, and top-level
    // paragraphs (#1675), and without this the hidden comment leaves a
    // second blank line in Live Preview between every pair of blocks.
    // Swallow the PRECEDING blank, never the following one - extending the
    // hidden range past the following blank joins the comment onto the next
    // block's line, which strips heading styling in Live Preview (the same
    // adjacency the renderer avoids). Quote-nested comments (callouts) are
    // left alone entirely.
    const end = line.to < doc.length ? line.to + 1 : line.to;
    let from = line.from;
    if (!line.text.startsWith('>') && i > 1 && doc.line(i - 1).text === '') {
      from = doc.line(i - 1).from;
    }
    ranges.push(Decoration.replace({}).range(from, end));
  }

  return Decoration.set(ranges, true);
}

const metaCommentField = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state);
  },
  update(decorations, tr) {
    // Rebuild on mode toggles too: switching Live Preview <-> Source Mode
    // does not change the doc, and stale LP decorations would keep hiding
    // comments and spacers in Source Mode (caught by spacer-live-preview.e2e).
    const modeChanged =
      tr.startState.field(editorLivePreviewField) !== tr.state.field(editorLivePreviewField);
    if (tr.docChanged || modeChanged) {
      return buildDecorations(tr.state);
    }
    return decorations;
  },
  provide(field) {
    return EditorView.decorations.from(field);
  },
});

/** CM6 extension that hides `%% n2o:{...} %%` lines in Live Preview. */
export const metaCommentHider = metaCommentField;
