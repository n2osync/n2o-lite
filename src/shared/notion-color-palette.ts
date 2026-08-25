/**
 * Single source of truth for Notion's color palette.
 *
 * Values verified against live notion.so DOM via Playwright (see commit history).
 * Notion uses low-opacity rgba over saturated base colors so highlights stay
 * subtle. Foreground colors are solid (no opacity).
 *
 * The renderer emits class names like `n2o-bg-red` / `n2o-fg-red`. The actual
 * color values live in styles.css as CSS custom properties so light/dark
 * themes resolve at render time.
 */

export const NOTION_COLOR_NAMES = [
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
] as const;

type NotionColorName = (typeof NOTION_COLOR_NAMES)[number];

export type NotionColor = 'default' | NotionColorName | `${NotionColorName}_background`;

const COLOR_SET: ReadonlySet<string> = new Set<string>([
  'default',
  ...NOTION_COLOR_NAMES,
  ...NOTION_COLOR_NAMES.map((c) => `${c}_background`),
]);

export function isNotionColor(value: string): value is NotionColor {
  return COLOR_SET.has(value);
}

/**
 * Map a Notion color annotation to its CSS class.
 * `red` -> `n2o-fg-red`, `red_background` -> `n2o-bg-red`, `default` -> `''`.
 */
export function notionColorToClass(color: NotionColor): string {
  if (color === 'default') return '';
  if (color.endsWith('_background')) {
    return `n2o-bg-${color.replace('_background', '')}`;
  }
  return `n2o-fg-${color}`;
}

/**
 * Inverse of notionColorToClass - used by the parser.
 * Returns null for unrecognized class names.
 */
export function classToNotionColor(className: string): NotionColor | null {
  const bg = className.match(/^n2o-bg-([a-z]+)$/);
  const bgName = bg?.[1] ?? '';
  if (bg && (NOTION_COLOR_NAMES as readonly string[]).includes(bgName)) {
    return `${bgName as NotionColorName}_background`;
  }
  const fg = className.match(/^n2o-fg-([a-z]+)$/);
  const fgName = fg?.[1] ?? '';
  if (fg && (NOTION_COLOR_NAMES as readonly string[]).includes(fgName)) {
    return fgName as NotionColorName;
  }
  return null;
}
