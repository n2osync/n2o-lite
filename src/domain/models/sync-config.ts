/**
 * SyncConfig - Clean dependency boundary for core sync modules.
 *
 * Core modules (engine, pull-sync, registry-builder, conflict-manager)
 * depend on this interface instead of the full N2OSettings type from settings.ts.
 * This decouples the sync engine from the plugin's UI/settings layer.
 *
 * At the plugin boundary (main.ts), `flattenSettings()` produces an object that
 * satisfies this interface - it remains the adapter between N2OSettings and SyncConfig.
 *
 * Types are defined in config-schema.ts (single source of truth).
 */

export type {
  SyncConfig,
  SyncSelectedItem,
  SyncDatabaseFilter,
  SyncFilterCondition,
  SyncPropertyMapping,
  PropertyMapping,
} from './config-schema';
