/**
 * Pro-detection guard - N2O Sync Lite and the full N2O Sync plugin (id `n2o`) must
 * never sync the same vault. Both editions share on-disk state formats, so
 * running them side by side would have two engines writing the same records.
 *
 * The check reads Obsidian's enabled-plugin set, which is not part of the
 * public plugin API, so everything is typed defensively: any unexpected
 * shape reads as "not active" and Lite keeps working.
 */

import type { App } from 'obsidian';

/** Plugin id of the full (paid) N2O edition in the community store. */
export const PRO_PLUGIN_ID = 'n2o';

/** Message shown when Lite refuses to sync because the full plugin is active. */
export const MSG_PRO_PLUGIN_ACTIVE =
  'N2O Sync Lite disabled its sync: the full N2O Sync plugin is active in this vault. Run one, not both.';

/**
 * True when the full N2O Sync plugin is enabled in this vault. Evaluated live at
 * every sync entry point (not cached at startup), so enabling or disabling
 * the full plugin takes effect on the next command without a reload.
 */
export function isProPluginActive(app: App): boolean {
  const plugins = (app as unknown as { plugins?: { enabledPlugins?: unknown } }).plugins;
  const enabled = plugins?.enabledPlugins;
  if (!(enabled instanceof Set)) return false;
  return enabled.has(PRO_PLUGIN_ID);
}
