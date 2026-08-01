/**
 * Pure display helpers used by the dashboard view.
 *
 * Kept separate from dashboard.ts so they can be unit-tested directly
 * without standing up an ItemView + plugin context.
 */

/** Map an orchestrator sync state to the corresponding CSS class for the status dot. */
export function getStatusDotClass(state: string): string {
  switch (state) {
    case 'syncing':
      return 'n2o-dash-dot--syncing';
    case 'paused':
      return 'n2o-dash-dot--paused';
    case 'error':
      return 'n2o-dash-dot--error';
    default:
      return 'n2o-dash-dot--idle';
  }
}

/**
 * Map an orchestrator sync state to a short human-readable status label.
 *
 * Accepts an optional phase (from SyncRunStatus.phase) so the 'syncing'
 * state can surface "Discovering..." / "Writing files..." / "Finalizing..."
 * instead of a generic "Syncing..." spinner. The generic fallback is used
 * when phase is absent or 'idle' (phase is only meaningful inside the
 * 'syncing' state - callers can just pass it unconditionally).
 */
export function getStatusLabel(
  state: string,
  phase?: import('../domain/models/sync-result').SyncPhase,
): string {
  if (state === 'syncing') return getSyncingLabel(phase);
  switch (state) {
    case 'paused':
      return 'Paused';
    case 'error':
      return 'Error';
    default:
      return 'Ready';
  }
}

/**
 * Human label for a specific sync phase. Exported so the dashboard can
 * embed phase strings into richer layouts (e.g. progress bars) without
 * re-deriving them. Returns the generic spinner label when no phase has
 * been reported yet.
 */
export function getSyncingLabel(phase?: import('../domain/models/sync-result').SyncPhase): string {
  switch (phase) {
    case 'waiting-on-discovery':
      return 'Getting ready...';
    case 'discovering':
      return 'Scanning Notion...';
    case 'applying':
      return 'Writing files...';
    case 'finalizing':
      return 'Wrapping up...';
    default:
      return 'Syncing...';
  }
}

/**
 * Pull the pass number out of a sync progress message. The orchestrator
 * emits messages like "Pass 1 - syncing 50 selected items" or
 * "Pass 2 - scanning 14 pages for nested content" during the multi-pass
 * discovery loop. Returns null when the message has no Pass prefix
 * (discovery, finalizing, single-pass syncs).
 */
export function extractPassNumber(message: string | undefined | null): number | null {
  if (!message) return null;
  const m = message.match(/^Pass\s+(\d+)\b/);
  return m ? parseInt(m[1] ?? '', 10) : null;
}

/** One failed-media item flattened with the page it belongs to (#1780). */
export interface FailedMediaRow {
  page: string;
  notionId: string;
  obsidianPath: string;
  item: import('../domain/models/sync-record').FailedMediaItem;
}

/**
 * Split the dashboard's failed-media entries into two honest buckets (#1780):
 *   - transient: a timeout / 5xx / expired Notion signature - N2O will retry.
 *   - permanent: a 404 / gone / forbidden source - Retry is a dead end.
 * Anything not explicitly classified `permanent` counts as transient, so an
 * unclassified failure defaults to "will retry" rather than "gone" - we never
 * cry wolf on a failure we do not understand. Pure, so the split is unit-tested
 * without standing up the view.
 */
export function partitionFailedMedia(
  entries: {
    pageName: string;
    notionId: string;
    obsidianPath: string;
    items: import('../domain/models/sync-record').FailedMediaItem[];
  }[],
): { transient: FailedMediaRow[]; permanent: FailedMediaRow[] } {
  const transient: FailedMediaRow[] = [];
  const permanent: FailedMediaRow[] = [];
  for (const entry of entries) {
    for (const item of entry.items) {
      const row: FailedMediaRow = {
        page: entry.pageName,
        notionId: entry.notionId,
        obsidianPath: entry.obsidianPath,
        item,
      };
      (item.class === 'permanent' ? permanent : transient).push(row);
    }
  }
  return { transient, permanent };
}

/** Turn an internal media type slug into a display string for the failed-media list. */
export function humanizeMediaType(type: string): string {
  switch (type) {
    case 'cover':
      return 'Cover image';
    case 'icon':
      return 'Page icon';
    case 'image':
      return 'Image';
    case 'video':
      return 'Video';
    case 'audio':
      return 'Audio';
    case 'file':
      return 'File';
    case 'pdf':
      return 'PDF';
    case 'file-property':
      return 'File attachment';
    default:
      return type;
  }
}

/**
 * Decide whether the dashboard should render the pre-connection onboarding
 * flow (hero / choose / oauth-waiting / manual-token).
 *
 * The gate is TOKEN PRESENCE, not workspaceName. workspaceName is a
 * display-only field populated lazily by testConnection or on startup.
 * A valid token + unfilled workspaceName cache is still a connected state
 * (e.g. tokens set via API, or a cold start before the Notion call
 * returns). Gating on workspaceName previously bounced valid-token users
 * back into onboarding - see 2026-04-20 retrospective.
 *
 * The "success" state is a transient post-connect celebration that also
 * uses the onboarding layout; it lives on the same sub-state machine.
 */
export function shouldShowOnboarding(input: {
  hasToken: boolean;
  connectStep: 'hero' | 'oauth-waiting' | 'manual-token' | 'success' | (string & {});
}): boolean {
  return !input.hasToken || input.connectStep === 'success';
}
