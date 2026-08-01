/**
 * BookmarkPostProcessor - Moves bookmark hover previews to document.body
 * so they escape callout/column stacking contexts.
 *
 * CSS position:fixed inside Obsidian's callout elements doesn't escape
 * the containing block. This PostProcessor detaches preview elements
 * and re-attaches them to document.body on hover.
 */

import type { Plugin } from 'obsidian';

export function registerBookmarkPostProcessor(plugin: Plugin): void {
  plugin.registerMarkdownPostProcessor((el) => {
    const bookmarks = el.querySelectorAll('.n2o-bookmark');
    for (const bookmark of Array.from(bookmarks)) {
      const preview = bookmark.querySelector<HTMLElement>('.n2o-bookmark-preview');
      if (!preview) continue;

      // Detach from inline position (can't escape stacking context via CSS)
      preview.remove();

      let active = false;
      let removalObserver: MutationObserver | null = null;

      bookmark.addEventListener('mouseenter', () => {
        if (active) return;
        active = true;
        document.body.appendChild(preview);
        // Force reflow before adding class (ensures transition works)
        void preview.offsetHeight;
        preview.classList.add('n2o-bookmark-preview-visible');
        // If the bookmark is removed from the DOM while hovering (note re-render,
        // scroll virtualization), mouseleave never fires - watch for its removal
        // so the detached preview does not orphan in document.body.
        removalObserver = new MutationObserver(() => {
          if (!bookmark.isConnected) {
            active = false;
            if (preview.parentElement === document.body) preview.remove();
            removalObserver?.disconnect();
            removalObserver = null;
          }
        });
        removalObserver.observe(document.body, { childList: true, subtree: true });
      });

      bookmark.addEventListener('mouseleave', () => {
        if (!active) return;
        active = false;
        preview.classList.remove('n2o-bookmark-preview-visible');
        removalObserver?.disconnect();
        removalObserver = null;
        // Small delay so fade-out animation can play
        window.setTimeout(() => {
          if (!active && preview.parentElement === document.body) {
            preview.remove();
          }
        }, 200);
      });
    }
  });
}
