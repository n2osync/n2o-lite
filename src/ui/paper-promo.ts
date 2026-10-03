/**
 * The N2O Paper row, drawn at the foot of every settings tab.
 *
 * The free theme and its settings plugin exist to bring people to N2O, and
 * Paper's own settings tab has carried a Sync row since 1.0.9. This is the
 * return leg, so the three products point at each other rather than only one
 * way. Same mark, same shape of row, deliberately: a reader who has seen one
 * recognises the other.
 *
 * It draws NOTHING when the theme is already the active one, because a row
 * advertising what somebody is already looking at is noise.
 */
import type { App } from 'obsidian';
import { createBrandMark } from './brand-mark';

const PAPER_THEME_NAME = 'N2O Paper';

/**
 * The slice of Obsidian's undocumented customCss we read. Narrow on purpose:
 * `theme` is the selected theme's name and `themes` is what is on disk.
 */
interface CustomCssApi {
  theme?: string;
  themes?: Record<string, unknown>;
  setTheme?: (name: string) => void;
}

type PaperState = 'active' | 'installed' | 'missing';

function paperState(app: App): PaperState {
  const css = (app as App & { customCss?: CustomCssApi }).customCss;
  if (!css) return 'missing';
  if (css.theme === PAPER_THEME_NAME) return 'active';
  return css.themes && PAPER_THEME_NAME in css.themes ? 'installed' : 'missing';
}

/**
 * Append the row to `container`. Returns whether anything was drawn, so a
 * caller can keep its own spacing honest.
 */
export function renderPaperRow(app: App, container: HTMLElement): boolean {
  const state = paperState(app);
  if (state === 'active') return false;

  const row = container.createDiv({ cls: 'n2o-paper-row' });
  const text = row.createDiv({ cls: 'n2o-paper-row-text' });

  const head = text.createDiv({ cls: 'n2o-paper-row-head' });
  const mark = createBrandMark();
  mark.addClass('n2o-paper-row-mark');
  head.appendChild(mark);
  head.createSpan({ cls: 'n2o-paper-row-name', text: 'Paper' });

  const body = text.createDiv({ cls: 'n2o-paper-row-body' });
  const actions = row.createDiv({ cls: 'n2o-paper-row-actions' });

  if (state === 'installed') {
    body.setText('The paper theme is in this vault and another theme is selected.');
    const use = actions.createEl('button', {
      cls: 'mod-cta',
      text: `Switch to ${PAPER_THEME_NAME}`,
    });
    use.addEventListener('click', () => {
      const css = (app as App & { customCss?: CustomCssApi }).customCss;
      css?.setTheme?.(PAPER_THEME_NAME);
    });
    return true;
  }

  body.setText(
    'Our free light theme for Obsidian. Made for long reading, and it reads like paper.',
  );
  const get = actions.createEl('button', { cls: 'mod-cta', text: `Get ${PAPER_THEME_NAME}` });
  get.addEventListener('click', () => {
    openAppearance(app);
  });
  return true;
}

/**
 * Obsidian's Appearance tab, where themes are browsed, installed and switched.
 *
 * NOT `window.open('obsidian://show-theme?name=...')`, which is the obvious
 * thing and is wrong: a non-http scheme opened from the renderer goes out to
 * the OS handler, which launches Obsidian against the DEFAULT profile. If that
 * profile does not know the vault you are sitting in, the user gets a native
 * "Vault not found" error box naming the URL. Seen, with a screenshot.
 *
 * The settings API stays inside the window that is already open, so it cannot
 * miss and cannot spawn a second Obsidian.
 */
function openAppearance(app: App): void {
  const setting = (app as App & { setting?: { open?: () => void; openTabById?: (id: string) => void } }).setting;
  setting?.open?.();
  setting?.openTabById?.('appearance');
}
