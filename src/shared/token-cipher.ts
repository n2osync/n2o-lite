/**
 * TokenCipher - AES-256-GCM encryption for sensitive plugin secrets.
 *
 * Why this exists
 * ---------------
 * Phase J of the audit fix-plan. Notion integration tokens have
 * workspace-wide read/write scope, so a leaked token is a workspace
 * compromise. Pre-Phase-J the token sat in plaintext at
 * `<vault>/<configDir>/plugins/notion-pull-lite/data.json`. That matches the
 * Obsidian community norm for plugin storage but has two real
 * downsides:
 *   1. Vault sync (Dropbox, iCloud, manual copy) ships the plaintext
 *      token to every device + every backup the vault touches.
 *   2. Casual file inspection (e.g. accidental screen-share, error
 *      report attachment) exposes the token without warning.
 *
 * Threat model & honest scope
 * ---------------------------
 * This is defense-in-depth, NOT a security boundary. An attacker with
 * local code execution on the machine can still extract the key from
 * IndexedDB and decrypt. What this DOES defeat:
 *   - Vault copy attacks: the encryption key lives in IndexedDB
 *     (per-Obsidian-instance, per-machine), never in the vault. A
 *     copied vault on a different machine produces undecryptable
 *     ciphertext, falling cleanly back to "user must re-paste token".
 *   - Casual file grep / shoulder-surfing of data.json.
 *   - Token leaking in shared backups.
 *
 * Format
 * ------
 * Encrypted values are JSON objects of shape:
 *   { alg: 'aes-256-gcm', iv: <base64>, ct: <base64> }
 * iv is 12 bytes (96-bit nonce, the AES-GCM standard). ct is the
 * concatenation of ciphertext + 128-bit auth tag (the WebCrypto
 * default output).
 *
 * Plaintext tokens that predate this module are detected by
 * `isCiphertext()` and transparently re-encrypted on next save.
 */

import { createLogger } from './logger';

const log = createLogger('TokenCipher');

const DB_NAME = 'n2o-secrets';
const STORE_NAME = 'keys';
const KEY_ID = 'token-encryption-key';
const ALGORITHM = 'AES-GCM';
const KEY_LENGTH_BITS = 256;
const IV_LENGTH_BYTES = 12;

/** Tagged ciphertext envelope persisted to data.json. */
export interface Ciphertext {
  alg: 'aes-256-gcm';
  /** 12-byte IV, base64-encoded. */
  iv: string;
  /** Ciphertext + 16-byte auth tag, base64-encoded. */
  ct: string;
}

/** True when the value is a ciphertext envelope (not a raw string). */
export function isCiphertext(value: unknown): value is Ciphertext {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { alg?: unknown }).alg === 'aes-256-gcm' &&
    typeof (value as { iv?: unknown }).iv === 'string' &&
    typeof (value as { ct?: unknown }).ct === 'string'
  );
}

/**
 * Get-or-create the per-machine AES-256 encryption key from IndexedDB.
 *
 * The key is generated on first call and persisted with extractable=true
 * so subsequent calls retrieve the same instance. We deliberately store
 * the key (not the rawkey bytes) so future code can ratchet to
 * extractable=false if a master-password flow ever lands.
 */
export async function getOrCreateKey(): Promise<CryptoKey> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB unavailable - cipher cannot persist keys in this environment');
  }
  if (typeof window.crypto === 'undefined' || !window.crypto.subtle) {
    throw new Error('WebCrypto unavailable - cipher cannot operate in this environment');
  }

  const existing = await readKey();
  if (existing) return existing;

  const key = await window.crypto.subtle.generateKey(
    { name: ALGORITHM, length: KEY_LENGTH_BITS },
    true, // extractable - lets a future migration re-import on key rotation
    ['encrypt', 'decrypt'],
  );
  await writeKey(key);
  log.info('Generated new token-encryption key in IndexedDB');
  return key;
}

/** Encrypt a UTF-8 string. Returns the tagged envelope shape. */
export async function encryptString(plaintext: string, key: CryptoKey): Promise<Ciphertext> {
  const iv = window.crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const ptBytes = new TextEncoder().encode(plaintext);
  const ctBuffer = await window.crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, ptBytes);
  return {
    alg: 'aes-256-gcm',
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ctBuffer)),
  };
}

/**
 * Decrypt a ciphertext envelope. Throws if the IV is wrong size, the
 * ciphertext is corrupt, or the auth tag fails (indicates tampering or
 * decryption with the wrong key, e.g. after a vault copy).
 */
export async function decryptString(ct: Ciphertext, key: CryptoKey): Promise<string> {
  if (ct.alg !== 'aes-256-gcm') {
    throw new Error(`Unsupported cipher algorithm: ${(ct as { alg: string }).alg}`);
  }
  const iv = base64ToBytes(ct.iv);
  if (iv.byteLength !== IV_LENGTH_BYTES) {
    throw new Error(`Invalid IV length: ${iv.byteLength} (expected ${IV_LENGTH_BYTES})`);
  }
  const ctBytes = base64ToBytes(ct.ct);
  const ptBuffer = await window.crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ctBytes);
  return new TextDecoder().decode(ptBuffer);
}

// ── IndexedDB helpers ──────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

async function readKey(): Promise<CryptoKey | null> {
  const db = await openDb();
  try {
    return await new Promise<CryptoKey | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(KEY_ID);
      req.onsuccess = () => resolve((req.result as CryptoKey | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'));
    });
  } finally {
    db.close();
  }
}

async function writeKey(key: CryptoKey): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(key, KEY_ID);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('IndexedDB write failed'));
    });
  } finally {
    db.close();
  }
}

// ── Base64 helpers (avoid node-Buffer dependency in browser) ────

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === undefined) continue;
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  // Allocate an ArrayBuffer-backed Uint8Array (not SharedArrayBuffer)
  // so the result satisfies WebCrypto's BufferSource constraint under
  // strict TS lib settings.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Wipe the encryption key from IndexedDB. Used by factory-reset and
 * "log out everywhere" flows. After this call, any existing
 * ciphertext in data.json becomes undecryptable - callers must
 * surface that to the user as "please re-enter your Notion token".
 */
export async function wipeKey(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(KEY_ID);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('IndexedDB delete failed'));
    });
  } finally {
    db.close();
  }
}
