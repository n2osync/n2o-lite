/**
 * Network purity gate.
 *
 * What this actually checks, precisely, so nobody reads more assurance into a
 * green run than it earns (#1980):
 *
 *  1. ALLOWLIST. Every `http(s)://host` literal in `src/**.ts` and in the built
 *     `main.js` is extracted and its host checked against the lists below. A host
 *     that is not on one of them fails the build. This is the real gate, and it is
 *     an inverted default on purpose: a denylist only catches what someone already
 *     thought to ban, while an allowlist catches what nobody thought of, which is
 *     the case that actually matters.
 *  2. DENYLIST. A short list of service names that can appear without a URL
 *     (payment providers, mail providers, the unofficial Notion API). Belt and
 *     braces on top of 1.
 *  3. GITHUB OWNERSHIP. Only `src/plugin/pro-installer.ts` may name the GitHub
 *     API, so the upgrade fetch cannot spread into the sync path.
 *
 * What it does NOT check: runtime behaviour. It reads text. A host assembled at
 * runtime from fragments would not be caught by any of the three, and the Notion
 * media URLs the API hands back at runtime are deliberately not knowable here.
 * Those are covered by review and by the media downloader's own SSRF guards, not
 * by this script.
 *
 * Until 1.0.7 this file was a denylist of eight strings whose header claimed
 * "anything else is a regression". It was not: a probe file containing
 * telemetry.evil-analytics.example.com, unpkg.com and a typo'd api.n2osync.co
 * passed it clean. tests/unit/check-network-gate.test.ts now runs that probe and
 * asserts the gate rejects it, so this cannot rot back into decoration.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

/** Hosts the plugin actually sends requests to. Keep this list tiny. */
const FETCH_HOSTS = [
  'api.notion.com', // the Notion API: all sync traffic
  'api.n2osync.com', // OAuth sign-in handshake only
  // The pro-installer. NOT on a click any more: the first launch after install
  // calls it with no dialog and no user action, and the dashboard's Install
  // button is now the second path rather than the only one. This comment said
  // "on an explicit click" for a while after that stopped being true, which is
  // the exact stale-claim shape this repo keeps paying for.
  'api.github.com',
  'github.com', // release asset download for the same installer
];

/** Hosts that only ever appear as links a user clicks, or in doc comments. */
const LINK_HOSTS = [
  'notion.so', // "create an integration" help links
  'developers.notion.com', // API doc references in comments
  'n2osync.com', // our own site, docs and privacy policy
  'obsidian.md', // Obsidian docs references
  'w3.org', // SVG xmlns attributes, not a network call
  'example.com', // placeholder in comments and fixtures
  'files2notion.com', // cited source for the icon map
  'prod-files-secure.s3.us-west-2.amazonaws.com', // sample Notion media URL in a comment
];

/**
 * Embed providers, read from the module that owns them rather than duplicated
 * here, so the two lists cannot drift apart. These are hosts Lite RECOGNISES in
 * Notion embed blocks so it can render a link instead of downloading junk; the
 * plugin does not fetch them. If a note embeds one, Obsidian may load it when the
 * user views that note, which is the user's own content doing the loading.
 */
function readEmbedHosts() {
  const source = readFileSync('src/shared/embed-providers.ts', 'utf8');
  const block = source.match(/EMBED_ONLY_HOSTS[^=]*=\s*\[([\s\S]*?)\]/);
  if (!block) {
    // Fail loudly. Silently allowing nothing here would turn a rename into a
    // gate that rejects the whole tree, and allowing everything would be worse.
    console.error(
      'check-network: could not find EMBED_ONLY_HOSTS in src/shared/embed-providers.ts. ' +
        'If it was renamed or restructured, update this gate to match.',
    );
    process.exit(1);
  }
  const hosts = [...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  // 'google.com/maps' is a host+path entry in that list; the gate matches hosts.
  return hosts.map((h) => h.split('/')[0]);
}

/**
 * Hosts named in block-renderer's embed rewriting but not in EMBED_ONLY_HOSTS.
 * airtable.com is rewritten to /embed for rendering, yet embed-providers.ts does
 * not list it, so the two lists disagree about what Airtable is. That is worth
 * settling, but it is a rendering question and not a network one, so it is parked
 * rather than changed inside a release verification.
 */
const EMBED_REWRITE_HOSTS = ['airtable.com'];

/**
 * Hosts that appear ONLY as illustrations inside comments and are never fetched.
 * 2130706433 is the decimal form of 127.0.0.1, quoted in media-downloader.ts as an
 * example of an address its SSRF guard blocks. It is documentation of a refusal.
 */
const COMMENT_EXAMPLE_HOSTS = ['2130706433'];

/** Service names that can show up without a URL. */
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

/**
 * Exact hosts, matched after stripping a leading "www." and nothing else.
 *
 * Subdomain matching is deliberately NOT applied here. Allowing `*.example.com`
 * let telemetry.evil-analytics.example.com through on the first run of this gate:
 * one placeholder host in the list silently permitted an entire namespace. Only
 * the embed providers get suffix matching, because they genuinely need it.
 */
const EXACT_HOSTS = [
  ...FETCH_HOSTS,
  ...LINK_HOSTS,
  ...EMBED_REWRITE_HOSTS,
  ...COMMENT_EXAMPLE_HOSTS,
].map((h) => h.toLowerCase());

/**
 * Embed providers, matched on the host or any subdomain of it, mirroring
 * isEmbedOnlyUrl. Notion hands back platform.twitter.com and w.soundcloud.com for
 * the same providers, so an exact list would reject its own rewrites.
 */
const SUFFIX_HOSTS = readEmbedHosts().map((h) => h.toLowerCase());

const failures = [];

function isAllowedHost(host) {
  const stripped = host.startsWith('www.') ? host.slice(4) : host;
  if (EXACT_HOSTS.includes(stripped)) return true;
  return SUFFIX_HOSTS.some((allowed) => stripped === allowed || stripped.endsWith('.' + allowed));
}

function scan(file) {
  const text = readFileSync(file, 'utf8');
  const lower = text.toLowerCase();

  for (const needle of FORBIDDEN) {
    if (lower.includes(needle)) failures.push(`${file}: contains "${needle}"`);
  }

  const seen = new Set();
  for (const match of text.matchAll(/https?:\/\/([A-Za-z0-9._-]+)/g)) {
    const host = match[1].toLowerCase();
    if (seen.has(host)) continue;
    seen.add(host);
    if (!isAllowedHost(host)) {
      failures.push(`${file}: unexpected host "${host}" (not in the network allowlist)`);
    }
  }

  // Keep the GitHub surface deliberate: only the pro-installer may hit
  // api.github.com. The bundle legitimately contains it (the installer is
  // compiled in), so this check applies to source files only.
  const normalized = file.split('\\').join('/');
  if (
    normalized.endsWith('.ts') &&
    normalized !== GITHUB_API_OWNER &&
    lower.includes('api.github.com')
  ) {
    failures.push(
      `${file}: contains "api.github.com" - only ${GITHUB_API_OWNER} may use the GitHub API`,
    );
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
else
  console.warn(
    'check-network: main.js not found, scanned src/ only (run the build first for full coverage)',
  );

if (failures.length > 0) {
  console.error('Network purity gate FAILED:');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('Network purity gate: clean (src' + (existsSync('main.js') ? ' + main.js' : '') + ')');
