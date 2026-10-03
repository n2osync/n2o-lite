/**
 * SyncConfigModal - Redirect helper that opens the N2O settings tab to the Sync tab.
 *
 * All sync configuration now lives in the tabbed settings page (settings-tab.ts).
 * This file provides openSyncSettings() for callers that used to open the modal.
 */

import type { App } from 'obsidian';
import type { SettingTabLike } from './setting-tab-like';

/**
 * Opens the N2O settings tab directly to the Sync tab.
 * Replaces the old SyncConfigModal - call this from dashboard, commands, etc.
 *
 * Takes the minimal SettingTabLike shape (just `showTab`) instead of
 * the concrete N2OSettingTab so this module can sit between
 * plugin/command-registration and ui/settings-tab without forming a
 * source-level cycle.
 */
export function openSyncSettings(app: App, settingTab: SettingTabLike): void {
  // Switch the settings tab to the Sync tab before opening
  settingTab.showTab('Sync');

  const setting = (app as unknown as Record<string, unknown>).setting as
    { open: () => void; openTabById: (id: string) => void } | undefined;
  if (setting) {
    setting.open();
    setting.openTabById('n2o');
  }
}
