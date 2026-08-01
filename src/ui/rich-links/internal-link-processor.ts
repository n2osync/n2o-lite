/**
 * InternalLinkProcessor - Hover preview for [[wiki links]].
 *
 * Shows a card with banner image, title, first paragraph, and key properties
 * when hovering over internal links. Data comes from the vault's metadata cache
 * and file content - zero network calls.
 */

import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import { buildPreviewCard, formatRelativeTime } from './preview-card';
import { positionPreview } from './smart-position';

const HOVER_DELAY_MS = 500;
const BANNER_KEYS = ['banner', 'bannerOriginal', 'cover', 'image'];

const processedLinks = new WeakSet<Element>();

export function processInternalLinks(el: HTMLElement, app: App): void {
  const links = el.querySelectorAll('a.internal-link');
  for (const link of Array.from(links)) {
    if (processedLinks.has(link)) continue;
    processedLinks.add(link);
    setupLinkHover(link as HTMLElement, app);
  }
}

/**
 * The target note's emoji icon, or null when the note has none or the icon
 * is not an inline-able emoji (URL / vault-path / data-URI icons render as
 * images elsewhere and would not fit inline before link text).
 * Exported for tests.
 */
export function inlineIconFromFrontmatter(fm: Record<string, unknown> | undefined): string | null {
  const icon = fm?.icon;
  if (typeof icon !== 'string' || icon.length === 0 || icon.length > 8) return null;
  if (/^(https?:|\/|data:)/.test(icon)) return null;
  return icon;
}

function setupLinkHover(link: HTMLElement, app: App): void {
  let timer: number | null = null;
  let activeCard: HTMLElement | null = null;
  let removalObserver: MutationObserver | null = null;

  link.addEventListener('mouseenter', () => {
    timer = window.setTimeout(() => {
      const card = buildCardForLink(link, app);
      if (!card) return;

      activeCard = card;
      document.body.appendChild(card);

      // If the link is removed from the DOM while hovering (note re-render,
      // scroll virtualization), mouseleave never fires - watch for its removal
      // so the card does not orphan in document.body.
      removalObserver = new MutationObserver(() => {
        if (!link.isConnected) {
          card.remove();
          activeCard = null;
          removalObserver?.disconnect();
          removalObserver = null;
        }
      });
      removalObserver.observe(document.body, { childList: true, subtree: true });

      // Position after DOM insertion (need dimensions)
      window.requestAnimationFrame(() => {
        const placement = positionPreview(link, card);
        card.classList.add('n2o-preview-card-visible');
        card.setAttribute('data-placement', placement);
      });
    }, HOVER_DELAY_MS);
  });

  link.addEventListener('mouseleave', () => {
    if (timer) {
      window.clearTimeout(timer);
      timer = null;
    }
    removalObserver?.disconnect();
    removalObserver = null;
    if (activeCard) {
      const card = activeCard;
      activeCard = null;
      card.classList.remove('n2o-preview-card-visible');
      window.setTimeout(() => card.remove(), 150);
    }
  });
}

function buildCardForLink(link: HTMLElement, app: App): HTMLElement | null {
  const file = resolveLinkTarget(link, app);
  return file ? buildCardFromFile(file, app) : null;
}

/** Resolve an internal link element to its target note, or null. */
function resolveLinkTarget(link: HTMLElement, app: App): TFile | null {
  const href = link.getAttribute('data-href') || link.getAttribute('href') || '';
  if (!href) return null;

  const targetPath = href.replace(/^#.*/, ''); // Strip heading anchors
  // getFirstLinkpathDest returns a TFile (or null); the old `instanceof
  // app.vault.constructor.prototype.constructor` resolved to `instanceof Vault`
  // and was therefore always false, discarding every valid result. Duck-type on
  // `extension` (present on TFile, absent on TFolder) instead.
  const file = app.metadataCache.getFirstLinkpathDest(targetPath, '');
  if (file && 'extension' in file) {
    return file;
  }
  // Fallback: resolve directly as a vault path (with and without .md).
  const resolved =
    app.vault.getAbstractFileByPath(targetPath) ||
    app.vault.getAbstractFileByPath(targetPath + '.md');
  if (!(resolved instanceof TFile)) return null;
  return resolved;
}

function buildCardFromFile(file: TFile, app: App): HTMLElement | null {
  const cache = app.metadataCache.getFileCache(file);
  if (!cache) return null;

  const fm = cache.frontmatter || {};

  // Extract banner image
  let bannerImage: string | undefined;
  for (const key of BANNER_KEYS) {
    if (fm[key] && typeof fm[key] === 'string') {
      const val = fm[key];
      if (val.startsWith('http')) {
        bannerImage = val;
      } else {
        // Local vault path - resolve to resource URL
        const bannerFile = app.metadataCache.getFirstLinkpathDest(val, file.path);
        if (bannerFile) {
          bannerImage = app.vault.getResourcePath(bannerFile);
        }
      }
      break;
    }
  }

  // Extract icon
  const icon = typeof fm.icon === 'string' ? fm.icon : undefined;

  // Title from frontmatter or filename
  const title = (typeof fm.title === 'string' ? fm.title : null) || file.basename;

  // Extract first paragraph from cached sections
  let excerpt: string | undefined;
  if (cache.sections && cache.sections.length > 0) {
    // Excerpt from first paragraph is not available synchronously
    // (cachedRead is async). Fall through to frontmatter-based excerpt below.
  }

  // Sync excerpt extraction from metadataCache
  // Use the headings + sections data to build a summary
  if (!excerpt) {
    // Try description or summary frontmatter
    if (typeof fm.description === 'string' && fm.description) {
      excerpt = fm.description;
    } else if (typeof fm.summary === 'string' && fm.summary) {
      excerpt = fm.summary;
    }
  }

  // Tags
  const tags: string[] = [];
  if (Array.isArray(fm.tags)) {
    for (const t of fm.tags.slice(0, 4)) {
      if (typeof t === 'string') tags.push(t);
    }
  }
  // Also check cache.tags
  if (tags.length === 0 && cache.tags) {
    for (const t of cache.tags.slice(0, 4)) {
      tags.push(t.tag.replace(/^#/, ''));
    }
  }

  // Updated time
  const updated: unknown = fm.updated || fm['last-edited-time'];
  const updatedAgo = typeof updated === 'string' ? formatRelativeTime(updated) : undefined;

  return buildPreviewCard({
    bannerImage,
    icon,
    title,
    excerpt,
    tags,
    updatedAgo,
  });
}
