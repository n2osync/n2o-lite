/**
 * StatusBarWidget - Shows sync status in Obsidian's status bar.
 * Renders sync state and progress into its host element.
 */

import type { SyncRunStatus } from '../application/sync/orchestrator';
import { timeAgo } from '../shared/time-ago';

export class StatusBarWidget {
  private workspaceLabel: string | null = null;
  private currentStatus: SyncRunStatus | null = null;
  private refreshTimer: number | null = null;
  private operationLabel: string | null = null;

  constructor(private element: HTMLElement) {
    this.element.addClass('n2o-status-bar');
    this.update({
      state: 'idle',
      phase: 'idle',
      lastSyncTime: null,
      lastResult: null,
      pendingChanges: 0,
      conflicts: 0,
    });
    this.startRefreshTimer();
  }

  /** Periodic refresh so "Synced X ago" stays current. */
  private startRefreshTimer(): void {
    this.refreshTimer = window.setInterval(() => {
      if (this.currentStatus && this.currentStatus.state === 'idle') {
        this.update(this.currentStatus);
      }
    }, 60_000);
  }

  /** Clean up the refresh timer. Called on plugin unload. */
  destroy(): void {
    if (this.refreshTimer) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Set workspace label shown in status bar. Set to null to hide (single workspace). */
  setWorkspaceLabel(label: string | null): void {
    this.workspaceLabel = label;
  }

  private get prefix(): string {
    return this.workspaceLabel ? `N2O [${this.workspaceLabel}]` : 'N2O';
  }

  /** Set the operation label shown during sync (e.g. "Pulling...", "Pushing..."). */
  setOperationLabel(label: string | null): void {
    this.operationLabel = label;
  }

  /**
   * Set free-form progress text during sync (e.g. "Syncing 3/15: Page Title").
   */
  setProgress(text: string): void {
    this.element.empty();
    this.element.setText(`${this.prefix}: ${text}`);
  }

  update(status: SyncRunStatus): void {
    this.currentStatus = status;
    const { state, lastSyncTime, conflicts, lastResult } = status;
    // Clear operation label when not syncing
    if (state !== 'syncing') {
      this.operationLabel = null;
    }
    this.element.empty();

    // Status dot
    const dot = this.element.createSpan({ cls: 'n2o-status-dot' });
    dot.addClass(`n2o-status-${state}`);

    // Main text
    const text = this.element.createSpan({ cls: 'n2o-status-text' });

    switch (state) {
      case 'syncing':
        // operationLabel (e.g. "Pulling...") wins if a caller explicitly set
        // one; otherwise surface the phase so users can distinguish
        // "Discovering..." (long API walk) from "Writing files..." etc.
        text.setText(this.operationLabel ?? syncingLabelForPhase(status.phase));
        break;
      case 'paused':
        text.setText('Paused');
        break;
      case 'error': {
        const errorCount = lastResult?.errors?.length ?? 0;
        text.setText(errorCount ? `${errorCount} error${errorCount > 1 ? 's' : ''}` : 'Error');
        // Hover tooltip with error details
        if (lastResult?.errors?.length) {
          const details = lastResult.errors.slice(0, 3).join('\n');
          const more =
            lastResult.errors.length > 3 ? `\n...and ${lastResult.errors.length - 3} more` : '';
          this.element.setAttribute('aria-label', details + more);
          this.element.setAttribute('title', details + more);
        }
        break;
      }
      case 'idle':
        if (lastSyncTime) {
          text.setText(`Synced ${timeAgo(lastSyncTime)}`);
        } else {
          text.setText('Ready');
        }
        break;
    }

    // Conflict badge (shown alongside main status in idle/error states)
    if (conflicts > 0 && state !== 'syncing') {
      const badge = this.element.createSpan({ cls: 'n2o-conflict-badge' });
      badge.setText(`${conflicts}`);
      badge.setAttribute('aria-label', `${conflicts} conflict${conflicts > 1 ? 's' : ''}`);
    }
  }
}

/**
 * Human label for a specific sync phase, used when no explicit operation
 * label ("Pulling...", "Pushing...") is set. Kept co-located with the
 * status bar to avoid pulling dashboard-helpers into every consumer.
 */
function syncingLabelForPhase(phase: import('../domain/models/sync-result').SyncPhase): string {
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
