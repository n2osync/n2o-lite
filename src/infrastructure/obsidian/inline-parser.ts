/**
 * Inline markdown parser - parses inline formatting into N2ORichText segments.
 * Handles bold, italic, code, strikethrough, links, highlights, wikilinks, equations, etc.
 * Extracted from ObsidianParser for modularity.
 */

import type { N2ORichText } from '../../domain/models/block';
import type { SyncStateDB } from '../storage/sync-state';
import { resolveWikilinkToNotionId } from './wikilink-resolver';
import type { PathMapping } from './wikilink-resolver';
import { classToNotionColor } from '../../shared/notion-color-palette';

/** Maximum line length for inline markdown parsing (ReDoS guard). */
const MAX_INLINE_LENGTH = 10_000;

/** Dependencies needed for inline parsing (wikilink resolution). */
export interface InlineParserDeps {
  syncState: SyncStateDB | null;
  resolveCache: PathMapping[] | null;
  updateResolveCache: (cache: PathMapping[] | null) => void;
}

/**
 * Parse inline markdown (bold, italic, code, links, wikilinks, etc.) into rich text segments.
 */
export function parseInlineMarkdown(text: string, deps: InlineParserDeps): N2ORichText[] {
  if (!text) return [{ text: '' }];

  // Skip regex parsing for extremely long lines to prevent ReDoS
  if (text.length > MAX_INLINE_LENGTH) {
    return [{ text }];
  }

  const segments: N2ORichText[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Bold + Italic (***text***) - recursively parse inner text
    let match = remaining.match(/^\*\*\*(.+?)\*\*\*/);
    if (match) {
      for (const child of parseInlineMarkdown(match[1] ?? '', deps)) {
        segments.push({ ...child, bold: true, italic: true });
      }
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Bold (**text**) - recursively parse inner text
    match = remaining.match(/^\*\*(.+?)\*\*/);
    if (match) {
      for (const child of parseInlineMarkdown(match[1] ?? '', deps)) {
        segments.push({ ...child, bold: true });
      }
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Italic (*text*) - recursively parse inner text
    match = remaining.match(/^\*([^*]+?)\*/);
    if (match) {
      for (const child of parseInlineMarkdown(match[1] ?? '', deps)) {
        segments.push({ ...child, italic: true });
      }
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Strikethrough (~~text~~) - recursively parse inner text
    match = remaining.match(/^~~(.+?)~~/);
    if (match) {
      for (const child of parseInlineMarkdown(match[1] ?? '', deps)) {
        segments.push({ ...child, strikethrough: true });
      }
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Inline code (`text`)
    match = remaining.match(/^`([^`]+)`/);
    if (match) {
      segments.push({ text: match[1] ?? '', code: true });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Link-mention chip (#1724): `<a href="URL" class="n2o-link-mention">...</a>`.
    // Display-only, rebuilt from Notion's official link_mention on every pull, so
    // round-trip it as a plain link - push never sends the literal chip HTML.
    match = remaining.match(/^<a href="([^"]*)" class="n2o-link-mention">.*?<\/a>/);
    if (match) {
      const href = (match[1] ?? '')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
      segments.push({ text: href, link: href });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Underline (<u>text</u>) - recursively parse inner text
    match = remaining.match(/^<u>(.+?)<\/u>/);
    if (match) {
      for (const child of parseInlineMarkdown(match[1] ?? '', deps)) {
        segments.push({ ...child, underline: true });
      }
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Highlight with Notion class (<mark class="n2o-bg-COLOR">text</mark>).
    // Unknown classes fall through to yellow_background so the wrapper is
    // still consumed (otherwise the parser would chew character-by-character).
    // Color precedence: inner annotation wins over outer (child.color ?? outer).
    match = remaining.match(/^<mark\s+class="([^"]+)">(.+?)<\/mark>/);
    if (match) {
      const color = classToNotionColor(match[1] ?? '') ?? 'yellow_background';
      for (const child of parseInlineMarkdown(match[2] ?? '', deps)) {
        segments.push({ ...child, color: child.color ?? color });
      }
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Highlight without class (<mark>text</mark>) - default yellow
    match = remaining.match(/^<mark>(.+?)<\/mark>/);
    if (match) {
      for (const child of parseInlineMarkdown(match[1] ?? '', deps)) {
        segments.push({ ...child, color: child.color ?? 'yellow_background' });
      }
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Colored text via Notion class (<span class="n2o-fg-COLOR">text</span>).
    // Unknown classes consume the wrapper without applying a color.
    match = remaining.match(/^<span\s+class="([^"]+)">(.+?)<\/span>/);
    if (match) {
      const color = classToNotionColor(match[1] ?? '');
      for (const child of parseInlineMarkdown(match[2] ?? '', deps)) {
        segments.push(color ? { ...child, color: child.color ?? color } : child);
      }
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Inline equation ($expr$). Only treat a dollar span as math when it looks
    // like math, not currency (#1509): the content must have non-space
    // boundaries (so "$5 and $10" doesn't capture "5 and " as an equation) and
    // the closing $ must not be immediately followed by a digit (which would be
    // the start of another currency amount). Standard markdown-it math heuristic.
    match = remaining.match(/^\$([^$\s](?:[^$]*[^$\s])?)\$(?!\d)/);
    if (match) {
      {
        const eq = match[1] ?? '';
        segments.push({ text: eq, equation: eq });
      }
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Wikilink: [[target|alias]] or [[target]]
    match = remaining.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
    if (match) {
      const target = match[1] ?? '';
      const alias = match[2];
      // .base links are database references
      const isBase = target.endsWith('.base');
      const resolveTarget = isBase ? target.slice(0, -5) : target;
      // Strip a #heading / #^block anchor before resolving: the link points at a
      // page (the file), the anchor only refines it. Resolving "Page#Section"
      // verbatim never matched a filename, so an anchored link silently
      // degraded to a plain link and dropped the Notion relation (#1510). The
      // transclusion path already strips it; do the same here.
      const hashIdx = resolveTarget.indexOf('#');
      const pageName = hashIdx >= 0 ? resolveTarget.slice(0, hashIdx) : resolveTarget;
      const { notionId, updatedCache } = pageName
        ? resolveWikilinkToNotionId(pageName, deps.syncState, deps.resolveCache)
        : { notionId: undefined, updatedCache: deps.resolveCache };
      deps.updateResolveCache(updatedCache);
      segments.push({
        text: alias ?? resolveTarget, // keep the anchor in the visible text
        mention: notionId
          ? { type: isBase ? 'database' : 'page', id: notionId, name: pageName }
          : undefined,
        link: !notionId ? target : undefined,
      });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Markdown link: [text](url)
    match = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (match) {
      segments.push({ text: match[1] ?? '', link: match[2] ?? '' });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Highlight (==text==) - maps to Notion yellow highlight, recursively parse inner
    match = remaining.match(/^==(.+?)==/);
    if (match) {
      for (const child of parseInlineMarkdown(match[1] ?? '', deps)) {
        segments.push({ ...child, color: child.color ?? 'yellow_background' });
      }
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Backslash-escaped ASCII punctuation: emit the unescaped character as plain
    // text so the escape actually SUPPRESSES formatting (\* is a literal *, not
    // the start of italic) and the backslash does not survive to Notion (#1511).
    // A backslash before a non-punctuation char stays literal (CommonMark).
    if (
      remaining[0] === '\\' &&
      remaining.length > 1 &&
      /[!-/:-@[-`{-~]/.test(remaining[1] ?? '')
    ) {
      segments.push({ text: remaining[1] ?? '' });
      remaining = remaining.slice(2);
      continue;
    }

    // Plain text - consume until next special character (backslash included so
    // lone backslashes are consumed in bulk rather than one char at a time)
    match = remaining.match(/^[^*~`<[!=$\\]+/);
    if (match) {
      segments.push({ text: match[0] });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Single special character that didn't match a pattern
    segments.push({ text: remaining[0] ?? '' });
    remaining = remaining.slice(1);
  }

  return mergeSegments(segments);
}

/**
 * Merge adjacent plain-text segments.
 */
export function mergeSegments(segments: N2ORichText[]): N2ORichText[] {
  const merged: N2ORichText[] = [];
  for (const seg of segments) {
    const prev = merged[merged.length - 1];
    const isPlain = (s: N2ORichText) =>
      !s.bold &&
      !s.italic &&
      !s.strikethrough &&
      !s.underline &&
      !s.code &&
      !s.link &&
      !s.mention &&
      !s.color &&
      !s.equation;
    if (prev && isPlain(prev) && isPlain(seg)) {
      prev.text += seg.text;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}
