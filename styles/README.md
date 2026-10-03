# styles/ - the stylesheet source of truth (#1625)

`styles.css` at the repo root is GENERATED: esbuild.config.mjs concatenates
every `*.css` here in numeric-prefix order on each build. Edit these files,
never the root artifact (the next build silently overwrites it).

Concat order IS the cascade order and it is load-bearing: two rules with equal
specificity resolve by position, so moving a rule across files can flip a
visual outcome. That is why this is a dumb concat and not @imports or a
bundler - the output is the exact byte sequence of the slices, in order.

## Slice map (from the 2026-07-13 split - verified byte-identical)

| File | Holds | Origin lines |
|---|---|---|
| 010-content.css | Plugin header, narrow-pane fallbacks, multi-column layout, toggle headings | 1-323 |
| 020-picker.css | Status bar + the whole tree picker (search, tree, token setup, two-pane redesign) | 324-2077 |
| 030-settings.css | Settings tabs, connection cockpit, health hub/pill, sections, filter builder, property mapper | 2078-2959 |
| 040-modals.css | Conflict modal, diff highlighting, merge editor, local changes, change log panel | 2960-3310 |
| 050-dashboard-wizard.css | Dashboard v1, spinners/error states, setup wizard, trial/dry-run/template/base-view modals, tier table | 3311-6074 |
| 060-dashboard-redesign.css | Dashboard redesign phase 1: states 1-4, hero scenes, gauges, connect flow, footers | 6075-8936 |
| 080-dialogs.css | Confirm dialogs, parent picker | 9519-9689 |

Some slices hold more than one concern (020 has the status bar, 050 mixes the
wizard and several modals) - that is deliberate: the initial split cut at
section boundaries WITHOUT reordering, so it changed nothing.

## Moving a section between slices (the migration protocol)

Reordering is a real change, do it one section per commit:

1. Move ONE banner-to-banner section from its slice to the target slice.
2. Check for same-specificity selector overlap between the moved section and
   every section it jumped over (grep the selectors; a collision means the
   move can flip which rule wins - stop and inspect).
3. Build and eyeball the affected surface at native resolution
   (avoiding-drift rule 9), or land the move release-adjacent so the
   /vismatch sweep verifies it for free.

## Adding new styles

New rules go at the END of the slice that owns the concern. A brand-new
concern gets a new numbered file - pick the prefix by where in the cascade it
must sit (almost always: after everything it needs to override).
