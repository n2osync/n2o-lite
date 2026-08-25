/**
 * ObsidianBuilder - Converts N2ODocument format into Obsidian Markdown.
 *
 * Delegates to focused sub-modules:
 * - block-renderer.ts - renderBlock() with the block-type switch
 * - inline-renderer.ts - renderRichText() with annotation handling
 * - frontmatter-builder.ts - buildFrontmatter() with icon/banner/tags
 * - property-renderer.ts - buildFrontmatterProperty() with value formatting
 * - yaml-formatter.ts - needsYamlQuoting(), formatDateHuman()
 */

import type { N2ODocument } from '../../domain/models/document';
import type { N2OBlock, N2ORichText } from '../../domain/models/block';
import type { PageRegistryReader } from '../../domain/models/page-registry';
import type { PropertyMapping } from '../../domain/models/sync-config';
import { createLogger } from '../../shared/logger';
import {
  renderBlock,
  collectHeadings,
  type BlockRenderContext,
  type DocumentHeading,
} from './block-renderer';
import { renderRichText } from './inline-renderer';
import { buildFrontmatter } from './frontmatter-builder';
import { formatMediaValue } from './property-renderer';
import { escapeYamlString } from '../../shared/yaml';

const log = createLogger('ObsidianBuilder');

/** Image file extensions for detecting embeddable files in `files` properties. */
const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico',
  '.avif',
]);

export type FilePropertyRenderMode = 'inline' | 'frontmatter' | 'hidden';

export class ObsidianBuilder {
  private pageRegistry: PageRegistryReader | null = null;
  private propertyMappings: PropertyMapping[] = [];
  private filePropertyRenderMode: FilePropertyRenderMode = 'frontmatter';
  private enableMultiColumnLayout = true;

  /** Ids of synced-block ORIGINALS the renderer actually anchored during the
   *  current render (#1719). The pull records these against the page so a
   *  cross-page reference resolves - keyed on what is truly RENDERED, not what
   *  merely appears in the doc (a page that references a synced block carries a
   *  phantom nested copy of the original that never gets anchored). */
  private anchoredSyncedOriginals = new Set<string>();

  /** Headings of the document currently being built, for `tableOfContents` blocks. */
  private documentHeadings: DocumentHeading[] = [];

  /** Title of the document currently being built, for `breadcrumb` blocks. */
  private documentTitle = '';
  private documentNotionId = '';

  /**
   * Set the page registry for resolving internal links to [[wikilinks]].
   */
  setPageRegistry(registry: PageRegistryReader): void {
    this.pageRegistry = registry;
  }

  /**
   * Set property mappings for customizing frontmatter output.
   */
  setPropertyMappings(mappings: PropertyMapping[]): void {
    this.propertyMappings = mappings;
  }

  /**
   * Set how file-property images are rendered: inline (body embeds), frontmatter (YAML only), or hidden.
   */
  setFilePropertyRenderMode(mode: FilePropertyRenderMode): void {
    this.filePropertyRenderMode = mode;
  }

  /**
   * Set whether Notion column layouts render as multi-column callouts.
   * When false, columns are flattened into normal stacked blocks.
   */
  setEnableMultiColumnLayout(enabled: boolean): void {
    this.enableMultiColumnLayout = enabled;
  }

  /**
   * Build a complete Obsidian markdown file from an N2ODocument.
   */
  build(doc: N2ODocument): string {
    const { frontmatter, body } = this.buildContentParts(doc);
    const parts: string[] = [];
    if (frontmatter) parts.push(frontmatter);
    parts.push(body);
    return parts.join('\n');
  }

  /**
   * Build frontmatter and body separately, for callers that need the
   * two parts independently of the joined build() output.
   */
  buildContentParts(doc: N2ODocument): { frontmatter: string | null; body: string } {
    const parentDatabaseId = doc.metadata.parentDatabaseId;
    // A table-of-contents block needs the document's headings, and a block renderer
    // only ever sees one block. Collect them once per document so the TOC can be
    // rendered as a real list of links instead of an invisible HTML comment.
    this.documentHeadings = collectHeadings(doc.blocks);
    // A breadcrumb block closes its chain with the page's own title - same
    // "page-level state for one block type" pattern as documentHeadings.
    this.documentTitle = doc.title;
    this.documentNotionId = doc.notionId ?? doc.id ?? '';
    let fm = this.buildFrontmatter(doc);

    const bodyParts: string[] = [];

    // Embed images from files-type properties (only in 'inline' mode)
    if (this.filePropertyRenderMode === 'inline') {
      const imageEmbeds = this.buildFilePropertyEmbeds(doc);
      if (imageEmbeds) {
        bodyParts.push(imageEmbeds);
      }
    }

    // Body content - pass parentDatabaseId as parameter (not instance state)
    // wrapAttachments=true wraps file/pdf blocks in n2o-attachments callout at top level
    bodyParts.push(this.buildBlocks(doc.blocks, 0, parentDatabaseId, true));

    // Extract first body image as n2o_cover for gallery card covers.
    // Notion's "page_content" gallery cover scans body for the first image.
    // Bases needs vault-relative paths, so we extract from the block tree
    // (which has full paths) rather than the rendered body (filenames only).
    if (fm && parentDatabaseId) {
      const coverPath = extractFirstLocalImagePath(doc.blocks);
      if (coverPath) {
        fm = fm.replace(/\n---$/, `\nn2o_cover: "${escapeYamlString(coverPath)}"\n---`);
      }
    }

    return { frontmatter: fm, body: bodyParts.join('\n') };
  }

  /**
   * Build image embeds from files-type properties.
   * Renders each image file as ![[filename]] so they're visible in the page,
   * matching how Notion displays images in file properties.
   */
  private buildFilePropertyEmbeds(doc: N2ODocument): string | null {
    const embeds: string[] = [];

    for (const prop of doc.properties) {
      if (prop.type !== 'files' || !Array.isArray(prop.value)) continue;
      const files = prop.value as string[];
      if (files.length === 0) continue;

      for (const file of files) {
        const fileName = formatMediaValue(file);
        const ext = fileName.substring(fileName.lastIndexOf('.')).toLowerCase();
        if (IMAGE_EXTENSIONS.has(ext)) {
          embeds.push(`![[${fileName}]]`);
        } else if (ext === '.bin') {
          log.warn(`File property has .bin extension, skipping embed: ${fileName}`);
        }
      }
    }

    return embeds.length > 0 ? embeds.join('\n') + '\n' : null;
  }

  /**
   * Build YAML frontmatter from document properties and metadata.
   */
  buildFrontmatter(doc: N2ODocument): string | null {
    return buildFrontmatter(
      doc,
      this.pageRegistry,
      this.propertyMappings,
      this.filePropertyRenderMode,
    );
  }

  /**
   * Build markdown body from N2OBlocks.
   * When wrapAttachments is true, consecutive file/pdf blocks are grouped
   * inside an `[!n2o-attachments]` callout to hide metadata comments in Live Preview.
   */
  buildBlocks(
    blocks: N2OBlock[],
    depth: number = 0,
    parentDatabaseId?: string,
    wrapAttachments: boolean = false,
  ): string {
    const lines: string[] = [];
    // Parallel to `lines`: true when the rendered entry is a list item, so
    // consecutive list items can be joined without a blank line (a tight list)
    // while everything else keeps its blank-line separation.
    const isList: boolean[] = [];
    const listTypes = new Set(['numberedList', 'bulletList', 'todo']);
    const ctx = this.createBlockRenderContext();

    let i = 0;
    // Running position within a run of consecutive numbered-list siblings, so
    // each item renders its real number instead of all "1.". Any non-numbered
    // block resets the run - matching how Notion restarts a list. The run's
    // first item seeds the base from its startIndex (a list can start at 5),
    // and later items count up from there.
    let numberedOrdinal = 0;
    let numberedBase = 1;
    while (i < blocks.length) {
      const block = blocks[i];
      if (block === undefined) {
        i++;
        continue;
      }
      if (block.type === 'numberedList') {
        if (numberedOrdinal === 0) {
          numberedBase =
            block.meta.kind === 'numberedList' && block.meta.startIndex ? block.meta.startIndex : 1;
        }
        numberedOrdinal++;
      } else {
        numberedOrdinal = 0;
      }
      const numberedDisplay = numberedOrdinal ? numberedBase + numberedOrdinal - 1 : undefined;

      // Group consecutive file/pdf blocks into an n2o-attachments callout
      // (only at top level to hide metadata comments in Live Preview)
      if (wrapAttachments && (block.type === 'file' || block.type === 'pdf')) {
        const group: N2OBlock[] = [block];
        let j = i + 1;
        while (j < blocks.length) {
          const next = blocks[j];
          if (next === undefined || (next.type !== 'file' && next.type !== 'pdf')) break;
          group.push(next);
          j++;
        }
        lines.push(this.renderAttachmentsCallout(group, ctx, parentDatabaseId));
        isList.push(false);
        i = j;
        continue;
      }

      const rendered = renderBlock(block, depth, ctx, parentDatabaseId, numberedDisplay);
      if (rendered !== null) {
        lines.push(rendered);
        isList.push(listTypes.has(block.type));
      }
      i++;
    }

    // Each rendered entry already ends in a newline. Between two list items
    // add nothing (tight list); everywhere else add one newline, reproducing
    // the previous `lines.join('\n')` spacing for non-list blocks.
    let out = '';
    for (let k = 0; k < lines.length; k++) {
      if (k > 0 && !(isList[k - 1] && isList[k])) out += '\n';
      out += lines[k];
    }
    return out;
  }

  /**
   * Render a group of file/pdf blocks wrapped in an n2o-attachments callout.
   * Hides metadata comments in Obsidian Live Preview.
   */
  private renderAttachmentsCallout(
    blocks: N2OBlock[],
    ctx: BlockRenderContext,
    parentDatabaseId?: string,
  ): string {
    const contentParts: string[] = [];
    for (const block of blocks) {
      const rendered = renderBlock(block, 0, ctx, parentDatabaseId);
      if (rendered !== null) {
        contentParts.push(rendered.replace(/\n$/, ''));
      }
    }
    const content = contentParts.join('\n');
    const prefixed = content
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n');
    return `> [!n2o-attachments]+ Attachments\n${prefixed}\n`;
  }

  /**
   * Render a single block to markdown.
   */
  renderBlock(block: N2OBlock, depth: number = 0, parentDatabaseId?: string): string | null {
    return renderBlock(block, depth, this.createBlockRenderContext(), parentDatabaseId);
  }

  /**
   * Render rich text segments to markdown string.
   */
  renderRichText(segments: N2ORichText[]): string {
    return renderRichText(segments, this.pageRegistry);
  }

  /**
   * Create a BlockRenderContext that binds this instance's state.
   */
  private createBlockRenderContext(): BlockRenderContext {
    return {
      pageRegistry: this.pageRegistry,
      enableMultiColumnLayout: this.enableMultiColumnLayout,
      documentHeadings: this.documentHeadings,
      documentTitle: this.documentTitle,
      documentNotionId: this.documentNotionId,
      renderRichText: (segments: N2ORichText[]) => renderRichText(segments, this.pageRegistry),
      buildBlocks: (
        blocks: N2OBlock[],
        depth: number,
        parentDatabaseId?: string,
        wrapAttachments?: boolean,
      ) => this.buildBlocks(blocks, depth, parentDatabaseId, wrapAttachments ?? false),
      onSyncedOriginalAnchored: (id: string) => this.anchoredSyncedOriginals.add(id),
    };
  }

  /** Clear the anchored-originals set before rendering a page (#1719). */
  resetAnchoredSyncedOriginals(): void {
    this.anchoredSyncedOriginals.clear();
  }

  /** Ids of synced-block originals anchored since the last reset (#1719). */
  getAnchoredSyncedOriginals(): string[] {
    return [...this.anchoredSyncedOriginals];
  }
}

/**
 * Walk the block tree and return the vault-relative path of the first local image.
 * Bases needs full paths (not filenames) for gallery card covers.
 */
function extractFirstLocalImagePath(blocks: N2OBlock[]): string | undefined {
  // Use an index instead of shift() to avoid O(n^2) behavior on large trees
  const stack = [...blocks];
  let i = 0;
  while (i < stack.length) {
    const block = stack[i++];
    if (block === undefined) continue;
    if (block.type === 'image' && block.meta.kind === 'image') {
      const meta = block.meta as { sourceType: string; url: string };
      const ext = '.' + (meta.url.split('.').pop()?.toLowerCase() ?? '');
      if (meta.sourceType === 'local' && IMAGE_EXTENSIONS.has(ext)) {
        return meta.url;
      }
    }
    if (block.children?.length) stack.push(...block.children);
  }
  return undefined;
}
