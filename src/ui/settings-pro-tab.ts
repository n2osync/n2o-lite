/**
 * Settings Tab - "N2O Sync Pro" tab.
 *
 * Its own tab rather than a section buried at the bottom of Connection, because
 * this is the one surface in Lite that asks anyone to pay (#1975).
 *
 * A list, not disabled controls. A greyed-out toggle that looks real teaches
 * someone the plugin is broken before they read the badge. Nothing here is
 * interactive except the install button.
 *
 * All static. Obsidian's developer policy allows "static ads within the
 * plugin's own interface" and forbids ads loaded over the internet, and
 * check-network.mjs fails the build for the latter regardless.
 *
 * The feature copy comes from shared/pro-features.ts so this tab, the upgrade
 * modal and the welcome note cannot disagree with each other or the README.
 */

import { setIcon } from 'obsidian';
import type { SettingsTabContext } from './settings-helpers';
import { PRO_FEATURES } from '../shared/pro-features';
import { LITE_PAGE_LIMIT } from '../application/sync/page-budget';

/** What Lite does, said plainly, so the comparison is honest in both directions. */
const LITE_DOES: ReadonlyArray<string> = [
  'Pulls pages, databases, properties and media from Notion',
  `Syncs up to ${LITE_PAGE_LIMIT} notes per vault, database rows included`,
  'Keeps your notes as plain Markdown you own, readable without the plugin',
  'Never overwrites a note you edited without saving a copy first',
];

export function renderProTab(container: HTMLElement, ctx: SettingsTabContext): void {
  // ── What you already have ──
  const liteGroup = container.createDiv({ cls: 'n2o-settings-group' });
  liteGroup.createDiv({
    cls: 'n2o-settings-group-title',
    text: 'What you already have',
  });
  liteGroup
    .createDiv({ cls: 'setting-item-description' })
    .setText('N2O Sync Lite is free, and stays free. Nothing here expires.');

  const liteList = liteGroup.createEl('ul', { cls: 'n2o-pro-lite-list' });
  for (const line of LITE_DOES) {
    liteList.createEl('li', { text: line });
  }

  // ── What the full edition adds ──
  const proGroup = container.createDiv({ cls: 'n2o-settings-group' });
  proGroup.createDiv({
    cls: 'n2o-settings-group-title',
    text: 'What the full edition adds',
  });

  const list = proGroup.createDiv({ cls: 'n2o-pro-features' });
  for (const feature of PRO_FEATURES) {
    const row = list.createDiv({ cls: 'n2o-pro-feature' });
    const head = row.createDiv({ cls: 'n2o-pro-feature-head' });
    setIcon(head.createSpan({ cls: 'n2o-pro-feature-icon' }), feature.icon);
    head.createSpan({ cls: 'n2o-pro-feature-title', text: feature.title });
    row.createDiv({ cls: 'n2o-pro-feature-detail', text: feature.detail });
  }

  // ── Price, stated before the button, not after ──
  const priceGroup = container.createDiv({ cls: 'n2o-settings-group' });
  priceGroup.createDiv({ cls: 'n2o-settings-group-title', text: 'What it costs' });
  const price = priceGroup.createDiv({ cls: 'setting-item-description' });
  price.createDiv({
    text: '14 days free, no card. After that $8 a month, or $249 once for a lifetime licence.',
  });
  price.createDiv({
    text: 'The trial is the full app and caps at 300 pages; paid plans have no page limit.',
  });

  // ── What actually happens if you try it ──
  const howGroup = container.createDiv({ cls: 'n2o-settings-group' });
  howGroup.createDiv({ cls: 'n2o-settings-group-title', text: 'What happens if you try it' });
  const how = howGroup.createEl('ul', { cls: 'n2o-pro-lite-list' });
  how.createEl('li', {
    text:
      'Install downloads the N2O Sync plugin (about 2 MB) from its GitHub releases and ' +
      'enables it. Nothing is downloaded until you press the button.',
  });
  how.createEl('li', {
    text: 'Your vault and your Lite settings are untouched. Lite stays installed and goes quiet so the two never sync the same vault at once.',
  });
  how.createEl('li', {
    text: 'Your synced notes are already plain Markdown, so nothing needs migrating and nothing is locked in.',
  });
  how.createEl('li', {
    text: 'If you stop paying, the notes in your vault stay exactly where they are. They are files.',
  });

  const actions = container.createDiv({ cls: 'n2o-upgrade-actions' });
  const tryBtn = actions.createEl('button', { text: 'Try N2O Sync free', cls: 'mod-cta' });
  tryBtn.addEventListener('click', () => ctx.plugin.openUpgradeModal());

  const site = container.createDiv({ cls: 'setting-item-description n2o-pro-note' });
  const link = site.createEl('a', { text: 'n2osync.com', href: 'https://n2osync.com' });
  link.setAttribute('target', '_blank');
  site.appendText(' has the full comparison and the docs.');
}
