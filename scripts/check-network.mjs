/**
 * Network purity gate. N2O Lite's allowed network surface is exactly:
 *   - api.notion.com (sync)
 *   - Notion-returned media URLs at runtime
 *   - n2o-lic.vercel.app (OAuth sign-in only)
 *   - api.github.com / github.com release assets (the user-initiated
 *     "Install N2O Sync" upgrade only - nothing is fetched without that click)
 * Anything else in the source or the built bundle is a regression. Fails the
 * build if a forbidden host or service string appears in src/**.ts or main.js,
 * or if the GitHub surface leaks outside the one module that owns it
 * (src/plugin/pro-installer.ts).
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

const FORBIDDEN = [
  'api.polar.sh',
  'gumroad',
  'cdnjs.cloudflare.com',
  'www.notion.so/api',
  'keygen.sh',
  'convertkit',
  'sequenzy',
  'resend.com',
];

/** The one source file allowed to talk to the GitHub releases API. */
const GITHUB_API_OWNER = 'src/plugin/pro-installer.ts';

const failures = [];

function scan(file) {
  const text = readFileSync(file, 'utf8').toLowerCase();
  for (const needle of FORBIDDEN) {
    if (text.includes(needle)) failures.push(`${file}: contains "${needle}"`);
  }
  // Keep the GitHub surface deliberate: only the pro-installer may hit
  // api.github.com. The bundle legitimately contains it (the installer is
  // compiled in), so this check applies to source files only.
  const normalized = file.split('\\').join('/');
  if (normalized.endsWith('.ts') && normalized !== GITHUB_API_OWNER && text.includes('api.github.com')) {
    failures.push(`${file}: contains "api.github.com" - only ${GITHUB_API_OWNER} may use the GitHub API`);
  }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.ts')) scan(p);
  }
}

walk('src');
if (existsSync('main.js')) scan('main.js');
else console.warn('check-network: main.js not found, scanned src/ only (run the build first for full coverage)');

if (failures.length > 0) {
  console.error('Network purity gate FAILED:');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('Network purity gate: clean (src' + (existsSync('main.js') ? ' + main.js' : '') + ')');
