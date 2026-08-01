/**
 * Shared types and helpers for settings tab modules.
 */

import { ToggleComponent, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import type { SettingsTabHost } from '../plugin/plugin-host';

export type TabName = 'Connection' | 'Sync' | 'Activity' | 'Advanced' | 'N2O Sync Pro';

/**
 * Context object passed to each extracted tab renderer.
 * Provides access to plugin state and shared helpers without coupling to the class.
 */
export interface SettingsTabContext {
  app: App;
  plugin: SettingsTabHost;
  expandedSections: Set<string>;
  debouncedSave: () => void;
  display: () => void;
  showTab: (tab: TabName) => void;
}

/**
 * Create a collapsible section with chevron, title, description, and optional
 * PRO badge. Returns the body container to add settings into.
 *
 * `options.headerToggle` puts an on/off toggle in the header, so a section can be
 * enabled/disabled while collapsed and expanded only for the detailed controls.
 * Clicking the toggle does not fold the section.
 */
export function createSection(
  ctx: SettingsTabContext,
  parent: HTMLElement,
  key: string,
  title: string,
  description: string,
  options?: {
    open?: boolean;
    pro?: boolean;
    badge?: { text: string; cls: string };
    headerToggle?: {
      value: boolean;
      disabled?: boolean;
      onChange: (value: boolean) => void | Promise<void>;
    };
  },
): HTMLElement {
  const details = parent.createEl('details', { cls: 'n2o-section' });

  if (ctx.expandedSections.has(key)) {
    details.setAttribute('open', '');
  } else if (options?.open) {
    details.setAttribute('open', '');
    ctx.expandedSections.add(key);
  }

  details.addEventListener('toggle', () => {
    if (details.open) {
      ctx.expandedSections.add(key);
    } else {
      ctx.expandedSections.delete(key);
    }
  });

  const summary = details.createEl('summary');
  summary.setAttribute('aria-label', title);

  const chevron = summary.createSpan({ cls: 'n2o-base-views-chevron' });
  setIcon(chevron, 'chevron-right');

  const info = summary.createDiv({ cls: 'n2o-section-info' });
  info.createDiv({ text: title, cls: 'n2o-section-title' });
  info.createDiv({ text: description, cls: 'n2o-section-desc' });

  if (options?.pro) {
    summary.createSpan({ text: 'PRO', cls: 'n2o-section-badge' });
  }
  if (options?.badge) {
    summary.createSpan({ text: options.badge.text, cls: options.badge.cls });
  }

  const body = details.createDiv({ cls: 'n2o-section-body' });

  if (options?.headerToggle) {
    const ht = options.headerToggle;
    // The toggle is a SIBLING of <summary>, positioned over the header in CSS.
    // Because it is not inside the summary, clicking it never triggers the
    // summary's fold - no conflict, no preventDefault gymnastics needed.
    details.addClass('n2o-section--has-toggle');
    const wrap = details.createDiv({ cls: 'n2o-section-header-toggle' });
    const toggle = new ToggleComponent(wrap);
    toggle.setValue(ht.value);
    toggle.onChange(ht.onChange);
    if (ht.disabled) toggle.setDisabled(true);
  }

  return body;
}

/** Format an ISO timestamp as a human-friendly "time ago" string. */
export function formatTimeAgo(isoTime: string): string {
  const diff = Date.now() - new Date(isoTime).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
