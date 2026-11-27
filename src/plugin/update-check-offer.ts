/**
 * Offer, once, to let Obsidian say when a Lite update is out (#512).
 *
 * Store plugins must not update themselves (Obsidian's Developer policies),
 * so a new Lite reaches people through Obsidian's own updater. Its automatic
 * check is off by default, and with it off Obsidian only looks when someone
 * presses Check for updates, so most people never learn a new Lite exists.
 *
 * Lite never checks for updates itself: that would be a network request its
 * network-purity rule forbids, and Obsidian's own check shows a notice and
 * looks at every installed plugin each time it runs, read on 1.13.7. Lite only
 * asks the person, once, whether to turn on Obsidian's setting, which is
 * theirs to turn off again under Settings, Community plugins.
 *
 * Asked once: the flag is written before the notice shows, so a crash or a
 * click elsewhere cannot make it come back. Not asked before the first
 * successful pull, so connecting is never crowded, and not asked when the
 * check is already on or this Obsidian has no such setting.
 */
import { Notice } from 'obsidian';
import type { App } from 'obsidian';

/** Obsidian's plugin manager, the part this uses. Not in the public API. */
interface UpdateCheckApi {
  autoCheckForUpdates?: boolean;
  setAutomaticUpdateCheck?: (on: boolean) => void;
}

/** What the offer needs from the plugin. */
export interface UpdateCheckOfferHost {
  app: App;
  settings: { welcomeNoteWritten?: boolean; updateCheckOffered?: boolean };
  saveSettings(): Promise<void>;
}

export const OFFER_TEXT =
  'Want to hear when a new N2O Sync Lite is out? Obsidian can check for plugin updates by itself, but that is switched off. Turn it on?';
export const TURNED_ON_TEXT =
  'Obsidian will now say when a plugin update is out, N2O Sync Lite included. Turn this off any time under Settings, Community plugins.';

/** Show the offer if it is due. Answers whether it was shown. */
/**
 * `makeFragment` is Obsidian's global `createFragment`, passed in so a test
 * can build the notice without a DOM.
 */
export async function offerUpdateCheckOnce(
  host: UpdateCheckOfferHost,
  makeFragment: (build: (f: DocumentFragment) => void) => DocumentFragment = createFragment,
): Promise<boolean> {
  const api = (host.app as unknown as { plugins?: UpdateCheckApi }).plugins;
  if (host.settings.updateCheckOffered) return false;
  if (!host.settings.welcomeNoteWritten) return false;
  if (typeof api?.setAutomaticUpdateCheck !== 'function') return false;
  host.settings.updateCheckOffered = true;
  await host.saveSettings();
  if (api.autoCheckForUpdates === true) return false;

  let on: HTMLButtonElement | null = null;
  let no: HTMLButtonElement | null = null;
  const body = makeFragment((f) => {
    f.createDiv({ text: OFFER_TEXT });
    const row = f.createDiv({ cls: 'n2o-update-offer-actions' });
    on = row.createEl('button', { cls: 'mod-cta', text: 'Turn on' });
    no = row.createEl('button', { text: 'No thanks' });
  });
  const notice = new Notice(body, 0);
  (on as HTMLButtonElement | null)?.addEventListener('click', () => {
    api.setAutomaticUpdateCheck?.(true);
    notice.hide();
    new Notice(TURNED_ON_TEXT, 8000);
  });
  (no as HTMLButtonElement | null)?.addEventListener('click', () => notice.hide());
  return true;
}
