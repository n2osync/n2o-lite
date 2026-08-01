import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import obsidianmd from 'eslint-plugin-obsidianmd';

/* The Obsidian community-store review rules (#1820), applied inside the src
 * block below so they inherit its TypeScript parser and project service.
 *
 * The plugin sat in devDependencies for months wired to nothing, so
 * `npm run lint` said nothing about store compliance and a real error went
 * undetected: an empty block left by a removed call, found only when the linter
 * was finally run by hand. A gate that never runs is not a gate.
 *
 * Takes the preset's CORE rules too, not just obsidianmd/*. The reviewer's
 * error list includes plain ESLint rules - no-empty is one, and filtering it out
 * is how a reintroduced empty block passed a "wired up" gate during this very
 * change. Rules from plugins this config does not register are dropped by
 * prefix, since ESLint cannot resolve them.
 */
/** Rule namespaces this config actually registers. A rule from anything else
 *  cannot resolve, so it is dropped rather than crashing the run. Core ESLint
 *  rules have no prefix and are always kept - the reviewer's error list includes
 *  several, and dropping them is how a reintroduced empty block passed a
 *  "wired up" gate during this very change. */
const REGISTERED_PREFIXES = ['obsidianmd/', '@typescript-eslint/'];
const isUsableRule = (name) =>
  !name.includes('/') || REGISTERED_PREFIXES.some((p) => name.startsWith(p));

const obsidianmdRules = Object.fromEntries(
  obsidianmd.configs.recommended
    .flatMap((c) => Object.entries(c.rules ?? {}))
    .filter(([name]) => isUsableRule(name)),
);

export default tseslint.config(
  // Global ignores (replaces .eslintignore)
  {
    ignores: [
      'node_modules/',
      'dist/',
      'main.js',
      '*.config.mjs',
      '*.config.js',
    ],
  },

  // Base recommended rules
  ...tseslint.configs.recommended,


  // Prettier compat (disables formatting rules)
  eslintConfigPrettier,

  // Source rules (strict). Type-aware: the parser loads the TS program so the
  // async-safety rules below can see promise types. Scoped to src only (tests
  // stay non-type-checked to keep lint fast and avoid mock-shaped fallout).
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { obsidianmd },
    rules: {
      ...obsidianmdRules,
      /* Off: postdates the 1.0.x review, flags 97 UI strings for capitalisation,
       * and is cosmetic. Turning it on would fail the build on day one and the
       * honest response would be to switch it off again. Tracked separately. */
      'obsidianmd/ui/sentence-case': 'off',
      /* Off on TypeScript, as typescript-eslint itself recommends: tsc already
       * resolves every identifier against lib.dom and the Obsidian types, and
       * does it better. Left on, it reports 129 false positives here - window,
       * document, console, createDiv - and nothing real. */
      'no-undef': 'off',
      /* Off: this asks for Obsidian's declarative settings API
       * (getSettingDefinitions) so settings show up in 1.13+ settings search.
       * That is a feature to build, not a lint fix, and silencing it inline
       * would hide a real gap. Tracked separately. */
      'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      // Match the Obsidian store review: flag control chars in regexes so the
      // two deliberate strippers (sanitize.ts, yaml.ts) carry a described
      // eslint-disable that is meaningful under both gates.
      'no-control-regex': 'error',
      // Allow the same console methods the Obsidian store review permits
      // (warn, error, debug). The Logger routes debug- and info-level output
      // through console.debug so it needs no eslint-disable comments, which the
      // store forbids (eslint-comments/no-restricted-disable). See #1823.
      'no-console': ['warn', { allow: ['warn', 'error', 'debug'] }],
      // Async-safety rules (require type info). no-floating-promises is the
      // headline guard for this promise-heavy sync engine (#1578).
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      // Async event handlers (addEventListener, setTimeout, Obsidian onClick) are
      // legitimate and pervasive; a `void (async()=>{})()` wrap around each adds
      // no runtime safety (the promise is ignored either way) and only noise.
      // `arguments: false` allows an async function in a void-return argument
      // slot while keeping the genuinely valuable checks - awaited conditionals,
      // spreads, and promise-returning object properties / return positions.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
    },
  },

  // Test rules (relaxed — allow any for mocks, allow console)
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
);
