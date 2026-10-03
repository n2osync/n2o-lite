/**
 * Renderer fingerprint (#1628): a hash of every source file that can shape pull
 * output, injected into the bundle as __N2O_RENDERER_VERSION__. Sync records
 * store the fingerprint that produced each note; a mismatch on the next sync
 * re-renders the note, so renderer fixes reach already-synced vaults instead of
 * waiting for the Notion page to change.
 *
 * DELIBERATELY over-broad (whole directories, not a curated file list): a curated
 * list is an exclusion list that the next renderer file silently escapes
 * (avoiding-drift #2). A false positive only costs one re-render sweep after an
 * update; a false negative re-creates #1628.
 *
 * The fingerprint must depend on renderer CONTENT and nothing else (#2034). It
 * used to hash each file's absolute path, so the same commit produced a different
 * fingerprint depending on where the repo sat on disk:
 *
 *   D:/DEV/n2o-lite                       fa4b7730a367
 *   /home/runner/work/n2o-lite/n2o-lite   7313dd67a6b0   (what shipped in 1.0.7)
 *   /build                                ac51725ae121   (the docker CI gate)
 *
 * That broke the promise that a clean checkout rebuilds the published main.js
 * byte for byte, and left a landmine: any change to the CI checkout path would
 * have triggered a full re-render sweep for every user with no renderer change at
 * all. Two normalisations keep it content-only, and both matter:
 *
 *   - Keys are repo-RELATIVE and forward-slashed, so the checkout directory and
 *     the platform separator are both invisible to the hash.
 *   - Sorting happens AFTER that normalisation. Sorting raw platform paths means
 *     Windows orders backslash paths and Linux orders forward-slash ones, and the
 *     order feeding a hash must not depend on the OS.
 *
 * Line endings are normalised for the same reason: git's CRLF/LF conversion must
 * not change the fingerprint, or every checkout flavour would trigger a spurious
 * vault-wide re-render. Hash the text, not the bytes.
 *
 * Extracted from the build config so it can be tested directly. The test asserts
 * that two copies of the same source at different paths agree, which is the
 * property that was broken.
 *
 * @param {string} root Repo root to fingerprint.
 * @returns {string} 12-char hex digest.
 */
import { createHash } from "crypto";
import { readdirSync, statSync, readFileSync } from "fs";
import { join, resolve, relative, sep } from "path";

/** Source trees whose contents can change rendered output. */
const RENDERER_DIRS = ["src/domain", "src/infrastructure/notion", "src/infrastructure/obsidian"];

export function computeRendererVersion(root) {
  const base = resolve(root);
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) found.push(p);
    }
  };
  for (const d of RENDERER_DIRS) walk(resolve(base, d));

  const keyed = found.map((path) => ({
    key: relative(base, path).split(sep).join("/"),
    path,
  }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const h = createHash("sha256");
  for (const { key, path } of keyed) {
    h.update(key);
    h.update(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
  }
  return h.digest("hex").slice(0, 12);
}
