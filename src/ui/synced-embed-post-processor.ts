/**
 * SyncedEmbedPostProcessor - tags the per-child transclusions of a synced-block
 * reference so CSS can render them as ONE unbroken synced block (#1719).
 *
 * Obsidian transcludes one block per `^anchor`, so a multi-block Notion synced
 * region renders as several `![[Page#^childId]]` embeds. Each carries Obsidian's
 * embed chrome (a bordered box, title, expand icon), so the region read as N
 * separate boxes. Notion shows a synced block as one piece, with no container.
 * This tags every embed whose src targets a synced anchor (`Page#^<notion-id>`)
 * so styles.css strips the chrome and the gaps, and the group reads as one block.
 */

import type { Plugin } from 'obsidian';

/** A block embed targeting a synced anchor: src ends `#^<notion-id>` (uuid or 32-hex). */
const SYNCED_EMBED_SRC_RE =
  /#\^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{32})$/;

export function registerSyncedEmbedPostProcessor(plugin: Plugin): void {
  plugin.registerMarkdownPostProcessor((el) => {
    for (const emb of Array.from(el.querySelectorAll<HTMLElement>('.internal-embed[src]'))) {
      const src = emb.getAttribute('src') ?? '';
      if (SYNCED_EMBED_SRC_RE.test(src)) emb.classList.add('n2o-synced-embed');
    }
  });
}
