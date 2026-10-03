/**
 * Inline rich text renderer - converts N2ORichText segments to Markdown.
 */

import type { N2ORichText } from '../../domain/models/block';
import type { PageRegistryReader } from '../../domain/models/page-registry';
import { isNotionColor, notionColorToClass } from '../../shared/notion-color-palette';

/** Escape text and attribute values for the inline HTML emitted for link chips (#1724). */
const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string): string => escHtml(s).replace(/"/g, '&quot;');

/**
 * Resolve a Notion page ID to a wikilink target using the registry.
 * Falls back to the provided name or raw ID.
 */
function resolveWikilink(
  pageRegistry: PageRegistryReader | null,
  notionId: string,
  fallbackName?: string,
): string {
  if (pageRegistry) {
    return pageRegistry.getWikilinkTarget(notionId, fallbackName);
  }
  return fallbackName ?? notionId;
}

/**
 * Escape inline markdown metacharacters in PLAIN (unannotated) text so literal
 * Notion content does not re-parse as formatting on the next push. Applied only
 * to segments with no annotation/link/mention/equation - annotated segments
 * carry real markdown syntax we must not escape. The inline parser unescapes
 * `\<punct>` back to the literal char and drops the backslash before it reaches
 * Notion, so this round-trips cleanly (#1503, mirrors the parser branch #1511).
 *
 * `[` and `<` are escaped surgically - only when they would actually re-parse -
 * so a footnote ref `[^1]`, a lone `[tag]`, or an inline `<details>` is left
 * intact instead of being needlessly backslashed (#1521, fixes a #1503
 * over-escape that broke Obsidian footnotes).
 */
function escapeInlineMarkdown(text: string): string {
  return (
    text
      // Always ambiguous: * ` ~ $ and backslash itself.
      .replace(/[\\*`~$]/g, '\\$&')
      // `=` only when it opens a `==highlight==` pair. A lone `=` (an HTML
      // attribute, `a=b`) never re-parses, so leave it (#1588, mirrors the `[` fix).
      .replace(/=(?==)/g, '\\=')
      // `[` only when it opens a wikilink (`[[`) or a markdown link (`[...](`).
      .replace(/\[(?=\[)|\[(?=[^\]\n]*\]\()/g, '\\[')
      // `<` only when it opens an inline tag the parser recognises (u / mark / span).
      .replace(/<(?=\/?u>|\/?mark[\s>]|\/?span[\s>])/g, '\\<')
      // `&` only when it forms `&nbsp;`. Unescaped, Obsidian renders the literal
      // text as a blank space, and the block parser would fold an &nbsp;-only
      // line back into an EMPTY paragraph - the spacer encoding (#1626). Escaped,
      // the user's literal "&nbsp;" text shows as typed and round-trips.
      .replace(/&(?=nbsp;)/g, '\\&')
  );
}

// Delimiter-based marks that can span consecutive segments and whose adjacent
// pairs COLLIDE if emitted per-segment (`**a****b**`, `==a====b==`). Ordered
// outermost -> innermost. A run of consecutive segments sharing a mark is wrapped
// in ONE pair, with boundary whitespace hoisted out (Obsidian will not open/close
// emphasis on a space-adjacent delimiter). This is what makes mixed bold/italic/
// coloured headings render instead of showing raw `*****` / literal `==`.
const RUN_MARKS = [
  { key: 'highlight', delim: '==' },
  { key: 'bold', delim: '**' },
  { key: 'italic', delim: '*' },
  { key: 'strikethrough', delim: '~~' },
] as const;

type RunMarkKey = (typeof RUN_MARKS)[number]['key'];

/**
 * Does this segment carry the given run mark? Equation and mention segments are
 * rendered standalone (they replace the text), so they never join a run.
 */
function hasRunMark(seg: N2ORichText, key: RunMarkKey): boolean {
  if (seg.equation || seg.mention) return false;
  if (key === 'highlight') return seg.color === 'yellow_background';
  return Boolean(seg[key]);
}

/**
 * Wrap `text` in this segment's colour annotation, if it has one. Notion's class
 * names are emitted and styles.css resolves them to muted, theme-aware values.
 * `yellow_background` is the native `==` highlight, handled by the run wrappers,
 * so it is skipped here.
 *
 * Shared by every leaf that can carry a colour (plain text AND equations) so the
 * two cannot drift - the equation path silently lacking this is exactly the bug
 * this helper exists to prevent.
 */
function applyColor(seg: N2ORichText, text: string): string {
  if (
    !seg.color ||
    seg.color === 'default' ||
    seg.color === 'yellow_background' ||
    !isNotionColor(seg.color)
  ) {
    return text;
  }
  const cls = notionColorToClass(seg.color);
  return seg.color.endsWith('_background')
    ? `<mark class="${cls}">${text}</mark>`
    : `<span class="${cls}">${text}</span>`;
}

/** Wrap `inner` in a delimiter pair, hoisting boundary whitespace outside it. */
function wrapRun(delim: string, inner: string): string {
  const lead = inner.match(/^\s*/)?.[0] ?? '';
  const trail = inner.match(/\s*$/)?.[0] ?? '';
  const core = inner.slice(lead.length, inner.length - trail.length);
  return core ? `${lead}${delim}${core}${delim}${trail}` : inner;
}

/**
 * Render ONE segment's non-run marks: the tag-based / text-replacing ones that
 * do NOT collide when adjacent (code, underline, colour span/mark, link,
 * mention, equation). Run marks (bold/italic/strike/highlight) are handled by
 * the enclosing run wrappers, so they are intentionally skipped here.
 */
function renderLeaf(seg: N2ORichText, pageRegistry: PageRegistryReader | null): string {
  // Inline equations replace the text entirely - but they still carry their own
  // annotations. Notion lets you colour an equation (annotations.color on an
  // `equation` rich-text item), and returning here bare dropped that colour on the
  // floor: a blue quadratic formula came out plain black in Obsidian. Route it
  // through the same colour wrapper as every other segment. The inline parser reads
  // <span class="n2o-fg-blue">$...$</span> back into a coloured equation segment,
  // so this round-trips.
  if (seg.equation) return applyColor(seg, `$${seg.equation}$`);

  // Mentions replace the text entirely.
  if (seg.mention) {
    if (seg.mention.type === 'page' || seg.mention.type === 'database') {
      const target = resolveWikilink(pageRegistry, seg.mention.id, seg.mention.name);
      if (seg.mention.type === 'database') {
        // Lite generates no .base note to link to - a wikilink would dangle.
        // Render the database's name as plain text.
        return target.split('/').pop() ?? target;
      }
      return `[[${target}]]`;
    }
    if (seg.mention.type === 'user') return `@${seg.mention.name ?? 'Unknown'}`;
    if (seg.mention.type === 'date') {
      if (seg.mention.dateStart && seg.mention.dateEnd) {
        return `${seg.mention.dateStart} \u2192 ${seg.mention.dateEnd}`;
      }
      return seg.mention.dateStart ?? seg.text;
    }
    if (seg.mention.type === 'template_mention') return `@${seg.mention.templateType ?? 'today'}`;
    if (seg.mention.type === 'link_preview') {
      const url = seg.mention.previewUrl ?? '';
      return `[${seg.text || seg.mention.name || url}](${url})`;
    }
    if (seg.mention.type === 'link_mention') {
      // #1724: an inline link chip. Notion returns the favicon, provider (site
      // name) and title in the OFFICIAL API (mention.link_mention), and renders
      // them as `<favicon> <provider muted> <title>` - e.g. a GitHub globe, then
      // "GitHub" in grey, then "GitHub - Change is constant". Mirror that layout.
      // No live fetch. The inline parser reads `.n2o-link-mention` back to a
      // plain link for round-trip.
      const href = seg.mention.linkHref ?? seg.mention.previewUrl ?? '';
      const title = seg.mention.linkTitle || seg.mention.linkProvider || href;
      const icon = seg.mention.linkIcon
        ? `<img class="n2o-link-mention-icon" src="${escAttr(seg.mention.linkIcon)}" alt="">`
        : '';
      // The provider prefix only when there is a real title, so a title-less
      // mention does not render "GitHub GitHub".
      const provider =
        seg.mention.linkProvider && seg.mention.linkTitle
          ? `<span class="n2o-link-mention-provider">${escHtml(seg.mention.linkProvider)}</span>`
          : '';
      return `<a href="${escAttr(href)}" class="n2o-link-mention">${icon}${provider}<span class="n2o-link-mention-title">${escHtml(title)}</span></a>`;
    }
  }

  // Escape metacharacters only in fully plain text. Any annotation or link adds
  // real markdown syntax below, which must not be escaped.
  const hasAnnotation =
    seg.bold ||
    seg.italic ||
    seg.strikethrough ||
    seg.code ||
    seg.underline ||
    seg.link ||
    (seg.color !== undefined && seg.color !== 'default' && isNotionColor(seg.color));
  let text = hasAnnotation ? seg.text : escapeInlineMarkdown(seg.text);

  if (seg.code) text = `\`${text}\``;
  if (seg.underline) text = `<u>${text}</u>`;

  text = applyColor(seg, text);

  if (seg.link) text = `[${text}](${seg.link})`;
  return text;
}

/**
 * Recursively wrap maximal runs of consecutive segments that share a run mark,
 * one delimiter pair per run. `applied` tracks marks already wrapped by an
 * enclosing call so each is emitted once. Segments with no remaining run mark
 * are rendered as leaves.
 */
function renderRuns(
  segments: N2ORichText[],
  applied: Set<RunMarkKey>,
  pageRegistry: PageRegistryReader | null,
): string {
  let out = '';
  for (let i = 0; i < segments.length;) {
    const seg = segments[i];
    const mark = RUN_MARKS.find((m) => !applied.has(m.key) && seg && hasRunMark(seg, m.key));
    if (!mark) {
      out += seg ? renderLeaf(seg, pageRegistry) : '';
      i++;
      continue;
    }
    let j = i;
    while (j < segments.length && segments[j] && hasRunMark(segments[j] as N2ORichText, mark.key))
      j++;
    const inner = renderRuns(segments.slice(i, j), new Set([...applied, mark.key]), pageRegistry);
    out += wrapRun(mark.delim, inner);
    i = j;
  }
  return out;
}

/**
 * Render rich text segments to markdown string.
 */
export function renderRichText(
  segments: N2ORichText[],
  pageRegistry: PageRegistryReader | null,
): string {
  return renderRuns(segments, new Set(), pageRegistry);
}
