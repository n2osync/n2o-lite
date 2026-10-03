/**
 * ObsidianParser - Converts Obsidian Markdown into N2ODocument format.
 * Handles frontmatter, wikilinks, callouts, tables, images, and all Obsidian-flavored markdown.
 * Used for bidirectional push (Obsidian -> Notion).
 *
 * Delegates to focused sub-modules:
 * - block-parser.ts - block-level markdown parsing
 * - inline-parser.ts - inline formatting parsing
 * - frontmatter-parser.ts - YAML frontmatter and property extraction
 * - wikilink-resolver.ts - wikilink resolution and color mapping
 */

import type { N2ODocument, N2ODocumentMetadata } from '../../domain/models/document';
import type { N2OBlock, N2ORichText } from '../../domain/models/block';
import type { SyncStateDB } from '../storage/sync-state';
import { createLogger } from '../../shared/logger';
import { N2OError } from '../../shared/errors';
import { normalizeLineEndings } from '../../shared/sanitize';
import { parseMarkdownToBlocks } from './block-parser';
import { parseInlineMarkdown } from './inline-parser';
import type { InlineParserDeps } from './inline-parser';
import {
  parseSimpleYaml,
  parseFrontmatterToProperties,
  extractTitle,
  normalizeIcon,
} from './frontmatter-parser';
import type { PathMapping } from './wikilink-resolver';

const log = createLogger('ObsidianParser');

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---(?:\n|$)/;

export class ObsidianParser {
  private syncState: SyncStateDB | null = null;
  /** Cached records for wikilink resolution - populated once per parse call. */
  private resolveCache: PathMapping[] | null = null;

  /**
   * Set sync state DB for resolving wikilinks to Notion page IDs.
   */
  setSyncState(db: SyncStateDB): void {
    this.syncState = db;
  }

  /**
   * Parse an Obsidian markdown file into an N2ODocument.
   *
   * Throws `N2OError('PARSE_ERROR', ...)` when frontmatter is present
   * but its YAML can't be parsed. Callers MUST catch this and stop:
   * treating a doc whose frontmatter went missing as valid strips
   * notion_id and produces a duplicate page on the next sync.
   */
  parse(content: string, filePath: string): N2ODocument {
    // Clear per-parse caches
    this.resolveCache = null;

    // Normalize line endings for cross-platform compatibility (CRLF -> LF)
    const normalized = normalizeLineEndings(content);
    const { frontmatter, body } = this.splitFrontmatter(normalized, filePath);
    const deps = this.makeDeps();
    const properties = parseFrontmatterToProperties(frontmatter, deps);
    const blocks = parseMarkdownToBlocks(body, deps);

    const title = extractTitle(filePath, frontmatter);

    const metadata: N2ODocumentMetadata = {
      createdTime: (frontmatter?.created as string) ?? '',
      lastEditedTime: (frontmatter?.['updated'] as string) ?? '',
      type:
        frontmatter?.n2o_type === 'database'
          ? 'database'
          : frontmatter?.n2o_type === 'database-item'
            ? 'database-item'
            : 'page',
      notionUrl: typeof frontmatter?.notion_url === 'string' ? frontmatter.notion_url : undefined,
      parentDatabaseId:
        typeof frontmatter?.n2o_database === 'string' ? frontmatter.n2o_database : undefined,
      parentId:
        typeof frontmatter?.n2o_parent_id === 'string' ? frontmatter.n2o_parent_id : undefined,
      parentType:
        frontmatter?.n2o_parent_type === 'database' || frontmatter?.n2o_parent_type === 'page'
          ? frontmatter.n2o_parent_type
          : undefined,
    };

    return {
      id: '',
      notionId: frontmatter?.notion_id as string,
      obsidianPath: filePath,
      title,
      properties,
      blocks,
      children: [],
      attachments: [],
      metadata,
      icon: normalizeIcon(frontmatter?.icon as string),
      banner: (frontmatter?.banner ?? frontmatter?.cover) as string,
      bannerOriginal: (frontmatter?.bannerOriginal ?? frontmatter?.coverOriginal) as string,
    };
  }

  /**
   * Split file content into frontmatter and body.
   */
  splitFrontmatter(
    content: string,
    filePath?: string,
  ): {
    frontmatter: Record<string, unknown> | null;
    body: string;
  } {
    // Limit frontmatter search to first 50KB to prevent regex backtracking on unclosed ---
    const searchRegion = content.length > 50_000 ? content.substring(0, 50_000) : content;
    const match = searchRegion.match(FRONTMATTER_REGEX);
    if (!match) {
      return { frontmatter: null, body: content };
    }

    try {
      const yamlStr = match[1] ?? '';
      const frontmatter = parseSimpleYaml(yamlStr);
      // parseSimpleYaml is pure regex and never throws, so the catch below is a
      // dead backstop on its own. Actively detect the corruption it silently
      // tolerates: a notion_id line IS present in the raw frontmatter but did not
      // parse into a value (broken quoting/indentation around the key). Left
      // unhandled this drops notion_id and the push treats the file as new,
      // creating a DUPLICATE Notion page - the exact failure this guard exists to
      // prevent (#1507). Throw so the push aborts while the id is still on disk.
      if (/^\s*notion_id\s*:/m.test(yamlStr) && !frontmatter.notion_id) {
        throw new Error('notion_id line present but did not parse to a value');
      }
      const body = content.substring(match[0].length).trim();
      return { frontmatter, body };
    } catch (err) {
      // Distinguish "no frontmatter" (handled above) from "had frontmatter
      // but YAML invalid". Pre-fix both returned null and the push silently
      // stripped notion_id metadata, creating a duplicate on the next sync.
      // Throwing forces the push pipeline to abort while the user still
      // owns their notion_id in the on-disk file.
      const detail = err instanceof Error ? err.message : String(err);
      const where = filePath ? `"${filePath}"` : 'document';
      log.warn(`Failed to parse frontmatter in ${where}: ${detail}`);
      throw new N2OError(`Frontmatter YAML is invalid in ${where}: ${detail}`, 'PARSE_ERROR');
    }
  }

  /**
   * Parse markdown body into N2OBlocks.
   * Delegates to the standalone parseMarkdownToBlocks function.
   */
  parseMarkdownToBlocks(markdown: string): N2OBlock[] {
    return parseMarkdownToBlocks(markdown, this.makeDeps());
  }

  /**
   * Parse inline markdown into rich text segments.
   * Delegates to the standalone parseInlineMarkdown function.
   */
  parseInlineMarkdown(text: string): N2ORichText[] {
    return parseInlineMarkdown(text, this.makeDeps());
  }

  /**
   * Build the dependency object that sub-parsers need for wikilink resolution.
   * The resolve cache is shared across the parse call via closure.
   */
  private makeDeps(): InlineParserDeps {
    return {
      syncState: this.syncState,
      resolveCache: this.resolveCache,
      updateResolveCache: (cache: PathMapping[] | null) => {
        this.resolveCache = cache;
      },
    };
  }
}
