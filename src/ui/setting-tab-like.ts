/**
 * SettingTabLike - minimal structural type for the N2O settings tab.
 *
 * Extracted to a leaf module so consumers (sync-config-modal,
 * dashboard-manager, plugin-host) can all import it without anyone
 * having to depend on the concrete N2OSettingTab class. Reaching into
 * settings-tab.ts directly pulls in the whole settings render graph
 * and re-introduces a plugin-host <-> dashboard-manager cycle.
 */

export interface SettingTabLike {
  showTab(name: string): void;
  display(): void;
  refreshIfVisible(): void;
}
