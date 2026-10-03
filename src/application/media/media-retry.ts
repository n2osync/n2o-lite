/**
 * Retry-cap helpers for failedMedia on SyncRecord (F-013).
 *
 * Without these, sync-entry's "re-sync if failedMedia.length > 0" check
 * loops forever for items that will never succeed (permanently-broken S3
 * URL, revoked Notion access, etc.), burning API quota every cycle.
 *
 * Strategy: each FailedMediaItem carries an optional retryCount. After
 * MAX_MEDIA_RETRIES unsuccessful attempts we stop triggering re-syncs for
 * that item; the record is left marked until the user intervenes.
 */

import type { FailedMediaItem } from '../../domain/models/sync-record';

/**
 * How many automatic re-sync retries a failed media item gets before the
 * engine stops scheduling re-syncs for it. A value of 3 means: initial fail
 * (retryCount=0) + 3 retries (1, 2, 3) = 4 attempts total.
 */
export const MAX_MEDIA_RETRIES = 3;

/**
 * True if at least one item is still eligible for an automatic re-sync - i.e. it
 * is NOT a permanent failure (#1780: retrying a 404/gone source can never help)
 * and its retryCount has not yet reached MAX_MEDIA_RETRIES. Permanent items never
 * trigger a re-sync, so a dead URL cannot burn the whole retry budget.
 */
export function hasUnexhaustedRetries(items: FailedMediaItem[] | undefined): boolean {
  if (!items || items.length === 0) return false;
  return items.some((i) => i.class !== 'permanent' && (i.retryCount ?? 0) < MAX_MEDIA_RETRIES);
}

/**
 * Merge the failed-media list from a fresh sync with the previous one.
 *
 *  - Items that failed before AND fail now have retryCount incremented.
 *  - Items that newly fail this pass start at retryCount = 0.
 *  - Items that were in the previous list but not the current one are
 *    assumed to have recovered and are dropped (the record's failedMedia
 *    ought to reflect only still-failing items).
 */
export function mergeFailedMedia(
  previous: FailedMediaItem[] | undefined,
  current: FailedMediaItem[],
): FailedMediaItem[] {
  const prevById = new Map((previous ?? []).map((p) => [p.id, p]));
  return current.map((curr) => {
    const prev = prevById.get(curr.id);
    if (!prev) return { ...curr, retryCount: 0 };
    // Carry a prior dismissal forward so a re-sync of the page does not
    // resurrect an item the user already dismissed (#1780) - but only while the
    // URL is unchanged. A new URL means a different file, so it re-alarms.
    const dismissed = prev.dismissed && prev.url === curr.url ? true : undefined;
    return { ...curr, retryCount: (prev.retryCount ?? 0) + 1, dismissed };
  });
}
