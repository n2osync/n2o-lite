/**
 * Notion view-type classification for the pull path.
 *
 * What is left of what used to be BasesViewMapper. The `.base` view generator it
 * was named after had no production consumer - Lite renders database blocks as
 * upsell cards, it does not generate Bases views - so it went with the Bases cut
 * (#1917). Only the view-type mapping survived, because discovery, sync-page and
 * the linked-view resolver all classify a Notion view on pull.
 *
 * The 'cards' and 'list' names are Obsidian Bases vocabulary, kept because the
 * pull path already stores and compares them.
 */

/**
 * Map a Notion view type to the type the pull path records for it.
 */
export function mapNotionViewType(notionViewType: string): 'table' | 'cards' | 'list' {
  switch (notionViewType) {
    case 'table':
      return 'table';
    case 'gallery':
      return 'cards';
    case 'list':
      return 'list';
    case 'board':
      // Obsidian Bases has no board/kanban type - table is the closest fallback
      return 'table';
    case 'timeline':
      // Obsidian Bases has no timeline type - table is the closest fallback
      return 'table';
    case 'calendar':
      // Obsidian Bases has no calendar type - table fallback preserves the
      // filter + columns so users can still see the data; they lose the
      // month grid. Better than silently dropping the view entirely.
      return 'table';
    default:
      return 'table';
  }
}
