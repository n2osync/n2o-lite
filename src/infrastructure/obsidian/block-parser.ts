/**
 * Block-level markdown parser - converts markdown lines into N2OBlock arrays.
 * Handles headings, lists, code blocks, tables, callouts, toggles, dividers,
 * images, embeds, equations, columns, synced blocks, etc.
 * Extracted from ObsidianParser for modularity.
 */

import type { N2OBlock, N2OBlockType } from '../../domain/models/block';
import type { SyncStateDB } from '../storage/sync-state';
import { createLogger } from '../../shared/logger';
import {
  CALLOUT_TYPE_TO_EMOJI,
  isBuiltInIconName,
  iconNameToEmoji,
} from '../../shared/callout-map';
import { isNotionCodeLanguage } from '../../shared/notion-code-language';
import { parseInlineMarkdown } from './inline-parser';
import type { InlineParserDeps } from './inline-parser';
import { resolveWikilinkToNotionId } from './wikilink-resolver';
import { CAPTION_MARKER_RE } from './caption-marker';
import { BREADCRUMB_LINE_RE, LEGACY_BREADCRUMB_LINE_RE } from './breadcrumb-marker';
import { IMAGE_UNAVAILABLE_LINE_RE } from './image-unavailable-marker';
import type { PathMapping } from './wikilink-resolver';

const log = createLogger('BlockParser');

const CALLOUT_REGEX = /^> \[!([\w-]+)\]([+-])?\s*(.*)/;

/** Map file extensions to their correct N2OBlockType (default: 'file') */
// Single source of truth for media extensions the parser recognises. MUST stay
// in sync with the media-downloader's set, or a pulled .mov/.mkv/.m4a/.flac/etc.
// fails the parser's media check on push and gets destroyed as a page link
// (#1504). Extensions added here are matched by hasMediaExtension below.
const EXT_TO_BLOCK_TYPE: Record<string, N2OBlockType> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  avif: 'image',
  ico: 'image',
  heic: 'image',
  tiff: 'image',
  tif: 'image',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  mkv: 'video',
  avi: 'video',
  wmv: 'video',
  mp3: 'audio',
  ogg: 'audio',
  wav: 'audio',
  m4a: 'audio',
  flac: 'audio',
  aac: 'audio',
  pdf: 'pdf',
};

/** True when the path's extension is a known media type. Derived from
 *  EXT_TO_BLOCK_TYPE so the media check can never drift narrower than the map. */
function hasMediaExtension(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return ext in EXT_TO_BLOCK_TYPE;
}

/** Valid N2OBlockType values for metadata comment validation. */
const VALID_BLOCK_TYPES = new Set([
  'paragraph',
  'heading1',
  'heading2',
  'heading3',
  'heading4',
  'bulletList',
  'numberedList',
  'todo',
  'toggle',
  'quote',
  'callout',
  'code',
  'divider',
  'image',
  'video',
  'audio',
  'file',
  'pdf',
  'bookmark',
  'embed',
  'equation',
  'table',
  'tableRow',
  'columnList',
  'column',
  'pageLink',
  'databaseLink',
  'syncedBlock',
  'tableOfContents',
  'breadcrumb',
  'unsupported',
  'linkPreview',
]);

/**
 * A standalone Obsidian block anchor N2O emits on a synced-block ORIGINAL
 * (#1719): `^<notion-id>` alone on a line. Notion-id-shaped (dashed uuid or
 * 32-hex) so a user's own short block anchors and stray carets are never
 * mistaken for it. Dropped on parse - it is round-trip scaffolding, not content.
 */
const SYNCED_ANCHOR_LINE_RE =
  /^\s*\^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{32})\s*$/;

/** Valid Notion color values for metadata comment validation. */
const VALID_COLORS = new Set([
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
  'gray_background',
  'brown_background',
  'orange_background',
  'yellow_background',
  'green_background',
  'blue_background',
  'purple_background',
  'pink_background',
  'red_background',
]);

/** Dependencies needed for block parsing. */
export interface BlockParserDeps {
  syncState: SyncStateDB | null;
  resolveCache: PathMapping[] | null;
  updateResolveCache: (cache: PathMapping[] | null) => void;
}

/**
 * Parse markdown body into N2OBlocks.
 */
export function parseMarkdownToBlocks(markdown: string, deps: BlockParserDeps): N2OBlock[] {
  const inlineDeps: InlineParserDeps = {
    syncState: deps.syncState,
    resolveCache: deps.resolveCache,
    updateResolveCache: deps.updateResolveCache,
  };

  const blocks: N2OBlock[] = [];
  const lines = markdown.split('\n');
  let i = 0;
  let pendingMeta: Record<string, unknown> | null = null;

  const pushBlock = (block: N2OBlock): void => {
    if (pendingMeta) {
      if (pendingMeta.id) block.id = pendingMeta.id as string;
      if (pendingMeta.type) block.type = pendingMeta.type as N2OBlockType;
      if (pendingMeta.color && block.meta) {
        (block.meta as unknown as Record<string, unknown>).color = pendingMeta.color;
      }
      if (pendingMeta.icon && block.meta && block.meta.kind === 'callout') {
        const iconValue = pendingMeta.icon as string;
        (block.meta as unknown as Record<string, unknown>).icon = iconValue;
        // The renderer inlines the icon's emoji at the start of the callout title
        // (a built-in name mapped to its emoji, or a real emoji as-is). Strip that
        // leading emoji from the first rich-text segment so it does not double up
        // on push - the icon itself round-trips via this meta comment.
        let emoji = '';
        if (isBuiltInIconName(iconValue)) emoji = iconNameToEmoji(iconValue) || '';
        else if (!/^(https?:|\/|data:)/.test(iconValue)) emoji = iconValue;
        if (emoji && block.content?.length) {
          const first = block.content[0];
          if (first && first.text.startsWith(emoji + ' ')) {
            first.text = first.text.slice(emoji.length + 1);
          } else if (first && first.text === emoji) {
            first.text = '';
          }
        }
      }
      if (pendingMeta.widthRatio && block.meta) {
        (block.meta as unknown as Record<string, unknown>).widthRatio = pendingMeta.widthRatio;
      }
      // F-035: restore table header flags from the meta-comment hint.
      // Markdown tables always parse with hasColumnHeader=true because
      // a separator is required, so this hint is the only way a headerless
      // Notion table keeps its has_column_header=false across round-trip.
      if (block.meta?.kind === 'table') {
        if (pendingMeta.noColumnHeader === true) {
          (block.meta as unknown as Record<string, unknown>).hasColumnHeader = false;
        }
        if (pendingMeta.rowHeader === true) {
          (block.meta as unknown as Record<string, unknown>).hasRowHeader = true;
        }
      }
      // F-037: restore is_toggleable on headings that rendered as plain
      // `## Heading` (no children). Without this hint the flag gets lost
      // on round-trip even though the callout-syntax path preserves it.
      if (pendingMeta.toggleable === true && block.meta?.kind === 'heading') {
        (block.meta as unknown as Record<string, unknown>).isToggleable = true;
      }
      // F-038: restore non-default numbered list format. Markdown has no
      // syntax for letter/roman list numbering, so the meta-comment hint
      // is the only way a Notion list_format=letters/roman survives the
      // round-trip.
      if (pendingMeta.listFormat && block.meta?.kind === 'numberedList') {
        (block.meta as unknown as Record<string, unknown>).listFormat = pendingMeta.listFormat;
      }
      // F-039: synced-block reference rendered as `![[#^id]]` parses as
      // a pageLink by default. When the meta comment flags type=syncedBlock
      // with a syncedFrom id, rewrite the block's meta to the syncedBlock
      // shape so push-builder emits the correct Notion synced_block block.
      if (pendingMeta.type === 'syncedBlock') {
        block.type = 'syncedBlock';
        if (pendingMeta.syncedFrom) {
          // Reference: rendered as `![[Page#^id]]`, parsed as a pageLink. Rebuild
          // the reference from the meta; the visible embed is derived content.
          block.meta = { kind: 'syncedBlock', syncedFrom: pendingMeta.syncedFrom as string };
          block.content = [];
        } else {
          // Original: rendered as a `[!n2o-synced]` container callout wrapping the
          // synced content. Keep the callout's parsed children as the synced
          // block's content; drop the empty callout title.
          block.meta = { kind: 'syncedBlock', syncedFrom: null };
          block.content = [];
        }
      }
      // Restore a locally-set image/media width carried in the metadata comment.
      if (pendingMeta['blockWidth'] !== undefined) {
        block.format = { blockWidth: pendingMeta['blockWidth'] as number };
      }
      pendingMeta = null;
    }
    blocks.push(block);
  };

  while (i < lines.length) {
    const line = lines[i];
    // The loop bound guarantees this; the guard makes the invariant explicit and
    // narrows `line` to `string` for the whole body (noUncheckedIndexedAccess).
    if (line === undefined) break;

    // Spacer paragraph (#1626/#1666): a line holding ONLY non-breaking
    // space(s) (U+00A0, the renderer's current form) or the legacy `&nbsp;`
    // entity maps back to Notion's EMPTY paragraph. Checked BEFORE the blank
    // skip: String.trim() strips U+00A0, so the line would otherwise read as
    // blank and the spacer would be silently dropped on push.
    if (/^\u00A0+$/.test(line) || line.trim() === '&nbsp;') {
      pushBlock({
        id: '',
        type: 'paragraph',
        content: [],
        meta: { kind: 'paragraph' },
      });
      i++;
      continue;
    }

    // Empty lines
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Synced-block anchor line (#1719): a standalone `^<notion-id>` N2O emits on
    // a synced-block ORIGINAL so a cross-page reference can transclude it. It is
    // round-trip scaffolding, not content - drop it so it never pushes to Notion
    // as text. Scoped to the Notion-id shape (dashed uuid or 32-hex) so real
    // user block anchors (short ids) and stray carets are untouched.
    if (SYNCED_ANCHOR_LINE_RE.test(line)) {
      i++;
      continue;
    }

    // N2O metadata comment - applies to next block
    const n2oMatch = line.match(/^(?:<!-- n2o:(\{.*\}) -->|%% n2o:(\{.*\}) %%)\s*$/);
    if (n2oMatch) {
      try {
        const raw = JSON.parse(n2oMatch[1] ?? n2oMatch[2] ?? '{}') as {
          id?: string;
          type?: string;
          color?: string;
          icon?: string;
          widthRatio?: number;
        };
        // Validate type against known N2OBlockType values
        if (raw.type && !VALID_BLOCK_TYPES.has(raw.type)) {
          log.warn(`Invalid block type in metadata comment: ${raw.type}`);
          raw.type = undefined;
        }
        // Validate color against known Notion colors
        if (raw.color && !VALID_COLORS.has(raw.color)) {
          log.warn(`Invalid color in metadata comment: ${raw.color}`);
          raw.color = undefined;
        }
        // Validate id format (alphanumeric + dashes only, no injection chars)
        if (raw.id && !/^[\w-]+$/.test(raw.id)) {
          log.warn(`Invalid block ID in metadata comment: ${raw.id}`);
          raw.id = undefined;
        }
        // Validate icon: allow emojis (short) and Notion external URLs (https://)
        if (raw.icon && raw.icon.length > 8 && !raw.icon.startsWith('https://')) {
          log.warn(`Invalid icon in metadata comment: too long`);
          raw.icon = undefined;
        }
        pendingMeta = raw;
      } catch {
        // Invalid JSON - skip
      }
      i++;
      continue;
    }

    // Stray caption marker (its owning code/media block already consumed the
    // paired one). Drop it so it never renders as a literal paragraph (#1515).
    if (CAPTION_MARKER_RE.test(line)) {
      i++;
      continue;
    }

    // Breadcrumb line. The marker anchors the block; the visible chain after
    // it is DERIVED content (rebuilt from the registry/sync records on every
    // pull by enrichBreadcrumbBlocks), so discard it here - push-block-builder
    // emits `breadcrumb: {}` and Notion derives its own path. The legacy
    // `<!-- breadcrumb -->` HTML-comment line is what older renderers wrote;
    // keep parsing it so already-pulled files hold their breadcrumb block
    // between the plugin update and the next re-render sweep.
    if (BREADCRUMB_LINE_RE.test(line) || LEGACY_BREADCRUMB_LINE_RE.test(line)) {
      pushBlock({
        id: '',
        type: 'breadcrumb',
        content: [],
        meta: { kind: 'breadcrumb' },
      });
      i++;
      continue;
    }

    // Image-unavailable fallback line: an external image whose source URL is
    // dead, rendered as a clickable link instead of a broken embed. Read the
    // link back into an external image (marked unavailable); the trailing
    // `(image unavailable)` note is cosmetic and ignored. Link text equal to
    // the URL means there was no caption (see image-unavailable-marker.ts).
    const imgUnavailMatch = line.match(IMAGE_UNAVAILABLE_LINE_RE);
    if (imgUnavailMatch) {
      const iuUrl = imgUnavailMatch[2] ?? '';
      const iuText = imgUnavailMatch[1] || undefined;
      pushBlock({
        id: '',
        type: 'image',
        content: [],
        meta: {
          kind: 'image',
          url: iuUrl,
          caption: iuText === iuUrl ? undefined : iuText,
          sourceType: 'external',
          unavailable: true,
        },
      });
      i++;
      continue;
    }

    // Headings (heading4 is official as of Notion 2025-09-03 - renders as ####). Match up
    // to six hashes and clamp to the deepest supported level so H5/H6 become a
    // heading, not literal "##### text" pushed verbatim to Notion (#1514).
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = Math.min((headingMatch[1] ?? '').length, 4) as 1 | 2 | 3 | 4;
      pushBlock({
        id: '',
        type: `heading${level}`,
        content: parseInlineMarkdown(headingMatch[2] ?? '', inlineDeps),
        meta: { kind: 'heading', level },
      });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      pushBlock({ id: '', type: 'divider', content: [], meta: { kind: 'empty' } });
      i++;
      continue;
    }

    // Code blocks. Capture the fence length and full info string so that
    // non-word language names (c++, c#, objective-c) survive, and close only on
    // a fence of at least the opening length containing nothing but backticks -
    // an inner ``` inside the code body no longer truncates the block.
    const codeMatch = line.match(/^(`{3,})(.*)$/);
    if (codeMatch) {
      const fence = codeMatch[1] ?? '```';
      // Keep the WHOLE info string when it is a valid multi-word Notion language
      // (`visual basic`, `llvm ir`, `ascii art`, `notion formula`) so it round-trips;
      // otherwise the first token (drops any trailing metadata like `js title="x"`).
      // Without this, a multi-word language was truncated to its first word and pushed
      // back as plain text, rewriting the block's language in Notion (#1737).
      const info = (codeMatch[2] ?? '').trim();
      const language = isNotionCodeLanguage(info.toLowerCase())
        ? info.toLowerCase()
        : info.split(/\s+/)[0] || 'plain text';
      const closeFence = new RegExp('^`{' + fence.length + ',}\\s*$');
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        const codeLine = lines[i];
        if (codeLine === undefined || closeFence.test(codeLine)) break;
        codeLines.push(codeLine);
        i++;
      }
      i++; // Skip closing fence
      // Caption: the builder emits `*caption*` immediately followed by a hidden
      // `%% n2o:cap %%` marker line. Require the marker so a user's plain italic
      // line right after a code block is NOT swallowed as a caption (#1515).
      let caption: string | undefined;
      if (i < lines.length) {
        const captionMatch = (lines[i] ?? '').match(/^\*([^*]+)\*\s*$/);
        if (captionMatch && CAPTION_MARKER_RE.test(lines[i + 1] ?? '')) {
          caption = captionMatch[1];
          i += 2; // Consume the caption line and its marker
        }
      }
      pushBlock({
        id: '',
        type: 'code',
        content: [{ text: codeLines.join('\n') }],
        meta: { kind: 'code', language, ...(caption ? { caption } : {}) },
      });
      continue;
    }

    // Equation block
    if (line.match(/^\$\$/)) {
      const trimmed = line.trim();
      // Same-line display equation ($$...$$ on one line). Detect this FIRST, or
      // the multi-line scan below treats the line as an opening delimiter and
      // swallows every following line up to the next standalone $$ (usually EOF),
      // then the push differ deletes all of it from Notion (#1502).
      if (trimmed.length > 4 && trimmed.endsWith('$$')) {
        pushBlock({
          id: '',
          type: 'equation',
          content: [],
          meta: { kind: 'equation', expression: trimmed.slice(2, -2).trim() },
        });
        i++;
        continue;
      }
      // Multi-line: opening $$ on its own line; scan to the closing $$.
      const eqLines: string[] = [];
      i++;
      while (i < lines.length) {
        const eqLine = lines[i];
        if (eqLine === undefined || eqLine.match(/^\$\$/)) break;
        eqLines.push(eqLine);
        i++;
      }
      i++; // skip closing $$
      pushBlock({
        id: '',
        type: 'equation',
        content: [],
        meta: { kind: 'equation', expression: eqLines.join('\n') },
      });
      continue;
    }

    // Table (lines starting with |)
    if (line.includes('|') && line.trim().startsWith('|')) {
      const tableRows: string[][] = [];
      let rawRowIdx = 0;
      while (i < lines.length) {
        const row = lines[i];
        if (row === undefined || !row.includes('|') || !row.trim().startsWith('|')) break;
        // The header separator is ALWAYS the second row (index 1) in a markdown
        // table. Only skip it there - testing every row dropped a legitimate
        // data row whose only cell was a dash/colon placeholder (#1513).
        // Matches alignment markers too (|:---|---:|:--:|).
        if (rawRowIdx === 1 && /^[|\s:-]+$/.test(row) && row.includes('-')) {
          rawRowIdx++;
          i++;
          continue;
        }
        rawRowIdx++;
        // Split on unescaped pipes only. Splitting on every '|' broke any cell
        // containing an escaped pipe (\|) into two cells, and the later
        // unescape could not recover the lost boundary.
        const cells = row
          .split(/(?<!\\)\|/)
          .slice(1, -1)
          .map((c) => c.trim().replace(/\\\|/g, '|'));
        tableRows.push(cells);
        i++;
      }
      if (tableRows.length > 0) {
        const tableChildren: N2OBlock[] = tableRows.map((cells) => ({
          id: '',
          type: 'tableRow',
          content: [],
          meta: {
            kind: 'tableRow' as const,
            cells: cells.map((c) => parseInlineMarkdown(c, inlineDeps)),
          },
        }));
        pushBlock({
          id: '',
          type: 'table',
          content: [],
          children: tableChildren,
          meta: {
            kind: 'table',
            width: tableRows[0]?.length ?? 0,
            hasColumnHeader: true,
            hasRowHeader: false,
          },
        });
      }
      continue;
    }

    // Blockquotes / Callouts
    if (line.startsWith('> ') || line === '>') {
      const calloutMatch = line.match(CALLOUT_REGEX);
      if (calloutMatch) {
        const calloutType = calloutMatch[1] ?? '';
        const foldChar = calloutMatch[2]; // optional group; its presence is the collapsible signal
        const title = calloutMatch[3] ?? '';
        const contentLines: string[] = [];
        i++;
        while (i < lines.length) {
          const quoteLine = lines[i];
          if (quoteLine === undefined || !(quoteLine.startsWith('> ') || quoteLine === '>')) break;
          contentLines.push(quoteLine.replace(/^> ?/, ''));
          i++;
        }

        // Check for inline metadata as first content line (new format: inside callout)
        // Skip for multi-column callouts - they never carry metadata and pendingMeta
        // would incorrectly apply to the columnList block.
        if (
          !pendingMeta &&
          contentLines.length > 0 &&
          calloutType !== 'multi-column' &&
          calloutType !== 'n2o-attachments'
        ) {
          const inlineMeta = (contentLines[0] ?? '').match(
            /^(?:<!-- n2o:(\{.*\}) -->|%% n2o:(\{.*\}) %%)\s*$/,
          );
          if (inlineMeta) {
            try {
              const raw = JSON.parse(inlineMeta[1] ?? inlineMeta[2] ?? '{}') as {
                id?: string;
                type?: string;
                color?: string;
                icon?: string;
                widthRatio?: number;
              };
              if (raw.type && !VALID_BLOCK_TYPES.has(raw.type)) {
                log.warn(`Invalid block type in metadata comment: ${raw.type}`);
                raw.type = undefined;
              }
              if (raw.color && !VALID_COLORS.has(raw.color)) {
                log.warn(`Invalid color in metadata comment: ${raw.color}`);
                raw.color = undefined;
              }
              if (raw.id && !/^[\w-]+$/.test(raw.id)) {
                log.warn(`Invalid block ID in metadata comment: ${raw.id}`);
                raw.id = undefined;
              }
              // Validate icon: allow emojis (short), Notion external URLs (https://),
              // and built-in icon names (e.g. "star", "check-circle" - up to 32 chars).
              if (raw.icon && raw.icon.length > 32 && !raw.icon.startsWith('https://')) {
                log.warn(`Invalid icon in metadata comment: too long`);
                raw.icon = undefined;
              }
              pendingMeta = raw;
              contentLines.shift();
            } catch {
              // Invalid JSON - skip
            }
          }
        }

        // Multi-column callout -> columnList with column children
        if (calloutType === 'multi-column') {
          const innerBlocks =
            contentLines.length > 0 ? parseMarkdownToBlocks(contentLines.join('\n'), deps) : [];
          const columns: N2OBlock[] = [];
          let currentNonCalloutBlocks: N2OBlock[] = [];
          for (const child of innerBlocks) {
            if (child.type === 'callout') {
              if (currentNonCalloutBlocks.length > 0) {
                columns.push({
                  id: '',
                  type: 'column',
                  content: [],
                  children: currentNonCalloutBlocks,
                  meta: { kind: 'column' },
                });
                currentNonCalloutBlocks = [];
              }
              // Carry widthRatio from callout metadata (set by inline metadata comment)
              const childRaw = child.meta as unknown as Record<string, unknown>;
              const colWidthRatio =
                typeof childRaw.widthRatio === 'number' ? childRaw.widthRatio : undefined;
              columns.push({
                id: child.id || '',
                type: 'column',
                content: [],
                children: child.children ?? [],
                meta: {
                  kind: 'column',
                  title: child.content.map((c) => c.text).join(''),
                  calloutType: child.meta.kind === 'callout' ? child.meta.calloutType : 'column',
                  ...(colWidthRatio ? { widthRatio: colWidthRatio } : {}),
                },
              });
            } else {
              currentNonCalloutBlocks.push(child);
            }
          }
          if (currentNonCalloutBlocks.length > 0) {
            columns.push({
              id: '',
              type: 'column',
              content: [],
              children: currentNonCalloutBlocks,
              meta: { kind: 'column' },
            });
          }
          pushBlock({
            id: '',
            type: 'columnList',
            content: [],
            children: columns.length >= 2 ? columns : undefined,
            meta: { kind: 'columnList' },
          });
          continue;
        }

        // Toggle heading callout (heading-1 through heading-4) -> heading block
        const headingCalloutMatch = calloutType.match(/^heading-([1234])$/);
        if (headingCalloutMatch) {
          const level = parseInt(headingCalloutMatch[1] ?? '1', 10) as 1 | 2 | 3 | 4;
          pushBlock({
            id: '',
            type: `heading${level}`,
            content: parseInlineMarkdown(title, inlineDeps),
            children:
              contentLines.length > 0
                ? parseMarkdownToBlocks(contentLines.join('\n'), deps)
                : undefined,
            meta: { kind: 'heading', level, isToggleable: true },
          });
          continue;
        }

        // Dedicated toggle callout -> toggle block (the renderer emits
        // `> [!toggle]-` for Notion toggle blocks; legacy files carry
        // `> [!info]` plus a type:"toggle" meta comment, which the
        // pendingMeta type override still maps). calloutType stays in the
        // meta so a re-render emits [!toggle] again.
        if (calloutType === 'toggle') {
          pushBlock({
            id: '',
            type: 'toggle',
            content: parseInlineMarkdown(title, inlineDeps),
            children:
              contentLines.length > 0
                ? parseMarkdownToBlocks(contentLines.join('\n'), deps)
                : undefined,
            meta: {
              kind: 'callout',
              calloutType: 'toggle',
              collapsible: true,
              defaultOpen: foldChar === '+',
            },
          });
          continue;
        }

        // n2o-attachments callout -> unwrap into individual file/pdf blocks
        if (calloutType === 'n2o-attachments') {
          const innerBlocks =
            contentLines.length > 0 ? parseMarkdownToBlocks(contentLines.join('\n'), deps) : [];
          for (const inner of innerBlocks) {
            pushBlock(inner);
          }
          continue;
        }

        pushBlock({
          id: '',
          type: 'callout',
          content: parseInlineMarkdown(title, inlineDeps),
          children:
            contentLines.length > 0
              ? parseMarkdownToBlocks(contentLines.join('\n'), deps)
              : undefined,
          meta: {
            kind: 'callout',
            calloutType,
            icon: CALLOUT_TYPE_TO_EMOJI[calloutType],
            collapsible: foldChar !== undefined,
            defaultOpen: foldChar === '+',
          },
        });
        continue;
      }

      // Regular blockquote
      const quoteLines: string[] = [line.replace(/^> ?/, '')];
      i++;
      while (i < lines.length) {
        const quoteLine = lines[i];
        if (quoteLine === undefined || !(quoteLine.startsWith('> ') || quoteLine === '>')) break;
        quoteLines.push(quoteLine.replace(/^> ?/, ''));
        i++;
      }
      pushBlock({
        id: '',
        type: 'quote',
        content: parseInlineMarkdown(quoteLines.join('\n'), inlineDeps),
        meta: { kind: 'empty' },
      });
      continue;
    }

    // Task lists (with nested children)
    const todoMatch = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.*)/);
    if (todoMatch) {
      const children = collectNestedListItems(
        lines,
        i + 1,
        (todoMatch[1] ?? '').length,
        0,
        inlineDeps,
      );
      pushBlock({
        id: '',
        type: 'todo',
        content: parseInlineMarkdown(todoMatch[3] ?? '', inlineDeps),
        children: children.items.length > 0 ? children.items : undefined,
        meta: { kind: 'todo', checked: todoMatch[2] !== ' ' },
      });
      i = children.nextIndex;
      continue;
    }

    // Bullet lists (with nested children)
    const bulletMatch = line.match(/^([-*+])\s+(.*)/);
    if (bulletMatch) {
      const children = collectNestedListItems(lines, i + 1, 0, 0, inlineDeps);
      pushBlock({
        id: '',
        type: 'bulletList',
        content: parseInlineMarkdown(bulletMatch[2] ?? '', inlineDeps),
        children: children.items.length > 0 ? children.items : undefined,
        meta: { kind: 'empty' },
      });
      i = children.nextIndex;
      continue;
    }

    // Numbered lists (capture start number for round-trip fidelity)
    const numMatch = line.match(/^(\d+)\.\s+(.*)/);
    if (numMatch) {
      const startNum = parseInt(numMatch[1] ?? '1', 10);
      const children = collectNestedListItems(lines, i + 1, 0, 0, inlineDeps);
      /* F-038: always set kind='numberedList' so the meta-comment-driven
       * listFormat hint has a place to land. Previously kind='empty' was
       * used for default lists, which caused pushBlock to drop pendingMeta
       * fields (listFormat, etc.) that target the numberedList kind. */
      const nlMeta: { kind: 'numberedList'; startIndex?: number } = { kind: 'numberedList' };
      if (startNum > 1) nlMeta.startIndex = startNum;
      pushBlock({
        id: '',
        type: 'numberedList',
        content: parseInlineMarkdown(numMatch[2] ?? '', inlineDeps),
        children: children.items.length > 0 ? children.items : undefined,
        meta: nlMeta,
      });
      i = children.nextIndex;
      continue;
    }

    // Embed: ![[filename]] or ![[filename|width]] - images vs note transclusions.
    //
    // Greedy match up to the LAST `]]` so filenames that happen to contain
    // inner square brackets (e.g. screenshots auto-named from a torrent
    // source like `foo[EZTVx.to].mkv - VLC.png`) still parse as an embed.
    // The previous regex used a `[^\]|]` character class that stopped at
    // the first `]`, so any such embed fell through to plain-text paragraph
    // and then got pushed to Notion verbatim as the literal wikilink.
    // After capturing the inner contents, split on the LAST `|` to isolate
    // the optional `|width` suffix - Obsidian's forbidden-char list bans
    // `|` in filenames so the last pipe is always the width separator.
    const embedMatch = line.match(/^!\[\[(.+)\]\]\s*$/);
    if (embedMatch) {
      const inner = embedMatch[1] ?? '';
      const pipeIdx = inner.lastIndexOf('|');
      const target = pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner;
      const widthStr = pipeIdx >= 0 ? inner.slice(pipeIdx + 1) : undefined;
      const isMedia = hasMediaExtension(target);
      if (isMedia) {
        const ext = target.split('.').pop()?.toLowerCase() ?? '';
        const blockType = EXT_TO_BLOCK_TYPE[ext] ?? 'file';
        const parsedWidth = widthStr ? parseInt(widthStr, 10) : NaN;
        // Consume an optional `*caption*` on the next line. The builder
        // renders captioned media as `![[file]]` then `*caption*`; if we do
        // not pull it back into the image block it parses as a separate
        // italic paragraph, making the round-trip asymmetric - pull output
        // never equals parse input, so with auto-sync on the change detector
        // never settles and loops, which can hang/crash Obsidian.
        // Require the hidden `%% n2o:cap %%` marker (emitted right after the
        // caption by the builder) so a user's plain italic line after an embed
        // is not swallowed as a caption (#1515).
        let mediaCaption: string | undefined;
        const mediaCapMatch = lines[i + 1]?.match(/^\*([^*]+)\*\s*$/);
        if (mediaCapMatch && CAPTION_MARKER_RE.test(lines[i + 2] ?? '')) {
          mediaCaption = mediaCapMatch[1];
          i += 2; // Consume the caption line and its marker (embed advanced below)
        }
        const block: N2OBlock = {
          id: '',
          type: blockType,
          content: [],
          meta: {
            kind: 'image',
            url: target,
            sourceType: 'local',
            ...(mediaCaption ? { caption: mediaCaption } : {}),
          },
        };
        // Preserve image width for push round-trip
        if (!isNaN(parsedWidth) && parsedWidth > 0) {
          block.format = { blockWidth: parsedWidth };
        }
        pushBlock(block);
      } else {
        // Note transclusion - maps to Notion page link (embed)
        const cleanTarget = target.split('#')[0] ?? ''; // Strip heading anchor
        // .base embeds are database views -> databaseLink block
        const isBase = cleanTarget.endsWith('.base');
        const resolveTarget = isBase ? cleanTarget.slice(0, -5) : cleanTarget;
        const { notionId, updatedCache } = resolveWikilinkToNotionId(
          resolveTarget,
          deps.syncState,
          deps.resolveCache,
        );
        deps.updateResolveCache(updatedCache);
        pushBlock({
          id: '',
          type: isBase ? 'databaseLink' : 'pageLink',
          content: [{ text: target }],
          meta: {
            kind: 'pageLink',
            pageId: notionId ?? '',
            pageName: resolveTarget,
            isEmbed: true,
          },
        });
      }
      i++;
      continue;
    }

    // External image/video/audio: ![alt](url)
    const extImgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (extImgMatch) {
      const extUrl = extImgMatch[2] ?? '';
      // Sniff extension from URL (strip query params first)
      const urlPath = extUrl.split('?')[0] ?? '';
      const urlExt = urlPath.split('.').pop()?.toLowerCase() ?? '';
      const sniffedType = EXT_TO_BLOCK_TYPE[urlExt] ?? 'image';
      // Detect YouTube URLs -> video
      const isYouTube = /(?:youtube\.com\/(?:watch|embed)|youtu\.be\/)/i.test(extUrl);
      const blockType = isYouTube ? 'video' : sniffedType;
      // A captioned media embed carries `*caption*` + the hidden marker on the
      // next lines (#1679); alt text is the legacy form and still parses.
      let extCaption = extImgMatch[1] || undefined;
      const extCapMatch = lines[i + 1]?.match(/^\*([^*]+)\*\s*$/);
      if (extCapMatch && CAPTION_MARKER_RE.test(lines[i + 2] ?? '')) {
        extCaption = extCapMatch[1];
        i += 2;
      }
      pushBlock({
        id: '',
        type: blockType,
        content: [],
        meta: {
          kind: 'image',
          url: extUrl,
          caption: extCaption,
          sourceType: 'external',
        },
      });
      i++;
      continue;
    }

    // Iframe embed: <iframe src="url" ... title="caption"></iframe>. Attributes are
    // read BY NAME, not by position, so a `sandbox="..."` between src and title
    // (added for #1704) does not drop the caption on round-trip.
    const iframeMatch =
      line.match(/^<iframe\s+[^>]*><\/iframe>\s*$/) && line.includes(' src="') ? line : null;
    if (iframeMatch) {
      const iframeSrc = iframeMatch.match(/\bsrc="([^"]*)"/)?.[1] ?? '';
      // Captioned iframes carry `*caption*` + the hidden marker below (#1679).
      let iframeCaption = iframeMatch.match(/\btitle="([^"]*)"/)?.[1] || undefined;
      const iframeCapMatch = lines[i + 1]?.match(/^\*([^*]+)\*\s*$/);
      if (iframeCapMatch && CAPTION_MARKER_RE.test(lines[i + 2] ?? '')) {
        iframeCaption = iframeCapMatch[1];
        i += 2;
      }
      pushBlock({
        id: '',
        type: 'embed',
        content: [],
        meta: {
          kind: 'bookmark',
          url: iframeSrc,
          title: iframeCaption,
        },
      });
      i++;
      continue;
    }

    // Wikilink on its own line
    const wikilinkLineMatch = line.match(/^\[\[([^\]]+)\]\]\s*$/);
    if (wikilinkLineMatch) {
      const target = (wikilinkLineMatch[1] ?? '').split('|')[0] ?? '';

      // Check if the target has a media file extension (e.g. [[file.pdf]])
      const mediaExtMatch = hasMediaExtension(target);
      if (mediaExtMatch) {
        const ext = target.split('.').pop()?.toLowerCase() ?? '';
        const blockType = EXT_TO_BLOCK_TYPE[ext] ?? 'file';
        pushBlock({
          id: '',
          type: blockType,
          content: [],
          meta: {
            kind: 'image',
            url: target,
            sourceType: 'local',
          },
        });
        i++;
        continue;
      }

      // .base links are database references -> databaseLink block
      const isBase = target.endsWith('.base');
      const resolveTarget = isBase ? target.slice(0, -5) : target;
      // Strip a #heading / #^block anchor before resolving (#1510) - the link is
      // to the page, the anchor only refines it. Resolving "Page#Section"
      // verbatim never matched, dropping the Notion page link.
      const hashIdx = resolveTarget.indexOf('#');
      const pageName = hashIdx >= 0 ? resolveTarget.slice(0, hashIdx) : resolveTarget;
      const { notionId, updatedCache } = pageName
        ? resolveWikilinkToNotionId(pageName, deps.syncState, deps.resolveCache)
        : { notionId: undefined, updatedCache: deps.resolveCache };
      deps.updateResolveCache(updatedCache);
      pushBlock({
        id: '',
        type: isBase ? 'databaseLink' : 'pageLink',
        content: [{ text: target }],
        meta: {
          kind: 'pageLink',
          pageId: notionId ?? '',
          pageName,
        },
      });
      i++;
      continue;
    }

    // N2O bookmark HTML card: <div class="n2o-bookmark"><a href="...">...</a>...</div>
    const bookmarkHtmlMatch = line.match(/<div class="n2o-bookmark"><a href="([^"]+)">/);
    if (bookmarkHtmlMatch) {
      const bmUrl = (bookmarkHtmlMatch[1] ?? '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"');
      const titleMatch = line.match(/n2o-bookmark-title">([^<]*)</);
      const descMatch = line.match(/n2o-bookmark-desc">([^<]*)</);
      const captionMatch = line.match(/n2o-bookmark-caption">([^<]*)</);
      const unescape = (s: string | undefined) =>
        s
          ?.replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"');
      const bmTitle = unescape(titleMatch?.[1]);
      const bmDesc = unescape(descMatch?.[1]);
      const bmCaption = unescape(captionMatch?.[1]);
      pushBlock({
        id: '',
        type: 'bookmark',
        content: [{ text: bmTitle || bmUrl }],
        meta: {
          kind: 'bookmark',
          url: bmUrl,
          title: bmTitle || undefined,
          description: bmDesc || undefined,
          caption: bmCaption || undefined,
        },
      });
      // Skip any following blank lines from the HTML block
      i++;
      while (i < lines.length && (lines[i] ?? '').trim() === '') i++;
      continue;
    }

    // Bookmark / link on its own line: [title](url)
    const linkLineMatch = line.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)\s*$/);
    if (linkLineMatch) {
      pushBlock({
        id: '',
        type: 'bookmark',
        content: [{ text: linkLineMatch[1] ?? '' }],
        meta: {
          kind: 'bookmark',
          url: linkLineMatch[2] ?? '',
          title: linkLineMatch[1],
        },
      });
      i++;
      continue;
    }

    // Raw block-level HTML line. A line that starts with a block HTML tag
    // (<details>, <div>, a multiline <table>, ...) would be chewed by the inline
    // parser - its < and > split into stray segments and the markup breaks on
    // push. Emit it as a single raw text segment so it round-trips verbatim
    // (#1588). Inline formatting tags (u/mark/span) and the n2o bookmark div are
    // handled by their own branches above, so they don't reach here.
    if (
      /^<\/?(?:details|summary|div|section|article|aside|figure|figcaption|table|thead|tbody|tfoot|tr|td|th|blockquote|pre|hr|br|iframe|video|audio|picture|col|colgroup|caption)\b[^>]*>?/i.test(
        line.trim(),
      )
    ) {
      pushBlock({
        id: '',
        type: 'paragraph',
        content: [{ text: line }],
        meta: { kind: 'paragraph' },
      });
      i++;
      continue;
    }

    // Default: paragraph (collect consecutive non-special lines)
    pushBlock({
      id: '',
      type: 'paragraph',
      content: parseInlineMarkdown(line, inlineDeps),
      meta: { kind: 'paragraph' },
    });
    i++;
  }

  return blocks;
}

/**
 * Collect nested list items at deeper indentation levels.
 */
function collectNestedListItems(
  lines: string[],
  startIdx: number,
  parentIndent: number,
  depth: number,
  inlineDeps: InlineParserDeps,
): { items: N2OBlock[]; nextIndex: number } {
  const items: N2OBlock[] = [];
  let i = startIdx;
  const maxDepth = 6; // Notion supports up to ~6 nesting levels

  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break; // bounds-safe (noUncheckedIndexedAccess)
    if (line.trim() === '') {
      // Blank lines terminate nesting. Notion rarely produces blank lines
      // within list items, so this is an acceptable limitation. Peeking
      // ahead to determine continuation would risk breaking edge cases.
      i++;
      break;
    }

    const indentMatch = line.match(/^(\s+)/);
    const indent = indentMatch ? (indentMatch[1] ?? '').length : 0;
    if (indent <= parentIndent) break;

    // Nested to-do. MUST precede the bullet branch: "- [x] task" also matches the
    // nested-bullet regex, which would strip the checkbox and leave "[x] task" as
    // literal bullet text (#1505). Mirrors the top-level to-do handling.
    const todoMatch = line.match(/^\s+[-*]\s+\[([ xX])\]\s+(.*)/);
    if (todoMatch) {
      const block: N2OBlock = {
        id: '',
        type: 'todo',
        content: parseInlineMarkdown(todoMatch[2] ?? '', inlineDeps),
        meta: { kind: 'todo', checked: todoMatch[1] !== ' ' },
      };
      i++;
      if (depth < maxDepth) {
        const children = collectNestedListItems(lines, i, indent, depth + 1, inlineDeps);
        if (children.items.length > 0) {
          block.children = children.items;
        }
        i = children.nextIndex;
      }
      items.push(block);
      continue;
    }

    // Nested bullet
    const bulletMatch = line.match(/^\s+[-*+]\s+(.*)/);
    if (bulletMatch) {
      const block: N2OBlock = {
        id: '',
        type: 'bulletList',
        content: parseInlineMarkdown(bulletMatch[1] ?? '', inlineDeps),
        meta: { kind: 'empty' },
      };
      i++;
      // Recursively collect deeper-nested children
      if (depth < maxDepth) {
        const children = collectNestedListItems(lines, i, indent, depth + 1, inlineDeps);
        if (children.items.length > 0) {
          block.children = children.items;
        }
        i = children.nextIndex;
      }
      items.push(block);
      continue;
    }

    // Nested numbered
    const numMatch = line.match(/^\s+\d+\.\s+(.*)/);
    if (numMatch) {
      const block: N2OBlock = {
        id: '',
        type: 'numberedList',
        // F-038: kind must be 'numberedList' (not 'empty') so the meta-comment
        // listFormat hint can land on nested items too - the top-level numbered
        // list already does this; the nested branch was missed.
        content: parseInlineMarkdown(numMatch[1] ?? '', inlineDeps),
        meta: { kind: 'numberedList' },
      };
      i++;
      // Recursively collect deeper-nested children
      if (depth < maxDepth) {
        const children = collectNestedListItems(lines, i, indent, depth + 1, inlineDeps);
        if (children.items.length > 0) {
          block.children = children.items;
        }
        i = children.nextIndex;
      }
      items.push(block);
      continue;
    }

    break;
  }

  return { items, nextIndex: i };
}
