/**
 * SyncTreePicker - Interactive checkbox tree for selecting Notion databases and pages to sync.
 *
 * Opens as a modal. Reads all data from PageCacheStore (instant). If the cache is empty,
 * runs discovery via discoverFn with a progress bar. Provides local filtering + optional
 * Notion API search for items not in cache.
 */

import { App, Notice, debounce, setIcon, setTooltip } from 'obsidian';
import type { NotionClient } from '../infrastructure/notion/client';
import type { NotionPage, NotionRichText } from '../domain/models/notion-api-types';
import type { PageCacheStore, CachedPage } from '../infrastructure/storage/page-cache-store';
import type { SelectedSyncItem } from '../settings';
import { getErrorMessage } from '../shared/errors';
import { createLogger } from '../shared/logger';
import { normalizeNotionId } from '../domain/models/notion-id';
import { NOTICE_SHORT } from '../shared/constants';
import { BaseN2OModal } from './base-modal';

const log = createLogger('SyncTreePicker');
const FILTER_DEBOUNCE_MS = 200;
const NOTION_SEARCH_DEBOUNCE_MS = 400;

/** Callback for running workspace discovery. Populates the page cache. */
export type DiscoverFn = (onProgress?: (message: string) => void) => Promise<void>;

interface TreeNode {
  id: string;
  title: string;
  type: 'database' | 'page';
  checked: boolean;
  expanded: boolean;
  children: TreeNode[];
  parentId?: string;
  itemCount?: number;
  /** True for workspace-level pages (no parent page). */
  isTopLevel?: boolean;
}

export class SyncTreePicker extends BaseN2OModal {
  private tree: TreeNode[] = [];
  private searchResults: TreeNode[] | null = null; // null = not searching
  private discovering = false;
  private discoveryCancelled = false;
  private searching = false;
  private searchHasMore = false;
  private searchCursor: string | undefined;
  private searchLastQuery = '';
  private loadingMoreSearch = false;
  private filterQuery = '';
  private treeContainerEl!: HTMLElement;
  private treeContentEl!: HTMLElement;
  private notionSearchEl!: HTMLElement;
  private selectedPanelEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private progressRailEl!: HTMLElement;
  private progressRailBarEl!: HTMLElement;
  private discoveryBannerEl!: HTMLElement;
  private crumbCacheTimeEl: HTMLElement | null = null;
  private refreshBtnEl!: HTMLButtonElement;
  private saveBtnEl: HTMLButtonElement | null = null;
  private filterMatchCountEl: HTMLElement | null = null;
  /** Persistent selection map - survives search/tree switches. Single source of truth. */
  private selectedItems = new Map<
    string,
    { title: string; type: 'database' | 'page'; parentId?: string }
  >();
  private selectedPanelCollapsed = false;
  /** Tracks which tree sections (databases, pages) are expanded. Both open by default. */
  private treeSectionsOpen = new Set<string>(['databases', 'top-level', 'pages']);
  /**
   * DOM caches populated during renderTree. Used by applyFilter() to
   * update visibility in place instead of destroying and rebuilding the
   * entire tree on every filter keystroke. Cleared at the start of
   * every renderTree so they always reflect the current DOM.
   */
  private renderedRows = new Map<string, { row: HTMLElement; node: TreeNode; depth: number }>();
  /** Node ids the active filter auto-expanded, restored on filter clear. */
  private filterAutoExpanded = new Set<string>();
  private renderedSections = new Map<
    string,
    {
      sectionEl: HTMLElement;
      labelEl: HTMLElement;
      nodes: TreeNode[];
      totalCount: number;
    }
  >();

  constructor(
    app: App,
    private notionClient: NotionClient | null,
    private currentSelections: SelectedSyncItem[],
    private onSave: (items: SelectedSyncItem[]) => void | Promise<void>,
    private pageCacheStore: PageCacheStore,
    private discoverFn: DiscoverFn,
    private onScanVault?: () => Promise<Set<string>>,
    private syncOptionsAccessor?: {
      get: () => {
        childPages: boolean;
        childDatabases: boolean;
        downloadMedia: boolean;
        archivedPages: boolean;
        filteredViewsOnly: boolean;
      };
      set: (
        key:
          'childPages' | 'childDatabases' | 'downloadMedia' | 'archivedPages' | 'filteredViewsOnly',
        value: boolean,
      ) => Promise<void>;
    },
    private workspaceName?: string | null,
    private oauthBotId?: string | null,
    /** Optional probe for "is a plugin-level discovery in flight right
        now?". When true, the picker treats the open as "join an
        in-progress discovery" (show its progress banner, await the
        shared lock's promise) instead of just loading whatever is in
        the cache so far. Without this probe a user opening the picker
        mid-discovery would see partial cached data and no hint that
        more is on the way. */
    private isDiscoveryRunning?: () => boolean,
  ) {
    super(app);
    // Seed selectedItems from saved selections (normalize IDs to dashless format
    // to match tree node IDs which come from PageCacheStore in dashless format)
    for (const s of currentSelections) {
      this.selectedItems.set(normalizeNotionId(s.id), { title: s.title, type: s.type });
    }
  }

  override async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass('n2o-tree-picker-modal');
    contentEl.addClass('n2o-tree-picker');

    // ── Title bar ── "N2O / Select pages to sync"  +  OAuth indicator
    const headerRow = contentEl.createDiv({ cls: 'n2o-tree-header' });
    const titleEl = headerRow.createDiv({ cls: 'n2o-tree-title' });
    const wm = titleEl.createSpan({ cls: 'n2o-tree-wordmark' });
    wm.createSpan({ text: 'N' });
    wm.createSpan({ cls: 'n2o-tree-wordmark-accent', text: '2' });
    wm.createSpan({ text: 'O' });
    titleEl.createSpan({ cls: 'n2o-tree-title-sep', text: '/' });
    titleEl.createSpan({ cls: 'n2o-tree-title-crumb', text: 'Choose what to sync' });

    // OAuth indicator (right side of header) - shows "OAuth / bot_xxx" when OAuth,
    // "Connected" as generic fallback for manual-token users.
    const oauth = headerRow.createSpan({ cls: 'n2o-tree-oauth' });
    oauth.createSpan({ cls: 'n2o-tree-oauth-dot' });
    if (this.oauthBotId) {
      const short = this.oauthBotId.replace(/-/g, '').slice(0, 8);
      oauth.createSpan({ text: `OAuth \u00B7 bot_${short}` });
    } else {
      oauth.createSpan({ text: 'Connected' });
    }

    // Inline close button - sits on the same row as title + OAuth pill so the
    // header is one tight strip. Hides Obsidian's default modal close button.
    const closeBtn = headerRow.createSpan({ cls: 'n2o-tree-header-close' });
    closeBtn.setAttribute('role', 'button');
    closeBtn.setAttribute('aria-label', 'Close');
    setIcon(closeBtn, 'x');
    closeBtn.addEventListener('click', () => this.close());

    // ── Progress rail (thin, under header) ──
    this.progressRailEl = contentEl.createDiv({ cls: 'n2o-tree-progress-rail' });
    this.progressRailBarEl = this.progressRailEl.createDiv({ cls: 'n2o-tree-progress-rail-bar' });

    // ── Discovery banner (accent-soft strip, only visible while discovering) ──
    this.discoveryBannerEl = contentEl.createDiv({ cls: 'n2o-tree-discovery-banner' });

    // ── Discovery status (live banner while fetching) ──
    // Status is legacy - kept for aria-live announcements but visually hidden.
    // The breadcrumbs ("Cache updated X ago") now carry the same info.
    this.statusEl = contentEl.createDiv({ cls: 'n2o-tree-status n2o-tree-status--legacy' });
    this.statusEl.setAttribute('role', 'status');
    this.statusEl.setAttribute('aria-live', 'polite');

    // ── Body: three-pane (rail full-height, main pane with breadcrumbs+filter+tree, selection panel) ──
    const bodyEl = contentEl.createDiv({ cls: 'n2o-tree-body' });

    // Workspace rail - full height of body on the left. Single active ws; placeholder + and settings.
    const rail = bodyEl.createDiv({ cls: 'n2o-tree-rail' });
    const wsLetter = (this.workspaceName ?? 'W').trim().charAt(0).toUpperCase() || 'W';
    const wsBtn = rail.createDiv({
      cls: 'n2o-tree-rail-ws is-active',
      attr: { title: this.workspaceName ?? 'Workspace' },
    });
    wsBtn.createSpan({ text: wsLetter });
    rail.createDiv({ cls: 'n2o-tree-rail-divider' });
    const addBtn = rail.createDiv({
      cls: 'n2o-tree-rail-add',
      attr: { title: 'Add workspace (coming soon)' },
    });
    setIcon(addBtn, 'plus');
    rail.createDiv({ cls: 'n2o-tree-rail-spacer' });
    // Interactive icon control: give it a button role, a label, and keyboard
    // operability so it isn't an inaccessible bare div (#1543).
    const railSettings = rail.createDiv({
      cls: 'n2o-tree-rail-settings',
      attr: { title: 'Settings', role: 'button', tabindex: '0', 'aria-label': 'Open N2O settings' },
    });
    setIcon(railSettings, 'settings');
    const openSettings = (): void => {
      this.close();
      const settings = (
        this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }
      ).setting;
      settings.open();
      settings.openTabById('n2o');
    };
    railSettings.addEventListener('click', openSettings);
    railSettings.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openSettings();
      }
    });

    // Main pane - breadcrumbs + filter/actions + tree all live here.
    const mainPane = bodyEl.createDiv({ cls: 'n2o-tree-mainpane' });

    // Breadcrumbs (now inside main pane so rail spans full body height)
    const breadcrumbs = mainPane.createDiv({ cls: 'n2o-tree-breadcrumbs' });
    const crumbLeft = breadcrumbs.createDiv({ cls: 'n2o-tree-crumb-left' });
    setIcon(crumbLeft.createSpan({ cls: 'n2o-tree-crumb-icon' }), 'home');
    crumbLeft.createSpan({ cls: 'n2o-tree-crumb-ws', text: this.workspaceName ?? 'Workspace' });
    setIcon(crumbLeft.createSpan({ cls: 'n2o-tree-crumb-sep' }), 'chevron-right');
    crumbLeft.createSpan({ cls: 'n2o-tree-crumb-path', text: 'All pages & databases' });
    const crumbRight = breadcrumbs.createDiv({ cls: 'n2o-tree-crumb-right' });
    setIcon(crumbRight.createSpan({ cls: 'n2o-tree-crumb-icon' }), 'clock');
    this.crumbCacheTimeEl = crumbRight.createSpan({
      cls: 'n2o-tree-crumb-cachetime',
      text: this.buildCacheAgeLabel(),
    });

    // Action bar - filter + match count + All/None/Scan/Refresh
    const actionBar = mainPane.createDiv({ cls: 'n2o-tree-actionbar' });

    const filterWrap = actionBar.createDiv({ cls: 'n2o-tree-filter-wrap' });
    const filterIcon = filterWrap.createSpan({ cls: 'n2o-tree-filter-icon' });
    setIcon(filterIcon, 'search');
    const filterInput = filterWrap.createEl('input', {
      type: 'text',
      placeholder: 'Filter pages and databases...',
      cls: 'n2o-tree-search',
    });
    filterInput.setAttribute('aria-label', 'Filter loaded pages and databases');
    this.filterMatchCountEl = filterWrap.createSpan({ cls: 'n2o-tree-filter-matches' });
    // Keyboard-shortcut hint, right-aligned inside the filter wrap
    const kbd = filterWrap.createSpan({ cls: 'n2o-tree-filter-kbd' });
    kbd.createSpan({ cls: 'n2o-tree-kbd', text: 'Ctrl' });
    kbd.createSpan({ cls: 'n2o-tree-kbd', text: 'F' });
    const debouncedFilter = debounce(
      () => {
        this.applyFilter();
      },
      FILTER_DEBOUNCE_MS,
      false,
    );
    filterInput.addEventListener('input', () => {
      this.filterQuery = filterInput.value.trim().toLowerCase();
      debouncedFilter();
    });

    const actionBtns = actionBar.createDiv({ cls: 'n2o-tree-action-btns' });
    const mkSoft = (
      label: string,
      icon: string | null,
      onClick: () => void | Promise<void>,
    ): HTMLButtonElement => {
      const btn = actionBtns.createEl('button', { cls: 'n2o-tree-soft-btn' });
      if (icon) setIcon(btn.createSpan({ cls: 'n2o-tree-soft-btn-icon' }), icon);
      btn.createSpan({ text: label });
      btn.addEventListener('click', () => {
        void onClick();
      });
      return btn;
    };
    mkSoft('All', null, () => this.setAllChecked(true));
    mkSoft('None', null, () => this.setAllChecked(false));
    if (this.onScanVault) {
      const scanBtn = mkSoft('Scan vault', 'search', async () => {
        if (scanBtn.disabled) return;
        scanBtn.disabled = true;
        scanBtn.addClass('n2o-refreshing');
        try {
          await this.handleScanVault();
        } finally {
          scanBtn.disabled = false;
          scanBtn.removeClass('n2o-refreshing');
        }
      });
    }
    this.refreshBtnEl = mkSoft('Refresh', 'refresh-cw', async () => {
      if (this.discovering) return;
      this.setRefreshLoading(true);
      this.progressRailBarEl.setCssStyles({ width: '0%' });
      this.progressRailEl.addClass('is-active');
      try {
        await this.runDiscovery(true);
      } finally {
        this.setRefreshLoading(false);
      }
    });

    // Tree container lives inside mainPane, below breadcrumbs + action bar
    this.treeContainerEl = mainPane.createDiv({ cls: 'n2o-tree-container' });
    this.treeContainerEl.setAttribute('role', 'tree');
    this.treeContentEl = this.treeContainerEl.createDiv({ cls: 'n2o-tree-content' });
    // Search card is a sibling of the tree container so it pins to the bottom
    // of the main pane (below the scrolling tree), not inside the scroll area.
    this.notionSearchEl = mainPane.createDiv({ cls: 'n2o-tree-notion-search' });

    // Selection panel on the right side of bodyEl (sibling of rail + mainPane)
    this.selectedPanelEl = bodyEl.createDiv({ cls: 'n2o-tree-selected' });
    this.renderSelectedPanel();

    // Render the "Search Notion directly" card immediately so it's visible
    // even before discovery completes / when tree is empty / when cancelled.
    this.renderNotionSearchSection();

    // Footer - keyboard hints left, info + actions right
    const footer = contentEl.createDiv({ cls: 'n2o-tree-footer' });

    const hints = footer.createDiv({ cls: 'n2o-tree-footer-hints' });
    const addHint = (kbd: string, label: string): void => {
      const wrap = hints.createSpan({ cls: 'n2o-tree-footer-hint' });
      wrap.createSpan({ cls: 'n2o-tree-kbd', text: kbd });
      wrap.createSpan({ text: ' ' + label });
    };
    addHint('\u2191\u2193', 'navigate');
    addHint('Space', 'toggle');
    addHint('\u2192', 'expand');
    addHint('Esc', 'cancel');

    const actions = footer.createDiv({ cls: 'n2o-tree-footer-actions' });
    const info = actions.createSpan({ cls: 'n2o-tree-footer-info' });
    setIcon(info.createSpan({ cls: 'n2o-tree-footer-info-icon' }), 'info');
    info.createSpan({ text: 'Saved to profile \u00B7 nothing writes until sync' });

    actions
      .createEl('button', { text: 'Cancel', cls: 'n2o-tree-footer-cancel' })
      .addEventListener('click', () => this.close());
    const saveBtn = actions.createEl('button', {
      cls: 'mod-cta n2o-tree-footer-save',
    });
    this.saveBtnEl = saveBtn;
    this.updateSaveButtonLabel();
    saveBtn.addEventListener('click', () => {
      void (async () => {
        if (saveBtn.disabled) return;
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
        try {
          await this.saveAndClose();
        } finally {
          saveBtn.disabled = false;
          this.updateSaveButtonLabel();
        }
      })();
    });

    // Render idle banner immediately so the strip is never empty,
    // then load tree (which re-renders the banner if cache has data).
    this.renderIdleBanner();

    // Global keyboard navigation - arrows / space work from anywhere in the picker
    // (not just when a row already has focus, which is the default tree-grid behavior).
    contentEl.addEventListener('keydown', (e) => this.handleGlobalKeydown(e));

    await this.fetchTree();
  }

  /**
   * Top-level keyboard handler - arrows navigate, Space/Enter toggles.
   * Works from anywhere in the picker (search input, soft buttons, or a focused row).
   */
  private handleGlobalKeydown(e: KeyboardEvent): void {
    const isArrowDown = e.key === 'ArrowDown';
    const isArrowUp = e.key === 'ArrowUp';
    const isArrowRight = e.key === 'ArrowRight';
    const isArrowLeft = e.key === 'ArrowLeft';
    const isToggle = e.key === ' ' || e.key === 'Enter';
    if (!isArrowDown && !isArrowUp && !isArrowRight && !isArrowLeft && !isToggle) return;

    const target = e.target as HTMLElement;
    if (target.tagName === 'TEXTAREA' || target.isContentEditable) return;

    // Space/Enter inside the search input should not toggle a tree row - // typing a space in the filter is normal text input.
    const isInInput =
      target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'checkbox';
    if (isInInput && isToggle) return;
    // Allow arrow keys from the search input to navigate the tree.

    const items = Array.from(this.treeContainerEl.querySelectorAll<HTMLElement>('.n2o-tree-node'));
    if (items.length === 0) return;

    const currentRow = target.closest<HTMLElement>('.n2o-tree-node');

    if (isArrowDown || isArrowUp) {
      let nextIndex: number;
      if (currentRow) {
        const idx = items.indexOf(currentRow);
        nextIndex = isArrowDown ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1);
      } else {
        nextIndex = isArrowDown ? 0 : items.length - 1;
      }
      e.preventDefault();
      const next = items[nextIndex];
      if (!next) return;
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
      return;
    }

    if (isToggle && currentRow) {
      e.preventDefault();
      const checkbox = currentRow.querySelector<HTMLInputElement>('input[type="checkbox"]');
      checkbox?.click();
      return;
    }

    if ((isArrowRight || isArrowLeft) && currentRow) {
      const toggle = currentRow.querySelector<HTMLElement>('.n2o-tree-toggle');
      const isExpanded = currentRow.getAttribute('aria-expanded') === 'true';
      if (isArrowRight && toggle && !isExpanded) {
        e.preventDefault();
        toggle.click();
      } else if (isArrowLeft && toggle && isExpanded) {
        e.preventDefault();
        toggle.click();
      }
    }
  }

  override onClose(): void {
    this.discoveryCancelled = true;
    super.onClose();
  }

  // ── Data Fetching ─────────────────────────────────────

  /**
   * Load tree data. Three cases:
   *   1. Discovery already in flight (startup / post-OAuth / kebab) ->
   *      join it: show the progress banner and await the shared lock's
   *      promise. runSharedDiscovery returns the same promise, so no
   *      new scan is started.
   *   2. Cache populated AND no discovery running -> instant load from
   *      SQLite. No network work at all.
   *   3. Cache empty AND no discovery running -> kick off a fresh
   *      discovery with progress UI.
   */
  private async fetchTree(): Promise<void> {
    const discoveryRunning = this.isDiscoveryRunning?.() ?? false;

    if (!discoveryRunning && !this.pageCacheStore.isEmpty()) {
      this.loadFromCache();
      return;
    }

    // Either a shared-lock discovery is in flight (await it, show the
    // banner so the user sees it) or the cache is empty (start fresh).
    // runSharedDiscovery dedupes at the plugin level either way.
    await this.runDiscovery(false);
  }

  /**
   * Load tree from PageCacheStore (instant, <100ms).
   * Builds the full TreeNode hierarchy including database items.
   */
  private loadFromCache(): void {
    const cache = this.pageCacheStore;
    const checkedIds = new Set([
      ...this.currentSelections.map((s) => s.id.replace(/-/g, '')),
      ...[...this.selectedItems.keys()].map((k) => k.replace(/-/g, '')),
    ]);

    // Load databases and their items
    const databases = cache.getAllDatabases();
    const dbIds = new Set(databases.map((db) => db.notionId));
    const dbNodes: TreeNode[] = databases.map((db) => {
      const savedItem = this.currentSelections.find((s) => s.id.replace(/-/g, '') === db.notionId);
      const dbChildren = cache.getChildrenOf(db.notionId);
      const childNodes: TreeNode[] = dbChildren
        .filter((c) => c.itemType === 'database-item')
        .map((child) => ({
          id: child.notionId,
          title: child.title || 'Untitled',
          type: 'page' as const,
          checked: checkedIds.has(child.notionId),
          expanded: false,
          children: [],
          parentId: db.notionId,
        }));

      return {
        id: db.notionId,
        title: db.title || 'Untitled Database',
        type: 'database' as const,
        checked: checkedIds.has(db.notionId),
        expanded: false,
        children: childNodes,
        itemCount:
          childNodes.length > 0 ? childNodes.length : (db.itemCount ?? savedItem?.itemCount),
      };
    });

    // Load all non-database pages and build hierarchy
    const topLevelPages = cache.getAllTopLevelPages();
    const pageNodeMap = new Map<string, TreeNode>();

    // First pass: create nodes for top-level (workspace) pages
    for (const page of topLevelPages) {
      pageNodeMap.set(page.notionId, {
        id: page.notionId,
        title: page.title || 'Untitled',
        type: 'page' as const,
        checked: checkedIds.has(page.notionId),
        expanded: false,
        children: [],
        isTopLevel: true,
      });
    }

    // Load child pages and build hierarchy
    this.loadChildrenRecursive(cache, topLevelPages, dbIds, checkedIds, pageNodeMap);

    // Collect top-level page nodes (those without a parent in our set)
    const topLevelPageNodes: TreeNode[] = [];
    for (const page of topLevelPages) {
      const node = pageNodeMap.get(page.notionId);
      if (node) topLevelPageNodes.push(node);
    }

    this.tree = [...dbNodes, ...topLevelPageNodes];
    this.renderTree();

    // Show summary + cache age in status
    const lastDiscovery = cache.getLastDiscoveryTime();
    const age = lastDiscovery ? `updated ${this.formatTimeAgo(lastDiscovery)}` : '';
    const totalCached = cache.count();
    this.updateStatus(
      `${totalCached.toLocaleString()} items accessible${age ? ` \u00B7 ${age}` : ''}`,
    );

    // Refresh the always-visible idle banner with current workspace summary
    this.renderIdleBanner();
  }

  /**
   * Render the idle (post-discovery) banner: workspace summary + cache age.
   * Always visible so the strip never collapses to empty space.
   */
  private renderIdleBanner(): void {
    if (!this.discoveryBannerEl || this.discovering) return;

    const cache = this.pageCacheStore;
    const dbCount = cache.getAllDatabases().length;
    const totalItems = cache.count();
    const lastDiscovery = cache.getLastDiscoveryTime();

    this.discoveryBannerEl.empty();
    this.discoveryBannerEl.removeClass('is-active');
    this.discoveryBannerEl.addClass('is-idle');

    // Left: status icon (check) + summary text
    const iconWrap = this.discoveryBannerEl.createSpan({ cls: 'n2o-tree-discovery-icon' });
    setIcon(iconWrap, totalItems > 0 ? 'check-circle' : 'info');

    if (totalItems > 0) {
      this.discoveryBannerEl.createSpan({
        cls: 'n2o-tree-discovery-text',
        text: 'Workspace ready',
      });
      this.discoveryBannerEl.createSpan({ cls: 'n2o-tree-discovery-sep', text: '\u00B7' });
      const summary = `${dbCount} database${dbCount === 1 ? '' : 's'} \u00B7 ${totalItems.toLocaleString()} items`;
      this.discoveryBannerEl.createSpan({ cls: 'n2o-tree-discovery-count', text: summary });
    } else {
      this.discoveryBannerEl.createSpan({
        cls: 'n2o-tree-discovery-text',
        text: 'Cache is empty \u2014 click Refresh to scan your workspace',
      });
    }

    this.discoveryBannerEl.createSpan({ cls: 'n2o-tree-discovery-spacer' });

    if (lastDiscovery) {
      this.discoveryBannerEl.createSpan({
        cls: 'n2o-tree-discovery-target',
        text: `updated ${this.formatTimeAgo(lastDiscovery)}`,
      });
    }

    // Progress rail at full width to indicate "complete / ready"
    if (this.progressRailEl && this.progressRailBarEl) {
      this.progressRailEl.addClass('is-active');
      this.progressRailEl.addClass('is-idle');
      this.progressRailBarEl.setCssStyles({ width: '100%' });
    }
  }

  /**
   * Recursively load child pages from cache and attach to parent nodes.
   */
  private loadChildrenRecursive(
    cache: PageCacheStore,
    parentPages: CachedPage[],
    dbIds: Set<string>,
    checkedIds: Set<string>,
    nodeMap: Map<string, TreeNode>,
  ): void {
    for (const parent of parentPages) {
      const children = cache.getChildrenOf(parent.notionId);
      const parentNode = nodeMap.get(parent.notionId);
      if (!parentNode) continue;

      for (const child of children) {
        // Skip database items - they are under database nodes
        if (
          child.itemType === 'database-item' ||
          child.itemType === 'database' ||
          dbIds.has(child.notionId)
        )
          continue;

        const childNode: TreeNode = {
          id: child.notionId,
          title: child.title || 'Untitled',
          type: 'page' as const,
          checked: checkedIds.has(child.notionId),
          expanded: false,
          children: [],
        };
        nodeMap.set(child.notionId, childNode);
        parentNode.children.push(childNode);
      }

      // Recurse into children that may have their own children
      if (parentNode.children.length > 0) {
        const childCachedPages = children.filter(
          (c) => c.itemType === 'page' && !dbIds.has(c.notionId),
        );
        this.loadChildrenRecursive(cache, childCachedPages, dbIds, checkedIds, nodeMap);
      }
    }
  }

  /** Format an ISO timestamp as a human-readable "X ago" string. */
  private formatTimeAgo(isoTime: string): string {
    const diff = Date.now() - new Date(isoTime).getTime();
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  // ── Discovery ─────────────────────────────────────────

  /**
   * Run workspace discovery via discoverFn.
   * Progress is shown via the thin rail bar (both modes).
   * If background=true: tree stays visible.
   * If background=false: shows full progress UI in tree container.
   */
  private async runDiscovery(background: boolean): Promise<void> {
    if (this.discovering) return;
    this.discovering = true;
    this.discoveryCancelled = false;
    // No need to signal the host dashboard - `runSharedDiscovery` owns
    // the radar scan scene lifecycle via its shared lock + progress fan-
    // out. This picker only manages its OWN inline banner below.

    // Activate progress rail only for foreground (first-time) discovery
    // Background auto-refresh is silent - rail only shows on user-initiated Refresh
    if (!background) {
      this.progressRailBarEl.setCssStyles({ width: '0%' });
      this.progressRailEl.addClass('is-active');
      this.progressRailEl.removeClass('is-idle');
    }

    let progressTextEl: HTMLElement | null = null;

    // Render the inline discovery banner (matches design: thin accent-soft strip at top).
    // Tree area below stays visible / empty-placeholder; we do NOT take it over.
    this.discoveryBannerEl.empty();
    this.discoveryBannerEl.removeClass('is-idle');
    this.discoveryBannerEl.addClass('is-active');

    if (!background) {
      this.discoveryBannerEl.createDiv({ cls: 'n2o-tree-discovery-spinner' });
      // Status (accent): "Querying databases 6 of 8" / "Searching for pages..."
      progressTextEl = this.discoveryBannerEl.createSpan({
        cls: 'n2o-tree-discovery-text',
        text: 'Discovering your workspace\u2026',
      });
      // Count chip: "1,108 items found"
      this.discoveryBannerEl.createSpan({ cls: 'n2o-tree-discovery-sep is-count-sep', text: '' });
      this.discoveryBannerEl.createSpan({ cls: 'n2o-tree-discovery-count', text: '' });
      // Current target: "Reading Queue"
      this.discoveryBannerEl.createSpan({ cls: 'n2o-tree-discovery-sep is-target-sep', text: '' });
      this.discoveryBannerEl.createSpan({ cls: 'n2o-tree-discovery-target', text: '' });
      this.discoveryBannerEl.createSpan({ cls: 'n2o-tree-discovery-spacer' });
      const cancelLink = this.discoveryBannerEl.createEl('a', {
        cls: 'n2o-tree-discovery-cancel',
        text: 'Cancel',
        href: '#',
      });
      cancelLink.addEventListener('click', (e) => {
        e.preventDefault();
        this.discoveryCancelled = true;
        cancelLink.textContent = 'Cancelling\u2026';
      });

      // Empty tree placeholder so the main body doesn't look broken during first discovery
      if (this.tree.length === 0) {
        this.treeContentEl.empty();
        this.treeContentEl.createEl('p', {
          text: 'Loading your workspace\u2026',
          cls: 'n2o-tree-empty-hint',
        });
      }
    }

    try {
      await this.discoverFn((message: string) => {
        if (this.discoveryCancelled) return;

        // Update progress rail if active
        if (this.progressRailEl.hasClass('is-active')) {
          const pct = this.estimateProgressPercent(message);
          this.progressRailBarEl.style.width = `${pct}%`;
        }

        // Update the inline banner - parse the message into status / count / target.
        // Discovery messages look like:
        //   "Searching for pages... 1,500 found"
        //   "Querying databases 6 of 8" + optional second line of names
        //   "Querying databases 6 of 8\nReading Queue, Project Atlas"
        if (!background && progressTextEl) {
          const [rawStatus = '', names] = message.split('\n');
          // Pull "N found" or "N items found" out of the status if present
          const countMatch = rawStatus.match(/([\d,]+)\s+(?:items?\s+)?found/i);
          const cleanStatus = countMatch
            ? rawStatus
                .replace(countMatch[0], '')
                .replace(/[\u2026.\u2026]+$/, '')
                .trim()
            : rawStatus;
          progressTextEl.setText(cleanStatus);

          const countEl = this.discoveryBannerEl.querySelector('.n2o-tree-discovery-count');
          const countSep = this.discoveryBannerEl.querySelector(
            '.n2o-tree-discovery-sep.is-count-sep',
          );
          if (countEl && countSep) {
            if (countMatch) {
              countEl.textContent = `${countMatch[1]} items found`;
              countSep.textContent = '\u00B7';
            } else {
              countEl.textContent = '';
              countSep.textContent = '';
            }
          }

          const target = this.discoveryBannerEl.querySelector('.n2o-tree-discovery-target');
          const targetSep = this.discoveryBannerEl.querySelector(
            '.n2o-tree-discovery-sep.is-target-sep',
          );
          if (target && targetSep) {
            const firstName = names?.split(',')[0]?.trim() ?? '';
            if (firstName) {
              target.textContent = `"${firstName}"`;
              targetSep.textContent = '\u00B7';
            } else {
              target.textContent = '';
              targetSep.textContent = '';
            }
          }
        }
      });

      if (this.discoveryCancelled) {
        this.progressRailEl.removeClass('is-complete');
        this.discovering = false;
        if (!background && this.tree.length === 0) {
          this.treeContentEl.empty();
          this.treeContentEl.createEl('p', {
            text: 'Discovery cancelled.',
            cls: 'n2o-tree-empty-hint',
          });
          const retryBtn = this.treeContentEl.createEl('button', {
            text: 'Try again',
            cls: 'mod-cta',
          });
          retryBtn.addEventListener('click', () => {
            void this.runDiscovery(false);
          });
        }
        // Restore idle banner with whatever cached state we have (may be empty)
        this.renderIdleBanner();
        return;
      }

      // Complete: fill to 100%, brief done animation, then settle into idle banner.
      this.progressRailBarEl.setCssStyles({ width: '100%' });
      this.progressRailEl.addClass('is-complete');
      this.discovering = false;

      // Load from cache, refresh cache-age label, update selection count
      this.loadFromCache();
      if (this.crumbCacheTimeEl) {
        this.crumbCacheTimeEl.textContent = this.buildCacheAgeLabel();
      }
      this.updateSelectionCount();

      // Settle: drop the complete-pulse class shortly after; idle banner is already rendered by loadFromCache
      window.setTimeout(() => {
        this.progressRailEl.removeClass('is-complete');
      }, 600);
    } catch (error) {
      const msg = getErrorMessage(error);
      log.error('Discovery failed', error);
      this.progressRailEl.removeClass('is-complete');
      this.progressRailEl.removeClass('is-idle');
      this.progressRailEl.addClass('is-active');
      this.progressRailBarEl.setCssStyles({ width: '100%' });
      this.discovering = false;

      // Show error in the always-visible banner instead of clearing it
      this.discoveryBannerEl.empty();
      this.discoveryBannerEl.removeClass('is-active');
      this.discoveryBannerEl.removeClass('is-idle');
      this.discoveryBannerEl.addClass('is-error');
      const errIcon = this.discoveryBannerEl.createSpan({ cls: 'n2o-tree-discovery-icon' });
      setIcon(errIcon, 'alert-triangle');
      this.discoveryBannerEl.createSpan({
        cls: 'n2o-tree-discovery-text',
        text: `Discovery failed: ${msg}`,
      });
      this.discoveryBannerEl.createSpan({ cls: 'n2o-tree-discovery-spacer' });
      const retryLink = this.discoveryBannerEl.createEl('a', {
        cls: 'n2o-tree-discovery-cancel',
        text: 'Retry',
        href: '#',
      });
      retryLink.addEventListener('click', (e) => {
        e.preventDefault();
        void this.runDiscovery(false);
      });

      if (!background && this.tree.length === 0) {
        this.treeContentEl.empty();
        this.updateStatus(`Discovery failed: ${msg}`);
        this.treeContentEl.createEl('p', {
          text: `Failed to discover workspace: ${msg}`,
          cls: 'n2o-tree-empty-hint',
        });
      } else if (background) {
        log.warn('Background discovery refresh failed (non-fatal)', error);
      }
    } finally {
      this.discovering = false;
      this.setRefreshLoading(false);
    }
  }

  /**
   * Estimate discovery progress percentage from the progress message text.
   * Phases: pages (0-30%), databases (30-45%), querying databases (45-95%), done (95-100%).
   */
  private estimateProgressPercent(message: string): number {
    // "Searching for pages... 1,500 found" -> 0-30% based on count (estimate ~5000 total)
    if (message.startsWith('Searching for pages')) {
      const countMatch = message.match(/([\d,]+)\s+found/);
      if (countMatch) {
        const count = parseInt((countMatch[1] ?? '').replace(/,/g, ''), 10);
        return Math.min(30, Math.round((count / 5000) * 30));
      }
      return 2;
    }

    // "Searching for databases... 11 found" -> 30-40%
    if (message.startsWith('Searching for databases')) {
      return 35;
    }

    // "Querying databases N-M of X / Y items found" -> 40-95%
    const dbMatch = message.match(/Querying databases? (\d+)/);
    if (dbMatch) {
      const ofMatch = message.match(/of (\d+)/);
      if (ofMatch) {
        const current = parseInt(dbMatch[1] ?? '', 10);
        const total = parseInt(ofMatch[1] ?? '', 10);
        if (total > 0) {
          return 40 + Math.round((current / total) * 55);
        }
      }
      return 50;
    }

    return 5;
  }

  // ── Search (Notion API - for items not in cache) ──────

  /**
   * Search Notion API for pages and databases matching the query.
   * Results render in the "Search Notion" section, not the main tree.
   */
  private async performSearch(query: string, resultsContainer: HTMLElement): Promise<void> {
    if (this.searching || !this.notionClient) return;
    this.searching = true;
    this.renderNotionSearchResults(resultsContainer);

    try {
      const checkedIds = new Set([...this.getCheckedIds(), ...this.selectedItems.keys()]);

      const response = await this.notionClient.search(
        query,
        undefined, // no type filter - search both pages and databases
        { direction: 'descending', timestamp: 'last_edited_time' },
      );

      const results: TreeNode[] = [];
      for (const item of response.results) {
        const id = item.id.replace(/-/g, '');
        const isDb = item.object === 'database';

        let title: string;
        if (isDb) {
          const dbItem = item;
          title = dbItem.title?.map((t) => t.plain_text ?? '').join('') ?? 'Untitled Database';
        } else {
          title = this.extractPageTitle(item as NotionPage);
        }

        results.push({
          id,
          title,
          type: isDb ? 'database' : 'page',
          checked: checkedIds.has(id),
          expanded: false,
          children: [],
        });
      }

      this.searchResults = results;
      this.searchHasMore = response.has_more;
      this.searchCursor = response.next_cursor ?? undefined;
      this.searchLastQuery = query;
      this.searching = false;
      this.updateStatus(
        `Found ${results.length} result${results.length !== 1 ? 's' : ''} for "${query}"`,
      );
      this.renderNotionSearchResults(resultsContainer);
    } catch (error) {
      const msg = getErrorMessage(error);
      this.updateStatus(`Search failed: ${msg}`);
      log.warn(`Notion search failed: ${msg}`);
    } finally {
      this.searching = false;
    }
  }

  /**
   * Load the next page of search results and append to searchResults.
   */
  private async loadMoreSearchResults(resultsContainer: HTMLElement): Promise<void> {
    if (
      !this.searchHasMore ||
      !this.searchCursor ||
      !this.searchResults ||
      this.loadingMoreSearch ||
      !this.notionClient
    )
      return;
    this.loadingMoreSearch = true;
    this.renderNotionSearchResults(resultsContainer);

    const existingResults = this.searchResults;

    try {
      const checkedIds = new Set([...this.getCheckedIds(), ...this.selectedItems.keys()]);

      const response = await this.notionClient.search(
        this.searchLastQuery,
        undefined,
        { direction: 'descending', timestamp: 'last_edited_time' },
        this.searchCursor,
      );

      for (const item of response.results) {
        const id = item.id.replace(/-/g, '');
        const isDb = item.object === 'database';
        const title = isDb
          ? (item.title?.map((t) => t.plain_text ?? '').join('') ?? 'Untitled Database')
          : this.extractPageTitle(item as NotionPage);
        existingResults.push({
          id,
          title,
          type: isDb ? 'database' : 'page',
          checked: checkedIds.has(id),
          expanded: false,
          children: [],
        });
      }

      this.searchHasMore = response.has_more;
      this.searchCursor = response.next_cursor ?? undefined;

      if (this.searchHasMore && !this.searchCursor) {
        log.warn('Pagination guard: has_more=true but no cursor for loadMoreSearchResults');
        this.searchHasMore = false;
      }

      const total = existingResults.length;
      this.updateStatus(
        `Found ${total} result${total !== 1 ? 's' : ''} for "${this.searchLastQuery}"`,
      );
    } catch (error) {
      log.warn(`loadMoreSearchResults failed: ${getErrorMessage(error)}`);
    } finally {
      this.loadingMoreSearch = false;
      this.renderNotionSearchResults(resultsContainer);
    }
  }

  // ── Tree Rendering ────────────────────────────────────

  /** Live-update the Save button label so user always sees the commit count. */
  private updateSaveButtonLabel(): void {
    if (!this.saveBtnEl) return;
    const n = this.selectedItems.size;
    this.saveBtnEl.textContent = n === 0 ? 'Save Selection' : `Save ${n} item${n !== 1 ? 's' : ''}`;
  }

  private renderSelectedPanel(): void {
    this.selectedPanelEl.empty();
    this.updateSaveButtonLabel();

    // ── Selection header block: gauge + counts + actions ──
    const top = this.selectedPanelEl.createDiv({ cls: 'n2o-tree-sel-top' });
    top.createDiv({ cls: 'n2o-tree-sel-label', text: 'YOUR SELECTION' });

    const stats = this.computeSelectionStats();
    const gaugeRow = top.createDiv({ cls: 'n2o-tree-sel-gauge-row' });
    gaugeRow.appendChild(this.buildGaugeSvg(stats.selectedCount, stats.totalAvailable));
    const gaugeMeta = gaugeRow.createDiv({ cls: 'n2o-tree-sel-gauge-meta' });
    gaugeMeta.createDiv({
      cls: 'n2o-tree-sel-of',
      text:
        stats.totalAvailable > 0
          ? `of ${stats.totalAvailable.toLocaleString()} items`
          : 'nothing selected',
    });
    if (stats.selectedCount > 0) {
      const breakdown: string[] = [];
      if (stats.dbCount > 0)
        breakdown.push(`${stats.dbCount} database${stats.dbCount !== 1 ? 's' : ''}`);
      if (stats.pageCount > 0)
        breakdown.push(`${stats.pageCount} page${stats.pageCount !== 1 ? 's' : ''}`);
      gaugeMeta.createDiv({ cls: 'n2o-tree-sel-breakdown', text: breakdown.join(' \u00B7 ') });
      // Rough estimate: ~1 item / 0.3s ≈ 200/min. Show minutes.
      const mins = Math.max(1, Math.round(stats.selectedCount / 200));
      const est = gaugeMeta.createDiv({ cls: 'n2o-tree-sel-estimate' });
      setIcon(est.createSpan({ cls: 'n2o-tree-sel-estimate-icon' }), 'clock');
      est.createSpan({ text: ` ≈ ${mins}m first sync` });
    }

    // Action row: Clear all  +  Preview
    const actions = top.createDiv({ cls: 'n2o-tree-sel-actions' });
    const clearBtn = actions.createEl('button', { cls: 'n2o-tree-sel-action' });
    setIcon(clearBtn.createSpan({ cls: 'n2o-tree-sel-action-icon' }), 'trash-2');
    clearBtn.createSpan({ text: 'Clear all' });
    clearBtn.disabled = stats.selectedCount === 0;
    clearBtn.addEventListener('click', () => this.setAllChecked(false));

    actions.createSpan({ cls: 'n2o-tree-sel-action-spacer' });

    const previewBtn = actions.createEl('button', { cls: 'n2o-tree-sel-action' });
    setIcon(previewBtn.createSpan({ cls: 'n2o-tree-sel-action-icon' }), 'eye');
    previewBtn.createSpan({ text: 'Preview' });
    previewBtn.disabled = stats.selectedCount === 0;
    previewBtn.addEventListener('click', () => {
      // Preview = scroll to first selected in tree
      const first = this.treeContentEl.querySelector('.n2o-tree-node.is-checked');
      first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    // ── Grouped selection list - always rendered so the INCLUDE WITH SYNC
    //    block below sticks to the bottom of the panel (flex-grow spacer). ──
    const list = this.selectedPanelEl.createDiv({ cls: 'n2o-tree-sel-list' });
    if (stats.selectedCount > 0) {
      const { checkedDbIds, dbGroup, pageGroup, underDbGroup } = this.groupSelectedForDisplay();
      if (dbGroup.length > 0) {
        this.renderSelGroup(list, 'Databases', dbGroup.length, dbGroup, 'database', checkedDbIds);
      }
      if (pageGroup.length > 0) {
        this.renderSelGroup(list, 'Pages', pageGroup.length, pageGroup, 'page', checkedDbIds);
      }
      if (underDbGroup.length > 0) {
        this.renderSelGroup(
          list,
          'Under databases',
          underDbGroup.length,
          underDbGroup,
          'page',
          checkedDbIds,
        );
      }
    }

    // ── Include-with-sync toggles (reflect + save to profile) ──
    if (this.syncOptionsAccessor) {
      const opts = this.syncOptionsAccessor.get();
      const optsBlock = this.selectedPanelEl.createDiv({ cls: 'n2o-tree-sel-opts' });
      optsBlock.createDiv({ cls: 'n2o-tree-sel-opts-label', text: 'INCLUDE WITH SYNC' });
      this.renderOptToggle(
        optsBlock,
        'Include sub-pages',
        opts.childPages,
        'childPages',
        'Sync sub-pages nested inside the pages you picked. Off keeps the sync flat - only the top-level page itself comes through.',
      );
      this.renderOptToggle(
        optsBlock,
        'Include inline databases',
        opts.childDatabases,
        'childDatabases',
        'Sync databases that live inside selected pages (the small tables and boards embedded in a page). Off skips them so only standalone databases sync.',
      );
      this.renderOptToggle(
        optsBlock,
        'Media & attachments',
        opts.downloadMedia,
        'downloadMedia',
        'Download images, PDFs, and other file attachments to your vault. Off leaves placeholder links to the originals on Notion (smaller vault, but content breaks if Notion expires the URL).',
      );
      this.renderOptToggle(
        optsBlock,
        'Archived pages',
        opts.archivedPages,
        'archivedPages',
        "Pull pages you've archived (sent to Notion's trash). Off skips them, matching what you normally see in Notion's sidebar.",
      );
      this.renderOptToggle(
        optsBlock,
        'Include all items from linked views',
        // Displayed as "include all" (the inverse of the stored filteredViewsOnly
        // flag) so this matches the Settings toggle exactly - same label, same
        // on=all meaning. The click still flips the raw key correctly.
        !opts.filteredViewsOnly,
        'filteredViewsOnly',
        "When a page embeds a linked database view, sync the whole source database. Off syncs only the items the view's filter shows in Notion (smaller, faster).",
      );
    }

    // ── Archive warning (large selected DB slows first sync) ──
    const bigDb = this.findBigSelectedDatabase();
    if (bigDb) {
      const warn = this.selectedPanelEl.createDiv({ cls: 'n2o-tree-sel-warn' });
      setIcon(warn.createSpan({ cls: 'n2o-tree-sel-warn-icon' }), 'alert-triangle');
      const msg = warn.createSpan({ cls: 'n2o-tree-sel-warn-msg' });
      const strong = msg.createEl('b', { text: bigDb.title });
      void strong;
      msg.appendText(
        ` has ${bigDb.itemCount.toLocaleString()} items and may slow the first sync. Consider adding it later.`,
      );
    }
  }

  private renderOptToggle(
    container: HTMLElement,
    label: string,
    on: boolean,
    key: 'childPages' | 'childDatabases' | 'downloadMedia' | 'archivedPages' | 'filteredViewsOnly',
    description?: string,
  ): void {
    const row = container.createDiv({ cls: 'n2o-tree-sel-opt-row' });
    row.createSpan({ cls: 'n2o-tree-sel-opt-label', text: label });
    const toggle = row.createDiv({ cls: `n2o-tree-sel-opt-toggle${on ? ' is-on' : ''}` });
    toggle.createDiv({ cls: 'n2o-tree-sel-opt-thumb' });
    if (description) {
      setTooltip(row, description, { placement: 'left', delay: 200 });
    }
    toggle.addEventListener('click', () => {
      void (async () => {
        if (!this.syncOptionsAccessor) return;
        const current = this.syncOptionsAccessor.get()[key];
        await this.syncOptionsAccessor.set(key, !current);
        this.renderSelectedPanel();
      })();
    });
  }

  /** Aggregate counts for the gauge + breakdown line.
   *  Explicit picks only - children of fully-selected databases are "implied"
   *  and don't inflate the numbers. */
  private computeSelectionStats(): {
    selectedCount: number;
    dbCount: number;
    pageCount: number;
    totalAvailable: number;
  } {
    const checkedDbIds = new Set<string>();
    for (const [id, info] of this.selectedItems) {
      if (info.type === 'database') checkedDbIds.add(id);
    }
    let dbCount = 0;
    let pageCount = 0;
    for (const [, info] of this.selectedItems) {
      if (info.type === 'database') {
        dbCount++;
      } else if (info.parentId && checkedDbIds.has(info.parentId)) {
        // Implied by parent selection - don't count.
        continue;
      } else {
        pageCount++;
      }
    }
    const totalAvailable = this.pageCacheStore.count() || this.tree.length;
    return {
      selectedCount: dbCount + pageCount,
      dbCount,
      pageCount,
      totalAvailable,
    };
  }

  /** SVG donut gauge with the selection count in the middle. */
  private buildGaugeSvg(selected: number, total: number): SVGElement {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'n2o-tree-sel-gauge');
    svg.setAttribute('width', '56');
    svg.setAttribute('height', '56');
    svg.setAttribute('viewBox', '0 0 56 56');
    const r = 22;
    const circ = 2 * Math.PI * r;
    const pct = total > 0 ? Math.max(0, Math.min(1, selected / total)) : 0;

    const bg = document.createElementNS(svgNS, 'circle');
    bg.setAttribute('cx', '28');
    bg.setAttribute('cy', '28');
    bg.setAttribute('r', String(r));
    bg.setAttribute('fill', 'none');
    bg.setAttribute('stroke', 'var(--background-modifier-border)');
    bg.setAttribute('stroke-width', '4');
    svg.appendChild(bg);

    const ring = document.createElementNS(svgNS, 'circle');
    ring.setAttribute('cx', '28');
    ring.setAttribute('cy', '28');
    ring.setAttribute('r', String(r));
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', 'var(--interactive-accent)');
    ring.setAttribute('stroke-width', '4');
    ring.setAttribute('stroke-linecap', 'round');
    ring.setAttribute('stroke-dasharray', String(circ));
    ring.setAttribute('stroke-dashoffset', String(circ * (1 - pct)));
    ring.setAttribute('transform', 'rotate(-90 28 28)');
    svg.appendChild(ring);

    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', '28');
    label.setAttribute('y', '32');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-family', 'var(--font-monospace, "JetBrains Mono", monospace)');
    label.setAttribute('font-size', '14');
    label.setAttribute('font-weight', '700');
    label.setAttribute('fill', 'var(--text-normal)');
    label.setAttribute('letter-spacing', '-0.5');
    label.textContent = String(selected);
    svg.appendChild(label);

    return svg;
  }

  private groupSelectedForDisplay(): {
    checkedDbIds: Set<string>;
    dbGroup: [string, { title: string; type: 'database' | 'page'; parentId?: string }][];
    pageGroup: [string, { title: string; type: 'database' | 'page'; parentId?: string }][];
    underDbGroup: [string, { title: string; type: 'database' | 'page'; parentId?: string }][];
  } {
    const checkedDbIds = new Set<string>();
    for (const [id, info] of this.selectedItems) {
      if (info.type === 'database') checkedDbIds.add(id);
    }
    // Build a lookup of known database IDs from the tree so we can tell
    // whether a child's parent is a DB vs a page.
    const dbIdsInTree = new Set<string>();
    for (const node of this.tree) {
      if (node.type === 'database') dbIdsInTree.add(node.id);
    }

    const dbGroup: [string, { title: string; type: 'database' | 'page'; parentId?: string }][] = [];
    const pageGroup: [string, { title: string; type: 'database' | 'page'; parentId?: string }][] =
      [];
    const underDbGroup: [
      string,
      { title: string; type: 'database' | 'page'; parentId?: string },
    ][] = [];

    for (const entry of this.selectedItems.entries()) {
      const [, info] = entry;
      if (info.type === 'database') {
        dbGroup.push(entry);
        continue;
      }
      // Child of a fully-selected DB -> implied by the parent; don't list.
      if (info.parentId && checkedDbIds.has(info.parentId)) continue;
      // Child of a DB that is NOT fully selected -> partial selection ("under databases")
      if (info.parentId && dbIdsInTree.has(info.parentId)) {
        underDbGroup.push(entry);
        continue;
      }
      // Top-level workspace page or child-of-page
      pageGroup.push(entry);
    }
    return { checkedDbIds, dbGroup, pageGroup, underDbGroup };
  }

  private renderSelGroup(
    container: HTMLElement,
    title: string,
    count: number,
    entries: [string, { title: string; type: 'database' | 'page'; parentId?: string }][],
    kind: 'database' | 'page',
    _checkedDbIds: Set<string>,
  ): void {
    const group = container.createDiv({ cls: 'n2o-tree-sel-group' });
    const hdr = group.createDiv({ cls: 'n2o-tree-sel-group-hdr' });
    setIcon(hdr.createSpan({ cls: 'n2o-tree-sel-group-chev' }), 'chevron-down');
    hdr.createSpan({ cls: 'n2o-tree-sel-group-title', text: title });
    hdr.createSpan({ cls: 'n2o-tree-sel-group-count', text: String(count) });

    for (const [id, info] of entries) {
      const row = group.createDiv({ cls: 'n2o-tree-sel-row' });
      setIcon(
        row.createSpan({ cls: 'n2o-tree-sel-row-icon' }),
        kind === 'database' ? 'database' : 'file-text',
      );
      const body = row.createDiv({ cls: 'n2o-tree-sel-row-body' });
      body.createDiv({ cls: 'n2o-tree-sel-row-title', text: info.title || 'Untitled' });
      // meta: for databases -> item count; for pages under DB -> parent name
      const node = this.tree.find((n) => n.id === id);
      let meta = '';
      if (kind === 'database' && node?.itemCount !== undefined) {
        meta = `${node.itemCount} item${node.itemCount !== 1 ? 's' : ''}`;
      } else if (info.parentId) {
        const parent =
          this.selectedItems.get(info.parentId) ?? this.tree.find((n) => n.id === info.parentId);
        if (parent) meta = parent.title;
      }
      if (meta) body.createDiv({ cls: 'n2o-tree-sel-row-meta', text: meta });
      const x = row.createEl('button', { cls: 'n2o-tree-sel-row-x' });
      setIcon(x, 'x');
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        if (info.type === 'database') {
          for (const [childId, childInfo] of this.selectedItems) {
            if (childInfo.parentId === id) {
              this.selectedItems.delete(childId);
              this.syncCheckedState(childId, false);
            }
          }
        }
        this.selectedItems.delete(id);
        this.syncCheckedState(id, false);
        this.renderTree();
        this.updateSelectionCount();
      });
    }
  }

  /** Find the biggest selected database (>= 300 items) for the archive-warning banner. */
  private findBigSelectedDatabase(): { title: string; itemCount: number } | null {
    let biggest: { title: string; itemCount: number } | null = null;
    for (const [id, info] of this.selectedItems) {
      if (info.type !== 'database') continue;
      const node = this.tree.find((n) => n.id === id);
      const count = node?.itemCount ?? 0;
      if (count < 300) continue;
      if (!biggest || count > biggest.itemCount) {
        biggest = { title: info.title || 'This database', itemCount: count };
      }
    }
    return biggest;
  }

  /** Check if a node (or any of its descendants) matches the filter query. */
  private nodeMatchesFilter(node: TreeNode, query: string): boolean {
    if (node.title.toLowerCase().includes(query)) return true;
    for (const child of node.children) {
      if (this.nodeMatchesFilter(child, query)) return true;
    }
    return false;
  }

  /**
   * Auto-expand collapsed ancestors of filter matches so the matches are
   * actually visible - a filter that only reveals a collapsed parent row
   * makes the user hunt for the result (private issue #21). Tracks what it
   * expanded in filterAutoExpanded so clearing the filter can restore the
   * user's collapsed state. Returns true when any node was expanded.
   */
  private autoExpandForFilter(node: TreeNode, query: string): boolean {
    let changed = false;
    if (!node.expanded && node.children.some((c) => this.nodeMatchesFilter(c, query))) {
      node.expanded = true;
      this.filterAutoExpanded.add(node.id);
      changed = true;
    }
    for (const child of node.children) {
      if (this.autoExpandForFilter(child, query)) changed = true;
    }
    return changed;
  }

  /** Collapse every node the filter auto-expanded (filter cleared). */
  private collapseAutoExpanded(node: TreeNode): void {
    if (this.filterAutoExpanded.has(node.id)) {
      node.expanded = false;
    }
    for (const child of node.children) {
      this.collapseAutoExpanded(child);
    }
  }

  private renderTree(): void {
    this.treeContentEl.empty();
    this.renderedRows.clear();
    this.renderedSections.clear();
    this.renderSelectedPanel();

    if (this.tree.length === 0) {
      this.treeContentEl.createEl('p', {
        text: "No pages or databases found. Make sure you've shared content with your integration.",
        cls: 'setting-item-description',
      });
      this.renderNotionSearchSection();
      return;
    }

    const allDatabases = this.tree.filter((n) => n.type === 'database');
    const allPages = this.tree.filter((n) => n.type === 'page');

    // Sort pages: those with children first, then alphabetical
    allPages.sort((a, b) => {
      const aHasKids = a.children.length > 0 ? 0 : 1;
      const bHasKids = b.children.length > 0 ? 0 : 1;
      if (aHasKids !== bHasKids) return aHasKids - bHasKids;
      return a.title.localeCompare(b.title);
    });

    // Count total pages including nested children
    const countNested = (nodes: TreeNode[]): number => {
      let count = 0;
      for (const n of nodes) {
        if (n.type === 'page') count++;
        count += countNested(n.children);
      }
      return count;
    };
    const totalPageCount = countNested(allPages) + allPages.length;

    // Always render the complete tree - filter visibility is applied
    // via CSS class toggling in applyFilter() after the DOM is built.
    // This decouples filter typing from full DOM rebuild.
    if (allDatabases.length > 0) {
      this.renderSection(
        'databases',
        allDatabases,
        allDatabases.length,
        `Databases ${allDatabases.length}`,
      );
    }

    if (allPages.length > 0) {
      this.renderSection('pages', allPages, totalPageCount, `Pages ${totalPageCount}`);
    }

    this.renderNotionSearchSection();

    // Apply current filter (no-op if filterQuery is empty)
    this.applyFilter();
  }

  /**
   * Toggle row visibility based on the current filter query without
   * destroying and rebuilding DOM. Run after every renderTree (so the
   * fresh tree respects an existing filter) and on every filter
   * keystroke (so typing doesn't churn the entire tree).
   *
   * Implementation: walk the cached row map, toggle a CSS class on
   * each row, then update each section's label + visibility based on
   * how many of its nodes match.
   */
  private applyFilter(): void {
    const q = this.filterQuery;
    let totalMatches = 0;

    if (this.renderedRows.size === 0) return;

    if (!q) {
      // Filter cleared: restore the collapse state the filter auto-expanded.
      // renderTree re-runs applyFilter with the set emptied, so no recursion.
      if (this.filterAutoExpanded.size > 0) {
        for (const node of this.tree) this.collapseAutoExpanded(node);
        this.filterAutoExpanded.clear();
        this.renderTree();
        return;
      }
      // No filter: clear hidden state on every row + restore base section
      // labels. Repaint titles too, else the last query's highlight lingers.
      for (const { row, node } of this.renderedRows.values()) {
        row.removeClass('is-filtered-out');
        const titleEl = row.querySelector<HTMLElement>('.n2o-tree-title');
        if (titleEl) {
          titleEl.empty();
          this.renderHighlightedTitle(titleEl, node.title || 'Untitled', '');
        }
      }
      for (const [key, info] of this.renderedSections) {
        info.sectionEl.removeClass('is-filtered-empty');
        const baseLabel =
          key === 'databases' ? `Databases ${info.nodes.length}` : `Pages ${info.totalCount}`;
        info.labelEl.textContent = baseLabel;
      }
      this.removeFilterEmptyHint();
      if (this.filterMatchCountEl) {
        this.filterMatchCountEl.textContent = '';
        this.filterMatchCountEl.toggleClass('is-visible', false);
      }
      return;
    }

    // Reveal matches hidden inside collapsed parents: expand their
    // ancestors, then rebuild so the children exist in the DOM. renderTree
    // re-runs applyFilter; the second pass finds nothing new to expand.
    let expandedAny = false;
    for (const node of this.tree) {
      if (this.autoExpandForFilter(node, q)) expandedAny = true;
    }
    if (expandedAny) {
      this.renderTree();
      return;
    }

    // Filter active: hide non-matching rows. A row matches if its node
    // OR any descendant matches the query (so an expanded ancestor
    // stays visible to anchor matching children). Also repaint each
    // visible row's title highlight for the CURRENT query - highlights
    // are otherwise only painted during a full renderTree, so without
    // this they go stale as the user keeps typing (private issue #21).
    for (const { row, node } of this.renderedRows.values()) {
      const matches = this.nodeMatchesFilter(node, q);
      row.toggleClass('is-filtered-out', !matches);
      const titleEl = row.querySelector<HTMLElement>('.n2o-tree-title');
      if (titleEl) {
        titleEl.empty();
        this.renderHighlightedTitle(titleEl, node.title || 'Untitled', q);
      }
    }

    // Update each section: count visible top-level nodes, hide empty
    // sections, refresh label text.
    let dbVisible = 0;
    let pageVisible = 0;
    for (const [key, info] of this.renderedSections) {
      const visibleCount = info.nodes.reduce(
        (n, node) => n + (this.nodeMatchesFilter(node, q) ? 1 : 0),
        0,
      );
      info.sectionEl.toggleClass('is-filtered-empty', visibleCount === 0);
      const sectionLabel = key === 'databases' ? 'Databases' : 'Pages';
      info.labelEl.textContent = `${sectionLabel} ${visibleCount} of ${info.nodes.length}`;
      if (key === 'databases') dbVisible = visibleCount;
      else if (key === 'pages') pageVisible = visibleCount;
    }
    totalMatches = dbVisible + pageVisible;

    // Empty-state hint when nothing matches at all.
    if (totalMatches === 0) {
      this.showFilterEmptyHint(q);
    } else {
      this.removeFilterEmptyHint();
    }

    if (this.filterMatchCountEl) {
      this.filterMatchCountEl.textContent = `${totalMatches} match${totalMatches !== 1 ? 'es' : ''}`;
      this.filterMatchCountEl.toggleClass('is-visible', true);
    }
  }

  private filterEmptyHintEl: HTMLElement | null = null;

  private showFilterEmptyHint(query: string): void {
    if (!this.filterEmptyHintEl) {
      this.filterEmptyHintEl = this.treeContentEl.createEl('p', {
        cls: 'setting-item-description n2o-tree-filter-empty',
      });
    }
    this.filterEmptyHintEl.textContent = `No matches for "${query}"`;
  }

  private removeFilterEmptyHint(): void {
    if (this.filterEmptyHintEl) {
      this.filterEmptyHintEl.remove();
      this.filterEmptyHintEl = null;
    }
  }

  /** Render a collapsible tree section (databases, top-level pages, or pages). */
  private renderSection(key: string, nodes: TreeNode[], totalCount: number, label: string): void {
    const section = this.treeContentEl.createEl('details', { cls: 'n2o-tree-section' });
    if (this.treeSectionsOpen.has(key)) section.setAttribute('open', '');
    section.addEventListener('toggle', () => {
      if (section.open) this.treeSectionsOpen.add(key);
      else this.treeSectionsOpen.delete(key);
    });
    const summary = section.createEl('summary', { cls: 'n2o-tree-section-header' });
    const labelEl = summary.createSpan({ cls: 'n2o-tree-section-label', text: label });
    // How many nodes in this section have something selected?
    const selectedInSection = nodes.reduce((n, node) => {
      if (this.selectedItems.has(node.id)) return n + 1;
      for (const child of node.children) {
        if (this.selectedItems.has(child.id)) return n + 1;
      }
      return n;
    }, 0);
    if (selectedInSection > 0) {
      summary.createSpan({
        cls: 'n2o-tree-section-count',
        text: `${selectedInSection} selected`,
      });
    }
    for (const node of nodes) {
      this.renderNode(section, node, 0);
    }
    this.renderedSections.set(key, { sectionEl: section, labelEl, nodes, totalCount });
  }

  /**
   * Render the "Search Notion directly" prompt card below the tree.
   * Matches the design: dashed-border card with search icon + 2-line label
   * + right chevron. Clicking the card expands the actual search input.
   */
  private renderNotionSearchSection(): void {
    this.notionSearchEl.empty();
    if (!this.notionClient) return;

    const details = this.notionSearchEl.createEl('details', {
      cls: 'n2o-tree-notion-search-details',
    });
    const summary = details.createEl('summary', { cls: 'n2o-tree-notion-search-card' });

    // Left icon
    const iconWrap = summary.createSpan({ cls: 'n2o-tree-notion-search-icon' });
    setIcon(iconWrap, 'search');

    // Two-line label
    const body = summary.createDiv({ cls: 'n2o-tree-notion-search-body' });
    body.createDiv({
      cls: 'n2o-tree-notion-search-title',
      text: "Can't find something? Search Notion directly",
    });
    body.createDiv({
      cls: 'n2o-tree-notion-search-sub',
      text: 'Searches pages & databases shared with your integration',
    });

    // Right chevron - flips to chevron-down when expanded via [open] attribute
    const chev = summary.createSpan({ cls: 'n2o-tree-notion-search-chev' });
    setIcon(chev, 'chevron-right');

    // Expanded content: search input + results
    const expandWrap = details.createDiv({ cls: 'n2o-tree-notion-search-expand' });

    const searchInput = expandWrap.createEl('input', {
      type: 'text',
      placeholder: 'Search Notion\u2026',
      cls: 'n2o-tree-notion-search-input',
    });
    searchInput.setAttribute('aria-label', 'Search Notion API');

    const resultsArea = expandWrap.createDiv({ cls: 'n2o-tree-notion-search-results' });

    const debouncedNotionSearch = debounce(
      (query: string) => {
        void this.performSearch(query, resultsArea);
      },
      NOTION_SEARCH_DEBOUNCE_MS,
      false,
    );
    searchInput.addEventListener('input', () => {
      const raw = searchInput.value.trim();
      if (!raw) {
        this.searchResults = null;
        this.searchHasMore = false;
        this.searchCursor = undefined;
        this.searchLastQuery = '';
        resultsArea.empty();
      } else {
        debouncedNotionSearch(raw);
      }
    });

    // Auto-focus the input when the card opens
    details.addEventListener('toggle', () => {
      if (details.open) searchInput.focus();
    });

    // Re-render existing search results if we have them
    if (this.searchResults !== null) {
      this.renderNotionSearchResults(resultsArea);
    }
  }

  /** Render Notion API search results into the given container. */
  private renderNotionSearchResults(container: HTMLElement): void {
    container.empty();

    if (this.searching) {
      container.createEl('p', { text: 'Searching Notion...', cls: 'setting-item-description' });
      return;
    }

    if (this.searchResults === null || this.searchResults.length === 0) {
      if (this.searchLastQuery) {
        container.createEl('p', {
          text: `No results for "${this.searchLastQuery}"`,
          cls: 'setting-item-description',
        });
      }
      return;
    }

    const databases = this.searchResults.filter((n) => n.type === 'database');
    const pages = this.searchResults.filter((n) => n.type === 'page');
    if (databases.length > 0) {
      container.createEl('h3', { text: 'Databases' });
      for (const node of databases) this.renderNode(container, node, 0);
    }
    if (pages.length > 0) {
      container.createEl('h3', { text: 'Pages' });
      for (const node of pages) this.renderNode(container, node, 0);
    }
    if (this.searchHasMore) {
      const btn = container.createEl('button', {
        text: this.loadingMoreSearch ? 'Loading...' : 'Load more results...',
        cls: 'n2o-tree-load-more',
      });
      btn.disabled = this.loadingMoreSearch;
      btn.addEventListener('click', () => {
        void this.loadMoreSearchResults(container);
      });
    }
  }

  private renderNode(container: HTMLElement, node: TreeNode, depth: number): void {
    const hasExpandableChildren = node.children.length > 0;
    const isChecked = this.selectedItems.has(node.id);
    const row = container.createDiv({
      cls: `n2o-tree-node${isChecked ? ' is-checked' : ''}${depth > 0 ? ' is-child' : ''}`,
    });
    this.renderedRows.set(node.id, { row, node, depth });
    row.setAttribute('role', 'treeitem');
    row.setAttribute('tabindex', '0');
    if (hasExpandableChildren) {
      row.setAttribute('aria-expanded', String(node.expanded));
    }
    row.style.paddingLeft = `${10 + depth * 18}px`;

    // Keyboard navigation for tree nodes
    row.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = this.getAdjacentTreeItem(row, 'next');
        next?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = this.getAdjacentTreeItem(row, 'prev');
        prev?.focus();
      } else if (e.key === 'ArrowRight' && hasExpandableChildren && !node.expanded) {
        e.preventDefault();
        row.querySelector<HTMLElement>('.n2o-tree-toggle')?.click();
      } else if (e.key === 'ArrowLeft' && hasExpandableChildren && node.expanded) {
        e.preventDefault();
        row.querySelector<HTMLElement>('.n2o-tree-toggle')?.click();
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
      }
    });

    // Expand/collapse toggle for nodes with children
    if (hasExpandableChildren) {
      const toggle = row.createSpan({
        cls: `n2o-tree-toggle${node.expanded ? ' is-expanded' : ''}`,
      });
      setIcon(toggle, 'chevron-right');
      toggle.addEventListener('click', () => {
        node.expanded = !node.expanded;
        // #1536: expanding/collapsing only inserts or removes this node's
        // descendant rows; the rest of the tree DOM is untouched. Search/filter
        // modes still rebuild (row set + highlighting depend on the query).
        if (this.searchResults === null && this.filterQuery === '') {
          if (node.expanded) this.expandNodeRows(node);
          else this.collapseNodeRows(node);
        } else {
          this.renderTree();
        }
      });
    } else {
      row.createSpan({ cls: 'n2o-tree-toggle-spacer' });
    }

    // Checkbox - derive checked state from selectedItems (single source of truth).
    // A database item counts as checked when its parent database is selected, so
    // children still display checked without each being persisted individually
    // (#1537). The sync already expands a selected database to all its items.
    node.checked =
      this.selectedItems.has(node.id) ||
      (node.parentId !== undefined && this.selectedItems.has(node.parentId));
    const checkbox = row.createEl('input', { type: 'checkbox' });
    checkbox.checked = node.checked;
    checkbox.setAttribute('aria-label', `Select ${node.title || 'Untitled'}`);

    checkbox.addEventListener('change', () => {
      node.checked = checkbox.checked;
      // A database is persisted as a SINGLE entry; its items are no longer each
      // written into selectedItems (which persisted to data.json and bloated
      // every save for large databases). The sync scope expands the database to
      // all its items, and children derive their checked display from the parent
      // above (#1537). Re-render below repaints the children accordingly.
      // Sync checked state between tree and search results
      this.syncCheckedState(node.id, node.checked);
      // Sync with selectedItems map
      if (node.checked) {
        this.selectedItems.set(node.id, { title: node.title, type: node.type });
        // Add search result items to main tree so they persist
        this.addToTreeIfMissing(node);
      } else {
        this.selectedItems.delete(node.id);
      }
      // #1536: in the plain tree a toggle only changes this node + its
      // descendants' checked display (children derive checked from a selected
      // parent), so repaint just those rows in place instead of rebuilding all
      // of them. Search/filter modes (rarer, and may add a brand-new row) still
      // do a full render for correctness.
      if (this.searchResults === null && this.filterQuery === '') {
        this.repaintCheckedState(node);
      } else {
        this.renderTree();
      }
      this.updateSelectionCount();
    });

    // Icon (theme-aware lucide, not emoji)
    const iconEl = row.createSpan({
      cls: `n2o-tree-icon${node.type === 'database' ? ' is-database' : ''}`,
    });
    setIcon(iconEl, node.type === 'database' ? 'database' : 'file-text');

    // Title (with filter match highlighting)
    const titleEl = row.createSpan({ cls: 'n2o-tree-title' });
    this.renderHighlightedTitle(titleEl, node.title || 'Untitled', this.filterQuery);

    // Right-side group: count pill + view type segmented (databases only)
    if (node.type === 'database') {
      const rightGroup = row.createDiv({ cls: 'n2o-tree-right' });

      // Count pill (mono, soft bg)
      if (node.itemCount !== undefined) {
        rightGroup.createSpan({
          cls: 'n2o-tree-item-count',
          text: node.itemCount.toLocaleString(),
        });
      }

      // Per-row view type override removed - the sync pipeline now detects every
      // Notion view via the Views API and writes each as its own YAML view entry.
      // Primary-view ordering is covered by entry.viewType (from discovery) and
      // settings.basesDefaultViewType (global fallback), so a per-DB override here
    }

    // Children
    if (node.expanded && node.children.length > 0) {
      for (const child of node.children) {
        this.renderNode(container, child, depth + 1);
      }
    }
  }

  /**
   * #1536: repaint the checked display of a node and its descendants in place,
   * without rebuilding the tree DOM. A child counts as checked when its parent
   * database is selected, so toggling a database repaints its item rows too.
   * Only touches rows that are currently rendered (collapsed subtrees render
   * with the right state when they next expand).
   */
  private repaintCheckedState(node: TreeNode): void {
    const walk = (n: TreeNode): void => {
      const cached = this.renderedRows.get(n.id);
      if (cached) {
        const checked =
          this.selectedItems.has(n.id) ||
          (n.parentId !== undefined && this.selectedItems.has(n.parentId));
        n.checked = checked;
        const cb = cached.row.querySelector<HTMLInputElement>('input[type="checkbox"]');
        if (cb) cb.checked = checked;
        cached.row.toggleClass('is-checked', checked);
      }
      for (const child of n.children) walk(child);
    };
    walk(node);
  }

  /**
   * #1536: render a newly-expanded node's descendant rows and splice them into
   * the flat row list right after the node, instead of rebuilding the tree.
   * renderNode recurses into any already-expanded children, so nested expansion
   * state is preserved. Falls back to a full render if the node isn't currently
   * rendered (shouldn't happen from its own toggle, but stays correct).
   */
  private expandNodeRows(node: TreeNode): void {
    const cached = this.renderedRows.get(node.id);
    if (!cached) {
      this.renderTree();
      return;
    }
    const frag = createFragment();
    for (const child of node.children) {
      this.renderNode(frag as unknown as HTMLElement, child, cached.depth + 1);
    }
    cached.row.after(frag);
    cached.row.setAttribute('aria-expanded', 'true');
    cached.row.querySelector('.n2o-tree-toggle')?.addClass('is-expanded');
  }

  /**
   * #1536: remove a collapsed node's rendered descendant rows from the DOM and
   * the renderedRows map, leaving the rest of the tree in place. Only rows that
   * were actually rendered (expanded subtrees) are touched.
   */
  private collapseNodeRows(node: TreeNode): void {
    const cached = this.renderedRows.get(node.id);
    if (!cached) {
      this.renderTree();
      return;
    }
    const removeDescendants = (n: TreeNode): void => {
      for (const child of n.children) {
        const c = this.renderedRows.get(child.id);
        if (c) {
          c.row.remove();
          this.renderedRows.delete(child.id);
          removeDescendants(child);
        }
      }
    };
    removeDescendants(node);
    cached.row.setAttribute('aria-expanded', 'false');
    cached.row.querySelector('.n2o-tree-toggle')?.removeClass('is-expanded');
  }

  /** Human-readable age of the page cache, e.g. "Cache updated 2h ago" / "just now" / "never". */
  private buildCacheAgeLabel(): string {
    const iso = this.pageCacheStore.getLastDiscoveryTime();
    if (!iso) return 'Cache not yet populated';
    const then = Date.parse(iso);
    if (isNaN(then)) return 'Cache updated recently';
    const ms = Date.now() - then;
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return 'Cache updated just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `Cache updated ${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `Cache updated ${hr}h ago`;
    const d = Math.floor(hr / 24);
    return `Cache updated ${d}d ago`;
  }

  /** Render a title with the active filter query highlighted. */
  private renderHighlightedTitle(container: HTMLElement, title: string, query: string): void {
    if (!query) {
      container.setText(title);
      return;
    }
    const lowerTitle = title.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const idx = lowerTitle.indexOf(lowerQuery);
    if (idx === -1) {
      container.setText(title);
      return;
    }
    container.createSpan({ text: title.slice(0, idx) });
    container.createSpan({
      cls: 'n2o-tree-title-match',
      text: title.slice(idx, idx + query.length),
    });
    container.createSpan({ text: title.slice(idx + query.length) });
  }

  /** Get the next or previous visible tree item element for keyboard navigation. */
  private getAdjacentTreeItem(
    current: HTMLElement,
    direction: 'next' | 'prev',
  ): HTMLElement | null {
    const items = Array.from(this.treeContainerEl.querySelectorAll<HTMLElement>('.n2o-tree-node'));
    const idx = items.indexOf(current);
    if (idx === -1) return null;
    const target = direction === 'next' ? idx + 1 : idx - 1;
    return items[target] ?? null;
  }

  // ── Actions ───────────────────────────────────────────

  /**
   * Handle "Scan Vault" button click - calls callback to get local notion_ids,
   * then walks the tree checking matching nodes.
   */
  private async handleScanVault(): Promise<void> {
    if (!this.onScanVault) return;
    this.updateStatus('Scanning vault for local files...');
    try {
      const localIds = await this.onScanVault();
      if (localIds.size === 0) {
        this.updateStatus('No files with notion_id found in sync folder.');
        return;
      }

      let matched = 0;
      for (const node of this.tree) {
        if (localIds.has(node.id)) {
          node.checked = true;
          this.selectedItems.set(node.id, { title: node.title, type: node.type });
          matched++;
        }
        if (node.type === 'database') {
          let allChildrenChecked = true;
          for (const child of node.children) {
            if (localIds.has(child.id)) {
              child.checked = true;
              this.selectedItems.set(child.id, {
                title: child.title,
                type: child.type,
                parentId: node.id,
              });
              matched++;
            }
            if (!child.checked) allChildrenChecked = false;
          }
          // Check database if all children are checked
          if (node.children.length > 0 && allChildrenChecked) {
            node.checked = true;
            this.selectedItems.set(node.id, { title: node.title, type: node.type });
          }
          // Check database if its ID is in localIds (from inferred database records)
          if (!node.checked && localIds.has(node.id)) {
            node.checked = true;
            this.selectedItems.set(node.id, { title: node.title, type: node.type });
            matched++;
          }
        }
      }

      this.renderTree();
      this.updateSelectionCount();
      new Notice(
        `N2O: Matched ${matched} item${matched !== 1 ? 's' : ''} from vault`,
        NOTICE_SHORT,
      );
    } catch (error) {
      const msg = getErrorMessage(error);
      this.updateStatus(`Scan failed: ${msg}`);
    }
  }

  private setAllChecked(checked: boolean): void {
    if (!checked) this.selectedItems.clear();
    for (const node of this.tree) {
      node.checked = checked;
      if (node.checked) {
        this.selectedItems.set(node.id, { title: node.title, type: node.type });
      } else {
        this.selectedItems.delete(node.id);
      }
      for (const child of node.children) {
        child.checked = node.checked;
        if (child.checked) {
          this.selectedItems.set(child.id, { title: child.title, type: child.type });
        } else {
          this.selectedItems.delete(child.id);
        }
      }
    }
    // Also update search result nodes (separate objects from tree nodes)
    if (this.searchResults) {
      for (const node of this.searchResults) {
        node.checked = checked;
        if (checked) {
          this.selectedItems.set(node.id, { title: node.title, type: node.type });
        }
      }
    }
    this.renderTree();
    this.updateSelectionCount();
  }

  private async saveAndClose(): Promise<void> {
    // Collect checked database IDs and their known child IDs
    const checkedDbIds = new Set<string>();
    const childIdsOfCheckedDbs = new Set<string>();
    for (const node of this.tree) {
      if (node.type === 'database' && node.checked) {
        checkedDbIds.add(node.id);
        for (const child of node.children) {
          childIdsOfCheckedDbs.add(child.id);
        }
      }
    }

    // Build output, excluding children covered by their parent database
    const items: SelectedSyncItem[] = [];
    for (const [id, info] of this.selectedItems) {
      // Skip: parentId known and parent is checked (new selections)
      if (info.parentId && checkedDbIds.has(info.parentId)) continue;
      // Skip: child of a checked database (from tree's loaded children)
      if (childIdsOfCheckedDbs.has(id)) continue;

      const item: SelectedSyncItem = { id, title: info.title, type: info.type };
      if (info.type === 'database') {
        const node = this.tree.find((n) => n.id === id);
        if (node?.itemCount !== undefined) item.itemCount = node.itemCount;
      }
      items.push(item);
    }
    log.info(`Saving ${items.length} selected items`);
    await this.onSave(items);
    this.close();
  }

  // ── Helpers ───────────────────────────────────────────

  /** Keep checked state in sync between tree and search results. */
  private syncCheckedState(id: string, checked: boolean): void {
    // Update in main tree (recursively, since pages can be nested)
    const syncInNodes = (nodes: TreeNode[]): boolean => {
      for (const node of nodes) {
        if (node.id === id) {
          node.checked = checked;
          return true;
        }
        if (syncInNodes(node.children)) return true;
      }
      return false;
    };
    syncInNodes(this.tree);
    // Update in search results
    if (this.searchResults) {
      for (const node of this.searchResults) {
        if (node.id === id) {
          node.checked = checked;
          break;
        }
      }
    }
  }

  /** Add a node to the main tree if it's not already present (for search results). */
  private addToTreeIfMissing(node: TreeNode): void {
    const findInNodes = (nodes: TreeNode[]): boolean => {
      for (const n of nodes) {
        if (n.id === node.id) return true;
        if (findInNodes(n.children)) return true;
      }
      return false;
    };
    if (!findInNodes(this.tree)) {
      this.tree.push({
        id: node.id,
        title: node.title,
        type: node.type,
        checked: node.checked,
        expanded: false,
        children: [],
      });
    }
  }

  /** Collect all currently checked IDs - selectedItems is the single source of truth. */
  private getCheckedIds(): Set<string> {
    return new Set(this.selectedItems.keys());
  }

  private updateStatus(text: string): void {
    this.statusEl.setText(text);
  }

  /** Toggle refresh button spinning state. */
  private setRefreshLoading(loading: boolean): void {
    if (loading) {
      this.refreshBtnEl.addClass('n2o-refreshing');
    } else {
      this.refreshBtnEl.removeClass('n2o-refreshing');
    }
  }

  /** Refresh the status line with cache info + re-render selected panel summary. */
  private updateSelectionCount(): void {
    // Status line always shows cache info
    const lastDiscovery = this.pageCacheStore.getLastDiscoveryTime();
    const age = lastDiscovery ? this.formatTimeAgo(lastDiscovery) : '';
    const totalCached = this.pageCacheStore.count();
    this.updateStatus(
      `${totalCached.toLocaleString()} items accessible${age ? ` \u00B7 ${age}` : ''}`,
    );

    // Re-render selected panel (includes selection summary)
    this.renderSelectedPanel();
  }

  private extractPageTitle(page: NotionPage): string {
    const properties = page.properties;
    if (!properties) return 'Untitled';
    for (const prop of Object.values(properties)) {
      if (prop.type === 'title') {
        const titleArray: NotionRichText[] | undefined = prop.title;
        if (titleArray && titleArray.length > 0) {
          return titleArray.map((t) => t.plain_text ?? '').join('');
        }
      }
    }
    return 'Untitled';
  }
}
