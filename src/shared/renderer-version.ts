/**
 * The renderer fingerprint - a build-time hash of every source file that
 * shapes pull output (domain models/services, the Notion parser, the
 * Obsidian builder and its renderers). Injected by esbuild as
 * __N2O_RENDERER_VERSION__; see computeRendererVersion in esbuild.config.mjs.
 *
 * Sync records store the fingerprint that produced each note. The pull skip
 * gate treats a mismatch as "stale output" and re-renders, which is what lets
 * a shipped renderer fix reach notes that are already synced (#1628) - the
 * Notion-side timestamp alone cannot see that the CODE turning blocks into
 * markdown changed.
 *
 * Falls back to 'dev' when the define is absent (vitest, ts-node) so tests
 * control it explicitly instead of tracking real source hashes.
 */
declare const __N2O_RENDERER_VERSION__: string | undefined;

export const RENDERER_VERSION: string =
  typeof __N2O_RENDERER_VERSION__ === 'string' && __N2O_RENDERER_VERSION__.length > 0
    ? __N2O_RENDERER_VERSION__
    : 'dev';
