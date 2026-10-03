/**
 * Block renderer - converts individual N2OBlocks to Markdown strings.
 */

import type { N2OBlock, N2OBlockType, N2ORichText } from '../../domain/models/block';
import type { PageRegistryReader } from '../../domain/models/page-registry';
import { resolveCalloutType, isBuiltInIconName, iconNameToEmoji } from '../../shared/callout-map';
import { CAPTION_MARKER } from './caption-marker';
import { BREADCRUMB_MARKER } from './breadcrumb-marker';
import { IMAGE_UNAVAILABLE_MARKER } from './image-unavailable-marker';

/**
 * Map a known service URL to the form an Obsidian `<iframe>` can actually embed,
 * so the player/card shows instead of the service's full web page (login walls,
 * cookie banners) or a broken image. Returns null when there's no known
 * conversion, so the caller keeps the original URL. Display-only: Notion still
 * stores the raw share/page URL, and these are the embed forms its own engine
 * resolves to anyway.
 */
function toEmbedUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '');

  if (host === 'open.spotify.com' && !u.pathname.startsWith('/embed/')) {
    return `https://open.spotify.com/embed${u.pathname}${u.search}`;
  }
  if (host === 'loom.com') {
    const m = u.pathname.match(/\/(?:share|embed)\/([0-9a-f]+)/i);
    if (m) return `https://www.loom.com/embed/${m[1]}`;
  }
  if (host === 'twitter.com' || host === 'x.com') {
    const m = u.pathname.match(/\/status\/(\d+)/);
    if (m) return `https://platform.twitter.com/embed/Tweet.html?id=${m[1]}`;
  }
  if (host === 'google.com' && u.pathname.startsWith('/maps')) {
    const place = u.pathname.match(/\/maps\/place\/([^/@]+)/);
    const q = place ? decodeURIComponent(place[1] ?? '') : (u.searchParams.get('q') ?? '');
    if (q) return `https://maps.google.com/maps?q=${encodeURIComponent(q)}&output=embed`;
  }
  if (host === 'figma.com' && !u.pathname.startsWith('/embed')) {
    return `https://www.figma.com/embed?embed_host=obsidian&url=${encodeURIComponent(raw)}`;
  }
  if (host === 'soundcloud.com') {
    return `https://w.soundcloud.com/player/?url=${encodeURIComponent(raw)}&visual=true`;
  }
  if (host === 'drive.google.com') return raw.replace(/\/view\b.*$/, '/preview');
  if (host === 'docs.google.com') return raw.replace(/\/edit\b.*$/, '/preview');
  if (host === 'airtable.com' && !u.pathname.startsWith('/embed')) {
    return `https://airtable.com/embed${u.pathname}${u.search}`;
  }
  if (host === 'youtube.com') {
    const v = u.searchParams.get('v');
    if (v) return `https://www.youtube.com/embed/${v}`;
  }
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1);
    if (id) return `https://www.youtube.com/embed/${id}`;
  }
  return null;
}

/**
 * Sandbox for embed <iframe>s. Allows the embed to run (scripts, its own origin,
 * popups for "open in new tab", fullscreen video, forms) but OMITS `allow-modals`,
 * so a broken embed's `alert()`/`confirm()` becomes a no-op instead of escaping
 * its frame into a native Obsidian dialog ("Importing from backend failed" on a
 * dead Figma/Excalidraw embed, #1704). This is what Notion does - its embed
 * iframes are sandboxed the same way, so the same broken file fails quietly.
 * `allow-scripts allow-same-origin` cannot self-unsandbox here because embeds are
 * cross-origin (figma.com, youtube.com), so the iframe keeps its own origin.
 */
const EMBED_SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-presentation allow-forms';

/** Fallback height (px) for an embed whose Notion block carries no dimensions. */
const DEFAULT_EMBED_HEIGHT = 480;

/**
 * Sizing style for an embed <iframe>. The official API carries no display
 * height, so every embed gets a sensible fixed height instead of Obsidian's
 * small default (which crops Twitter, Spotify, Maps, ...) or a collapsed frame
 * that shows the target site's own scrollbars (#1728).
 */
function embedStyle(): string {
  return `width:100%;border:0;border-radius:8px;height:${DEFAULT_EMBED_HEIGHT}px`;
}

/**
 * Allow only web-safe URL schemes in rendered href/src attributes. Blocks
 * javascript:, data:, vbscript:, etc. which would execute when a synced
 * bookmark/embed is clicked or loaded (escapeHtml stops tag injection but not
 * a hostile scheme). Bookmarks and embeds are always absolute web URLs, so
 * anything that is not http(s)/mailto/tel is replaced with a harmless anchor.
 */
function safeUrl(url: string): string {
  return /^(https?:|mailto:|tel:)/i.test(url.trim()) ? url : '#';
}

/**
 * The ONE emitter for every embed <iframe> (generic embed, typed service embeds,
 * external video/audio). Extracting it means the sandbox attribute (#1704, #1732)
 * cannot land on only some paths again - the three hand-rolled emitters had
 * drifted, and the video/audio branch shipped unsandboxed. `src` must already be
 * scheme-checked with safeUrl; src and title are HTML-escaped here.
 */
function renderEmbedIframe(src: string, style: string, title: string): string {
  const styleAttr = style ? ` style="${style}"` : '';
  return `<iframe src="${escapeHtml(src)}" sandbox="${EMBED_SANDBOX}"${styleAttr} title="${escapeHtml(title)}"></iframe>`;
}

/**
 * Context passed to block rendering functions to avoid `this` references.
 */
/** A heading in the document being rendered, for `tableOfContents` blocks. */
export interface DocumentHeading {
  /** 1-4, matching heading1..heading4. */
  level: number;
  /** Plain text, as it appears in the rendered heading (link targets match on this). */
  text: string;
}

/**
 * Every heading in the document, in order. A block renderer only ever sees ONE
 * block, but a table of contents is the one block whose content is the whole
 * document - so the builder collects the headings up front and hands them over.
 *
 * Recurses: headings nested inside toggles, callouts and columns are real headings
 * on the page and Notion lists them in its TOC too.
 */
export function collectHeadings(blocks: N2OBlock[]): DocumentHeading[] {
  const out: DocumentHeading[] = [];
  const walk = (bs: N2OBlock[]): void => {
    for (const b of bs) {
      const level = HEADING_LEVELS[b.type];
      if (level !== undefined) {
        const text = b.content
          .map((c) => c.text)
          .join('')
          .trim();
        if (text) out.push({ level, text });
      }
      if (b.children?.length) walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

const HEADING_LEVELS: Partial<Record<N2OBlockType, number>> = {
  heading1: 1,
  heading2: 2,
  heading3: 3,
  heading4: 4,
};

export interface BlockRenderContext {
  pageRegistry: PageRegistryReader | null;
  /**
   * When false, columnList blocks are flattened into stacked blocks instead
   * of rendering a `[!multi-column]` callout. Treated as enabled when omitted.
   */
  enableMultiColumnLayout?: boolean;
  /** Headings of the whole document, for rendering a `tableOfContents` block. */
  documentHeadings?: DocumentHeading[];
  /**
   * Title of the document being rendered - the last segment of a breadcrumb
   * block's chain. Like documentHeadings, this exists because a breadcrumb is
   * a block whose content is really page-level state.
   */
  documentTitle?: string;
  /** Notion id of the document being rendered, so a breadcrumb can close its
   *  chain with a self-wikilink instead of bare text. */
  documentNotionId?: string;
  renderRichText: (segments: N2ORichText[]) => string;
  buildBlocks: (
    blocks: N2OBlock[],
    depth: number,
    parentDatabaseId?: string,
    wrapAttachments?: boolean,
  ) => string;
  /** Called with a synced-block original's id when the renderer emits its anchor,
   *  so the pull indexes only originals that are truly RENDERED (#1719). */
  onSyncedOriginalAnchored?: (id: string) => void;
}

/**
 * Build an N2O metadata comment for round-trip preservation.
 *
 * Emitted when a block carries metadata worth preserving across a round-
 * trip through markdown. Two policies:
 *
 *   1. Media blocks ALWAYS get a comment when they have an ID. The block
 *      ID is the only reliable identity for an image across push cycles
 * - filenames get mangled (spaces/brackets stripped by Notion's S3
 *      upload), content-hash suffixes get added by the vault-side media
 *      downloader, and freshly uploaded images get new file_upload.ids.
 *      Without the ID comment, the block differ has no way to match an
 *      existing Notion image block to the same image in re-pushed
 *      markdown, so it treats the re-push as a new insert and leaves
 *      the old block preserved - one duplicate image per push cycle.
 *      (History: the previous author assumed blocksEqual's positional
 *      matching would preserve media. It doesn't when fingerprints
 *      disagree, which they almost always do for Notion-hosted media.)
 *
 *   2. Non-media blocks still skip ID-only comments, because for text
 *      blocks the content fingerprint is usually stable enough to match
 *      and emitting a comment above every paragraph would be visual
 *      noise in source mode.
 */
function buildMetaComment(block: N2OBlock): string {
  if (!block.id) return '';
  const meta: Record<string, unknown> = { id: block.id };
  // Include type for ambiguous blocks (toggle vs callout, embed vs bookmark, synced blocks)
  if (
    block.type === 'toggle' ||
    block.type === 'callout' ||
    block.type === 'syncedBlock' ||
    block.type === 'embed'
  ) {
    meta.type = block.type;
  }
  // A link_preview renders as a bookmark card, so without the type here the
  // parser would read it back as a plain 'bookmark' and push would recreate it
  // as a static bookmark (duplicating the preserved Notion block). The type in
  // this comment is what keeps it a linkPreview across the round-trip.
  if (block.type === 'linkPreview') {
    meta.type = block.type;
  }
  // A table of contents renders as a LIST of heading links, which markdown cannot
  // tell apart from a real bulleted list. Without the type here a push would replace
  // Notion's table_of_contents block with actual bullets. The parser restores the type
  // from this comment; push-block-builder then emits table_of_contents and drops the
  // body it rendered from.
  if (block.type === 'tableOfContents') {
    meta.type = block.type;
  }
  // Include type for media blocks where URL extension may not indicate the correct type
  if (
    block.type === 'video' ||
    block.type === 'audio' ||
    block.type === 'file' ||
    block.type === 'pdf'
  ) {
    meta.type = block.type;
  }
  // Include block-level color
  if (block.meta && 'color' in block.meta && block.meta.color && block.meta.color !== 'default') {
    meta.color = block.meta.color;
  }
  // Include callout icon for round-trip preservation
  if (block.type === 'callout' && block.meta.kind === 'callout' && block.meta.icon) {
    meta.icon = block.meta.icon;
  }
  // Preserve non-default numbered list format (letters/roman) for round-trip.
  // Standard markdown has no letter/roman list syntax, so we store it here.
  if (
    block.type === 'numberedList' &&
    block.meta.kind === 'numberedList' &&
    block.meta.listFormat &&
    block.meta.listFormat !== 'numbers'
  ) {
    meta.listFormat = block.meta.listFormat;
  }
  // F-035: preserve non-default table header flags that markdown can't
  // represent. Markdown tables always have a `|---|---|` separator, so
  // a headerless Notion table would otherwise flip to has_column_header
  // on round-trip. Parser reads these hints back and restores the flags.
  if (block.type === 'table' && block.meta.kind === 'table') {
    if (block.meta.hasColumnHeader === false) meta.noColumnHeader = true;
    if (block.meta.hasRowHeader === true) meta.rowHeader = true;
  }
  // F-037: a toggleable heading with no body renders as a plain
  // `## Heading` and loses its is_toggleable flag across round-trip.
  // The callout syntax (`> [!heading-N]+`) already carries the flag
  // when there are children. For the empty case, emit a hint so the
  // parser can restore the flag without needing children.
  if (
    (block.type === 'heading1' ||
      block.type === 'heading2' ||
      block.type === 'heading3' ||
      block.type === 'heading4') &&
    block.meta.kind === 'heading' &&
    block.meta.isToggleable === true &&
    !block.children?.length
  ) {
    meta.toggleable = true;
  }
  // F-039: synced block references render as `![[#^blockId]]` which on
  // re-parse would become a plain pageLink. Emit the syncedFrom id so
  // the parser can reconstruct the syncedBlock meta.kind.
  if (block.type === 'syncedBlock' && block.meta.kind === 'syncedBlock' && block.meta.syncedFrom) {
    meta.syncedFrom = block.meta.syncedFrom;
  }
  // Carry a locally-set image/media width through the round-trip.
  if (block.format?.blockWidth) {
    meta.blockWidth = block.format.blockWidth;
  }
  // Emit ID-only comments for EVERY block with an id - media and text alike.
  // Previous policy (2026-04-23, audit F-002) skipped text blocks on the
  // assumption that content fingerprints would match across edits. They
  // don't: blockFingerprint() includes the first 80 chars of rich-text,
  // so any text change invalidates the fingerprint, Phase A (ID) match
  // can't fire without an ID in parsed blocks, Phase B (fingerprint)
  // fails, and the differ deletes+recreates - breaking every inbound
  // Notion @mention, block-link, and comment anchored to the old id.
  // Source-mode clutter is hidden from Live Preview by meta-comment-hider.
  // EXCEPT list items: a %% n2o %% line between items shatters one list into
  // separate single-item lists, so Obsidian renders big gaps between them
  // (Vissu: "feels like hardcoded lines, not a list"). A list item only ever
  // carries its id here, and the differ matches unchanged items by content
  // fingerprint, so drop the id-only comment to keep the list tight. Items
  // that carry real meta (color, listFormat) still emit it and accept a gap.
  const listType =
    block.type === 'numberedList' || block.type === 'bulletList' || block.type === 'todo';
  if (listType && Object.keys(meta).length === 1) return '';
  // Sort keys for deterministic output (prevents false hash changes between syncs)
  const sorted = Object.keys(meta)
    .sort()
    .reduce<Record<string, unknown>>((o, k) => {
      o[k] = meta[k];
      return o;
    }, {});
  return `%% n2o:${JSON.stringify(sorted)} %%\n`;
}

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
 * Escape a leading block marker in paragraph text so it does not re-parse as a
 * different block type on the next push. A Notion paragraph whose text starts
 * with `1. `, `- `, `# `, `> `, or `|` would otherwise become a numbered list,
 * bullet, heading, blockquote, or table row. Only the leading marker is escaped;
 * the parser unescapes `\<punct>` back to the literal and drops the backslash
 * (#1503). Escapes are mutually exclusive (a line starts with at most one marker
 * kind), so chaining the replacements is safe.
 */
function escapeLeadingBlockMarker(text: string): string {
  return text
    .replace(/^( *)(#{1,6})( )/, '$1\\$2$3') // heading: # .. ######
    .replace(/^( *)(\d+)([.)])( )/, '$1$2\\$3$4') // ordered list: 1. or 1)
    .replace(/^( *)([-*+])( )/, '$1\\$2$3') // bullet: - * +
    .replace(/^( *)(>)( )/, '$1\\$2$3') // blockquote: >
    .replace(/^( *)(\|)/, '$1\\$2'); // table row: |
}

/**
 * Render a single block to markdown.
 */
export function renderBlock(
  block: N2OBlock,
  depth: number,
  ctx: BlockRenderContext,
  parentDatabaseId?: string,
  ordinal?: number,
): string | null {
  const indent = '    '.repeat(depth);
  const text = ctx.renderRichText(block.content);
  const metaComment = buildMetaComment(block);
  // Block-level markdown that the renderer only recognises at the start of a
  // fresh block - headings (Live Preview) and tables (GFM) - breaks when the
  // %% n2o %% comment sits on the immediately preceding line: the heading
  // loses its styling in edit mode and the table renders as raw pipes. Put a
  // blank line between the comment and the block. The parser skips blank lines
  // while holding pendingMeta, so the comment still binds to the block on the
  // way back (round-trip preserved).
  const metaCommentSep = metaComment ? `${metaComment}\n` : '';

  switch (block.type) {
    case 'paragraph': {
      // Blank-separate the comment from a TOP-LEVEL paragraph (same as
      // headings/tables below). Adjacent, the comment lazily continues into
      // the paragraph and reading view strips it to a leading <br> - one
      // phantom line above every text block, the main driver of the ~2x
      // block spacing (#1675). Blank-separated, it renders as an empty
      // zero-margin <p>. Nested (indented) paragraphs
      // keep the adjacent form: a blank line inside a list item would flip
      // the list to loose rendering or break item continuation.
      const parSep = indent ? metaComment : metaCommentSep;
      // An EMPTY paragraph is a deliberate spacer in Notion (~one line of
      // height). Rendering it as a bare id comment collapsed it to nothing,
      // so pages read tighter than their Notion source (#1626). A lone
      // &nbsp; occupies one line in Reading view; Live Preview does not
      // render HTML entities, so meta-comment-hider.ts blanks the line via
      // a CM6 decoration (#1666, SPACER_LINE_RE - keep the forms in sync).
      // A raw U+00A0 was tried and reverted: Reading view trims it to an
      // empty zero-height <p> inconsistently under section virtualization
      // (see the #1666 investigation, 2026-07-13). The parser maps BOTH
      // forms back to an empty paragraph on push.
      if (!text.trim() && !block.children?.length) {
        return `${parSep}${indent}&nbsp;\n`;
      }
      return `${parSep}${indent}${escapeLeadingBlockMarker(text)}\n`;
    }

    case 'heading1':
    case 'heading2':
    case 'heading3':
    case 'heading4': {
      const headingMeta = block.meta;
      const level =
        block.type === 'heading1'
          ? 1
          : block.type === 'heading2'
            ? 2
            : block.type === 'heading3'
              ? 3
              : 4;
      const hashes = '#'.repeat(level);

      // Toggle heading with children -> collapsible callout. Collapsed by
      // default (#1677, owner decision 2026-07-13): Notion presents every
      // toggle collapsed on a fresh page load and the API carries no
      // per-toggle state, so collapsed is the faithful default. Readers
      // expand with a click; folded content stays searchable. (Reverses
      // the #1089 expanded-for-usability choice.)
      if (headingMeta.kind === 'heading' && headingMeta.isToggleable && block.children?.length) {
        const calloutType = `heading-${level}`;
        let result = `> [!${calloutType}]- ${text}`;
        if (metaComment) {
          result += `\n> ${metaComment.trimEnd()}`;
        }
        const childContent = ctx.buildBlocks(block.children, 0, parentDatabaseId);
        const prefixed = childContent
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n');
        result += '\n' + prefixed;
        return result + '\n';
      }

      // Non-toggleable heading with children (rare) -> heading + children below
      if (block.children?.length) {
        let result = `${metaCommentSep}${hashes} ${text}\n`;
        result += '\n' + ctx.buildBlocks(block.children, 0, parentDatabaseId);
        return result;
      }

      return `${metaCommentSep}${hashes} ${text}\n`;
    }

    case 'bulletList': {
      let result = `${metaComment}${indent}- ${text}`;
      if (block.children?.length) {
        result += '\n' + ctx.buildBlocks(block.children, depth + 1, parentDatabaseId);
      }
      return result + '\n';
    }

    case 'numberedList': {
      // Notion numbers items by position; markdown re-derives the number from
      // the marker. Every item emitting "1." only auto-numbers when the items
      // are one contiguous list - but each carries a %% n2o %% comment on its
      // own line, which splits them into separate single-item lists that each
      // restart at 1 (the "1. 1. 1." bug). Emit the running position among
      // consecutive siblings so every fragment shows the right number.
      const startNum =
        ordinal ??
        (block.meta.kind === 'numberedList' && block.meta.startIndex ? block.meta.startIndex : 1);
      let result = `${metaComment}${indent}${startNum}. ${text}`;
      if (block.children?.length) {
        result += '\n' + ctx.buildBlocks(block.children, depth + 1, parentDatabaseId);
      }
      return result + '\n';
    }

    case 'todo': {
      const checked = block.meta.kind === 'todo' && block.meta.checked;
      let result = `${metaComment}${indent}- [${checked ? 'x' : ' '}] ${text}`;
      if (block.children?.length) {
        result += '\n' + ctx.buildBlocks(block.children, depth + 1, parentDatabaseId);
      }
      return result + '\n';
    }

    case 'toggle': {
      const meta = block.meta;
      // Dedicated `toggle` callout type: styled into Notion's bare
      // chevron-plus-text row by 010-content.css (same chrome-strip the
      // heading-N callouts get), instead of borrowing `info` and reading as
      // a blue box. The parser maps [!toggle] back natively; legacy files
      // still round-trip via the type:"toggle" meta comment until their
      // next re-render.
      const type = meta.kind === 'callout' ? meta.calloutType : 'toggle';
      // Collapsed by default, like Notion's fresh-load render (#1677) - see
      // the toggleable-heading case above for the reasoning.
      let result = `> [!${type}]- ${text}`;
      if (metaComment) {
        result += `\n> ${metaComment.trimEnd()}`;
      }
      if (block.children?.length) {
        const childContent = ctx.buildBlocks(block.children, 0, parentDatabaseId);
        const prefixed = childContent
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n');
        result += '\n' + prefixed;
      }
      return result + '\n';
    }

    case 'quote': {
      const quoteLines = text.split('\n').map((l) => `> ${l}`);
      let result = `${metaComment}${quoteLines.join('\n')}`;
      if (block.children?.length) {
        const childContent = ctx.buildBlocks(block.children, 0, parentDatabaseId);
        const prefixed = childContent
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n');
        result += '\n' + prefixed;
      }
      return result + '\n';
    }

    case 'callout': {
      const meta = block.meta;
      // A background-coloured Notion callout maps to an `n2o-<colour>` type so
      // Obsidian's callout is the closest native equivalent - Obsidian's
      // semantic type colours (note=blue etc.) lose Notion's gray/brown/etc, which
      // is why a gray "Linked Block" rendered blue. Default-colour callouts keep
      // the semantic type. Colour + icon still round-trip via the meta comment.
      const bgColor =
        meta.kind === 'callout' && meta.color && meta.color.endsWith('_background')
          ? meta.color.slice(0, -'_background'.length)
          : '';
      const calloutType = bgColor
        ? `n2o-${bgColor}`
        : meta.kind === 'callout'
          ? resolveCalloutType(meta.icon, meta.color)
          : 'note';
      const foldChar =
        meta.kind === 'callout' && meta.collapsible ? (meta.defaultOpen ? '+' : '-') : '';
      // Inline the Notion icon as an emoji at the START of the callout so it reads
      // like Notion (its ACTUAL emoji, not Obsidian's generic type glyph). Built-in
      // icon NAMES map to their emoji; a real emoji is used as-is; URL/file icons
      // are skipped. The emoji is emitted inline so only this
      // shows. The parser strips it back off on push (the icon round-trips via the
      // meta comment, so no data is duplicated).
      let iconEmoji = '';
      if (meta.kind === 'callout' && meta.icon) {
        if (isBuiltInIconName(meta.icon)) iconEmoji = iconNameToEmoji(meta.icon) || '';
        else if (!/^(https?:|\/|data:)/.test(meta.icon)) iconEmoji = meta.icon;
      }
      const titleText = iconEmoji ? (text ? `${iconEmoji} ${text}` : iconEmoji) : text;
      let result = `> [!${calloutType}]${foldChar} ${titleText}`;
      if (metaComment) {
        result += `\n> ${metaComment.trimEnd()}`;
      }
      if (block.children?.length) {
        const childContent = ctx.buildBlocks(block.children, 0, parentDatabaseId);
        const prefixed = childContent
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n');
        result += '\n' + prefixed;
      }
      return result + '\n';
    }

    case 'code': {
      const lang = block.meta.kind === 'code' ? block.meta.language : '';
      const caption = block.meta.kind === 'code' ? block.meta.caption : undefined;
      // A fenced code body is verbatim - it must NOT go through the inline
      // markdown escaper (that would turn a literal ` into \` inside the code).
      // Build the raw body straight from the segment text (#1503).
      const codeBody = block.content.map((s) => s.text).join('');
      // If the body contains a line that is itself a backtick fence (```), use a
      // longer outer fence so it doesn't close the block early. This mirrors the
      // parser, which closes only on a fence at least as long as the opener.
      const innerFence = codeBody
        .split('\n')
        .reduce((max, l) => (/^`{3,}\s*$/.test(l) ? Math.max(max, l.trim().length) : max), 0);
      const fence = '`'.repeat(innerFence >= 3 ? innerFence + 1 : 3);
      let result = `${metaComment}${fence}${lang}\n${codeBody}\n${fence}`;
      if (caption) result += `\n*${caption}*\n${CAPTION_MARKER}`;
      return result + '\n';
    }

    case 'divider':
      // CommonMark needs a blank line BEFORE `---` for it to render as a
      // horizontal rule. Without it, the line above (here the n2o meta
      // comment) is interpreted as a setext heading and `---` becomes its
      // underline. Inserting `\n` between metaComment and `---` gives us:
      //   %% n2o:... %%
      //   <blank>
      //   ---
      // which renders as an HR. Parser tolerates the blank line - it
      // matches `^(-{3,}|...)$` line-by-line.
      return `${metaComment}\n---\n`;

    case 'image': {
      if (block.meta.kind === 'image') {
        const { url, caption, sourceType } = block.meta;
        // Width from the locally-set `|width` embed syntax, if any.
        const width = block.format?.blockWidth ? `|${Math.round(block.format.blockWidth)}` : '';
        if (sourceType === 'local') {
          const fileName = url.split('/').pop() ?? url;
          return caption
            ? `${metaComment}![[${fileName}${width}]]\n*${caption}*\n${CAPTION_MARKER}\n`
            : `${metaComment}![[${fileName}${width}]]\n`;
        }
        // External URLs (user-provided, e.g. Imgur) - keep as-is, they don't expire
        if (sourceType === 'external') {
          // Dead source URL that could not be downloaded: render an honest,
          // clickable fallback instead of a broken `![](url)` embed.
          if (block.meta.unavailable) {
            const label = caption || url;
            return `${metaComment}${IMAGE_UNAVAILABLE_MARKER} [${label}](${url}) (image unavailable)\n`;
          }
          return caption ? `${metaComment}![${caption}](${url})\n` : `${metaComment}![](${url})\n`;
        }
        // Notion-hosted (sourceType='file'): S3 URL expires ~1 hour - render placeholder.
        // Media retry on next sync will replace with local path.
        const alt = caption || 'image - download pending';
        return `${metaComment}![${alt}]()\n`;
      }
      return null;
    }

    case 'embed':
      if (block.meta.kind === 'bookmark') {
        const { url, title } = block.meta;
        return `${metaComment}${renderEmbedIframe(safeUrl(toEmbedUrl(url) ?? url), embedStyle(), title ?? '')}\n`;
      }
      return null;

    case 'bookmark':
    // A block-level link_preview renders as the same card as a bookmark (we only
    // have the URL). The distinct block.type is what keeps the metaComment
    // carrying the type back on parse.
    // falls through
    case 'linkPreview':
      if (block.meta.kind === 'bookmark') {
        const { url, title, description, caption } = block.meta;
        const hostname = extractHostname(url);
        const descHtml = description
          ? `<div class="n2o-bookmark-desc">${escapeHtml(description)}</div>`
          : '';
        const previewParts: string[] = [];
        const previewTitle =
          title && title !== url
            ? `<div class="n2o-bookmark-preview-title">${escapeHtml(title)}</div>`
            : '';
        const previewDesc = description
          ? `<div class="n2o-bookmark-preview-desc">${escapeHtml(description)}</div>`
          : '';
        const previewUrl = `<div class="n2o-bookmark-preview-url">${escapeHtml(hostname)}</div>`;
        if (description) {
          previewParts.push(
            `<div class="n2o-bookmark-preview-text">${previewTitle}${previewDesc}${previewUrl}</div>`,
          );
        }
        const previewHtml =
          previewParts.length > 0
            ? `<div class="n2o-bookmark-preview">${previewParts.join('')}</div>`
            : '';
        // Card layout mirrors Notion: title on top (the DOMAIN when the
        // bookmark has no fetched title, never the raw URL), the FULL URL on
        // the bottom line, and the user's CAPTION below the card - a sibling
        // div on the same line so the whole bookmark stays one markdown block.
        const captionHtml = caption
          ? `<div class="n2o-bookmark-caption">${escapeHtml(caption)}</div>`
          : '';
        return `${metaComment}<div class="n2o-bookmark"><a href="${escapeHtml(safeUrl(url))}"><div class="n2o-bookmark-info"><div class="n2o-bookmark-title">${escapeHtml(title || hostname)}</div>${descHtml}<div class="n2o-bookmark-url">${escapeHtml(url)}</div></div></a>${previewHtml}</div>${captionHtml}\n\n`;
      }
      return null;

    case 'equation':
      if (block.meta.kind === 'equation') {
        return `${metaComment}$$\n${block.meta.expression}\n$$\n`;
      }
      return null;

    case 'video':
    case 'audio': {
      if (block.meta.kind === 'image') {
        const { url, caption, sourceType } = block.meta;
        const width = block.format?.blockWidth ? `|${Math.round(block.format.blockWidth)}` : '';
        if (sourceType === 'local') {
          const fileName = url.split('/').pop() ?? url;
          return caption
            ? `${metaComment}![[${fileName}${width}]]\n*${caption}*\n${CAPTION_MARKER}\n`
            : `${metaComment}![[${fileName}${width}]]\n`;
        }
        // Non-local: render placeholder for Notion S3 URLs (expire ~1 hour)
        // but keep external URLs - Obsidian embeds YouTube natively from a plain
        // image embed, but services like Loom render as a broken image, so use a
        // proper <iframe> with their embed URL instead.
        if (sourceType === 'external') {
          // The caption belongs BELOW the player, like Notion. Alt text on a
          // media embed is invisible (Obsidian upgrades the link to an iframe
          // /video player and never paints alt), which silently dropped every
          // video caption (#1679). Emit the same `*caption*` + hidden marker
          // line the local-file branch above uses, so the parser reads it back.
          const capLine = caption ? `*${caption}*\n${CAPTION_MARKER}\n` : '';
          const ytHost = (() => {
            try {
              return new URL(url).hostname.replace(/^www\./, '');
            } catch {
              return '';
            }
          })();
          const isYouTube = ytHost === 'youtube.com' || ytHost === 'youtu.be';
          const embed = isYouTube ? null : toEmbedUrl(url);
          if (embed) {
            return `${metaComment}${renderEmbedIframe(safeUrl(embed), embedStyle(), caption ?? '')}\n${capLine}`;
          }
          return `${metaComment}![](${url})\n${capLine}`;
        }
        const alt = caption || `${block.type} - download pending`;
        return `${metaComment}![${alt}]()\n`;
      }
      return null;
    }

    case 'file':
    case 'pdf': {
      if (block.meta.kind === 'image') {
        const { url, caption, sourceType } = block.meta;
        if (sourceType === 'local') {
          const fileName = url.split('/').pop() ?? url;
          /* F-024: emit embed-wikilink (`![[...]]`) so Obsidian renders
           * PDFs inline via its built-in viewer and generic files as
           * downloadable attachment cards. Matches image/video/audio
           * behavior and Notion's rich-embed visual. Parser already
           * round-trips both embed and plain-link forms. */
          return caption
            ? `${metaComment}![[${fileName}]]\n*${caption}*\n${CAPTION_MARKER}\n`
            : `${metaComment}![[${fileName}]]\n`;
        }
        // External URLs (user-provided) - keep as-is
        if (sourceType === 'external') {
          return caption
            ? `${metaComment}[${caption}](${url})\n`
            : `${metaComment}[${url}](${url})\n`;
        }
        // Notion-hosted (sourceType='file'): S3 URL expires - placeholder
        const label = caption || `${block.type} - download pending`;
        return `${metaComment}[${label}]()\n`;
      }
      return null;
    }

    case 'pageLink':
      if (block.meta.kind === 'pageLink') {
        const resolved = resolveWikilink(ctx.pageRegistry, block.meta.pageId, block.meta.pageName);
        // Database references: Lite generates no .base note to link to, so a
        // wikilink would dangle. Render the database's name as plain text -
        // its rows are ordinary notes in the database's folder.
        const isDb = ctx.pageRegistry?.isDatabaseEntry(block.meta.pageId) ?? false;
        if (isDb) {
          return `${resolved.split('/').pop() ?? resolved}\n`;
        }
        // Preserve anchor from original content (e.g. "Note#Section" or "Note#^block-id")
        const anchor = block.content[0]?.text?.includes('#')
          ? block.content[0].text.slice(block.content[0].text.indexOf('#'))
          : '';
        const target = `${resolved}${anchor}`;
        const prefix = block.meta.isEmbed ? '!' : '';
        // Bare wikilink, no icon baked in: the target's icon belongs to the
        // target's own frontmatter, so stamping it into the link text here
        // would go stale the moment the target's icon changes.
        return `${prefix}[[${target}]]\n`;
      }
      return `[[${text}]]\n`;

    case 'databaseLink': {
      // child_database blocks: Lite does not generate .base view files, so
      // an embed here would be a dead wikilink ("...base is not created yet"
      // in Reading view). Render one quiet callout instead - no name (for
      // unresolvable view stubs any name would be fabricated), no URL.
      // Identical for every block, so re-pulls hash identically.
      return (
        '> [!info] Database view\n' +
        "> Live database views are part of N2O Sync. This database's rows sync as regular notes.\n"
      );
    }

    case 'table': {
      if (!block.children?.length) return null;
      const rows = block.children;
      const tableLines: string[] = [];
      for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
        const row = rows[rowIdx];
        if (row !== undefined && row.meta.kind === 'tableRow') {
          const cells = row.meta.cells.map((cell) => {
            const cellText = ctx.renderRichText(cell);
            // Escape pipes and collapse newlines for table cells
            return cellText.replace(/\|/g, '\\|').replace(/\n/g, ' ');
          });
          tableLines.push(`| ${cells.join(' | ')} |`);
          // Add separator after the first row (header)
          if (rowIdx === 0) {
            tableLines.push(`| ${cells.map(() => '---').join(' | ')} |`);
          }
        }
      }
      // F-035: prefix with meta comment so noColumnHeader / rowHeader
      // hints ride along. Without this, a headerless Notion table flips
      // to has_column_header=true on the next push. The blank line after the
      // comment (metaCommentSep) is required - GFM only recognises a table
      // when a blank line precedes it, else it renders as raw pipes.
      return `${metaCommentSep}${tableLines.join('\n')}\n`;
    }

    case 'tableRow':
      // Table rows are handled by the parent 'table' case
      return null;

    case 'columnList': {
      if (!block.children?.length) return null;
      // When multi-column layout is disabled, flatten the columns into a
      // normal stacked document: render each column's children sequentially
      // with no [!multi-column] wrapper and no per-column callouts.
      // Default (undefined) is enabled, preserving the original behavior.
      if (ctx.enableMultiColumnLayout === false) {
        const parts: string[] = [];
        for (const col of block.children) {
          if (!col.children?.length) continue;
          parts.push(ctx.buildBlocks(col.children, depth, parentDatabaseId, false));
        }
        return parts.length ? parts.join('\n') + '\n' : null;
      }
      // Emit the columnList's own id as a meta comment BEFORE the callout (not
      // inside it) so the parser's pendingMeta carries it onto the columnList
      // block. Putting it inside the flex container would add a stray empty
      // paragraph / flex item and shift the column layout. Without the id the
      // differ recreates the whole column layout on every push.
      let result = `${metaComment}> [!multi-column]\n`;
      for (const col of block.children) {
        if (!col.children?.length) continue;
        const colType =
          col.meta.kind === 'column' && col.meta.calloutType ? col.meta.calloutType : 'column';
        const colTitle = col.meta.kind === 'column' && col.meta.title ? col.meta.title : '';
        // Pass widthRatio as callout metadata so CSS can set flex proportions
        // Always include width even when column has a custom calloutType
        const widthMeta =
          col.meta.kind === 'column' && col.meta.widthRatio
            ? `|${Math.round(col.meta.widthRatio * 100)}`
            : '';
        result += `> \n> > [!${colType}${widthMeta}]+ ${colTitle}\n`;
        // Preserve column width_ratio in metadata comment for round-trip
        if (col.id && col.meta.kind === 'column' && col.meta.widthRatio) {
          result += `> > %% n2o:{"id":"${col.id}","type":"column","widthRatio":${col.meta.widthRatio}} %%\n`;
        }
        const childContent = ctx.buildBlocks(col.children, 0, parentDatabaseId, false);
        const prefixed = childContent
          .split('\n')
          .map((l) => `> > ${l}`)
          .join('\n');
        result += prefixed + '\n';
      }
      return result + '\n';
    }

    case 'column':
      // Columns are handled by the parent 'columnList' case
      return null;

    case 'syncedBlock': {
      // Synced blocks: render children inline (originals contain content,
      // references point to the original block ID)
      if (block.meta.kind === 'syncedBlock') {
        if (block.meta.syncedFrom) {
          // F-039: prepend meta comment so the re-parser can reconstruct
          // the syncedBlock type from what would otherwise parse as a
          // plain block-embed wikilink.
          //
          // #1719: when enrichSyncedReferences resolved the original's page,
          // emit the CROSS-PAGE embed `![[Page#^id]]` so Obsidian transcludes
          // the original from where it actually lives. Without a resolved page
          // the current-file `![[#^id]]` is the fallback (self-heals next pull).
          // The parser discards the visible link either way and rebuilds the
          // reference from the meta comment, so round-trip is identical.
          // ONE embed: the original renders its whole region as a single
          // container callout anchored by the synced block's id, so this embeds
          // it wholesale. `syncedFromPage` is the page the original lives on
          // (resolved by enrichSyncedReferences); without it the original is not
          // indexed yet (first pull) so fall back to the current-file form, which
          // self-heals to the cross-page embed next pull.
          const page = block.meta.syncedFromPage;
          const target = page ? `${page}#^${block.meta.syncedFrom}` : `#^${block.meta.syncedFrom}`;
          return `${metaComment}![[${target}]]\n`;
        }
      }
      // Original synced block or fallback - render children normally, plus an
      // Obsidian block anchor on the FIRST child so a cross-page reference
      // `![[Page#^id]]` can transclude it (#1719). Placement verified live: a
      // blank line then a standalone `^id` line attaches to the block above for
      // every block type (callout/paragraph/list/table). The parser drops the
      // anchor line on the way back, so it never reaches Notion. Obsidian
      // transcludes ONE block per anchor, so a multi-block original embeds its
      // first block for now (faithful multi-block is a follow-up).
      if (block.children?.length) {
        // Index THIS page as the block's home (by the synced block's own id, what
        // a reference points at via syncedFrom). Only reached when the original is
        // actually rendered - a phantom copy nested under a reference on another
        // page never gets here (#1719).
        if (block.id) ctx.onSyncedOriginalAnchored?.(block.id);
        // A Notion synced block is ONE container. Render it as a single unbroken
        // callout wrapping its children, so a cross-page reference embeds the
        // whole region with ONE `![[Page#^id]]` (Obsidian embeds a container and
        // all its nested content in one embed). The meta comment (type:syncedBlock)
        // rides inside the callout so the parser rebuilds the synced block; the
        // `^id` anchors the container. The callout renders flush so it
        // reads like Notion's boxless synced block.
        const childContent = ctx.buildBlocks(block.children, 0, parentDatabaseId, false);
        const prefixed = childContent
          .split('\n')
          .map((l) => (l ? `> ${l}` : '>'))
          .join('\n');
        const inner = metaComment ? `> ${metaComment.trim()}\n${prefixed}` : prefixed;
        return `> [!n2o-synced]\n${inner}\n\n^${block.id}\n`;
      }
      return '';
    }

    case 'tableOfContents': {
      // Notion renders a real, clickable list of the page's headings here. This used
      // to emit an HTML comment, which Obsidian renders as NOTHING - the block simply
      // vanished from the synced page.
      //
      // Render the same thing Notion does: the document's headings, indented by
      // level, as `[[#Heading]]` links (Obsidian's native in-note heading links).
      // Round-trip is safe because the meta comment above carries
      // `"type":"tableOfContents"`: the parser applies that type to whatever it parses
      // here, and push-block-builder emits a `table_of_contents` block from it and
      // ignores the body - so pushing back never turns this list into real bullets in
      // Notion. See buildMetaComment.
      const headings = ctx.documentHeadings ?? [];
      if (headings.length === 0) return '';
      const top = Math.min(...headings.map((h) => h.level));
      const items = headings.map((h) => {
        const listIndent = '  '.repeat(Math.max(0, h.level - top));
        // `|alias` keeps the visible text identical to the heading even when the link
        // target has to be escaped.
        return `${listIndent}- [[#${h.text}|${h.text}]]`;
      });
      // metaComment carries "type":"tableOfContents" - without it the parser reads
      // this back as a plain bulleted list and a push would replace Notion's TOC block
      // with real bullets.
      return `${metaComment}${items.join('\n')}\n`;
    }

    case 'unsupported':
      return `<!-- N2O: unsupported block type -->\n`;

    case 'breadcrumb': {
      // Notion renders the page's ancestor chain here. This used to emit a
      // raw `<!-- breadcrumb -->` HTML comment, which Live Preview shows as
      // literal text under the title of every affected page.
      //
      // Render a real chain instead: `%% n2o:breadcrumb %% [[A]] / [[B]] / Title`.
      // The marker (breadcrumb-marker.ts) is the round-trip anchor - reading
      // view strips `%% %%` comments natively, meta-comment-hider hides the
      // marker span in Live Preview, and the parser keys on it and discards
      // the visible chain (derived content, rebuilt from the registry/sync
      // records by enrichBreadcrumbBlocks on every pull). push-block-builder
      // emits `breadcrumb: {}` from the parsed block; Notion derives its own
      // path, so nothing rendered here ever leaks back.
      //
      // Ancestors come from meta.breadcrumbPath (root-first, page excluded);
      // the page's own title closes the chain via ctx.documentTitle. With
      // neither resolved, the marker still goes out alone - never the raw
      // comment, and the line stays parseable.
      const segments = block.meta.kind === 'breadcrumb' ? (block.meta.breadcrumbPath ?? []) : [];
      // A synced ancestor renders as a wikilink, an unsynced one / a database
      // as plain text. Icons are NOT prefixed here, for the same reason as the
      // body wikilinks above: an icon stamped into the link text goes stale
      // when the target's frontmatter icon changes.
      const parts = segments.map((s) =>
        !s.linkTarget
          ? s.title
          : s.linkTarget === s.title
            ? `[[${s.linkTarget}]]`
            : `[[${s.linkTarget}|${s.title}]]`,
      );
      // Close the chain with the page itself as a self-wikilink so the last
      // crumb is clickable and the decorator gives it the page's own icon,
      // matching how Notion shows the current page as the final crumb.
      const ownTitle = ctx.documentTitle?.trim();
      if (ownTitle) {
        const ownTarget = ctx.documentNotionId
          ? ctx.pageRegistry?.getWikilinkTarget(ctx.documentNotionId, ownTitle)
          : undefined;
        parts.push(
          ownTarget
            ? ownTarget === ownTitle
              ? `[[${ownTarget}]]`
              : `[[${ownTarget}|${ownTitle}]]`
            : ownTitle,
        );
      }
      const chain = parts.join(' / ');
      // Same separation rule as paragraphs: blank-separate the id comment at
      // top level, keep it adjacent when nested so lists stay tight.
      const bcSep = indent ? metaComment : metaCommentSep;
      return `${bcSep}${indent}${BREADCRUMB_MARKER}${chain ? ` ${chain}` : ''}\n`;
    }

    default:
      return `${indent}${text}\n`;
  }
}

/** Extract hostname from a URL for display (e.g. "https://example.com/path" -> "example.com"). */
function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Escape HTML special characters to prevent XSS in rendered bookmark cards. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
