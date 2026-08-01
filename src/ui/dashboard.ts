/**
 * Dashboard - Sidebar panel for N2O.
 * Adaptive 6-section layout: StatusHero, Issues, ActionZone, Automation, CollapsedDetails, Footer.
 * Shows different content based on user state (never synced, first sync ready, normal).
 * Event-driven refresh via explicit refresh() calls; lightweight 60s timer for relative timestamps only.
 */

import { ItemView, WorkspaceLeaf, Notice, Menu, setIcon, setTooltip, addIcon } from 'obsidian';
import type { DashboardData, DashboardCallbacks, DashboardPluginRef } from './dashboard-types';
/* Re-exports preserve the public API - callers that import these
 * types from './dashboard' keep working. New code should import from
 * './dashboard-types' directly. */
export type { DashboardData, DashboardCallbacks, DashboardPluginRef } from './dashboard-types';
import { MAX_MEDIA_RETRIES } from '../application/media/media-retry';
import { computeHealthRollup } from '../application/sync/sync-health';
import { getErrorMessage, N2OError } from '../shared/errors';
import { createLogger } from '../shared/logger';
import { openExternalUrl } from '../shared/electron-cookies';
import { NOTICE_ERROR } from '../shared/constants';
import { timeAgo } from '../shared/time-ago';
import { sanitizeFileName } from '../shared/sanitize';
import {
  getSyncingLabel,
  shouldShowOnboarding,
  extractPassNumber,
  partitionFailedMedia,
  humanizeMediaType,
  type FailedMediaRow,
} from './dashboard-helpers';
import { ConnectFlowRenderer } from './dashboard/connect-flow-renderer';
import { deriveHeroScene, mountRadarScan, sceneCopy } from './hero-scenes';
import { OverwriteConfirmModal } from './overwrite-confirm-modal';

const log = createLogger('Dashboard');

// Lite-specific view id: the full edition registers 'n2o-dashboard', and both
// plugins coexist during the in-app upgrade handover - a shared id makes the
// second registerView() call fail the whole plugin load.
export const DASHBOARD_VIEW_TYPE = 'n2o-lite-dashboard';

// N2O wordmark: monospace N + amber 2 + O. 100x100 viewBox, centered, no dy drift.
// Amber "2" falls back to currentColor outside the dashboard scope.
addIcon(
  'n2o-logo',
  '<g font-family="JetBrains Mono, SF Mono, ui-monospace, Menlo, monospace" font-weight="700" text-anchor="middle" fill="currentColor">' +
    '<text x="26" y="72" font-size="62" letter-spacing="-2">N</text>' +
    '<text x="52" y="60" font-size="40" fill="var(--n2o-accent, currentColor)">2</text>' +
    '<text x="76" y="72" font-size="62" letter-spacing="-2">O</text>' +
    '</g>',
);

/* DashboardData / DashboardCallbacks / DashboardPluginRef moved to
 * src/ui/dashboard-types.ts to break the source-level cycle between
 * this file and its child renderers (hero-scenes, connect-flow-
 * renderer). The types are re-exported above so callers that import
 * them from './dashboard' keep working. */

export class DashboardView extends ItemView {
  /** Static plugin reference -- set during registerViews(), survives workspace restore. */
  static pluginRef: DashboardPluginRef | null = null;

  private plugin: DashboardPluginRef | null = null;
  private data: DashboardData | null = null;
  private callbacks: DashboardCallbacks | null = null;
  private refreshTimer: number | null = null;
  private timeAgoTimer: number | null = null;
  private healthCollapseTimer: number | null = null;
  private dbReady = false;
  private dbRetryCount = 0;
  private static readonly MAX_DB_RETRIES = 30; // 30 * 2s = 60s max wait

  /** Tracks which collapsible sections are expanded across re-renders. */
  private expandedSections = new Set<string>();

  // P1 #18: connect-flow state + render moved to ConnectFlowRenderer
  // (src/ui/dashboard/connect-flow-renderer.ts). This view delegates
  // the entire "not connected" sub-state machine to it.
  private connectFlow: ConnectFlowRenderer = new ConnectFlowRenderer({
    expandedSections: this.expandedSections,
    getCallbacks: () => this.callbacks,
    refresh: () => this.refresh(),
    render: () => this.render(),
  });

  // Direct DOM refs for live progress updates (no full re-render needed)
  private progressBarEl: HTMLElement | null = null;
  private progressTextEl: HTMLElement | null = null;
  private progressContainerEl: HTMLElement | null = null;
  private syncBtnEl: HTMLButtonElement | null = null;
  private syncControlRowEl: HTMLElement | null = null;
  private syncSeparatorEl: HTMLElement | null = null;
  private statusDotEl: HTMLElement | null = null;
  private statusTextEl: HTMLElement | null = null;
  /**
   * The Notion/ scopecard stats container ("3 pages / 3 databases / N
   * files"). Held as a ref so updateSyncProgress can refresh just the
   * "files" tile mid-sync without a full dashboard re-render. Pre-fix
   * the stats stayed at "0 files" through entire syncs because the
   * count came from `d.totalMedia` which only refreshed on
   * dashboard-wide refresh().
   */
  private scopecardStatsEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return DASHBOARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'N2O';
  }

  override getIcon(): string {
    return 'n2o-logo';
  }

  override async onOpen(): Promise<void> {
    // Lock the workspace-leaf's min-width so the user can drag the
    // sidebar wider but never narrower than 360px. CSS min-width on
    // the dashboard content alone doesn't constrain Obsidian's
    // resize handle - the leaf shrinks past the floor and the
    // dashboard content gets clipped on the right. Setting it on
    // the leaf's container element propagates up to the resize
    // logic so the floor is real.
    // `containerEl` isn't part of the public WorkspaceLeaf typings but is the
    // long-stable internal field every plugin reaches for to constrain leaf
    // sizing - needs the unknown-cast so `npm run typecheck` stays clean.
    const leafEl = (this.leaf as unknown as { containerEl?: HTMLElement } | null)?.containerEl;
    if (leafEl) leafEl.setCssStyles({ minWidth: '360px' });

    // On first open the right sidebar can be narrower than the 360px floor, and
    // Obsidian won't re-clamp to the leaf min-width until a manual resize - so
    // the panel opens cropped until the user "shakes" the width. Force the floor
    // ourselves once the leaf is laid out. A ResizeObserver catches the initial
    // 0 -> final width transition so there's no glitch; setSize is a no-op once
    // we're at or above the floor, so it can't fight a user-widened sidebar.
    if (leafEl) {
      const DASH_MIN_WIDTH = 360;
      const enforceFloor = (): void => {
        const rs = this.app.workspace.rightSplit as unknown as {
          setSize?: (n: number) => void;
          collapsed?: boolean;
          containerEl?: HTMLElement;
        } | null;
        if (!rs || rs.collapsed || typeof rs.setSize !== 'function') return;
        // Only manage width when the dashboard is docked in the right sidebar.
        if (rs.containerEl && !rs.containerEl.contains(leafEl)) return;
        const w = leafEl.getBoundingClientRect().width;
        if (w > 0 && w < DASH_MIN_WIDTH) rs.setSize(DASH_MIN_WIDTH);
      };
      const ro = new ResizeObserver(() => enforceFloor());
      ro.observe(leafEl);
      this.register(() => ro.disconnect());
      window.requestAnimationFrame(enforceFloor);
    }

    if (DashboardView.pluginRef) {
      this.plugin = DashboardView.pluginRef;
      this.callbacks = this.plugin.getDashboardCallbacks();
      await this.refresh();
    } else {
      this.renderInitializing();
    }

    // Fast retry while DB not ready (2s); once ready, event-driven only
    if (!this.dbReady) this.startDbRetryTimer();
  }

  /** Poll every 2s until DB is ready, then stop. All further refreshes are event-driven. */
  private startDbRetryTimer(): void {
    if (this.refreshTimer) window.clearInterval(this.refreshTimer);
    this.refreshTimer = window.setInterval(() => {
      void (async () => {
        try {
          await this.refresh();
          if (this.dbReady) {
            // DB ready - stop polling, start lightweight timeAgo ticker
            if (this.refreshTimer) {
              window.clearInterval(this.refreshTimer);
              this.refreshTimer = null;
            }
            this.startTimeAgoTimer();
          }
        } catch (err) {
          log.error('Dashboard DB retry error', err);
        }
      })();
    }, 2000);
  }

  /** Update only the relative timestamp text every 60s. No DOM rebuild. */
  private startTimeAgoTimer(): void {
    if (this.timeAgoTimer) window.clearInterval(this.timeAgoTimer);
    this.timeAgoTimer = window.setInterval(() => {
      if (!this.data || this.data.syncState === 'syncing') return;
      // Update "Synced Xm ago" in status bar
      if (this.statusTextEl && this.data.lastSyncTime && this.data.syncState === 'idle') {
        const issues =
          this.data.conflicts +
          this.data.errors +
          this.data.failedMedia.length +
          this.data.duplicateNotionIds;
        if (issues === 0) {
          this.statusTextEl.textContent = `Synced ${timeAgo(this.data.lastSyncTime)}`;
        }
      }
    }, 60_000);
  }

  override async onClose(): Promise<void> {
    if (this.refreshTimer) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.timeAgoTimer) {
      window.clearInterval(this.timeAgoTimer);
      this.timeAgoTimer = null;
    }
    // Clear the pending health-collapse timeout too, or it fires against the
    // emptied contentEl after the view closes (#1540).
    if (this.healthCollapseTimer) {
      window.clearTimeout(this.healthCollapseTimer);
      this.healthCollapseTimer = null;
    }
    this.connectFlow.cleanup();
    this.contentEl.empty();
  }

  /**
   * Full data refresh from plugin. Called after sync completes, on open, etc.
   */
  async refresh(): Promise<void> {
    if (!this.plugin) {
      if (DashboardView.pluginRef) {
        this.plugin = DashboardView.pluginRef;
        this.callbacks = this.plugin.getDashboardCallbacks();
      } else {
        return;
      }
    }

    try {
      this.data = await this.plugin.buildDashboardDataAsync();
      this.dbReady = true;
      if (!this.timeAgoTimer) this.startTimeAgoTimer();
      this.render();
    } catch (e) {
      if (e instanceof N2OError && e.code === 'DATABASE_INIT_FAILED') {
        if (this.refreshTimer) {
          window.clearInterval(this.refreshTimer);
          this.refreshTimer = null;
        }
        this.renderDbError(e.message);
        return;
      }
      if (!this.dbReady) {
        this.dbRetryCount++;
        if (this.dbRetryCount >= DashboardView.MAX_DB_RETRIES) {
          log.warn(`Dashboard DB not ready after ${this.dbRetryCount} retries - giving up`);
          if (this.refreshTimer) {
            window.clearInterval(this.refreshTimer);
            this.refreshTimer = null;
          }
          this.renderDbError('Database failed to initialize. Try restarting Obsidian.');
          return;
        }
        log.debug(
          `Dashboard refresh failed (DB may not be ready yet, retry ${this.dbRetryCount}/${DashboardView.MAX_DB_RETRIES})`,
        );
        this.renderInitializing();
      }
    }
  }

  /**
   * Live sync progress update -- updates only the progress bar DOM, no full re-render.
   */
  updateSyncProgress(message: string, current: number, total: number): void {
    // Keep this.data in sync so the timeAgo timer skips updates during sync
    if (this.data) {
      this.data.syncState = 'syncing';
      this.data.syncProgress = { message, current, total };
    }

    // Update state dot + text to syncing
    if (this.statusDotEl) {
      this.statusDotEl.className = 'n2o-dash-dot n2o-dash-dot--syncing';
    }
    if (this.statusTextEl) {
      // Phase-aware: "Discovering..." / "Writing files..." / "Finalizing..." /
      // falls back to the generic spinner label when no phase is known yet.
      this.statusTextEl.textContent = getSyncingLabel(this.data?.syncPhase);
    }

    // Disable sync button
    if (this.syncBtnEl) {
      this.syncBtnEl.disabled = true;
      const textSpan = this.syncBtnEl.querySelector('span:last-child');
      if (textSpan) textSpan.textContent = getSyncingLabel(this.data?.syncPhase);
    }

    // Show sync controls (cancel + pause) and separator
    if (this.syncControlRowEl) {
      this.syncControlRowEl.setCssStyles({ display: 'flex' });
    }
    if (this.syncSeparatorEl) {
      this.syncSeparatorEl.setCssStyles({ display: 'block' });
    }

    // Show progress bar
    if (this.progressContainerEl) {
      this.progressContainerEl.setCssStyles({ display: 'block' });
    }
    if (this.progressBarEl && total > 0) {
      const pct = Math.round((current / total) * 100);
      this.progressBarEl.style.width = `${pct}%`;
      this.updateTankGauge(pct);
    }
    if (this.progressTextEl) {
      this.progressTextEl.textContent = total > 0 ? `${message} ${current}/${total}` : message;
    }

    // Live hero update. Pre-fix this only ran inside updateTankGauge,
    // which itself was gated on total > 0. During discovery there is
    // no total yet (the orchestrator emits text-only messages like
    // "Querying database 4/7"), so the hero stayed frozen on the
    // last full-render copy ("Scanning your Notion workspace.")
    // for the entire discovery phase. Users had no signal whether
    // anything was happening.
    //
    // Always reflect the latest message into the hero subtitle.
    // Title gets a phase-aware label so it's never a static "0% / syncing".
    const heroTitle = this.contentEl.querySelector('.n2o-dash-hybrid-title');
    if (heroTitle instanceof HTMLElement) {
      heroTitle.textContent = getSyncingLabel(this.data?.syncPhase);
    }
    // The chip carries the FULL pass message ("Pass 2 / resolving views
    // for 2 new databases") - meaningful on its own. The subtitle is
    // hidden during pass-prefixed messages to avoid duplicating the same
    // text twice in the hero. Non-pass messages (Discovering, Finalizing,
    // generic Syncing...) keep the subtitle as today.
    const pass = extractPassNumber(message);
    const heroSub = this.contentEl.querySelector('.n2o-dash-hybrid-sub');
    const passChip = this.contentEl.querySelector('.n2o-dash-hybrid-pass-chip');
    if (pass !== null) {
      if (passChip instanceof HTMLElement) {
        passChip.textContent =
          total > 0 ? `${message.toUpperCase()} \u00B7 ${current}/${total}` : message.toUpperCase();
        passChip.removeClass('is-hidden');
      }
      if (heroSub instanceof HTMLElement) heroSub.addClass('is-hidden');
    } else {
      if (passChip instanceof HTMLElement) passChip.addClass('is-hidden');
      if (heroSub instanceof HTMLElement) {
        heroSub.removeClass('is-hidden');
        heroSub.textContent = total > 0 ? `${message} \u00B7 ${current}/${total}` : message;
      }
    }

    // Live "files" count on the Notion/ scopecard. Reads
    // app.vault.getFiles() each tick - cheap, accurate, and matches what
    // the user sees in the file explorer.
    this.updateVaultCounts();
  }

  /**
   * Update the per-DB count cells in-place during a sync. Keyed by the
   * folder name (matches sanitizeFileName(db.title)) which the rows
   * already carry as `data-db-folder`. Avoids re-rendering the whole
   * scope list on every onItem tick.
   */
  updateLiveDbCounts(counts: Record<string, number>): void {
    if (this.data) {
      this.data.liveDbCounts = counts;
    }
    if (!this.data?.selectedItems) return;
    const titleByFolder = new Map<string, { title: string; itemCount?: number }>();
    for (const it of this.data.selectedItems) {
      if (it.type === 'database') {
        titleByFolder.set(sanitizeFileName(it.title), { title: it.title, itemCount: it.itemCount });
      }
    }
    const rows = this.contentEl.querySelectorAll('.n2o-dash-scope-row[data-db-folder]');
    rows.forEach((row) => {
      if (!row.instanceOf(HTMLElement)) return;
      const folder = row.getAttribute('data-db-folder');
      if (!folder) return;
      const meta = titleByFolder.get(folder);
      if (!meta || meta.itemCount === undefined) return;
      const synced = counts[folder] ?? 0;
      const countEl = row.querySelector('.n2o-dash-scope-count');
      if (countEl instanceof HTMLElement) {
        countEl.textContent = `${synced} / ${meta.itemCount}`;
        countEl.addClass('is-live');
      }
    });
  }

  // -- Rendering ------------------------------------------------------

  private renderInitializing(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('n2o-dashboard');
    const msg = contentEl.createDiv({ cls: 'n2o-dash-init' });
    const spinner = msg.createDiv({ cls: 'n2o-spinner' });
    spinner.createSpan({ cls: 'n2o-spinner-dot' });
    spinner.createSpan({ cls: 'n2o-spinner-dot' });
    spinner.createSpan({ cls: 'n2o-spinner-dot' });
    msg.createDiv({ cls: 'n2o-dash-init-text', text: 'Loading sync database...' });
  }

  private renderDbError(message: string): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('n2o-dashboard');
    const wrap = contentEl.createDiv({ cls: 'n2o-dash-error' });
    wrap.createDiv({ cls: 'n2o-dash-error-title', text: 'Database Error' });
    wrap.createDiv({ cls: 'n2o-dash-error-msg', text: message });
    const hint = wrap.createDiv({ cls: 'n2o-dash-error-hint' });
    hint.textContent =
      'Delete the n2o.db file from your plugin folder and restart Obsidian, or run a clean deploy.';
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('n2o-dashboard');
    contentEl.setAttribute('role', 'region');
    contentEl.setAttribute('aria-label', 'N2O Sync Dashboard');

    // Clear timers and direct DOM refs
    if (this.healthCollapseTimer) {
      window.clearTimeout(this.healthCollapseTimer);
      this.healthCollapseTimer = null;
    }
    this.progressBarEl = null;
    this.progressTextEl = null;
    this.progressContainerEl = null;
    this.syncBtnEl = null;
    this.syncControlRowEl = null;
    this.syncSeparatorEl = null;
    this.statusDotEl = null;
    this.statusTextEl = null;

    if (!this.data) {
      this.renderInitializing();
      return;
    }

    const d = this.data;

    // Sticky header - visible on every screen
    this.renderFrameHeader(contentEl, d);

    // State 1: not connected OR mid-connect success celebration.
    // Renders a sub-state machine: hero / choose / oauth-waiting / manual-token / success.
    // Gate logic lives in shouldShowOnboarding - see dashboard-helpers.ts
    // for why it keys on hasToken rather than workspaceName.
    if (shouldShowOnboarding({ hasToken: d.hasToken, connectStep: this.connectFlow.step })) {
      this.connectFlow.render(contentEl, d);
      this.renderMinimalFooter(contentEl, d);
      return;
    }

    // All other states (Ready / Pre-sync / Syncing / Idle / Healthy) use the
    // single unified A+C Mix layout. Content adapts based on syncState + flags.
    this.renderHybridHero(contentEl, d);
    this.renderMinimalFooter(contentEl, d);
  }

  /** Sticky frame header - N₂O wordmark + workspace name + kebab. Always visible. */
  private renderFrameHeader(container: HTMLElement, d: DashboardData): void {
    const header = container.createDiv({ cls: 'n2o-dash-frame-header' });

    const wm = header.createSpan({ cls: 'n2o-dash-frame-wordmark' });
    wm.createSpan({ text: 'N' });
    wm.createSpan({ cls: 'n2o-dash-frame-wordmark-accent', text: '2' });
    wm.createSpan({ text: 'O' });

    if (d.workspaceName) {
      header.createSpan({ cls: 'n2o-dash-frame-sep', text: '/' });
      header.createSpan({ cls: 'n2o-dash-frame-workspace', text: d.workspaceName });
    }

    header.createSpan({ cls: 'n2o-dash-frame-spacer' });

    // Kebab menu - opens a full dropdown with grouped actions.
    // Design reference: docs/reports/sessions/2026-04-20... and chat.
    // Context-aware items are hidden (not disabled/greyed) when they
    // don't apply, keeping the menu tight at any given moment.
    if (this.callbacks) {
      const cb = this.callbacks;
      const kebab = header.createSpan({ cls: 'n2o-dash-frame-kebab' });
      kebab.setAttribute('role', 'button');
      kebab.setAttribute('tabindex', '0');
      kebab.setAttribute('aria-label', 'More actions');
      setIcon(kebab, 'more-vertical');
      const openMenu = (evt: MouseEvent | KeyboardEvent): void => {
        this.buildKebabMenu(cb, d).showAtMouseEvent(evt as MouseEvent);
      };
      kebab.addEventListener('click', (e) => openMenu(e));
      kebab.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const rect = kebab.getBoundingClientRect();
          this.buildKebabMenu(cb, d).showAtPosition({ x: rect.left, y: rect.bottom });
        }
      });
      setTooltip(kebab, 'More actions');
    }
  }

  /**
   * Build the kebab-menu dropdown. Items are grouped by intent, with
   * separators between groups. Context-aware items (retry queue,
   * resolve conflicts, trial CTA, etc.) are conditionally added so
   * the menu only shows what's actionable right now.
   *
   * All items map to callbacks that already exist - no new wiring.
   * Previously orphaned actions (Manage base views, Preview sync,
   * Scan vault, Help link) are restored here since the Phase 1
   * redesign's renderToolbar is never called.
   */
  private buildKebabMenu(cb: DashboardCallbacks, d: DashboardData): Menu {
    const menu = new Menu();
    const isSyncing = d.syncState === 'syncing';
    const failedMediaCount = d.failedMedia.reduce((sum, p) => sum + p.items.length, 0);

    // ── Sync controls ──────────────────────────────────────
    menu.addItem((i) =>
      i
        .setTitle('Preview sync')
        .setIcon('eye')
        .onClick(() => void cb.onPreviewSync()),
    );
    menu.addItem((i) =>
      i
        .setTitle('Sync now')
        .setIcon('refresh-cw')
        .onClick(() => void cb.onSyncNow()),
    );
    menu.addItem((i) =>
      i
        .setTitle('Overwrite from Notion (replace local)')
        .setIcon('arrow-down')
        .onClick(() => new OverwriteConfirmModal(this.app, () => void cb.onPullChanges()).open()),
    );
    if (isSyncing) {
      menu.addItem((i) =>
        i
          .setTitle('Cancel running sync')
          .setIcon('x')
          .onClick(() => void cb.onCancelSync()),
      );
    }
    menu.addSeparator();

    // ── Workspace ──────────────────────────────────────────
    menu.addItem((i) =>
      i
        .setTitle('Choose what to sync')
        .setIcon('list-checks')
        .onClick(() => cb.onOpenTreePicker()),
    );
    menu.addItem((i) =>
      i
        .setTitle('Scan vault for Notion files')
        .setIcon('search')
        .onClick(() => void cb.onScanVault()),
    );
    menu.addItem((i) =>
      i
        .setTitle('Refresh page list')
        .setIcon('compass')
        .onClick(() => void cb.onDiscoverPages()),
    );
    menu.addItem((i) =>
      i
        .setTitle('Open sync log')
        .setIcon('scroll-text')
        .onClick(() => void cb.onOpenSyncLog()),
    );
    menu.addSeparator();

    // ── Maintenance (only items with something to do) ──────
    let addedMaintenance = false;
    if (failedMediaCount > 0) {
      menu.addItem((i) =>
        i
          .setTitle(`Retry failed media (${failedMediaCount})`)
          .setIcon('refresh-ccw')
          .onClick(() => void cb.onRetryFailedMedia()),
      );
      addedMaintenance = true;
    }
    if (d.conflicts > 0) {
      menu.addItem((i) =>
        i
          .setTitle(`Resolve conflicts (${d.conflicts})`)
          .setIcon('git-merge')
          .onClick(() => cb.onResolveConflicts()),
      );
      addedMaintenance = true;
    }
    if (addedMaintenance) {
      menu.addSeparator();
    }

    // ── Settings / help ────────────────────────────────────
    menu.addItem((i) =>
      i
        .setTitle('Settings')
        .setIcon('settings')
        .onClick(() => cb.onOpenSettings()),
    );
    menu.addItem((i) =>
      i
        .setTitle('Sync configuration')
        .setIcon('sliders')
        .onClick(() => cb.onOpenSyncConfig()),
    );
    menu.addItem((i) =>
      i
        .setTitle('Help & docs')
        .setIcon('help-circle')
        .onClick(() => openExternalUrl('https://n2osync.com/docs/')),
    );
    menu.addSeparator();

    // ── Danger zone ────────────────────────────────────────
    // Reset is destructive - placed last, after a separator, with a
    // warn-coloured icon so it's visually distinct from normal items.
    menu.addItem((i) => {
      i.setTitle('Reset N2O')
        .setIcon('trash-2')
        .onClick(() => cb.onResetN2O());
      // Apply a warn class to the native menu item for red styling.
      const el = (i as unknown as { dom?: HTMLElement }).dom;
      if (el) el.addClass('n2o-menu-danger');
    });

    return menu;
  }
  // -- State 1: Connect flow ----------------------------------------
  //
  // The full sub-state machine (hero / oauth-waiting / manual-token /
  // success) lives in src/ui/dashboard/connect-flow-renderer.ts.
  // DashboardView only retains a public showConnectError delegate
  // for the plugin's protocol handler (dashboard-manager.ts:614).

  /** Forwarded to ConnectFlowRenderer so external callers (the plugin's
   *  OAuth protocol handler) can surface a connect failure on the hero. */
  showConnectError(message: string): void {
    this.connectFlow.showError(message);
  }

  // -- First-run shared helpers --------------------------------------

  /** SVG tank gauge with N₂O glyph centered. pct: 0-100. Returns the <svg> element. */
  private createTankGauge(pct: number, size = 92): SVGElement {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'n2o-dash-tank-gauge');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 92 92');

    const r = 38;
    const circ = 2 * Math.PI * r;
    const clamped = Math.max(0, Math.min(100, pct));

    const bg = document.createElementNS(svgNS, 'circle');
    bg.setAttribute('cx', '46');
    bg.setAttribute('cy', '46');
    bg.setAttribute('r', String(r));
    bg.setAttribute('fill', 'none');
    bg.setAttribute('stroke', 'var(--n2o-line-soft)');
    bg.setAttribute('stroke-width', '4.5');
    svg.appendChild(bg);

    // Hairline accent outlines on BOTH sides of the track (inner + outer
    // edge). Visible in both themes - the dim --n2o-line-soft track sits
    // between them and the accent hairlines give the whole ring a crisp
    // frame. Separate "inner" and "outer" classes so either can be
    // tweaked per-theme later without touching the TS.
    const outerOutline = document.createElementNS(svgNS, 'circle');
    outerOutline.setAttribute('class', 'n2o-dash-tank-gauge-outline is-outer');
    outerOutline.setAttribute('cx', '46');
    outerOutline.setAttribute('cy', '46');
    outerOutline.setAttribute('r', String(r + 2.25));
    outerOutline.setAttribute('fill', 'none');
    outerOutline.setAttribute('stroke', 'var(--interactive-accent)');
    outerOutline.setAttribute('stroke-width', '1');
    svg.appendChild(outerOutline);

    const innerOutline = document.createElementNS(svgNS, 'circle');
    innerOutline.setAttribute('class', 'n2o-dash-tank-gauge-outline is-inner');
    innerOutline.setAttribute('cx', '46');
    innerOutline.setAttribute('cy', '46');
    innerOutline.setAttribute('r', String(r - 2.25));
    innerOutline.setAttribute('fill', 'none');
    innerOutline.setAttribute('stroke', 'var(--interactive-accent)');
    innerOutline.setAttribute('stroke-width', '1');
    svg.appendChild(innerOutline);

    const ring = document.createElementNS(svgNS, 'circle');
    ring.setAttribute('class', 'n2o-dash-tank-gauge-ring');
    ring.setAttribute('cx', '46');
    ring.setAttribute('cy', '46');
    ring.setAttribute('r', String(r));
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', 'var(--n2o-accent)');
    ring.setAttribute('stroke-width', '4.5');
    ring.setAttribute('stroke-linecap', 'round');
    ring.setAttribute('stroke-dasharray', String(circ));
    // Start visually empty so the CSS transition (400ms ease-out on
    // stroke-dashoffset) animates the ring filling up to its current
    // value on every full render. Without this, opening the dashboard
    // mid-sync shows the ring instantly at e.g. 60% with no fill cue.
    const targetOffset = circ * (1 - clamped / 100);
    ring.setAttribute('stroke-dashoffset', String(circ));
    ring.setAttribute('transform', 'rotate(-90 46 46)');
    svg.appendChild(ring);
    // Two rAF: the first lets the browser paint the empty ring, the
    // second triggers the transition to the real offset so the user
    // sees the fill instead of a teleport.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        ring.setAttribute('stroke-dashoffset', String(targetOffset));
      });
    });

    // Glyph: N + amber 2 + O
    const mkText = (x: number, y: number, fs: number, fill: string, text: string): SVGElement => {
      const t = document.createElementNS(svgNS, 'text');
      t.setAttribute('x', String(x));
      t.setAttribute('y', String(y));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('font-family', 'JetBrains Mono, SF Mono, ui-monospace, Menlo, monospace');
      t.setAttribute('font-weight', '700');
      t.setAttribute('font-size', String(fs));
      t.setAttribute('fill', fill);
      t.textContent = text;
      return t;
    };

    svg.appendChild(mkText(36, 50, 16, 'var(--n2o-ink)', 'N'));
    svg.appendChild(mkText(46, 44, 11, 'var(--n2o-accent)', '2'));
    svg.appendChild(mkText(56, 50, 16, 'var(--n2o-ink)', 'O'));

    const pctLabel = mkText(46, 64, 8, 'var(--n2o-soft)', `${Math.round(clamped)}%`);
    pctLabel.setAttribute('class', 'n2o-dash-tank-gauge-pct');
    pctLabel.setAttribute('letter-spacing', '1');
    pctLabel.setAttribute('font-weight', '500');
    svg.appendChild(pctLabel);

    return svg;
  }

  /** Update the gauge ring offset + percent label in place (for sync progress animations). */
  private updateTankGauge(pct: number): void {
    const clamped = Math.max(0, Math.min(100, pct));
    const ring = this.contentEl.querySelector('.n2o-dash-tank-gauge-ring');
    if (ring instanceof SVGElement) {
      const r = 38;
      const circ = 2 * Math.PI * r;
      ring.setAttribute('stroke-dashoffset', String(circ * (1 - clamped / 100)));
    }
    const label = this.contentEl.querySelector('.n2o-dash-tank-gauge-pct');
    if (label instanceof SVGElement) {
      label.textContent = `${Math.round(clamped)}%`;
    }
    // Also keep the hero title + sub text in sync - they read from the
    // last full render otherwise and get stuck at "0% / syncing" while
    // the inner gauge ticks up. Both strings mirror render() line ~1367.
    const heroTitle = this.contentEl.querySelector('.n2o-dash-hybrid-title');
    if (heroTitle instanceof HTMLElement) {
      heroTitle.textContent = getSyncingLabel(this.data?.syncPhase);
    }
    const heroSub = this.contentEl.querySelector('.n2o-dash-hybrid-sub');
    if (heroSub instanceof HTMLElement && this.data?.syncProgress?.message) {
      heroSub.textContent = this.data.syncProgress.message;
    }
  }

  /** 4-segment progress ribbon: Connect | Folder | Pick | Sync. */
  private renderProgressRibbon(container: HTMLElement, stepIndex: number): void {
    const wrap = container.createDiv({ cls: 'n2o-dash-progress-ribbon' });
    const labels = ['Connect', 'Folder', 'Pick', 'Sync'];
    const row = wrap.createDiv({ cls: 'n2o-dash-ribbon-row' });
    for (let i = 0; i < 4; i++) {
      const seg = row.createDiv({ cls: 'n2o-dash-ribbon-seg' });
      if (i < stepIndex) seg.addClass('is-done');
      else if (i === stepIndex) seg.addClass('is-current');
      else seg.addClass('is-pending');
    }
    const label = wrap.createDiv({ cls: 'n2o-dash-ribbon-label' });
    label.createSpan({ cls: 'n2o-dash-ribbon-step', text: `STEP ${stepIndex + 1} OF 4` });
    label.createSpan({ text: ` \u00B7 ${labels[stepIndex]}` });
  }
  private renderDoneStep(
    container: HTMLElement,
    title: string,
    meta: string,
    onEdit: (() => void) | null,
  ): void {
    const row = container.createDiv({ cls: 'n2o-dash-done-step' });
    const check = row.createDiv({ cls: 'n2o-dash-done-check' });
    setIcon(check, 'check');
    const body = row.createDiv({ cls: 'n2o-dash-done-body' });
    body.createDiv({ cls: 'n2o-dash-done-title', text: title });
    if (meta) body.createDiv({ cls: 'n2o-dash-done-meta', text: meta });
    if (onEdit) {
      const edit = row.createEl('a', { cls: 'n2o-dash-done-edit', text: 'Edit', href: '#' });
      edit.addEventListener('click', (e) => {
        e.preventDefault();
        onEdit();
      });
    }
  }
  /**
   * A+C Mix hybrid hero - single layout that adapts to all states (onboarding /
   * syncing / idle). Sections shown/hidden based on state.
   */
  private renderHybridHero(container: HTMLElement, d: DashboardData): void {
    const root = container.createDiv({ cls: 'n2o-dash-hybrid' });

    const isSyncing = d.syncState === 'syncing';
    const neverSynced = !d.lastSyncTime && d.totalPages === 0;
    const hasCommitted = d.syncScope === 'all' || d.selectedItems.length > 0;
    const isOnboarding = neverSynced;
    const isIdle = !neverSynced && !isSyncing;

    const { dbs, pages, dbItems } = this.computeDryRunStats(d);
    const totalSelected = (dbs ?? 0) + (pages ?? 0) + (dbItems ?? 0);

    // Pick which percentage to show in the gauge based on state
    let fillPct: number;
    if (isSyncing) {
      const p = d.syncProgress;
      fillPct = p && p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
    } else if (isOnboarding) {
      const totalAvailable = d.pageCacheCount > 0 ? d.pageCacheCount : Math.max(totalSelected, 1);
      fillPct =
        d.syncScope === 'all'
          ? 100
          : Math.min(100, Math.round((totalSelected / totalAvailable) * 100));
    } else {
      fillPct = 100;
    }

    // Gauge hero panel - radial accent gradient background, contains status row + gauge + title + sub
    const gaugePanel = root.createDiv({ cls: 'n2o-dash-hybrid-gauge-wrap' });

    // Top status row: dot + label + license/trial pill
    const statusRow = gaugePanel.createDiv({ cls: 'n2o-dash-hybrid-statusrow' });
    const statusDot = statusRow.createSpan({ cls: 'n2o-dash-hybrid-statusrow-dot' });
    const statusLabel = statusRow.createSpan({ cls: 'n2o-dash-hybrid-statusrow-label' });
    // Cancellation is a distinct terminal state. Pre-fix a canceled
    // sync rendered the same "In sync" pill as a clean-success run,
    // and the heroTitle below said "All caught up" - actively
    // misleading the user that everything was fine when in fact the
    // run was aborted mid-flight. The orchestrator now sets
    // result.canceled = true on cancellation; we surface it here.
    const wasCanceled = !!d.lastResult?.canceled;
    if (isSyncing) {
      statusDot.addClass('is-syncing');
      statusLabel.textContent = 'Syncing\u2026';
    } else if (wasCanceled) {
      statusDot.addClass('is-pending');
      statusLabel.textContent = 'Sync canceled';
    } else if (isIdle) {
      statusDot.addClass('is-ok');
      statusLabel.textContent = 'In sync';
    } else {
      statusDot.addClass('is-pending');
      statusLabel.textContent = 'Not syncing yet';
    }
    statusRow.createSpan({ cls: 'n2o-dash-hybrid-statusrow-spacer' });
    const pill = statusRow.createSpan({ cls: 'n2o-dash-hybrid-pill' });
    pill.addClass('is-pro');
    pill.textContent = 'Free';

    // Scene selection - derived from state, single source of truth for
    // which hero visual is playing right now.
    const scene = deriveHeroScene(d);

    // Centered gauge (inside the gradient panel)
    const gaugeWrap = gaugePanel.createDiv({
      cls: `n2o-dash-hybrid-gauge n2o-dash-hero-scene is-${scene}`,
    });
    if (isSyncing) gaugeWrap.addClass('is-syncing');
    gaugeWrap.appendChild(this.createTankGauge(fillPct, 108));

    // Scan scene: hide the glyph + % (via .is-scanning CSS) and mount
    // the full radar scan animation. Clean start; unmount happens by
    // the next render rebuilding the gauge without .is-scanning.
    if (scene === 'scan') {
      gaugeWrap.addClass('is-scanning');
      mountRadarScan(gaugeWrap);
    }

    // Centered title + subtitle.
    //
    // Scene-driven for 'scan' (picker discovery or sync-phase scan) so the
    // text matches what the radar animation implies - otherwise the old
    // state-based branches below pick the label. Keeps pre-existing copy
    // intact for every other state while letting new scenes own their
    // messaging via sceneCopy().
    let heroTitle: string;
    let subText: string;
    if (scene === 'scan') {
      const copy = sceneCopy(scene, d);
      heroTitle = copy.title;
      subText = copy.sub;
    } else if (isSyncing) {
      heroTitle = getSyncingLabel(d.syncPhase);
      subText = d.syncProgress?.message ?? 'Pulling from Notion\u2026';
    } else if (wasCanceled) {
      // Distinct copy for the canceled-mid-flight terminal state.
      // itemsSynced may be > 0 if cancellation hit after the diff
      // phase (some pages already landed); we acknowledge that
      // partial work instead of pretending the run was complete.
      const partial = d.lastResult?.itemsSynced ?? 0;
      heroTitle = 'Sync canceled';
      subText =
        partial > 0
          ? `Stopped after ${partial.toLocaleString()} ${partial === 1 ? 'page' : 'pages'}. Run sync again to finish.`
          : 'Stopped before anything was written. Run sync again to start over.';
    } else if (isIdle) {
      heroTitle = 'In sync';
      subText = `Synced ${d.lastSyncTime ? timeAgo(d.lastSyncTime) : 'just now'} \u00B7 ${d.totalPages.toLocaleString()} page${d.totalPages === 1 ? '' : 's'} in vault`;
    } else if (fillPct === 0) {
      heroTitle = 'Ready to fill your vault';
      subText = `Connected to ${d.workspaceName ?? 'Notion'}. Pick what to bring in.`;
    } else {
      heroTitle = `${fillPct}% of workspace queued`;
      subText =
        d.syncScope === 'all'
          ? `Connected to ${d.workspaceName ?? 'Notion'}. Everything will sync.`
          : `Connected to ${d.workspaceName ?? 'Notion'}. Pick what to bring in.`;
    }
    gaugePanel.createDiv({ cls: 'n2o-dash-hybrid-title', text: heroTitle });
    // Pass message chip: when the orchestrator emits a "Pass N / ..." message
    // (multi-pass discovery loop), the chip carries the full message in
    // uppercase and the subtitle is hidden to avoid duplicating it. For
    // non-pass messages (discovering, finalizing, idle copy, etc.) the chip
    // is hidden and the subtitle carries the text as before.
    const passNum = isSyncing ? extractPassNumber(d.syncProgress?.message) : null;
    const passChip = gaugePanel.createDiv({ cls: 'n2o-dash-hybrid-pass-chip' });
    const subEl = gaugePanel.createDiv({ cls: 'n2o-dash-hybrid-sub' });
    if (passNum !== null) {
      const passMessage = d.syncProgress?.message ?? '';
      const total = d.syncProgress?.total ?? 0;
      const current = d.syncProgress?.current ?? 0;
      passChip.textContent =
        total > 0
          ? `${passMessage.toUpperCase()} \u00B7 ${current}/${total}`
          : passMessage.toUpperCase();
      subEl.addClass('is-hidden');
    } else {
      passChip.addClass('is-hidden');
      subEl.textContent = subText;
    }

    // Inline progress bar during sync (still inside the gradient panel)
    if (isSyncing) {
      const track = gaugePanel.createDiv({
        cls: 'n2o-dash-progress-track n2o-dash-hybrid-progress',
      });
      const fill = track.createDiv({ cls: 'n2o-dash-progress-fill' });
      fill.style.width = `${fillPct}%`;
      this.progressBarEl = fill;
      this.progressContainerEl = track;
    }

    // Scope card - folder path + counts + direction chip + edit link
    if (this.callbacks) {
      const cb = this.callbacks;
      const card = root.createDiv({ cls: 'n2o-dash-hybrid-scopecard' });
      const cardHead = card.createDiv({ cls: 'n2o-dash-hybrid-scopecard-head' });
      setIcon(cardHead.createSpan({ cls: 'n2o-dash-hybrid-scopecard-icon' }), 'folder');
      cardHead.createSpan({ cls: 'n2o-dash-hybrid-scopecard-path', text: `${d.syncFolder}/` });
      cardHead.createSpan({ cls: 'n2o-dash-hybrid-statusrow-spacer' });
      const editLink = cardHead.createEl('a', {
        cls: 'n2o-dash-hybrid-scopecard-edit',
        text: 'Edit',
        href: '#',
      });
      editLink.addEventListener('click', (e) => {
        e.preventDefault();
        cb.onOpenTreePicker();
      });
      const stats = card.createDiv({ cls: 'n2o-dash-hybrid-scopecard-stats' });
      // Scope card: the pages/databases counts reflect what N2O is
      // CONFIGURED to sync (selection size for 'selected' scope, workspace
      // reach for 'all' scope). The "files" count reflects what's actually
      // ON DISK in syncFolder right now - live, not stale. This way the
      // user sees the vault filling up during sync and matches what they
      // see in the file explorer. updateVaultCounts() refreshes this
      // tile on every progress emit.
      let showPages: number;
      let showDbs: number;
      if (isOnboarding) {
        // Nothing synced yet, so preview what a sync WOULD bring (dry-run stats).
        showPages = pages ?? 0;
        showDbs = dbs ?? 0;
      } else {
        /* Once anything is synced, all three tiles describe the same thing: what
         * N2O actually has. They used to disagree - pages and databases reported
         * intent (the selection, or the tree-picker's idea of workspace reach)
         * while files reported the vault. Under "Everything" the picker cache is
         * empty until the user opens it, so a whole-workspace sync reported
         * "0 pages, 0 databases" immediately after succeeding (#1978). */
        showPages = d.syncedPages;
        showDbs = d.syncedDatabases;
      }
      const showFiles = isOnboarding ? (dbItems ?? 0) : this.countMdFilesInSyncFolder(d.syncFolder);
      this.renderHybridStat(stats, showPages, 'pages');
      this.renderHybridStat(stats, showDbs, 'databases');
      this.renderHybridStat(stats, showFiles, 'files');
      this.scopecardStatsEl = stats;
    }

    // Direction - standalone card below scope card. Lite is pull-only,
    // so the chip is a static "Notion -> Obsidian" line, not a control.
    {
      const dirCard = root.createDiv({ cls: 'n2o-dash-hybrid-dircard' });
      const dirRow = dirCard.createDiv({ cls: 'n2o-dash-hybrid-direction' });
      dirRow.createSpan({ cls: 'n2o-dash-hybrid-direction-label', text: 'DIRECTION' });
      const chip = dirRow.createDiv({ cls: 'n2o-dash-hybrid-direction-chip' });
      chip.createSpan({ cls: 'n2o-dash-hybrid-direction-side', text: 'Notion' });
      chip.createSpan({ cls: 'n2o-dash-hybrid-direction-arrow', text: '\u2192' });
      chip.createSpan({ cls: 'n2o-dash-hybrid-direction-side', text: 'Obsidian' });
      chip.createSpan({ cls: 'n2o-dash-hybrid-direction-desc', text: ' \u00B7 One-way' });
    }

    // Primary action area - adapts to state:
    //   syncing:   [Pause] [Cancel] full-width pair
    //   idle:      [Sync] [Pull] [Push] trio
    //   onboarding:[Run first sync] full + ghost link OR [Select pages] full
    if (this.callbacks) {
      const cb = this.callbacks;
      const actions = root.createDiv({ cls: 'n2o-dash-hybrid-cta-wrap' });

      if (isSyncing) {
        // Mid-sync: only Cancel. The previous "Pause" button here was
        // wired to orchestrator.pauseSync() which cancels the running
        // sync (engine.cancelSync) AND stops the auto-sync scheduler -
        // misleading for a button labelled "Pause" since the user can't
        // resume from where they left off. The engine doesn't support
        // true mid-sync pause/resume; honest UX is one Cancel button.
        // Auto-sync scheduler pause lives in the kebab menu where it's
        // correctly labelled "Pause auto-sync".
        const cancelBtn = actions.createEl('button', {
          cls: 'n2o-dash-hybrid-secondary-btn n2o-dash-btn-icon',
        });
        setIcon(cancelBtn.createSpan(), 'x');
        cancelBtn.createSpan({ text: 'Cancel' });
        cancelBtn.addEventListener('click', () => {
          void cb.onCancelSync();
        });
      } else if (isIdle) {
        const syncBtn = actions.createEl('button', {
          cls: 'n2o-dash-btn-primary mod-cta n2o-dash-btn-icon n2o-dash-hybrid-cta',
        });
        setIcon(syncBtn.createSpan(), 'refresh-cw');
        syncBtn.createSpan({ text: 'Sync' });
        this.syncBtnEl = syncBtn;
        syncBtn.addEventListener('click', () => {
          void (async () => {
            if (syncBtn.disabled) return;
            syncBtn.disabled = true;
            try {
              await cb.onSyncNow();
            } catch (e) {
              new Notice(`N2O: Sync failed \u2014 ${getErrorMessage(e)}`, NOTICE_ERROR);
              syncBtn.disabled = false;
            }
          })();
        });
        // One safe primary action. The one-way operations (Overwrite from
        // Notion, Send to Notion) live in the kebab + command palette so the
        // main surface can't fire a destructive overwrite by accident.
      } else {
        const cta = actions.createEl('button', {
          cls: 'n2o-dash-btn-primary mod-cta n2o-dash-btn-icon n2o-dash-hybrid-cta',
        });
        const isReady = hasCommitted;
        setIcon(cta.createSpan(), isReady ? 'refresh-cw' : 'list-tree');
        cta.createSpan({ text: isReady ? 'Run first sync' : 'Choose what to sync' });
        this.syncBtnEl = cta;
        cta.addEventListener('click', () => {
          void (async () => {
            if (cta.disabled) return;
            if (!isReady) {
              cb.onOpenTreePicker();
              return;
            }
            cta.disabled = true;
            try {
              await cb.onSyncNow();
            } catch (e) {
              new Notice(`N2O: Sync failed \u2014 ${getErrorMessage(e)}`, NOTICE_ERROR);
              cta.disabled = false;
            }
          })();
        });

        // Ghost link in onboarding only
        const ghost = root.createDiv({ cls: 'n2o-dash-hybrid-ghost' });
        const ghostLink = ghost.createEl('a', {
          text: d.syncScope === 'all' ? 'Or choose specific items' : 'Or sync everything',
          href: '#',
        });
        ghostLink.addEventListener('click', (e) => {
          e.preventDefault();
          if (d.syncScope === 'all') cb.onOpenTreePicker();
          else cb.onSetSyncScopeAll();
        });
      }
    }

    // NEEDS ATTENTION - issues card list (red-bordered cards, title + sub + action)
    const failedCount = d.failedMedia.reduce((sum, p) => sum + p.items.length, 0);
    /* Discovery-only failures: pages the registry builder couldn't scan.
     * Counted here so the NEEDS ATTENTION section appears for a sync
     * where everything else was clean but discovery dropped pages. */
    const discoveryIssueCount = (d.lastResult?.errors ?? []).filter(
      (e) => e.startsWith('Discovery') || e.startsWith('Nested'),
    ).length;
    const totalIssues =
      d.conflicts + d.errors + failedCount + d.duplicateNotionIds + discoveryIssueCount;
    if (totalIssues > 0 && !isOnboarding) {
      const issues = root.createDiv({ cls: 'n2o-dash-hybrid-section' });
      const head = issues.createDiv({ cls: 'n2o-dash-hybrid-section-head' });
      head.createSpan({ cls: 'n2o-dash-hybrid-setup-label', text: 'NEEDS ATTENTION' });
      head.createSpan({ cls: 'n2o-dash-hybrid-section-count', text: String(totalIssues) });
      this.renderHybridIssues(issues, d);
    }

    /* SYNC HEALTH (Move 3.1) - 7-day rollup over sync history. Hidden
     * when no history (fresh install) so we don't claim "0 syncs" as
     * a problem; once the user has done a few syncs the section
     * appears and stays. */
    if (!isOnboarding && d.syncHistory.length > 0) {
      const rollup = computeHealthRollup(d.syncHistory, new Date(), 7);
      if (rollup.syncCount > 0) {
        const health = root.createDiv({ cls: 'n2o-dash-hybrid-section n2o-dash-flat-section' });
        const hhead = health.createDiv({ cls: 'n2o-dash-hybrid-section-head' });
        hhead.createSpan({ cls: 'n2o-dash-hybrid-setup-label', text: 'SYNC HEALTH \u00B7 7 DAYS' });
        const counts = health.createDiv({ cls: 'n2o-dash-health-counts' });
        counts.createSpan({ text: `${rollup.syncCount} sync${rollup.syncCount === 1 ? '' : 's'}` });
        counts.createSpan({ text: ` \u00B7 ${rollup.cleanCount} clean` });
        if (rollup.partialCount > 0)
          counts.createSpan({ text: `, ${rollup.partialCount} partial` });
        if (rollup.failureCount > 0) counts.createSpan({ text: `, ${rollup.failureCount} failed` });
        const detail = health.createDiv({ cls: 'n2o-dash-health-detail' });
        const pagesLine =
          `${rollup.totalPagesSynced} page${rollup.totalPagesSynced === 1 ? '' : 's'} synced` +
          (rollup.totalPagesFailed > 0 ? `, ${rollup.totalPagesFailed} failed` : '');
        const avgSec = (rollup.avgDurationMs / 1000).toFixed(1);
        detail.createSpan({ text: `${pagesLine} \u00B7 ${avgSec}s avg` });
      }
    }
  }

  /** Issues list - one card per issue type with title + sub + action button. */
  private renderHybridIssues(container: HTMLElement, d: DashboardData): void {
    const failedCount = d.failedMedia.reduce((sum, p) => sum + p.items.length, 0);
    const cb = this.callbacks;

    if (d.conflicts > 0 && cb) {
      const sub =
        d.failedMedia.length > 0
          ? `Resolve to keep both sides in sync`
          : `${d.conflicts} file${d.conflicts > 1 ? 's have' : ' has'} divergent edits`;
      this.renderIssueCard(
        container,
        `${d.conflicts} conflict${d.conflicts > 1 ? 's' : ''}`,
        sub,
        'Resolve',
        () => cb.onResolveConflicts(),
      );
    }

    if (failedCount > 0 && cb) {
      this.renderFailedMediaCard(container, d, cb);
    }

    if (d.errors > 0) {
      /* Persistent recent errors (error_log table): show the newest few with
       * a relative time so the card answers "what failed, when" without a
       * trip to the sync log. Falls back to the generic sub when the log is
       * empty (e.g. errors recorded before the error_log table existed). */
      const recentErrors = d.errorHistory.slice(0, 3);
      const card = container.createDiv({ cls: 'n2o-dash-hybrid-issue-card' });
      const body = card.createDiv({ cls: 'n2o-dash-hybrid-issue-body' });
      body.createDiv({
        cls: 'n2o-dash-hybrid-issue-title',
        text: `${d.errors} error${d.errors > 1 ? 's' : ''}`,
      });
      if (recentErrors.length === 0) {
        body.createDiv({
          cls: 'n2o-dash-hybrid-issue-sub',
          text: 'Check the sync log for details',
        });
      } else {
        for (const err of recentErrors) {
          const msg = err.message.length > 120 ? `${err.message.slice(0, 117)}...` : err.message;
          body.createDiv({
            cls: 'n2o-dash-hybrid-issue-sub',
            text: `${msg} (${timeAgo(err.timestamp)})`,
          });
        }
      }
      if (cb) {
        const btn = card.createEl('button', { cls: 'n2o-dash-hybrid-issue-btn', text: 'View log' });
        btn.addEventListener('click', () => void cb.onOpenSyncLog());
      }
    }

    /* Discovery-only failures (Move 2.3): pages where the registry
     * builder couldn't fetch content but the orphan detector then
     * spared them from deletion. These don't set a SyncRecord status
     * to 'error' so they don't show in `d.errors` - derive the count
     * from lastResult.errors using the registry-builder prefixes. */
    const discoveryErrorCount = (d.lastResult?.errors ?? []).filter(
      (e) => e.startsWith('Discovery') || e.startsWith('Nested'),
    ).length;
    if (discoveryErrorCount > 0) {
      this.renderIssueCard(
        container,
        `${discoveryErrorCount} discovery issue${discoveryErrorCount > 1 ? 's' : ''}`,
        'Some pages could not be fully scanned - local copies were preserved',
        'View log',
        cb ? () => void cb.onOpenSyncLog() : undefined,
      );
    }

    if (d.duplicateNotionIds > 0) {
      this.renderIssueCard(
        container,
        `${d.duplicateNotionIds} duplicate ID${d.duplicateNotionIds > 1 ? 's' : ''}`,
        'Same Notion page exists in multiple files',
        '',
        undefined,
      );
    }
  }

  private renderIssueCard(
    container: HTMLElement,
    title: string,
    sub: string,
    actionLabel: string,
    onAction?: () => void,
  ): void {
    const card = container.createDiv({ cls: 'n2o-dash-hybrid-issue-card' });
    const body = card.createDiv({ cls: 'n2o-dash-hybrid-issue-body' });
    body.createDiv({ cls: 'n2o-dash-hybrid-issue-title', text: title });
    if (sub) body.createDiv({ cls: 'n2o-dash-hybrid-issue-sub', text: sub });
    if (actionLabel && onAction) {
      const btn = card.createEl('button', { cls: 'n2o-dash-hybrid-issue-btn', text: actionLabel });
      btn.addEventListener('click', onAction);
    }
  }

  /**
   * Failed-media card (#1780). Splits the flat "N failed downloads" count into
   * two honest buckets, each an expandable per-item list:
   *   - transient (timeout / 5xx / expired Notion signature): red alarm, "Retry
   *     now", and a per-item "will retry" note - N2O handles these itself.
   *   - permanent (404 / gone / forbidden): a quiet info tone, per item "Open in
   *     Notion" (the only place a dead source can be fixed) and "Dismiss".
   * Each row names the note it belongs to (click to open), shows the failing URL
   * truncated, and the real classified reason.
   */
  private renderFailedMediaCard(
    container: HTMLElement,
    d: DashboardData,
    cb: DashboardCallbacks,
  ): void {
    const { transient, permanent } = partitionFailedMedia(d.failedMedia);

    if (transient.length > 0) {
      this.renderFailedMediaBucket(
        container,
        transient,
        {
          tone: 'alarm',
          title: `${transient.length} download${transient.length > 1 ? 's' : ''} need${transient.length === 1 ? 's' : ''} attention`,
          sub: 'Images & files that failed to download - N2O will retry on the next sync',
          action: { label: 'Retry now', onClick: () => void cb.onRetryFailedMedia() },
        },
        cb,
      );
    }
    if (permanent.length > 0) {
      this.renderFailedMediaBucket(
        container,
        permanent,
        {
          tone: 'info',
          title: `${permanent.length} unavailable at source`,
          sub: 'The source file is gone; fix or remove it in Notion',
        },
        cb,
      );
    }
  }

  private renderFailedMediaBucket(
    container: HTMLElement,
    rows: FailedMediaRow[],
    opts: {
      tone: 'alarm' | 'info';
      title: string;
      sub: string;
      action?: { label: string; onClick: () => void };
    },
    cb: DashboardCallbacks,
  ): void {
    const card = container.createDiv({
      cls: `n2o-dash-hybrid-issue-card n2o-dash-media-card${opts.tone === 'info' ? ' n2o-dash-media-card-info' : ''}`,
    });
    const details = card.createEl('details', { cls: 'n2o-dash-media-details' });
    const summary = details.createEl('summary', { cls: 'n2o-dash-media-summary' });
    const body = summary.createDiv({ cls: 'n2o-dash-hybrid-issue-body' });
    body.createDiv({ cls: 'n2o-dash-hybrid-issue-title', text: opts.title });
    body.createDiv({ cls: 'n2o-dash-hybrid-issue-sub', text: opts.sub });
    if (opts.action) {
      const btn = summary.createEl('button', {
        cls: 'n2o-dash-hybrid-issue-btn',
        text: opts.action.label,
      });
      // Inside a <summary>, a click would toggle the disclosure; keep the button
      // meaning "do the action", not "expand".
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        opts.action?.onClick();
      });
    }

    const list = details.createDiv({ cls: 'n2o-dash-media-list' });
    for (const r of rows) {
      const row = list.createDiv({ cls: 'n2o-dash-media-row' });

      const head = row.createDiv({ cls: 'n2o-dash-media-row-head' });
      const noteLink = head.createEl('a', { cls: 'n2o-dash-media-note', text: r.page, href: '#' });
      setTooltip(noteLink, `Open ${r.obsidianPath}`);
      noteLink.addEventListener('click', (e) => {
        e.preventDefault();
        cb.onOpenNote(r.obsidianPath);
      });
      head.createSpan({ cls: 'n2o-dash-media-kind', text: humanizeMediaType(r.item.mediaType) });
      if (r.item.url) {
        const url = head.createEl('code', {
          cls: 'n2o-dash-media-url',
          text: this.truncateUrlMiddle(r.item.url, 52),
        });
        setTooltip(url, r.item.url);
      }

      if (r.item.reason) row.createDiv({ cls: 'n2o-dash-media-reason', text: r.item.reason });

      const actions = row.createDiv({ cls: 'n2o-dash-media-actions' });
      if (r.item.class === 'permanent') {
        const openBtn = actions.createEl('button', {
          cls: 'n2o-dash-btn-tiny',
          text: 'Open in Notion',
        });
        openBtn.addEventListener('click', () => cb.onOpenPageInNotion(r.notionId));
        const dismissBtn = actions.createEl('button', {
          cls: 'n2o-dash-btn-tiny n2o-dash-media-dismiss',
          text: 'Dismiss',
        });
        dismissBtn.addEventListener(
          'click',
          () => void cb.onDismissFailedMedia(r.notionId, r.item.id),
        );
      } else {
        const n = r.item.retryCount ?? 0;
        actions.createSpan({
          cls: 'n2o-dash-media-retrynote',
          text:
            n >= MAX_MEDIA_RETRIES
              ? 'retry limit reached - retry manually'
              : `will retry (attempt ${n + 1})`,
        });
      }
    }
  }

  /** Truncate a URL in the MIDDLE so both the host and the filename stay visible. */
  private truncateUrlMiddle(s: string, max: number): string {
    if (s.length <= max) return s;
    const keep = Math.max(4, max - 3);
    const head = Math.ceil(keep / 2);
    const tail = Math.floor(keep / 2);
    return `${s.slice(0, head)}...${s.slice(s.length - tail)}`;
  }

  private renderHybridStat(container: HTMLElement, count: number, label: string): void {
    const wrap = container.createDiv({ cls: 'n2o-dash-hybrid-stat' });
    wrap.createSpan({ cls: 'n2o-dash-hybrid-stat-num', text: count.toLocaleString() });
    const displayLabel = count === 1 ? label.replace(/s$/, '') : label;
    wrap.createSpan({ cls: 'n2o-dash-hybrid-stat-label', text: displayLabel });
  }

  /**
   * Live count of `.md` files inside the sync folder. Used by the
   * scopecard "files" tile so users see vault content grow during
   * sync instead of a stale 0.
   */
  private countMdFilesInSyncFolder(syncFolder: string): number {
    const prefix = `${syncFolder}/`;
    return this.app.vault
      .getFiles()
      .filter((f) => f.path.startsWith(prefix) && f.path.endsWith('.md')).length;
  }

  /**
   * Refresh the "files" tile of the Notion/ scopecard from the live
   * vault count. Cheap (one Map iteration); safe to call on every
   * progress emit. Pages/databases tiles are static (config-driven)
   * so we don't touch them here.
   */
  private updateVaultCounts(): void {
    if (!this.scopecardStatsEl || !this.data) return;
    const count = this.countMdFilesInSyncFolder(this.data.syncFolder);
    const fileNumEl = this.scopecardStatsEl
      .querySelectorAll('.n2o-dash-hybrid-stat')[2]
      ?.querySelector('.n2o-dash-hybrid-stat-num');
    if (fileNumEl instanceof HTMLElement) {
      fileNumEl.textContent = count.toLocaleString();
    }
  }

  private computeDryRunStats(d: DashboardData): {
    dbs: number | null;
    pages: number | null;
    dbItems: number | null;
  } {
    if (d.syncScope === 'all') {
      return { dbs: null, pages: null, dbItems: null };
    }
    let dbs = 0;
    let pages = 0;
    let dbItems = 0;
    for (const it of d.selectedItems) {
      if (it.type === 'database') {
        dbs++;
        if (it.itemCount !== undefined) dbItems += it.itemCount;
      } else {
        pages++;
      }
    }
    return { dbs, pages, dbItems: dbItems > 0 ? dbItems : null };
  }
  // -- Minimal footer (first-run) ------------------------------------

  /** Bottom-anchored minimal footer: tiny settings gear + version. Nothing else. */
  /**
   * Lite edition banner - sticky just above the footer, reusing the tier
   * banner styles from the full edition. One quiet line: what Lite is,
   * what the full edition adds, and a link. No license state to render.
   */
  private renderTierBanner(container: HTMLElement): void {
    const banner = container.createDiv({ cls: 'n2o-dash-tier-banner is-lifetime' });

    const iconEl = banner.createSpan({ cls: 'n2o-dash-tier-icon' });
    setIcon(iconEl, 'arrow-down-to-line');

    const body = banner.createDiv({ cls: 'n2o-dash-tier-body' });
    body.createSpan({ cls: 'n2o-dash-tier-title', text: 'N2O Sync Lite \u00B7 free edition.' });
    body.createSpan({
      cls: 'n2o-dash-tier-sub',
      text: ' The full edition adds two-way sync, automation, and live database views.',
    });

    const btn = banner.createEl('button', { cls: 'n2o-dash-tier-cta' });
    btn.textContent = 'Try Pro free';
    btn.addEventListener('click', () => this.callbacks?.onOpenUpgrade());
  }

  private renderMinimalFooter(container: HTMLElement, d: DashboardData): void {
    // Outer shell is the bottom-anchored section (uses margin-top: auto
    // in the flex-column dashboard). It wraps the tier banner AND the
    // minfooter gear/version row so both stay glued to the bottom as a
    // single unit - previously I tried to anchor them separately with
    // two margin-top: auto elements and they split the remaining space.
    const shell = container.createDiv({ cls: 'n2o-dash-bottom-shell' });

    // Lite edition banner renders above the minfooter proper.
    this.renderTierBanner(shell);

    const footer = shell.createDiv({ cls: 'n2o-dash-minfooter' });

    // Top row: gear + version. Everything visible lives here.
    const row = footer.createDiv({ cls: 'n2o-dash-minfooter-row' });
    if (this.callbacks) {
      const cb = this.callbacks;
      const gear = row.createEl('button', { cls: 'n2o-dash-minfooter-gear' });
      setIcon(gear, 'settings');
      gear.setAttribute('aria-label', 'Open settings');
      gear.addEventListener('click', () => cb.onOpenSettings());
    }
    row.createSpan({ cls: 'n2o-dash-minfooter-spacer' });
    row.createSpan({ cls: 'n2o-dash-minfooter-version', text: `v${d.pluginVersion}` });

    // Empty placeholder row underneath that doubles the overall footer
    // height so the sticky footer clears Obsidian's own status hints and
    // stays comfortably above the bottom edge of the sidebar.
    footer.createDiv({ cls: 'n2o-dash-minfooter-pad' });
  }
}
