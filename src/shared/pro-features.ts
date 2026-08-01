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
}

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
    detail: 'Sync a whole workspace instead of the 100 pages Lite allows.',
  },
];
