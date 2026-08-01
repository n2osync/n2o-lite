/**
 * SyncHealth - sliding-window rollup over sync history.
 *
 * Computed from SyncHistoryEntry rows already persisted in the history
 * database. Pure function so unit tests can pin behavior without a DB.
 *
 * The user-facing surface is a small dashboard section ("SYNC HEALTH / 7d")
 * that gives users a single glance at whether the plugin has been
 * working over a meaningful window - not just "did the last sync
 * succeed." Different from the existing per-sync error count because
 * a workspace can have a clean last sync after a week of failures.
 */

import type { SyncHistoryEntry } from '../../infrastructure/storage/sync-history';

export interface SyncHealthRollup {
  /** Window length used to compute this rollup (days). */
  windowDays: number;
  /** Total sync ticks in window. Zero means no data - UI should hide the section. */
  syncCount: number;
  /** Ticks where result.success was true AND no errors were reported. */
  cleanCount: number;
  /** Ticks where result.success was true but errors[] was non-empty (partial-success path). */
  partialCount: number;
  /** Ticks where result.success was false. */
  failureCount: number;
  /** Sum of pagesSynced across ticks. */
  totalPagesSynced: number;
  /** Sum of pagesFailed across ticks. */
  totalPagesFailed: number;
  /** Mean duration of in-window ticks (ms). 0 when syncCount = 0. */
  avgDurationMs: number;
  /** Slowest tick's duration (ms). 0 when syncCount = 0. */
  maxDurationMs: number;
  /** ISO timestamp of the most recent successful tick. Null when none in window. */
  lastSuccessAt: string | null;
  /** ISO timestamp of the most recent failed tick. Null when none in window. */
  lastFailureAt: string | null;
}

const EMPTY_ROLLUP: Omit<SyncHealthRollup, 'windowDays'> = {
  syncCount: 0,
  cleanCount: 0,
  partialCount: 0,
  failureCount: 0,
  totalPagesSynced: 0,
  totalPagesFailed: 0,
  avgDurationMs: 0,
  maxDurationMs: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
};

/**
 * Compute the rollup over entries falling within `windowDays` of `now`.
 * Entries outside the window are ignored. Stable when entries are
 * empty or all out-of-window - returns a zeroed rollup the dashboard
 * can render as "no recent activity."
 */
export function computeHealthRollup(
  entries: SyncHistoryEntry[],
  now: Date,
  windowDays = 7,
): SyncHealthRollup {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const inWindow = entries.filter((e) => {
    const ts = Date.parse(e.timestamp);
    return Number.isFinite(ts) && ts >= cutoff;
  });

  if (inWindow.length === 0) {
    return { windowDays, ...EMPTY_ROLLUP };
  }

  let cleanCount = 0;
  let partialCount = 0;
  let failureCount = 0;
  let totalPagesSynced = 0;
  let totalPagesFailed = 0;
  let totalDurationMs = 0;
  let maxDurationMs = 0;
  let lastSuccessAt: string | null = null;
  let lastFailureAt: string | null = null;

  for (const entry of inWindow) {
    const r = entry.result;
    const hasErrors = (r.errors?.length ?? 0) > 0;
    if (r.success && !hasErrors) cleanCount++;
    else if (r.success && hasErrors) partialCount++;
    else failureCount++;

    totalPagesSynced += entry.pagesSynced;
    totalPagesFailed += entry.pagesFailed;
    totalDurationMs += entry.duration;
    if (entry.duration > maxDurationMs) maxDurationMs = entry.duration;

    if (r.success) {
      if (!lastSuccessAt || entry.timestamp > lastSuccessAt) lastSuccessAt = entry.timestamp;
    } else {
      if (!lastFailureAt || entry.timestamp > lastFailureAt) lastFailureAt = entry.timestamp;
    }
  }

  return {
    windowDays,
    syncCount: inWindow.length,
    cleanCount,
    partialCount,
    failureCount,
    totalPagesSynced,
    totalPagesFailed,
    avgDurationMs: Math.round(totalDurationMs / inWindow.length),
    maxDurationMs,
    lastSuccessAt,
    lastFailureAt,
  };
}
