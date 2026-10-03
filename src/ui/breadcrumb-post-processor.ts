/**
 * BreadcrumbPostProcessor - tags the rendered breadcrumb paragraph so CSS can
 * space the chain like Notion, in READING VIEW.
 *
 * The breadcrumb renders as one line, `%% n2o:breadcrumb %% [[A]] / [[B]] / C`.
 * Reading view strips
 * the `%% %%` marker from the DOM, so the rendered <p> has no way to be told
 * apart from an ordinary paragraph of links. This reads the marker back from
 * the source and tags the <p> `n2o-breadcrumb`; styles.css then gives the chain
 * its crumb-to-crumb spacing. Display-layer only, zero markdown changes.
 */

import type { Plugin } from 'obsidian';
import { BREADCRUMB_LINE_RE } from '../infrastructure/obsidian/breadcrumb-marker';

export function registerBreadcrumbPostProcessor(plugin: Plugin): void {
  plugin.registerMarkdownPostProcessor((el, ctx) => {
    const p = el.instanceOf(HTMLParagraphElement) ? el : el.querySelector('p');
    if (!p) return;
    const info = ctx.getSectionInfo(el);
    if (!info) return;
    const line = info.text.split('\n')[info.lineStart] ?? '';
    if (BREADCRUMB_LINE_RE.test(line)) p.classList.add('n2o-breadcrumb');
  });
}
