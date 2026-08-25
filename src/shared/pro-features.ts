/**
 * What the full edition adds, written ONCE (#1975).
 *
 * Three surfaces pitch the paid edition: the upgrade modal, the settings
 * section, and the welcome note written on first sync (#1973). Written three
 * times they drift, and a Lite surface contradicting another Lite surface is
 * exactly what #1913 and #1968 were filed for. This is the single source; add a
 * feature here and every surface gains it at once.
 *
 * The claims here must stay true against the README's comparison table. Both
 * change together or the disclosure drifts again.
 *
 * `icon` is a Lucide name for the surfaces that render icons; the plain-text
 * surfaces ignore it.
 *
 * @module
 */

export interface ProFeature {
  /** Lucide icon name, for surfaces that show one. */
  icon: string;
  /** What the user gets, in their words. */
  title: string;
  /** What it means in practice - a sentence, not a feature name. */
  detail: string;
  /**
   * Marks the one claim that a free N2O Sync Pro user does NOT get, so the
   * surfaces can tag it. Owner direction: the tag is for the page cap alone.
   * Everything else here is paid too, but tagging all of them made the tag
   * invisible and the list noisy.
   */
  paidOnly?: boolean;
}

/**
 * What Lite DOES, so the comparison is honest in both directions. Lived in
 * settings-pro-tab.ts until the upgrade dialog needed it too; a second copy is
 * exactly the drift this module exists to prevent.
 *
 * The page figure is interpolated by the caller from LITE_PAGE_LIMIT rather
 * than written here, so this module keeps no imports.
 */
/**
 * What pressing an install control does, said once. Obsidian's developer
 * policies require this disclosure, and BOTH the dialog and the dashboard
 * banner can start the download now, so it has to sit next to each of them.
 */
export const PRO_INSTALL_DISCLOSURE =
  'This downloads N2O Sync Pro (about 2 MB) from github.com/n2osync/n2o and enables it. ' +
  'Your vault and your Lite settings are untouched, and your notes stay where they are.';

export const LITE_DOES: ReadonlyArray<string> = [
  'Pulls pages, databases, properties and media from Notion',
  'Syncs up to {pages} notes per vault, database rows included',
  'Keeps your notes as plain Markdown you own, readable without the plugin',
  'Never overwrites a note you edited without saving a copy first',
];

export const PRO_FEATURES: ReadonlyArray<ProFeature> = [
  {
    icon: 'arrow-right-left',
    title: 'Stop copy-pasting',
    detail: 'Edit in Obsidian and your changes flow back to Notion on their own.',
  },
  {
    icon: 'refresh-cw',
    title: 'Never open a stale note',
    detail: 'Both sides stay current in the background while you work.',
  },
  {
    icon: 'layout-grid',
    title: 'Your databases stay alive',
    detail: 'Notion galleries and boards render as live Obsidian Bases, not flat tables.',
  },
  {
    icon: 'shield-check',
    title: 'Never lose your work',
    detail:
      'Edit the same page in both places and smart merge keeps both changes instead of overwriting.',
  },
  {
    icon: 'palette',
    title: 'Pages that look like Notion',
    detail: 'Notion text colours, page covers and page icons render in your vault.',
  },
  {
    icon: 'infinity',
    title: 'No page limit',
    paidOnly: true,
    detail: 'Sync a whole workspace instead of the 100 pages Lite allows.',
  },
];
