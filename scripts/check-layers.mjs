/**
 * Layer-boundary gate. Enforces the project's layer dependency direction
 * mechanically, because a rule that lives only in prose is a rule that drifts.
 *
 * Layers (by folder under src/): domain, application, infrastructure, ui,
 * plugin, shared. src/main.ts is the entry ('main'); src/settings.ts is the
 * settings module ('settings').
 *
 * The rules, all of which hold with ZERO violations at the time this gate
 * landed (2026-07-15 survey):
 *   - domain imports NOTHING outside domain/. Not shared, not obsidian. Pure.
 *   - shared imports only shared/ ('obsidian' allowed as import type only).
 *   - application never imports ui/, plugin/, or main; 'obsidian' as import
 *     type only; RUNTIME imports of infrastructure/ or settings only via the
 *     frozen allowlist below. Type-only imports across layers are fine - they
 *     erase at compile time and exist for constructor DI.
 *   - infrastructure never imports application/, ui/, plugin/, main, settings.
 *   - ui and plugin never import main. (main is the composition root; nothing
 *     imports it - that is what makes it a root.)
 *
 * THE ALLOWLIST RATCHETS DOWN, NEVER UP. Each entry is a known legacy edge,
 * frozen 2026-07-15. Fixing one = delete its line. Adding one = you are about
 * to violate the architecture; extract an interface or move the helper to
 * domain/shared instead. The kinds present here, so you can tell whether your
 * edge "belongs": (a) pure wire-format helpers that live in infrastructure but
 * are logically domain services (data-source-shape, type-maps), (b) merge
 * helpers pending extraction, (c) the settings module consumed by
 * settings-manager, (d) one UI tab reaching into connection-manager.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';

const SRC = 'src';
const norm = (p) => p.split('\\').join('/');

/** Frozen runtime edges: "fromFile -> toLayerOrFile". See header before touching. */
const ALLOWLIST = new Set([]);

const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.ts$/.test(e)) files.push(norm(p));
  }
})(SRC);

const layerOf = (p) => {
  const r = norm(relative(SRC, p));
  if (r === 'main.ts') return 'main';
  if (r === 'settings.ts') return 'settings';
  for (const l of ['domain', 'application', 'infrastructure', 'ui', 'plugin', 'shared']) {
    if (r.startsWith(l + '/')) return l;
  }
  return 'root';
};

const violations = [];
for (const f of files) {
  const from = layerOf(f);
  const text = readFileSync(f, 'utf8');
  const re = /^(?:import|export)\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(text))) {
    const typeOnly = !!m[1];
    const spec = m[2];

    if (!spec.startsWith('.')) {
      if (spec === 'obsidian' && !typeOnly && (from === 'domain' || from === 'application' || from === 'shared')) {
        violations.push(`${f}: runtime import of 'obsidian' from ${from}/ (type-only is allowed${from === 'domain' ? ' nowhere in domain' : ''})`);
      }
      continue;
    }

    let target = norm(resolve(dirname(f), spec));
    target = norm(relative(process.cwd(), target));
    if (!target.startsWith('src/')) continue; // json/assets outside src
    if (!/\.ts$/.test(target)) target += '.ts';
    const to = layerOf(target);
    if (from === to) continue;

    const edge = `${f} -> ${target}`;
    const fail = (why) => violations.push(`${f}: ${why} (imports ${spec})`);

    if (to === 'main') { fail('imports main.ts - nothing may import the composition root'); continue; }

    switch (from) {
      case 'domain':
        fail('domain/ must import nothing outside domain/');
        break;
      case 'shared':
        if (to !== 'shared') fail('shared/ must import only shared/');
        break;
      case 'application':
        if (to === 'ui' || to === 'plugin') { fail(`application/ must not import ${to}/`); break; }
        if (!typeOnly && (to === 'infrastructure' || to === 'settings') && !ALLOWLIST.has(edge)) {
          fail(`new runtime import of ${to} from application/ - use a type-only import + DI, or extract the helper (see check-layers.mjs header)`);
        }
        break;
      case 'infrastructure':
        if (to === 'application' || to === 'ui' || to === 'plugin' || to === 'settings') {
          fail(`infrastructure/ must not import ${to}`);
        }
        break;
      case 'ui':
        if (!typeOnly && to === 'plugin' && !ALLOWLIST.has(edge)) {
          fail('new runtime import of plugin/ from ui/ - pass a callback or narrow interface instead');
        }
        break;
      default:
        break; // plugin and main/root may compose anything below them
    }
  }
}

if (violations.length) {
  console.error(`layer gate: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error('  ' + v);
  console.error('\nRules + the frozen-edge allowlist: scripts/check-layers.mjs (header).');
  process.exit(1);
}
console.log(`layer gate: clean (${files.length} files, ${ALLOWLIST.size} frozen legacy edges)`);
