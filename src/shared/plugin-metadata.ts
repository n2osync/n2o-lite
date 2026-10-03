/**
 * The plugin's manifest id (`manifest.json` -> `id`).
 *
 * Obsidian installs the plugin into `<configDir>/plugins/<id>/`, so every path
 * that points at the plugin's own folder - where the SQLite databases and
 * data.json live - must derive from this constant, never a separate literal. It
 * MUST stay equal to the id in manifest.json; a guard test asserts that so the
 * two can never drift (a mismatch would open the databases in the wrong folder).
 *
 * This is the Obsidian-facing plugin id. It is deliberately NOT the server-side
 * `client` identifier used in connection-manager - that value is a wire contract
 * with the license OAuth endpoint and is out of this repo's scope to change.
 */
export const PLUGIN_ID = 'notion-pull-lite';
