/**
 * Pro installer - user-initiated upgrade to the full N2O Sync plugin.
 *
 * Downloads the latest N2O Sync release from its public GitHub releases
 * (github.com/n2osync/n2o) and installs it into this vault's plugin folder,
 * exactly like BRAT would. Nothing is fetched until the user clicks Install
 * in the upgrade modal, and nothing is written to disk until every
 * downloaded file passes verification:
 *
 *   - manifest.json parses and its id is exactly `n2o`
 *   - main.js is larger than 100 KB
 *   - sql-wasm.wasm's SHA-256 matches the pinned sql.js hash
 *   - styles.css is non-empty
 *
 * Lite is NOT disabled after a successful install - the pro-guard already
 * makes Lite's sync dormant while the full plugin is enabled, and the
 * Pro-side state handover runs from the full edition.
 */

import { Notice, requestUrl } from 'obsidian';
import type { App } from 'obsidian';
import { SQL_WASM_SHA256 } from '../infrastructure/storage/database-manager';
import { PRO_PLUGIN_ID, isProPluginActive } from './pro-guard';

import { getErrorMessage } from '../shared/errors';
import { createLogger } from '../shared/logger';
import { NOTICE_LONG } from '../shared/constants';
import { PLUGIN_ID } from '../shared/plugin-metadata';

/** This plugin's own id - what the handover disables before enabling Pro. */
const LITE_PLUGIN_ID = PLUGIN_ID;

const log = createLogger('ProInstaller');

/** Latest-release endpoint of the full edition's public repo. */
const RELEASE_API_URL = 'https://api.github.com/repos/n2osync/n2o/releases/latest';

/** Every release asset the install needs. Missing any one aborts. */
export const REQUIRED_ASSETS = ['main.js', 'manifest.json', 'styles.css', 'sql-wasm.wasm'] as const;
export type RequiredAsset = (typeof REQUIRED_ASSETS)[number];

/** main.js below this size cannot be the real bundle - reject as corrupt. */
const MIN_MAIN_JS_BYTES = 100 * 1024;

/** Per-step progress reporter for the upgrade modal. */
export type InstallProgressFn = (message: string) => void;

/** Install outcome: whether the plugin could also be auto-enabled. */
export interface InstallResult {
  enabled: boolean;
}

/**
 * Where the full plugin stands in this vault right now. `installed` means
 * the manifest is present but the plugin is not enabled.
 */
export function getProPluginStatus(app: App): 'enabled' | 'installed' | 'absent' {
  if (isProPluginActive(app)) return 'enabled';
  const plugins = (app as unknown as { plugins?: { manifests?: unknown } }).plugins;
  const manifests = plugins?.manifests;
  if (
    manifests &&
    typeof manifests === 'object' &&
    PRO_PLUGIN_ID in (manifests as Record<string, unknown>)
  ) {
    return 'installed';
  }
  return 'absent';
}

/**
 * Resolve the download URL of every required asset from a GitHub release
 * response. Throws with the missing asset's name so the user knows the
 * release itself is broken, not their connection.
 */
export function resolveReleaseAssets(release: unknown): Record<RequiredAsset, string> {
  const assets = (release as { assets?: unknown } | null)?.assets;
  const list = Array.isArray(assets)
    ? (assets as { name?: unknown; browser_download_url?: unknown }[])
    : [];
  const urls = {} as Record<RequiredAsset, string>;
  for (const name of REQUIRED_ASSETS) {
    const match = list.find((a) => a.name === name);
    const url = match?.browser_download_url;
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error(
        `The latest N2O Sync release is missing "${name}". ` +
          'This is a release packaging problem, not something on your end - ' +
          'try again later or install manually from n2osync.com.',
      );
    }
    urls[name] = url;
  }
  return urls;
}

/**
 * Verify every downloaded file BEFORE anything touches disk. Throws with
 * a what/why/what-now message on the first failure.
 */
export async function verifyDownloads(files: Record<RequiredAsset, ArrayBuffer>): Promise<void> {
  // manifest.json: must parse and identify the full edition.
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  } catch (err) {
    throw new Error(
      'The downloaded manifest.json is not valid JSON ' +
        `(${getErrorMessage(err)}). The download may be corrupted - try again.`,
    );
  }
  const id = (manifest as { id?: unknown } | null)?.id;
  if (id !== PRO_PLUGIN_ID) {
    throw new Error(
      `The downloaded manifest.json identifies plugin "${String(id)}" instead of "${PRO_PLUGIN_ID}". ` +
        'Refusing to install it - try again later or install manually from n2osync.com.',
    );
  }

  // main.js: a real bundle is well over 100 KB.
  const mainSize = files['main.js'].byteLength;
  if (mainSize <= MIN_MAIN_JS_BYTES) {
    throw new Error(
      `The downloaded main.js is only ${mainSize.toLocaleString()} bytes - too small to be the real plugin. ` +
        'The download may be corrupted or truncated - try again.',
    );
  }

  // styles.css: just has to exist with content.
  if (files['styles.css'].byteLength === 0) {
    throw new Error(
      'The downloaded styles.css is empty. The download may be corrupted - try again.',
    );
  }

  // sql-wasm.wasm: byte-exact pin. The wasm executes inside Obsidian, so a
  // hash mismatch is a hard stop, never a warning.
  const digest = await crypto.subtle.digest('SHA-256', files['sql-wasm.wasm']);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== SQL_WASM_SHA256) {
    throw new Error(
      'sql-wasm.wasm failed its SHA-256 integrity check. The download failed verification, ' +
        'so nothing was installed - try again, and if it keeps failing install manually from n2osync.com.',
    );
  }
}

/**
 * Full install flow: fetch the latest release, download all four assets,
 * verify everything, then write the files and enable the plugin. Throws
 * on any failure BEFORE the write phase with nothing on disk; the modal
 * shows the error inline with a Retry.
 */
export async function installProPlugin(
  app: App,
  onProgress: InstallProgressFn,
): Promise<InstallResult> {
  onProgress('Fetching release info...');
  const releaseRes = await requestUrl({
    url: RELEASE_API_URL,
    headers: { Accept: 'application/vnd.github+json' },
    throw: false,
  });
  if (releaseRes.status !== 200) {
    throw new Error(
      `GitHub returned HTTP ${releaseRes.status} while fetching the latest N2O Sync release. ` +
        'Check your internet connection and try again.',
    );
  }
  const urls = resolveReleaseAssets(releaseRes.json);

  const files = {} as Record<RequiredAsset, ArrayBuffer>;
  let i = 0;
  for (const name of REQUIRED_ASSETS) {
    i++;
    onProgress(`Downloading ${name} (${i} of ${REQUIRED_ASSETS.length})...`);
    const res = await requestUrl({ url: urls[name], throw: false });
    if (res.status !== 200) {
      throw new Error(
        `Downloading ${name} failed (HTTP ${res.status}). ` +
          'Check your internet connection and try again.',
      );
    }
    files[name] = res.arrayBuffer;
  }

  onProgress('Verifying downloads...');
  await verifyDownloads(files);

  // Only now, with all four files verified, does anything touch disk.
  onProgress('Installing...');
  const adapter = app.vault.adapter;
  // Resolve under the vault's config dir - it is not always ".obsidian".
  const proPluginDir = `${app.vault.configDir}/plugins/${PRO_PLUGIN_ID}`;
  if (!(await adapter.exists(proPluginDir))) {
    await adapter.mkdir(proPluginDir);
  }
  for (const name of REQUIRED_ASSETS) {
    await adapter.writeBinary(`${proPluginDir}/${name}`, files[name]);
  }
  log.info(
    `Installed N2O Sync ${(files['main.js'].byteLength / 1024).toFixed(0)} KB bundle to ${proPluginDir}`,
  );

  onProgress('Preparing N2O Sync...');
  // loadManifests/enablePluginAndSave are not public API - type defensively
  // and fall back to a manual-enable instruction when they are unavailable.
  // Enabling is deliberately NOT done here: both editions register the same
  // obsidian:// OAuth action (and would race other shared surfaces), so the
  // caller must disable Lite FIRST and only then call enableProPlugin - the
  // two plugins never run their onload at the same time.
  const plugins = getPluginApi(app);
  if (
    typeof plugins?.loadManifests === 'function' &&
    typeof plugins?.enablePluginAndSave === 'function'
  ) {
    await plugins.loadManifests();
    // No notice here, deliberately. This point is several seconds before the
    // handover actually runs, and the message that used to fire here was
    // written in the present tense about a switch that had not happened yet:
    // "N2O Sync Lite is turning itself off" while Lite was still the plugin
    // printing it. It also promised that settings and sync data stay on disk
    // "for N2O Sync to pick up", which nothing on the Pro side does today.
    // handOverToPro says what happened, once it has happened.
    return { enabled: true };
  }

  log.warn('Obsidian plugin API for enabling is unavailable - asking the user to enable manually');
  new Notice(
    'N2O Sync is installed, but Obsidian did not let N2O Sync Lite enable it automatically. ' +
      'Enable "N2O Sync" under Settings, then Community plugins.',
    NOTICE_LONG,
  );
  return { enabled: false };
}

/** Defensively typed access to Obsidian's non-public plugin management API. */
function getPluginApi(app: App):
  | {
      loadManifests?: () => Promise<void>;
      enablePluginAndSave?: (id: string) => Promise<void>;
      disablePluginAndSave?: (id: string) => Promise<void>;
    }
  | undefined {
  return (
    app as unknown as {
      plugins?: {
        loadManifests?: () => Promise<void>;
        enablePluginAndSave?: (id: string) => Promise<void>;
        disablePluginAndSave?: (id: string) => Promise<void>;
      };
    }
  ).plugins;
}

/**
 * The handover: disable Lite, THEN enable the full edition. Called from a
 * raw window timer that survives Lite's own unload. Ordering is the point -
 * with zero overlap there is no view-type or protocol-handler collision.
 */
export async function handOverToPro(app: App): Promise<void> {
  const plugins = getPluginApi(app);
  if (!plugins?.enablePluginAndSave) return;
  try {
    await plugins.disablePluginAndSave?.(LITE_PLUGIN_ID);
  } catch (err) {
    log.warn(`Could not disable N2O Sync Lite before the handover: ${getErrorMessage(err)}`);
  }
  try {
    await plugins.enablePluginAndSave(PRO_PLUGIN_ID);
  } catch (err) {
    new Notice(
      'N2O Sync could not be enabled automatically: ' +
        getErrorMessage(err) +
        ' Enable "N2O Sync" under Settings, then Community plugins.',
      NOTICE_LONG,
    );
    return;
  }

  // Said here, and only here, because here is where it becomes true. The UI is
  // changing under the reader at this exact moment, which is the only moment an
  // explanation of it is worth anything.
  new Notice('N2O Sync is running. N2O Sync Lite has been turned off.');
}
