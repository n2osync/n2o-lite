/**
 * N2O Plugin Settings - type re-exports and account-UI helpers.
 * The settings tab UI is in ui/settings-tab.ts.
 *
 * Types are defined in domain/models/config-schema.ts (single source of truth);
 * this module re-exports them so existing `../settings` imports keep working.
 * The defaults and the profile / config helpers now live in config-schema too,
 * so callers reach them through the domain model rather than this root module.
 */

// Re-export all types from config-schema so existing imports keep working
export type {
  SelectedSyncItem,
  DatabaseFilter,
  FilterCondition,
  WorkspaceProfile,
  N2OSettings,
  PropertyMapping,
} from './domain/models/config-schema';

/**
 * Show the user's own email as-is in their account UI. Deliberately NOT masked:
 * it is the account owner's own address on their own device, and every call site
 * is the settings/account screen. Named `displayEmail` (not `maskEmail`) so no
 * caller ever trusts it to redact - if a masked surface is ever needed, add a
 * separate masking helper rather than repurposing this one (#1800).
 */
export function displayEmail(email: string): string {
  return email;
}
