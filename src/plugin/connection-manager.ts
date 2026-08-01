/**
 * ConnectionManager - Notion connection testing, workspace caching,
 * and OAuth flow.
 *
 * Extracted from main.ts to keep the plugin class slim.
 */

import { Notice, requestUrl } from 'obsidian';
import { openExternalUrl } from '../shared/electron-cookies';
import { NOTICE_MEDIUM } from '../shared/constants';
import type { ConnectionHost } from './plugin-host';
import { createOAuthProfile } from '../domain/models/config-schema';
import type { SelectedSyncItem } from '../settings';
import { NotionDiscovery } from '../application/discovery/discovery';
import type { CachedPage } from '../infrastructure/storage/page-cache-store';
import { normalizeNotionId } from '../domain/models/notion-id';
import { createLogger } from '../shared/logger';
import { LICENSE_SERVER_URL } from '../shared/constants';

/** Shape of the OAuth token retrieval response from the license server. */
export interface OAuthTokenResponse {
  success: boolean;
  accessToken?: string;
  botId?: string;
  workspaceId?: string;
  workspaceName?: string;
  ownerName?: string | null;
  ownerEmail?: string | null;
  userToken?: string;
  error?: string;
}

/*
 * The server also returns `tier`, `trialExpiresAt` and `licenseKey`. Lite has no
 * licence system and read none of the three, so parsing them was dead weight on
 * the wire that also named our payment provider in public source (#1913). They
 * are deliberately not in the type: if Lite ever needs an entitlement, that is a
 * decision to make on purpose, not a field that happens to already be parsed.
 */

/** Validate and parse a raw JSON response into OAuthTokenResponse. */
export function parseOAuthTokenResponse(raw: unknown): OAuthTokenResponse {
  if (!raw || typeof raw !== 'object') {
    throw new Error('OAuth token response is not an object');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.success !== 'boolean') {
    throw new Error('OAuth token response missing boolean "success" field');
  }
  return {
    success: obj.success,
    accessToken: typeof obj.accessToken === 'string' ? obj.accessToken : undefined,
    botId: typeof obj.botId === 'string' ? obj.botId : undefined,
    workspaceId: typeof obj.workspaceId === 'string' ? obj.workspaceId : undefined,
    workspaceName: typeof obj.workspaceName === 'string' ? obj.workspaceName : undefined,
    ownerName:
      typeof obj.ownerName === 'string' ? obj.ownerName : obj.ownerName === null ? null : undefined,
    ownerEmail:
      typeof obj.ownerEmail === 'string'
        ? obj.ownerEmail
        : obj.ownerEmail === null
          ? null
          : undefined,
    userToken: typeof obj.userToken === 'string' ? obj.userToken : undefined,
    error: typeof obj.error === 'string' ? obj.error : undefined,
  };
}

const log = createLogger('Connection');

const SERVER_BASE = LICENSE_SERVER_URL;

/**
 * Test the Notion API connection using the configured token.
 */
export async function testConnection(
  plugin: ConnectionHost,
): Promise<{ success: boolean; detail: string; workspaceName?: string }> {
  if (!plugin.profile.notionToken) {
    return { success: false, detail: 'No API token configured.' };
  }
  const client = plugin.getNotionClient();
  // Capture the currently-authenticated token so we can restore it if the
  // candidate fails validation (#1535).
  const previousToken = client.getToken();
  client.setToken(plugin.profile.notionToken);
  try {
    const me = await client.getMe();
    const botName = me.name ?? 'Unknown Bot';
    const workspaceName = me.bot?.workspace_name ?? me.workspace_name ?? undefined;
    const detail = workspaceName
      ? `Connected as ${botName} (${workspaceName})`
      : `Connected as ${botName}`;
    plugin.cachedWorkspaceName = workspaceName ?? null;
    void plugin.getDashboardManager().refreshDashboardPanels();
    return { success: true, detail, workspaceName };
  } catch (error) {
    // Restore the previously-authenticated token so a failed re-test doesn't
    // leave the live client stuck on the rejected token, silently failing
    // background sync while the profile still looks connected (#1535).
    client.setToken(previousToken);
    if (error && typeof error === 'object' && 'statusCode' in error) {
      const status = (error as { statusCode: number }).statusCode;
      if (status === 401) {
        return {
          success: false,
          detail: "Invalid token - check the token is correct and hasn't been revoked.",
        };
      }
      if (status === 403) {
        return {
          success: false,
          detail: "Token lacks permissions. Re-check your integration's capabilities.",
        };
      }
      return { success: false, detail: `Notion API error (${status})` };
    }
    return {
      success: false,
      detail: 'Network error - check your internet connection.',
    };
  }
}

// ── OAuth Flow ──────────────────────────────────────────

/**
 * Start the OAuth flow by opening the user's browser to the Vercel server,
 * which redirects to Notion's authorization page.
 */
export function startOAuthFlow(): void {
  openExternalUrl(`${SERVER_BASE}/api/oauth/start`);
}

/**
 * Handle the OAuth callback from the obsidian:// protocol handler.
 * Retrieves tokens from the server and stores them in the active profile.
 */
/**
 * Normalise an OAuth session id received via the obsidian:// protocol
 * handler. Returns the cleaned hex string when the shape is plausible,
 * or null when the input is too far gone to send to the server.
 *
 * Server emits a 64-char lowercase hex string (32 random bytes × 2 hex
 * digits) - see server/n2o-lic/api/oauth/callback.ts. The obsidian://
 * hand-off has been observed to mutate the URL on some Win 11 + Edge
 * configurations (issue #1: trailing whitespace, partial percent-
 * encoding). Trim incidental whitespace and accept any hex shape
 * between 32 and 128 chars so a one-off browser quirk doesn't lock the
 * user out. The server's /api/oauth/token endpoint is the authoritative
 * validator - a session that doesn't exist in Redis (truly malformed,
 * expired, or replayed) will fail there with a clear error.
 */
export function normaliseOAuthSession(input: string | null | undefined): string | null {
  const trimmed = (input ?? '').trim();
  return /^[a-f0-9]{32,128}$/i.test(trimmed) ? trimmed : null;
}

export async function handleOAuthCallback(
  plugin: ConnectionHost,
  sessionId: string,
): Promise<{
  success: boolean;
  detail: string;
  discoveredPages?: number;
  discoveredDatabases?: number;
}> {
  const cleanSession = normaliseOAuthSession(sessionId);
  if (cleanSession === null) {
    const raw = (sessionId ?? '').trim();
    log.warn(
      `OAuth callback received an unexpected session shape ` +
        `(length=${raw.length}, head=${JSON.stringify(raw.slice(0, 8))}). ` +
        `Aborting before server round-trip. See issue #1.`,
    );
    return { success: false, detail: 'Invalid session ID format.' };
  }

  try {
    // Retrieve tokens from Vercel (one-time, deleted after retrieval)
    // client/version identify Lite connects server-side (free-tier user
    // creation instead of a trial); emailOptIn carries the connect-flow
    // checkbox - the server subscribes the email only when true. The
    // current server ignores unknown fields, so this is forward-compatible.
    const response = await requestUrl({
      url: `${SERVER_BASE}/api/oauth/token`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: cleanSession,
        client: 'n2o-lite', // server license OAuth client id (wire value), not the plugin id
        version: plugin.version,
        emailOptIn: plugin.settings.newsletterOptIn === true,
      }),
    });

    const data = parseOAuthTokenResponse(response.json);

    if (!data.success || !data.accessToken) {
      return { success: false, detail: data.error ?? 'Failed to retrieve tokens from server.' };
    }

    // Three-tier profile matching:
    // 1. Exact OAuth re-auth (same workspace, same auth type)
    // 2. Single-profile upgrade (first-install case - upgrade in-place, keep all settings)
    // 3. Multi-workspace new profile (future - multiple profiles, none match)
    let targetProfile = plugin.settings.profiles.find(
      (p) => p.oauthWorkspaceId === data.workspaceId && p.authType === 'oauth',
    );

    if (targetProfile) {
      // Tier 1: re-auth existing OAuth profile - update token only
      targetProfile.notionToken = data.accessToken;
      targetProfile.oauthBotId = data.botId ?? '';
      targetProfile.workspaceName = data.workspaceName;
    } else if (plugin.settings.profiles.length === 1 && plugin.settings.profiles[0]) {
      // Tier 2: single profile - upgrade in-place (keeps syncFolder, etc.)
      targetProfile = plugin.settings.profiles[0];
      targetProfile.authType = 'oauth';
      targetProfile.notionToken = data.accessToken;
      targetProfile.oauthBotId = data.botId ?? '';
      targetProfile.oauthWorkspaceId = data.workspaceId ?? '';
      targetProfile.workspaceName = data.workspaceName;
      if (targetProfile.name === 'Notion' || targetProfile.name === 'Default') {
        targetProfile.name = data.workspaceName || targetProfile.name;
      }
    } else {
      // Tier 3: multi-workspace - create new profile
      const profileId = crypto.randomUUID();
      const profileName = data.workspaceName || 'Notion Workspace';
      targetProfile = createOAuthProfile(
        profileId,
        profileName,
        data.accessToken,
        data.botId ?? '',
        data.workspaceId ?? '',
      );
      plugin.settings.profiles.push(targetProfile);
    }

    plugin.settings.activeProfileId = targetProfile.id;

    // Store owner info from OAuth response (available for display)
    if (data.ownerName) targetProfile.workspaceOwnerName = data.ownerName;
    if (data.ownerEmail) targetProfile.workspaceOwnerEmail = data.ownerEmail;

    await plugin.saveSettings();

    // Test the connection to confirm everything works
    const connectionResult = await testConnection(plugin);
    if (connectionResult.success) {
      // Auto-discover accessible content via the shared lock: if startup
      // already kicked off a discovery (page cache empty at layout-ready),
      // we await that one instead of spawning a second.
      await plugin.runSharedDiscovery();
      const cache = plugin.getDatabase?.()?.getPageCacheStore?.();
      const totalCached = cache?.count?.() ?? 0;
      const dbCount = cache?.getAllDatabases?.().length ?? 0;
      const pageCount = Math.max(0, totalCached - dbCount);
      const countDetail =
        totalCached > 0 ? ` Found ${pageCount} pages and ${dbCount} databases.` : '';
      new Notice(
        `N2O: Connected to ${data.workspaceName ?? 'Notion'} via OAuth!${countDetail}`,
        NOTICE_MEDIUM,
      );
      return {
        success: true,
        detail: `Connected to ${data.workspaceName ?? 'Notion'} via OAuth`,
        discoveredPages: pageCount,
        discoveredDatabases: dbCount,
      };
    }

    return {
      success: false,
      detail: `OAuth tokens received but connection test failed: ${connectionResult.detail}`,
    };
  } catch (error) {
    log.error('OAuth callback failed', error);
    return { success: false, detail: 'OAuth connection failed. Check the console for details.' };
  }
}

/**
 * Discover all accessible pages and databases after OAuth.
 * Returns counts and items for display purposes - does NOT persist to profile.
 * Callers decide whether to save discovery results to selectedItems.
 *
 * If the plugin provides getDatabase(), results are persisted to the page cache
 * so the tree picker can load instantly on next open.
 */
export async function discoverAccessibleContent(
  plugin: {
    getNotionClient(): import('../infrastructure/notion/client').NotionClient;
    getDatabase?(): import('../infrastructure/storage/core-database').CoreDatabase;
  },
  onProgress?: (message: string) => void,
): Promise<{ pageCount: number; dbCount: number; items: SelectedSyncItem[] } | null> {
  try {
    const discovery = new NotionDiscovery(plugin.getNotionClient());
    if (onProgress) discovery.onProgress(onProgress);
    const result = await discovery.discoverAll();

    const items: SelectedSyncItem[] = [];

    for (const db of result.databases) {
      items.push({
        id: db.notionId,
        title: db.title,
        type: 'database',
        itemCount: result.databaseItems.get(db.notionId)?.length ?? 0,
      });
    }

    for (const page of result.pages) {
      items.push({
        id: page.notionId,
        title: page.title,
        type: 'page',
      });
    }

    log.info(
      `Post-OAuth discovery: ${result.pages.length} pages, ${result.databases.length} databases`,
    );

    // Persist to page cache if database is available and initialized
    if (plugin.getDatabase) {
      try {
        const pageCacheStore = plugin.getDatabase().getPageCacheStore();
        const now = new Date().toISOString();
        const cachedPages: CachedPage[] = [];

        for (const db of result.databases) {
          cachedPages.push({
            notionId: normalizeNotionId(db.notionId),
            title: db.title,
            itemType: 'database',
            parentType: null,
            parentId: null,
            itemCount: result.databaseItems.get(db.notionId)?.length ?? null,
            lastEdited: db.lastEditedTime,
            discoveredAt: now,
          });
        }

        for (const page of result.pages) {
          cachedPages.push({
            notionId: normalizeNotionId(page.notionId),
            title: page.title,
            itemType: 'page',
            parentType: page.parentType,
            parentId: page.parentId ? normalizeNotionId(page.parentId) : null,
            itemCount: null,
            lastEdited: page.lastEditedTime,
            discoveredAt: now,
          });
        }

        // Cache database items (pages inside databases)
        for (const [dbId, dbItems] of result.databaseItems) {
          for (const item of dbItems) {
            cachedPages.push({
              notionId: normalizeNotionId(item.notionId),
              title: item.title,
              itemType: 'database-item',
              parentType: 'database',
              parentId: normalizeNotionId(dbId),
              itemCount: null,
              lastEdited: item.lastEditedTime,
              discoveredAt: now,
            });
          }
        }

        pageCacheStore.upsertPages(cachedPages);

        // Prune pages that are no longer accessible
        const currentIds = new Set(cachedPages.map((p) => p.notionId));
        pageCacheStore.removeMissing(currentIds);

        pageCacheStore.setLastDiscoveryTime(now);
        log.info(`Page cache updated: ${cachedPages.length} items`);
      } catch (cacheErr) {
        log.warn('Failed to update page cache (non-fatal)', cacheErr);
      }
    }

    // Total page count includes standalone pages + all database items
    let totalDbItems = 0;
    for (const [, dbItems] of result.databaseItems) {
      totalDbItems += dbItems.length;
    }

    return {
      pageCount: result.pages.length + totalDbItems,
      dbCount: result.databases.length,
      items,
    };
  } catch (error) {
    log.warn('Post-OAuth discovery failed (non-fatal)', error);
    return null;
  }
}

/**
 * Disconnect an OAuth profile - clears OAuth tokens but keeps the profile.
 */
export async function disconnectOAuth(plugin: ConnectionHost): Promise<void> {
  const profile = plugin.profile;
  if (profile.authType !== 'oauth') return;

  profile.notionToken = '';
  profile.oauthBotId = '';
  profile.oauthWorkspaceId = '';
  profile.authType = 'internal';
  await plugin.saveSettings();
  plugin.getNotionClient().setToken('');
  new Notice('N2O: Disconnected from Notion OAuth.', NOTICE_MEDIUM);
}
