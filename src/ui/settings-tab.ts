/**
 * N2OSettingTab - Tabbed settings page for the N2O plugin.
 *
 * Thin orchestrator that delegates each tab's rendering to focused modules:
 *   1. Connection - settings-connection-tab.ts
 *   2. Sync - settings-sync-tab.ts
 *   4. Activity - inline (small)
 *   5. Advanced - inline (small)
 */

import { PluginSettingTab, Setting, Notice, debounce, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import type { SettingsTabHost } from '../plugin/plugin-host';
import type { SettingsTabContext, TabName } from './settings-helpers';
import { formatTimeAgo } from './settings-helpers';
import { renderConnectionTab } from './settings-connection-tab';
import { renderSyncTab, resetSyncTabState } from './settings-sync-tab';
import { renderProTab } from './settings-pro-tab';
import {
  getActiveProfile,
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
} from '../domain/models/config-schema';
import { ResetConfirmModal } from './reset-confirm-modal';
import { NOTICE_SHORT, NOTICE_CRITICAL } from '../shared/constants';

export { type TabName } from './settings-helpers';

export class N2OSettingTab extends PluginSettingTab {
  private debouncedSave = debounce(
    () => {
      void this.plugin.saveSettings();
    },
    500,
    true,
  );

  /** Currently visible tab. */
  private activeTab: TabName = 'Connection';

  /** Tracks which collapsible sections are expanded (by section key). */
  private expandedSections = new Set<string>();

  constructor(
    app: App,
    private plugin: SettingsTabHost,
  ) {
    /* PluginSettingTab's super wants a concrete `Plugin` instance.
     * `plugin` here is typed as the PluginHost interface to keep this
     * file off the main.ts -> settings-tab.ts cycle, but at runtime the
     * caller always passes a real SettingsTabHost (which extends Plugin), so
     * the cast is safe. */
    super(app, plugin as unknown as import('obsidian').Plugin);
  }

  /** Track whether settings tab is currently rendered. */
  private isVisible = false;
  /** Guard: true while display() is running, prevents recursive refresh. */
  private isRendering = false;
  /** Re-render the settings tab if it's currently visible and not already rendering. */
  refreshIfVisible(): void {
    if (this.isVisible && !this.isRendering) {
      this.display();
    }
  }

  /** Switch to a specific tab and re-render. */
  showTab(tab: TabName): void {
    this.activeTab = tab;
    if (this.isVisible) {
      this.display();
    }
  }

  override hide(): void {
    this.isVisible = false;
  }

  /** Build a SettingsTabContext for the extracted tab renderers. */
  private buildContext(): SettingsTabContext {
    return {
      app: this.app,
      plugin: this.plugin,
      expandedSections: this.expandedSections,
      debouncedSave: () => this.debouncedSave(),
      display: () => this.display(),
      showTab: (tab: TabName) => this.showTab(tab),
    };
  }

  // ── Main display ────────────────────────────────────

  display(): void {
    this.isVisible = true;
    this.isRendering = true;
    resetSyncTabState();
    const { containerEl } = this;

    try {
      // Preserve scroll position across re-renders.
      const scrollParent = containerEl.closest('.vertical-tab-content') ?? containerEl;
      const savedScrollTop = scrollParent.scrollTop;

      containerEl.empty();

      const headerRow = containerEl.createDiv({ cls: 'n2o-settings-header' });
      headerRow.createSpan({ text: 'N2O Sync Lite', cls: 'n2o-settings-header-title' });
      headerRow.createSpan({
        text: 'Import your Notion workspace into Obsidian. One-way sync, Notion to Obsidian.',
        cls: 'n2o-settings-header-desc',
      });

      // ── Tab bar ──
      const tabBar = containerEl.createDiv({ cls: 'n2o-settings-tabs' });
      const tabContent = containerEl.createDiv({ cls: 'n2o-settings-content' });

      const tabs: TabName[] = ['Connection', 'Sync', 'Activity', 'Advanced', 'N2O Sync Pro'];
      for (const tab of tabs) {
        const tabEl = tabBar.createEl('button', {
          cls: `n2o-settings-tab ${tab === this.activeTab ? 'is-active' : ''}`,
          text: tab,
        });
        tabEl.addEventListener('click', () => {
          this.activeTab = tab;
          this.display();
        });
      }

      // Render active tab
      const ctx = this.buildContext();
      switch (this.activeTab) {
        case 'Connection':
          renderConnectionTab(tabContent, ctx);
          break;
        case 'Sync':
          renderSyncTab(tabContent, ctx);
          break;
        case 'Activity':
          this.renderActivityTab(tabContent);
          break;
        case 'Advanced':
          this.renderAdvancedTab(tabContent);
          break;
        case 'N2O Sync Pro':
          renderProTab(tabContent, ctx);
          break;
      }

      // Footer on every tab
      this.renderFooter(tabContent);

      window.requestAnimationFrame(() => {
        scrollParent.scrollTop = savedScrollTop;
      });
    } finally {
      this.isRendering = false;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // TAB 5: ACTIVITY (kept inline - small)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  private renderActivityTab(container: HTMLElement): void {
    this.renderRecentActivitySection(container);
    this.renderSyncHistorySection(container);
  }

  private renderRecentActivitySection(container: HTMLElement): void {
    const group = container.createDiv({ cls: 'n2o-settings-group' });
    group.createDiv({ cls: 'n2o-settings-group-title', text: 'Recent Activity' });
    group.createDiv({ cls: 'n2o-settings-group-desc', text: 'Items changed in the last sync.' });

    const lastResult = this.plugin.getOrchestrator().getStatus().lastResult;
    if (!lastResult?.items) {
      group.createDiv({ cls: 'setting-item-description', text: 'No sync activity yet.' });
      return;
    }

    const changed = lastResult.items.filter((item) => item.status !== 'unchanged');
    if (changed.length === 0) {
      group.createDiv({ cls: 'setting-item-description', text: 'No changes in last sync.' });
      return;
    }

    const syncTime =
      this.plugin.getOrchestrator().getStatus().lastSyncTime ?? new Date().toISOString();
    const list = group.createDiv({ cls: 'n2o-dash-activity-list' });
    for (const item of changed.slice(0, 20)) {
      const row = list.createDiv({ cls: 'n2o-dash-activity-row' });
      const iconEl = row.createSpan({ cls: 'n2o-dash-activity-icon' });
      const iconName =
        item.status === 'created'
          ? 'plus'
          : item.status === 'updated'
            ? 'pencil'
            : item.status === 'orphaned'
              ? 'trash'
              : item.status === 'failed'
                ? 'alert-triangle'
                : 'file';
      setIcon(iconEl, iconName);
      row.createSpan({
        cls: 'n2o-dash-activity-name',
        text: item.title || item.vaultPath.split('/').pop()?.replace('.md', '') || 'Untitled',
      });
      row.createSpan({ cls: 'n2o-dash-activity-time', text: formatTimeAgo(syncTime) });
    }
  }

  private renderSyncHistorySection(container: HTMLElement): void {
    const group = container.createDiv({ cls: 'n2o-settings-group' });
    group.createDiv({ cls: 'n2o-settings-group-title', text: 'Sync History' });
    group.createDiv({
      cls: 'n2o-settings-group-desc',
      text: 'Past sync operations and results. Click an entry to expand details.',
    });

    let history: {
      timestamp: string;
      duration: number;
      result: {
        success: boolean;
        items?: { title: string; vaultPath: string; status: string; error?: string }[];
        counts?: {
          total: number;
          created: number;
          updated: number;
          unchanged: number;
          failed: number;
          orphaned: number;
        };
        errors?: string[];
      };
    }[] = [];
    try {
      history = this.plugin.getSyncHistoryDB().loadHistory();
    } catch {
      /* DB not ready */
    }

    if (history.length === 0) {
      group.createDiv({ cls: 'setting-item-description', text: 'No sync history yet.' });
      return;
    }

    const list = group.createDiv({ cls: 'n2o-dash-history-list' });
    for (const entry of history.slice(0, 50)) {
      const isError = !entry.result.success;
      const time = new Date(entry.timestamp);
      const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const dateStr = time.toLocaleDateString([], { month: 'short', day: 'numeric' });
      const durationStr = (entry.duration / 1000).toFixed(1);

      const details = list.createEl('details', { cls: 'n2o-log-entry' });
      const summary = details.createEl('summary', {
        cls: isError ? 'n2o-log-error' : 'n2o-log-success',
      });

      summary.createSpan({
        cls: `n2o-dash-hdot ${isError ? 'n2o-dash-hdot--error' : 'n2o-dash-hdot--ok'}`,
      });
      summary.createSpan({ text: `${dateStr} ${timeStr}`, cls: 'n2o-dash-htime' });
      summary.createSpan({ text: ` (${durationStr}s)`, cls: 'n2o-dash-hdur' });

      if (!isError && entry.result.counts) {
        const c = entry.result.counts;
        const parts: string[] = [];
        if (c.created > 0) parts.push(`+${c.created}`);
        if (c.updated > 0) parts.push(`~${c.updated}`);
        if (c.failed > 0) parts.push(`!${c.failed}`);
        if (parts.length > 0) {
          summary.createSpan({ text: ` ${parts.join(' ')}`, cls: 'n2o-dash-hcounts' });
        }
      } else if (isError) {
        summary.createSpan({ cls: 'n2o-dash-hcounts n2o-dash-hcounts--error', text: ' error' });
      }

      // Expandable body with per-item details
      const body = details.createDiv({ cls: 'n2o-log-body' });

      if (entry.result.counts) {
        const c = entry.result.counts;
        body.createDiv({
          cls: 'n2o-log-stats',
          text: `Total: ${c.total} | New: ${c.created} | Updated: ${c.updated} | Unchanged: ${c.unchanged} | Failed: ${c.failed} | Removed: ${c.orphaned}`,
        });
      }

      const items = entry.result.items?.filter((i) => i.status !== 'unchanged') ?? [];
      if (items.length > 0) {
        const itemList = body.createEl('ul', { cls: 'n2o-log-items' });
        for (const item of items.slice(0, 50)) {
          const icon =
            item.status === 'created'
              ? '+'
              : item.status === 'updated'
                ? '~'
                : item.status === 'failed'
                  ? '!'
                  : item.status === 'orphaned'
                    ? '-'
                    : '?';
          const li = itemList.createEl('li', { cls: `n2o-log-item-${item.status}` });
          li.setText(`${icon} ${item.title}`);
          if (item.error) {
            li.createSpan({ text: ` - ${item.error}`, cls: 'n2o-log-item-error' });
          }
        }
        if (items.length > 50) {
          body.createEl('p', { text: `...and ${items.length - 50} more`, cls: 'n2o-log-more' });
        }
      }

      const errors = entry.result.errors ?? [];
      if (errors.length > 0) {
        const errorEl = body.createDiv({ cls: 'n2o-log-errors' });
        errorEl.createEl('strong', { text: 'Errors:' });
        const errorList = errorEl.createEl('ul');
        for (const err of errors) {
          errorList.createEl('li', { text: err });
        }
      }
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // TAB 6: ADVANCED (kept inline - moderate size)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  private renderAdvancedTab(container: HTMLElement): void {
    // ── System Health Hub (top) ──

    // ── Debug Mode ──
    const debugGroup = container.createDiv({ cls: 'n2o-settings-group' });
    debugGroup.createDiv({ cls: 'n2o-settings-group-title', text: 'Debug' });
    debugGroup.createDiv({ cls: 'n2o-settings-group-desc', text: 'Logging and diagnostics' });

    new Setting(debugGroup)
      .setName('Debug Mode')
      .setDesc('Enable verbose logging in the developer console')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debugMode).onChange(async (value) => {
          this.plugin.settings.debugMode = value;
          await this.plugin.saveSettings();
        }),
      );

    // ── Reset N2O ──
    const resetGroup = container.createDiv({ cls: 'n2o-settings-group' });
    resetGroup.createDiv({ cls: 'n2o-settings-group-title', text: 'Danger Zone' });
    resetGroup.createDiv({
      cls: 'n2o-settings-group-desc',
      text: 'Destructive actions that cannot be undone',
    });

    new Setting(resetGroup)
      .setName('Known Notion pages')
      .setDesc(
        'Forget the list of pages N2O found. The next sync or "Choose what to sync" rebuilds it.',
      )
      .addButton((btn) =>
        btn.setButtonText('Forget pages').onClick(() => {
          try {
            this.plugin.getDatabase().getPageCacheStore().clear();
            new Notice('N2O: Page cache cleared.', NOTICE_SHORT);
            this.display();
          } catch {
            new Notice('N2O: Could not clear cache - database not ready.', NOTICE_SHORT);
          }
        }),
      );

    new Setting(resetGroup)
      .setName('Reset N2O')
      .setDesc(
        'Clear all sync data, caches, and page selections. License and Notion connection preserved.',
      )
      .addButton((btn) =>
        btn
          .setButtonText('Reset')
          .setWarning()
          .onClick(() => {
            new ResetConfirmModal(this.app, async () => {
              await this.plugin.resetN2O();
              new Notice(
                'N2O: Reset complete. Select pages and sync to start fresh.',
                NOTICE_CRITICAL,
              );
            }).open();
          }),
      );

    new Setting(resetGroup)
      .setName('Factory Reset')
      .setDesc(
        'Wipe everything - database, caches, settings. Plugin returns to first-install state.',
      )
      .addButton((btn) =>
        btn
          .setButtonText('Factory Reset')
          .setWarning()
          .onClick(() => {
            new ResetConfirmModal(
              this.app,
              async () => {
                // Variant 'factory' - see ResetConfirmModal for why the
                // shared modal needs to know which reset it's confirming.
                // 1. Wipe all sync/cache data (SQLite tables + filesystem
                //    caches + in-memory stores).
                await this.plugin.resetN2O();

                // 2. Reset the profile to shipping defaults. Previous versions
                //    of this handler hand-listed ~11 fields, which meant every
                //    newly-added profile field silently persisted across a
                //    "factory reset" - oauthBotId, syncFolder, property
                //    mappings, automation intervals, etc. all leaked through.
                //    Spreading DEFAULT_PROFILE covers every field as of today
                //    AND every field added in the future.
                const profile = getActiveProfile(this.plugin.settings);
                Object.assign(profile, DEFAULT_PROFILE, { notionToken: '', authType: 'internal' });

                // 4. Reset top-level settings to defaults while preserving the
                //   profile structure we just reset above.
                this.plugin.settings.debugMode = DEFAULT_SETTINGS.debugMode;

                // 5. Clear cached connection state and force the in-memory
                //    NotionClient to drop its auth header (saveSettings below
                //    would update it via settings-manager anyway, but doing
                //    it explicitly guards against future wiring changes).
                this.plugin.cachedWorkspaceName = null;
                try {
                  this.plugin.getNotionClient().setToken('');
                } catch {
                  /* non-critical */
                }

                await this.plugin.saveSettings();
                new Notice(
                  'N2O: Factory reset complete. Plugin is back to first-install state.',
                  NOTICE_CRITICAL,
                );
                this.display();
              },
              'factory',
            ).open();
          }),
      );
  }

  // ── Footer ──────────────────

  private renderFooter(container: HTMLElement): void {
    const footer = container.createDiv({ cls: 'n2o-settings-footer' });

    // Spread the Word
    footer.createDiv({
      cls: 'n2o-footer-tagline',
      text: 'Spread the Word - Enjoying N2O? Share it with the community',
    });

    const spreadRow = footer.createDiv({ cls: 'n2o-footer-spread' });

    const makeLink = (parent: HTMLElement, text: string, href: string) => {
      const a = parent.createEl('a', { text, href, cls: 'n2o-footer-link' });
      a.setAttribute('target', '_blank');
      return a;
    };

    makeLink(spreadRow, '\u2B50 Review on Obsidian', 'https://obsidian.md/plugins?id=n2o');
    makeLink(
      spreadRow,
      '\uD835\uDD4F Share on X',
      "https://twitter.com/intent/tweet?text=I'm+syncing+Notion+%26+Obsidian+with+N2O!+Check+it+out:+https://n2osync.com",
    );
    makeLink(spreadRow, '\u2605 Star on GitHub', 'https://github.com/n2osync/n2o');

    // Version + legal links
    const legalRow = footer.createDiv({ cls: 'n2o-footer-legal' });
    const version = this.plugin.manifest.version;
    legalRow.createSpan({ text: `N2O v${version}` });
    legalRow.createSpan({ text: ' \u00B7 ' });
    makeLink(legalRow, 'Privacy', 'https://n2osync.com/docs/legal/privacy/');
    legalRow.createSpan({ text: ' \u00B7 ' });
    makeLink(legalRow, 'Terms', 'https://n2osync.com/docs/legal/terms/');
    legalRow.createSpan({ text: ' \u00B7 ' });
    makeLink(legalRow, 'Troubleshooting', 'https://n2osync.com/docs/guides/troubleshooting/');
  }
}
