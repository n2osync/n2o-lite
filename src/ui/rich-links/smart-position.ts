/**
 * Smart positioning for preview cards.
 * Places the card above or below the trigger element, clamped to viewport.
 * Arrow points to the trigger link.
 */

const MARGIN = 8;
const VIEWPORT_PAD = 12;

export function positionPreview(trigger: HTMLElement, preview: HTMLElement): 'above' | 'below' {
  const rect = trigger.getBoundingClientRect();
  const pw = preview.offsetWidth || 380;
  const ph = preview.offsetHeight || 300;

  // Prefer above the trigger. Fall back to below if not enough space.
  let placement: 'above' | 'below' = 'above';
  let top = rect.top - ph - MARGIN;
  if (top < VIEWPORT_PAD) {
    top = rect.bottom + MARGIN;
    placement = 'below';
  }
  // Clamp to bottom of viewport
  if (top + ph > window.innerHeight - VIEWPORT_PAD) {
    top = window.innerHeight - ph - VIEWPORT_PAD;
  }

  // Horizontal: center on trigger, clamp to viewport edges
  let left = rect.left + rect.width / 2 - pw / 2;
  left = Math.max(VIEWPORT_PAD, Math.min(left, window.innerWidth - pw - VIEWPORT_PAD));

  preview.style.top = `${top}px`;
  preview.style.left = `${left}px`;

  return placement;
}
