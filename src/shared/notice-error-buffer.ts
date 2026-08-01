/**
 * NoticeErrorBuffer - rate-limits per-item error toasts so bulk failures
 * (rate-limit cascades, permission-denied on many pages) don't flood
 * the user with one critical Notice per item.
 *
 * Behavior:
 * - First MAX_SHOWN_PER_WINDOW (3) errors in a rolling 5s window are
 *   shown individually.
 * - Subsequent errors within the window are suppressed from the UI but
 *   counted.
 * - After 5s of quiet, if any were suppressed, emit one summary toast
 *   ("N2O: N more items failed - see Activity for details").
 * - Each new error resets the quiet timer, so a long streak of errors
 *   stays as one "window" and produces at most one summary.
 *
 * Callers are responsible for logging each error at full detail via
 * the Logger - this class only governs user-facing toast volume.
 */

type ShowNotice = (message: string, duration?: number) => void;

const DEFAULT_MAX_SHOWN_PER_WINDOW = 3;
const DEFAULT_WINDOW_MS = 5000;
/** A window can be extended by new errors at most this long before it is
 *  force-closed. Without this cap a continuous error stream resets the quiet
 *  timer forever, so the suppressed-count summary is never emitted and the
 *  timer never clears (leak). Defaults to 6x the quiet window (#1569). */
const HARD_WINDOW_FACTOR = 6;

export class NoticeErrorBuffer {
  private shownInWindow = 0;
  private suppressedInWindow = 0;
  private closeTimer: number | null = null;
  private hardTimer: number | null = null;

  constructor(
    private showNotice: ShowNotice,
    private criticalDuration: number,
    private maxShownPerWindow: number = DEFAULT_MAX_SHOWN_PER_WINDOW,
    private windowMs: number = DEFAULT_WINDOW_MS,
  ) {}

  handleError(title: string, error: string): void {
    // Arm the absolute cap once per window so a continuous stream still flushes.
    if (!this.hardTimer) {
      this.hardTimer = window.setTimeout(
        () => this.closeWindow(),
        this.windowMs * HARD_WINDOW_FACTOR,
      );
    }
    this.extendWindow();
    if (this.shownInWindow < this.maxShownPerWindow) {
      this.showNotice(`N2O: Failed "${title}"\n${error}`, this.criticalDuration);
      this.shownInWindow++;
    } else {
      this.suppressedInWindow++;
    }
  }

  /** Cancel pending timers (call on plugin unload) so they don't leak/fire late. */
  dispose(): void {
    if (this.closeTimer) window.clearTimeout(this.closeTimer);
    if (this.hardTimer) window.clearTimeout(this.hardTimer);
    this.closeTimer = null;
    this.hardTimer = null;
  }

  private extendWindow(): void {
    if (this.closeTimer) window.clearTimeout(this.closeTimer);
    this.closeTimer = window.setTimeout(() => this.closeWindow(), this.windowMs);
  }

  private closeWindow(): void {
    if (this.suppressedInWindow > 0) {
      const n = this.suppressedInWindow;
      const label = n === 1 ? '1 more item failed' : `${n} more items failed`;
      this.showNotice(`N2O: ${label} - see Activity for details`, this.criticalDuration);
    }
    this.shownInWindow = 0;
    this.suppressedInWindow = 0;
    if (this.closeTimer) window.clearTimeout(this.closeTimer);
    if (this.hardTimer) window.clearTimeout(this.hardTimer);
    this.closeTimer = null;
    this.hardTimer = null;
  }
}
