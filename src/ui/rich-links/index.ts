/**
 * N2O Rich Links - MarkdownPostProcessor that enriches links with previews.
 *
 * Phase 1: Bookmark cards with hover preview (via bookmark-post-processor.ts)
 * Phase 2: Internal link hover previews with banner, title, excerpt, tags
 */

import type { Plugin } from 'obsidian';
import { processInternalLinks } from './internal-link-processor';

export function registerRichLinksPostProcessor(plugin: Plugin): void {
  plugin.registerMarkdownPostProcessor((el) => {
    processInternalLinks(el, plugin.app);
  });
}
