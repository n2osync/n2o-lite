/**
 * Check that the N2O this plugin is about to install was signed by N2O (#512).
 *
 * Every N2O release carries `release-signature.json`: a short text naming the
 * version and the SHA-256 of main.js, manifest.json and styles.css, signed with
 * N2O's release key. A file changed after signing, a release from anyone else,
 * or a release with no signature is refused before anything is written.
 *
 * The format and the key are N2O's: `n2o/src/domain/models/release-signature.ts`
 * defines both, and a test in the n2o repo fails when this copy's key or
 * header disagrees with it. N2O Settings and N2O Sync Lite carry this same file, byte for byte. Verification
 * uses Node's crypto, which every desktop Obsidian has, and WebCrypto where it
 * does not (Ed25519 and SHA-256, measured working in Obsidian 1.13.7, Chromium
 * 150, on 2026-11-27).
 */

/** N2O's release key, base64url of its raw 32 bytes. Must equal n2o's RELEASE_PUBKEY_B64URL. */
const RELEASE_PUBKEY_B64URL = '0GIUTcTMrmwHfK6iNqLZm5g_n8aY6ppXYeoCnpb3FYY';
const RELEASE_SIGNATURE_ASSET = 'release-signature.json';

let keyOverrideForTests: string | null = null;
/**
 * Test seam: verify with a throwaway key so tests can sign a release. A
 * production build replaces process.env.NODE_ENV, so this override is
 * compiled out there and a patched client cannot swap the key.
 */
export function __setReleaseKeyForTests(b64url: string | null): void {
  keyOverrideForTests = b64url;
}
function trustedKey(): string {
  return process.env.NODE_ENV !== 'production' && keyOverrideForTests
    ? keyOverrideForTests
    : RELEASE_PUBKEY_B64URL;
}
export const SIGNED_RELEASE_FILES = ['main.js', 'manifest.json', 'styles.css'] as const;

const HEADER = 'n2o-release v1';

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Node's crypto, the part used here. */
interface NodeCrypto {
  createPublicKey(o: { key: Uint8Array; format: 'der'; type: 'spki' }): unknown;
  verify(alg: null, data: Uint8Array, key: unknown, sig: Uint8Array): boolean;
  createHash(alg: 'sha256'): { update(d: Uint8Array): { digest(e: 'hex'): string } };
}

/**
 * Node's crypto when Obsidian provides it, which every desktop installer does
 * (Ed25519 since Node 12). WebCrypto is the fallback, because Chromium only
 * turned Ed25519 on by default in 137, and older installers run older ones.
 */
function nodeCrypto(): NodeCrypto | null {
  const load =
    typeof window === 'undefined'
      ? undefined
      : (window as unknown as { require?: (m: string) => unknown }).require;
  if (typeof load !== 'function') return null;
  try {
    return load('crypto') as NodeCrypto;
  } catch {
    return null;
  }
}

/** SPKI DER prefix for an Ed25519 public key (RFC 8410). */
const SPKI_ED25519 = Uint8Array.from([48, 42, 48, 5, 6, 3, 43, 101, 112, 3, 33, 0]);

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const node = nodeCrypto();
  if (node) return node.createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Ed25519 over `data` by the trusted key, by Node's crypto or WebCrypto. */
async function verifySignature(
  data: Uint8Array<ArrayBuffer>,
  signature: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const raw = b64urlBytes(trustedKey());
  const node = nodeCrypto();
  if (node) {
    const der = new Uint8Array(SPKI_ED25519.length + raw.length);
    der.set(SPKI_ED25519);
    der.set(raw, SPKI_ED25519.length);
    const key = node.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return node.verify(null, data, key, signature);
  }
  const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, signature, data);
}

/** The version and hashes a payload states, or null when it is not N2O's format. */
function parsePayload(payload: string): { version: string; sha256: Record<string, string> } | null {
  const lines = payload.split('\n');
  if (lines.pop() !== '' || lines.length !== 2 + SIGNED_RELEASE_FILES.length) return null;
  if (lines[0] !== HEADER) return null;
  const version = /^version (\d+\.\d+\.\d+)$/.exec(lines[1] ?? '')?.[1];
  if (!version) return null;
  const sha256: Record<string, string> = {};
  for (const [i, f] of SIGNED_RELEASE_FILES.entries()) {
    const m = new RegExp(`^${f.replace('.', '\\.')} ([0-9a-f]{64})$`).exec(lines[i + 2] ?? '');
    if (!m?.[1]) return null;
    sha256[f] = m[1];
  }
  return { version, sha256 };
}

/**
 * Null when `files` are a release N2O signed and nothing in them changed since;
 * otherwise the reason, as the end of a sentence.
 */
export async function signedReleaseProblem(
  files: Record<string, ArrayBuffer>,
): Promise<string | null> {
  const sig = files[RELEASE_SIGNATURE_ASSET];
  if (!sig) return 'the release carries no signature';
  let doc: { payload?: unknown; signature?: unknown };
  try {
    doc = JSON.parse(new TextDecoder().decode(sig)) as typeof doc;
  } catch {
    return 'its signature file cannot be read';
  }
  if (typeof doc.payload !== 'string' || typeof doc.signature !== 'string') {
    return 'its signature file cannot be read';
  }
  if (!nodeCrypto() && !crypto?.subtle) {
    return 'this Obsidian has no cryptography to check the signature with';
  }
  let ok: boolean;
  try {
    ok = await verifySignature(new TextEncoder().encode(doc.payload), b64urlBytes(doc.signature));
  } catch (e) {
    return `its signature could not be checked (${e instanceof Error ? e.message : String(e)})`;
  }
  if (!ok) return 'it is not signed by N2O';
  const claims = parsePayload(doc.payload);
  if (!claims) return 'its signed description is not one this plugin reads';
  for (const f of SIGNED_RELEASE_FILES) {
    const bytes = files[f];
    if (!bytes) return `${f} is missing from the release`;
    if ((await sha256Hex(bytes)) !== claims.sha256[f])
      return `${f} is not the file that was signed`;
  }
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as {
    version?: unknown;
  };
  if (manifest.version !== claims.version) {
    return `its manifest says ${String(manifest.version)}, its signature ${claims.version}`;
  }
  return null;
}
