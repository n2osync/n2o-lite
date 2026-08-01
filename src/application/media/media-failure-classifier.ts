/**
 * Classify a media-download failure so the dashboard and the note can tell the
 * user the truth: is this file gone for good (permanent), or will the next sync
 * likely fix it (transient)?
 *
 * Pure: no I/O, no Obsidian imports. Takes what a failed download already knows
 * (the URL, whether the host is Notion's, the error message, and an HTTP status
 * if one was recovered) and returns a class + a plain-words reason.
 */

/** Where a media file lives, from the caller's point of view. */
export type MediaSourceType = 'file' | 'external';

/**
 * A failure is either `permanent` (retrying can never help - the source is gone
 * or forbidden) or `transient` (a timeout, rate limit, 5xx, or an expired Notion
 * signature that refreshes on re-fetch).
 */
export type MediaFailureClass = 'permanent' | 'transient';

export interface MediaFailureClassification {
  class: MediaFailureClass;
  /** Human-readable, user-facing reason. No HTTP jargon beyond the status number. */
  reason: string;
  /** The HTTP status code, when one was recovered from the error. */
  statusCode?: number;
}

/**
 * Pull an HTTP status code out of an unknown caught value.
 *
 * Obsidian's requestUrl throws an object carrying `.status` on a non-2xx
 * response, so that is the primary source. Falls back to `.statusCode` and, last,
 * to a "status NNN" substring in the message (some wrappers only stringify it).
 */
export function extractStatusCode(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const withStatus = error as { status?: unknown; statusCode?: unknown };
    if (typeof withStatus.status === 'number') return withStatus.status;
    if (typeof withStatus.statusCode === 'number') return withStatus.statusCode;
  }
  const msg = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const match = msg.match(/status[:\s]+(\d{3})\b/i);
  if (match?.[1]) return Number(match[1]);
  return undefined;
}

/** The Notion-controlled hosts whose file signatures expire and refresh on re-fetch. */
function isNotionHostedUrl(url: string, sourceType: MediaSourceType | undefined): boolean {
  if (sourceType === 'file') return true;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host.endsWith('amazonaws.com') ||
    host.endsWith('notion.so') ||
    host.endsWith('notion-static.com') ||
    host.endsWith('notion.site')
  );
}

/** Best-effort host label for a reason string; falls back to "the source" when the URL won't parse. */
function hostLabel(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'the source';
  }
}

/** DNS / name-resolution failures - the host itself does not resolve. */
function isDnsFailure(message: string): boolean {
  return /ENOTFOUND|getaddrinfo|ERR_NAME_NOT_RESOLVED|net::ERR_NAME|EAI_AGAIN/i.test(message);
}

/**
 * Classify a failed media download.
 *
 * @param url        The source URL that failed.
 * @param error      The human-readable error message (already extracted).
 * @param statusCode The HTTP status, if the caller recovered one.
 * @param sourceType 'file' for Notion-hosted media, 'external' otherwise.
 */
export function classifyMediaFailure(params: {
  url: string;
  error: string;
  statusCode?: number;
  sourceType?: MediaSourceType;
}): MediaFailureClassification {
  const { url, error, statusCode, sourceType } = params;
  const notionHosted = isNotionHostedUrl(url, sourceType);
  const host = hostLabel(url);

  // Blocked / malformed URL (SSRF guard, bad scheme). Retrying can't help - the
  // URL itself is the problem, fixable only in Notion.
  if (/Invalid media URL|Blocked media URL/i.test(error)) {
    return {
      class: 'permanent',
      reason: `The media link is not valid or is blocked (${host}). Fix or remove it in Notion.`,
      statusCode,
    };
  }

  if (statusCode !== undefined) {
    // 404 gone, 410 gone-for-good: the source file no longer exists.
    if (statusCode === 404 || statusCode === 410) {
      return {
        class: 'permanent',
        reason: `The source file no longer exists (${statusCode} from ${host}). Fix or remove it in Notion.`,
        statusCode,
      };
    }
    // 403 forbidden. On Notion's own hosts this is almost always an expired
    // signature that refreshes on the next fetch, so it is transient there;
    // on an external host it is a real access block.
    if (statusCode === 403) {
      return notionHosted
        ? {
            class: 'transient',
            reason: 'Temporary - the file link expired. N2O will refresh it on the next sync.',
            statusCode,
          }
        : {
            class: 'permanent',
            reason: `Access to the source file is forbidden (403 from ${host}). Fix or remove it in Notion.`,
            statusCode,
          };
    }
    // 429 and 5xx: server-side, retryable.
    if (statusCode === 429) {
      return {
        class: 'transient',
        reason:
          'Temporary - the source rate-limited the download. N2O will retry on the next sync.',
        statusCode,
      };
    }
    if (statusCode >= 500 && statusCode <= 599) {
      return {
        class: 'transient',
        reason: `Temporary - the source server errored (${statusCode}). N2O will retry on the next sync.`,
        statusCode,
      };
    }
    // Other 4xx (400, 401, 451, ...): the request itself is refused and a
    // re-fetch of the same URL will be refused the same way.
    if (statusCode >= 400 && statusCode <= 499) {
      return {
        class: 'permanent',
        reason: `The source refused the download (${statusCode} from ${host}). Fix or remove it in Notion.`,
        statusCode,
      };
    }
  }

  // DNS: the host does not resolve. Permanent unless the domain comes back, which
  // is not something N2O can wait on.
  if (isDnsFailure(error)) {
    return {
      class: 'permanent',
      reason: `The source host could not be found (${host}). Fix or remove it in Notion.`,
      statusCode,
    };
  }

  // Timeouts and empty bodies: transient network hiccups.
  if (/timed out|timeout/i.test(error)) {
    return {
      class: 'transient',
      reason: 'Temporary - the download timed out. N2O will retry on the next sync.',
      statusCode,
    };
  }
  if (/Empty response body/i.test(error)) {
    return {
      class: 'transient',
      reason: 'Temporary - the source returned an empty response. N2O will retry on the next sync.',
      statusCode,
    };
  }

  // Unknown. Default to transient so N2O keeps trying rather than permanently
  // giving up on something that may well be fixable - never cry "gone" on a
  // failure we do not understand.
  return { class: 'transient', reason: 'Temporary - N2O will retry on the next sync.', statusCode };
}
