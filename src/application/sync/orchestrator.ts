/**
 * SyncOrchestrator - Manages the sync lifecycle.
 * Coordinates all sync components: detection, diffing, conflict resolution, and applying changes.
 */

import { getErrorMessage } from '../../shared/errors';
import { createLogger, setRunId } from '../../shared/logger';
import { eventBus } from '../../shared/event-bus';
import type { SyncResult, SyncRunStatus } from '../../domain/models/sync-result';
export type {
  SyncResult,
  SyncResultItem,
  SyncResultCounts,
  SyncRunStatus,
} from '../../domain/models/sync-result';

const log = createLogger('Orchestrator');

/**
 * Error string startSync puts in SyncResult.errors when a sync is already
 * holding the lock. pull-commands matches on it to show a friendlier notice,
 * so both sides must share this constant, never the literal.
 */
export const ERR_SYNC_IN_PROGRESS = 'Sync already in progress';

/** Progress callback for sync operations. */
export type ProgressCallback = (message: string, current?: number, total?: number) => void;
/** Error callback for sync operations. */
export type ErrorCallback = (title: string, error: string) => void;
/**
 * Per-item callback fired as each entry lands during the apply phase.
 * Lets a status surface show items live during a long sync instead of
 * waiting for the final SyncResult.
 */
export type ItemCallback = (item: import('../../domain/models/sync-result').SyncResultItem) => void;

/**
 * The direction stamped on every sync record.
 *
 * A constant, not a setting. Lite pulls and only pulls, so the profile-level
 * syncDirection it used to read is gone: it could be set to 'obsidian-to-notion'
 * from an imported profile and silently disable the one thing this plugin does.
 * `sync_direction` stays a real column because it is persisted state, and
 * nothing branches on it.
 */
export function getSyncRecordDirection(): 'both' | 'notion-only' | 'obsidian-only' {
  return 'notion-only';
}

/** Minimal interface for SyncEngine - avoids circular import with engine.ts */
interface SyncEngineLike {
  sync(options?: { dryRun?: boolean }): Promise<SyncResult>;
  pull(options?: { dryRun?: boolean }): Promise<SyncResult>;
  cancelSync(): void;
}

export class SyncOrchestrator {
  private status: SyncRunStatus = {
    state: 'idle',
    phase: 'idle',
    lastSyncTime: null,
    lastResult: null,
    pendingChanges: 0,
    conflicts: 0,
  };

  /**
   * Update the fine-grained sync phase. Emits a state:changed event so
   * status surfaces re-render with the new label. Called by downstream
   * orchestrators (pull-orchestrator, apply phases) as each stage starts.
   */
  setPhase(phase: import('../../domain/models/sync-result').SyncPhase): void {
    if (this.status.phase === phase) return;
    this.status.phase = phase;
    eventBus.emit('state:changed', undefined);
  }

  private syncLockPromise: Promise<SyncResult> | null = null;

  constructor(
    private engine: SyncEngineLike,
    /**
     * Optional gate: when set, startSync awaits this before doing any work.
     * Used by the plugin host to block sync until background workspace
     * discovery (runSharedDiscovery) finishes - both share the Notion rate
     * limit, so running them in parallel slows both down and the in-flight
     * discovery's queryDatabase calls get attributed to sync in any probe.
     * Returns null when no discovery is in flight.
     */
    private awaitDiscovery: () => Promise<void> | null = () => null,
    /**
     * True while the plugin is unloading. When set, a sync that fails because
     * the database was closed underneath it is a benign shutdown cancellation,
     * not a reported error (the "Core database not initialized" teardown race).
     */
    private isShuttingDown: () => boolean = () => false,
  ) {}

  /**
   * Resolve when no sync is in flight, or after `timeoutMs` - whichever comes
   * first. Called on plugin unload so an in-flight sync can finish its writes
   * and `finally` against a live database BEFORE it is closed. Bounded so a
   * stuck sync can never hang unload.
   */
  async awaitIdle(timeoutMs = 3000): Promise<void> {
    const inFlight = this.syncLockPromise;
    if (!inFlight) return;
    let timer: number | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = window.setTimeout(resolve, timeoutMs);
    });
    // Ignore the sync's own outcome - we only care that it has settled.
    await Promise.race([
      inFlight.then(
        () => undefined,
        () => undefined,
      ),
      timeout,
    ]);
    if (timer) window.clearTimeout(timer);
  }

  /**
   * Start a pull operation (Notion wins on conflicts, no three-way merge).
   */
  async startPull(): Promise<SyncResult> {
    return this.startSync({ mode: 'pull' });
  }

  async startSync(options?: { dryRun?: boolean; mode?: 'pull' | 'sync' }): Promise<SyncResult> {
    if (this.syncLockPromise) {
      log.warn('Sync already in progress, skipping');
      return {
        success: false,
        itemsSynced: 0,
        counts: {
          total: 0,
          created: 0,
          updated: 0,
          unchanged: 0,
          failed: 0,
          orphaned: 0,
          localChanges: 0,
        },
        items: [],
        conflicts: 0,
        errors: [ERR_SYNC_IN_PROGRESS],
        warnings: [],
        duration: 0,
      };
    }

    // Measured after the discovery wait (see runWithDiscovery below) so it
    // reflects actual sync work, not time spent waiting on discovery.
    let startTime = 0;

    const doSync = async (): Promise<SyncResult> => {
      const eventMode = options?.mode === 'pull' ? ('pull' as const) : ('sync' as const);
      // Correlation id for this run: stamped on every log line (via the
      // logger's run tag) and the SyncResult, so a reported failure can be
      // matched to the exact log window it came from. Only the orchestrated
      // path gets one - single-page ops run outside the sync lock, and a
      // process-global id would bleed across their interleaved logs.
      const correlationId = crypto.randomUUID().slice(0, 8);
      setRunId(correlationId);
      try {
        const opLabel =
          options?.mode === 'pull' ? 'pull' : options?.dryRun ? 'dry run preview' : 'sync';
        log.info(`Starting ${opLabel}...`);
        eventBus.emit('sync:start', { mode: eventMode });
        const result =
          options?.mode === 'pull'
            ? await this.engine.pull(options)
            : await this.engine.sync(options);
        result.correlationId = correlationId;

        // Only record last sync time for real syncs, not dry runs
        if (!options?.dryRun) {
          this.status.lastSyncTime = new Date().toISOString();
        }
        this.status.lastResult = result;
        // Only transition to 'idle' if still in 'syncing' state.
        // If the sync was cancelled the engine sets a cancelled flag but state stays
        // 'syncing' until here - this is the single place that clears it.
        if (this.status.state === 'syncing') {
          this.status.state = 'idle';
        }
        this.status.phase = 'idle';
        this.status.conflicts = result.conflicts;

        log.info(`Sync complete: ${result.itemsSynced} items, ${result.conflicts} conflicts`);
        eventBus.emit('sync:end', {
          mode: eventMode,
          success: result.success,
          duration: result.duration,
        });
        eventBus.emit('state:changed', undefined);

        return result;
      } catch (error) {
        const errorMsg = getErrorMessage(error);
        // Teardown race: the plugin is unloading and closed the database under
        // this in-flight sync. That's an expected cancellation by us, not a
        // failure - don't log it as an error and don't surface it. (A "not
        // initialized" error OUTSIDE shutdown is a real bug and still flows
        // through the normal error path below.)
        const errCode = (error as { code?: string } | null)?.code;
        if (
          this.isShuttingDown() &&
          (errCode === 'DATABASE_INIT_FAILED' || /not initialized/i.test(errorMsg))
        ) {
          log.info(
            'Sync interrupted by plugin shutdown (database closed) - benign cancellation, not reported',
          );
          if (this.status.state === 'syncing') this.status.state = 'idle';
          this.status.phase = 'idle';
          return {
            success: false,
            itemsSynced: 0,
            counts: {
              total: 0,
              created: 0,
              updated: 0,
              unchanged: 0,
              failed: 0,
              orphaned: 0,
              localChanges: 0,
            },
            items: [],
            conflicts: 0,
            errors: [],
            warnings: ['Sync cancelled: plugin unloading'],
            duration: Date.now() - startTime,
            correlationId,
          };
        }
        log.error('Sync failed', error);
        // Don't overwrite 'idle' from cancel with 'error'
        if (this.status.state === 'syncing') {
          this.status.state = 'error';
        }
        this.status.phase = 'idle';
        eventBus.emit('sync:end', {
          mode: eventMode,
          success: false,
          duration: Date.now() - startTime,
        });
        eventBus.emit('state:changed', undefined);

        const failResult: SyncResult = {
          success: false,
          itemsSynced: 0,
          counts: {
            total: 0,
            created: 0,
            updated: 0,
            unchanged: 0,
            failed: 0,
            orphaned: 0,
            localChanges: 0,
          },
          items: [],
          conflicts: 0,
          errors: [errorMsg],
          warnings: [],
          duration: Date.now() - startTime,
          correlationId,
        };

        return failResult;
      } finally {
        setRunId(null);
        this.syncLockPromise = null;
      }
    };

    const runWithDiscovery = async (): Promise<SyncResult> => {
      // Wait for in-flight workspace discovery (tree-picker cache population)
      // before starting sync. Both share the Notion rate limit; running in
      // parallel slows the user-visible sync without changing the total work.
      const discoveryWait = this.awaitDiscovery();
      if (discoveryWait) {
        log.info('Sync waiting for in-flight discovery to finish before starting');
        this.status.phase = 'waiting-on-discovery';
        eventBus.emit('state:changed', undefined);
        try {
          await discoveryWait;
        } catch (err) {
          log.warn(`Discovery promise rejected (continuing with sync): ${getErrorMessage(err)}`);
        }
      }

      this.status.state = 'syncing';
      // Phase starts in 'discovering' - the first thing any sync does is
      // walk the Notion API and reconcile the vault. Downstream orchestrators
      // bump this to 'applying' / 'finalizing' as they progress. Reset on
      // every startSync so a previous run's terminal phase doesn't leak.
      this.status.phase = 'discovering';
      startTime = Date.now();

      return doSync();
    };

    // Claim the single-flight lock synchronously, in the same frame as the
    // guard above. Previously the lock was assigned only after `await
    // discoveryWait`, so two concurrent startSync calls could both see a null
    // lock, pass the guard, and run two syncs at once. doSync's finally clears
    // the lock when the operation settles.
    this.syncLockPromise = runWithDiscovery();
    return this.syncLockPromise;
  }

  /**
   * Cancel a running sync.
   * The current sync will stop at the next checkpoint and return partial results.
   */
  cancelSync(): void {
    if (this.syncLockPromise) {
      this.engine.cancelSync();
      // Don't set state here - the sync's finally block already transitions to 'idle'.
      // Setting it early would cause a misleading window where state is 'idle' but
      // syncLockPromise is still non-null.
      log.info('Sync cancelled by user');
    } else if (this.status.state === 'error') {
      // Allow dismissing error state when no sync is running
      this.status.state = 'idle';
      log.info('Error state dismissed');
    }
  }

  getStatus(): SyncRunStatus {
    return { ...this.status };
  }
}
