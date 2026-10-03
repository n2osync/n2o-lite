/**
 * PreviewCard - Builds the DOM for link preview cards.
 * Shared between bookmark previews and internal link previews.
 */

export interface PreviewCardData {
  /** Banner/cover image path or URL */
  bannerImage?: string;
  /** Page icon (emoji or image) */
  icon?: string;
  /** Card title */
  title: string;
  /** First paragraph or description */
  excerpt?: string;
  /** Property tags to show at the bottom */
  tags?: string[];
  /** Relative time like "2 days ago" */
  updatedAgo?: string;
}

export function buildPreviewCard(data: PreviewCardData): HTMLElement {
  const card = createDiv();
  card.className = 'n2o-preview-card';

  // Banner image
  if (data.bannerImage) {
    const banner = createDiv();
    banner.className = 'n2o-preview-banner';
    const img = createEl('img');
    img.src = data.bannerImage;
    img.alt = '';
    img.loading = 'lazy';
    banner.appendChild(img);
    card.appendChild(banner);
  }

  // Content area
  const content = createDiv();
  content.className = 'n2o-preview-content';

  // Title with optional icon
  const titleEl = createDiv();
  titleEl.className = 'n2o-preview-title';
  if (data.icon) {
    const iconSpan = createSpan();
    iconSpan.className = 'n2o-preview-icon';
    iconSpan.textContent = data.icon;
    titleEl.appendChild(iconSpan);
  }
  const titleText = createSpan();
  titleText.textContent = data.title;
  titleEl.appendChild(titleText);
  content.appendChild(titleEl);

  // Excerpt
  if (data.excerpt) {
    const excerptEl = createDiv();
    excerptEl.className = 'n2o-preview-excerpt';
    excerptEl.textContent = data.excerpt;
    content.appendChild(excerptEl);
  }

  // Tags + updated time footer
  if ((data.tags && data.tags.length > 0) || data.updatedAgo) {
    const footer = createDiv();
    footer.className = 'n2o-preview-footer';
    if (data.tags) {
      for (const tag of data.tags.slice(0, 4)) {
        const tagEl = createSpan();
        tagEl.className = 'n2o-preview-tag';
        tagEl.textContent = tag;
        footer.appendChild(tagEl);
      }
    }
    if (data.updatedAgo) {
      const time = createSpan();
      time.className = 'n2o-preview-time';
      time.textContent = data.updatedAgo;
      footer.appendChild(time);
    }
    content.appendChild(footer);
  }

  card.appendChild(content);
  return card;
}

/** Format a date string as relative time (e.g. "2 days ago") */
export function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
