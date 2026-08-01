/**
 * Settings Tab - Sync tab renderer.
 *
 * Renders the Sync tab as focused collapsible sections: scope, folders,
 * sync rules, media, performance, and maintenance.
 */

import { Setting, Notice, normalizePath } from 'obsidian';
import type { SettingsTabContext } from './settings-helpers';
import { createSection, formatTimeAgo } from './settings-helpers';
import { getActiveProfile } from '../domain/models/config-schema';
import { SyncTreePicker } from './sync-tree-picker';
import { FilterBuilderModal } from './filter-builder';
import { PropertyMapperModal } from './property-mapper';

/** Reset transient state (called when settings tab is reconstructed). */
export function resetSyncTabState(): void {
  // No transient sync-tab state to reset in the current section set.
}

/** Render the Sync tab into the given container. */
export function renderSyncTab(container: HTMLElement, ctx: SettingsTabContext): void {
  const profile = getActiveProfile(ctx.plugin.settings);
  const hasToken = !!profile.notionToken;

  if (!hasToken) {
    container.createDiv({
      text: 'Connect to Notion first in the Connection tab.',
      cls: 'setting-item-description',
    });
    return;
  }

  renderScopeSection(container, ctx);
  renderFoldersSection(container, ctx);
  renderSyncRulesSection(container, ctx);
  renderMediaSection(container, ctx);
  renderMaintenanceSection(container, ctx);
}

// ── Section: Scope ─────────────────────────

function renderScopeSection(container: HTMLElement, ctx: SettingsTabContext): void {
  const body = createSection(
    ctx,
    container,
    'sync-scope',
    'What to sync',
    'Choose what syncs from Notion.',
    { open: true },
  );
  body.createDiv({
    cls: 'n2o-automation-tip',
    text: '\u{1F4A1} Choose \u2018Selected items\u2019 to control exactly what syncs. \u2018Everything\u2019 brings in every page and database your Notion connection can access.',
  });

  const profile = getActiveProfile(ctx.plugin.settings);

  // What to sync
  new Setting(body)
    .setName('What to sync')
    .setDesc('Sync your whole Notion workspace, or only the pages and databases you choose.')
    .addDropdown((dropdown) =>
      dropdown
        .addOption('all', 'Everything')
        .addOption('selected', 'Selected items')
        .setValue(profile.syncScope)
        .onChange(async (value) => {
          profile.syncScope = value as 'all' | 'selected';
          await ctx.plugin.saveSettings();
          ctx.display();
        }),
    );

  if (profile.syncScope === 'selected') {
    // Selection summary
    const items = profile.selectedItems;
    const databases = items.filter((i) => i.type === 'database');
    const standalonePages = items.filter((i) => i.type === 'page');
    const dbPageTotal = databases.reduce((sum, db) => sum + (db.itemCount ?? 0), 0);

    let summaryText: string;
    if (items.length === 0) {
      summaryText = 'Nothing selected yet. Click "Choose items" to browse your Notion workspace.';
    } else {
      const parts: string[] = [];
      if (databases.length > 0) {
        const label = `${databases.length} database${databases.length !== 1 ? 's' : ''}`;
        parts.push(
          dbPageTotal > 0 ? `${label} (${dbPageTotal} page${dbPageTotal !== 1 ? 's' : ''})` : label,
        );
      }
      if (standalonePages.length > 0) {
        const qualifier = databases.length > 0 ? 'standalone ' : '';
        parts.push(
          `${standalonePages.length} ${qualifier}page${standalonePages.length !== 1 ? 's' : ''}`,
        );
      }
      summaryText = `Syncing: ${parts.join(', ')}`;
    }

    const summaryEl = body.createDiv({ cls: 'n2o-selected-summary' });
    summaryEl.setText(summaryText);

    // Show selected item names
    if (items.length > 0 && items.length <= 20) {
      const listEl = summaryEl.createEl('ul');
      listEl.setCssStyles({ marginTop: '4px' });
      listEl.setCssStyles({ fontSize: '12px' });
      for (const item of items) {
        const icon = item.type === 'database' ? '\uD83D\uDDC4\uFE0F' : '\uD83D\uDCC4';
        const suffix =
          item.type === 'database' && item.itemCount !== undefined
            ? ` (${item.itemCount} page${item.itemCount !== 1 ? 's' : ''})`
            : '';
        listEl.createEl('li', { text: `${icon} ${item.title}${suffix}` });
      }
    } else if (items.length > 20) {
      summaryEl.createEl('p', {
        text: `(${items.length} items - too many to list)`,
        cls: 'setting-item-description',
      });
    }

    // Select Pages button
    new Setting(body)
      .setName('Choose items')
      .setDesc('Browse your Notion workspace and pick the pages and databases to sync')
      .addButton((btn) =>
        btn
          .setButtonText('Choose items')
          .setCta()
          .onClick(() => {
            let settingsPickerCache;
            try {
              settingsPickerCache = ctx.plugin.getDatabase().getPageCacheStore();
            } catch {
              new Notice('N2O: Database is still loading. Please try again in a moment.');
              return;
            }
            new SyncTreePicker(
              ctx.app,
              ctx.plugin.getNotionClient(),
              profile.selectedItems,
              async (selected) => {
                profile.selectedItems = selected;
                profile.notionPages = selected.map((s) => s.id);
                await ctx.plugin.saveSettings();
                ctx.display();
              },
              settingsPickerCache,
              (onProgress) => ctx.plugin.runSharedDiscovery(onProgress),
              () => ctx.plugin.scanVaultIds(),
              undefined,
              undefined,
              undefined,
              () => ctx.plugin.isDiscoveryRunning,
            ).open();
          }),
      );

    // Child sync settings
    new Setting(body)
      .setName('Include sub-pages')
      .setDesc('Also sync sub-pages nested inside the pages you picked')
      .addToggle((toggle) =>
        toggle.setValue(profile.syncChildPages).onChange(async (value) => {
          profile.syncChildPages = value;
          await ctx.plugin.saveSettings();
        }),
      );

    new Setting(body)
      .setName('Include inline databases')
      .setDesc('Also sync databases that live inside the pages you picked. May add a lot of items.')
      .addToggle((toggle) =>
        toggle.setValue(profile.syncChildDatabases).onChange(async (value) => {
          profile.syncChildDatabases = value;
          await ctx.plugin.saveSettings();
        }),
      );

    new Setting(body)
      .setName('Include all items from linked views')
      .setDesc(
        "When a page embeds a linked database view, sync the whole source database. Off syncs only the items the view's filter shows (faster).",
      )
      .addToggle((toggle) =>
        toggle.setValue(profile.linkedViewFullDatabase).onChange(async (value) => {
          profile.linkedViewFullDatabase = value;
          await ctx.plugin.saveSettings();
        }),
      );

    // Manual page entry (collapsed, tracked across re-renders)
    const manualDetails = body.createEl('details');
    if (ctx.expandedSections.has('manual-pages')) {
      manualDetails.setAttribute('open', '');
    }
    manualDetails.addEventListener('toggle', () => {
      if (manualDetails.open) {
        ctx.expandedSections.add('manual-pages');
      } else {
        ctx.expandedSections.delete('manual-pages');
      }
    });
    manualDetails.createEl('summary', {
      text: 'Manual page entry (advanced)',
      cls: 'n2o-advanced-toggle',
    });

    new Setting(manualDetails)
      .setName('Notion Page URLs')
      .setDesc('Paste Notion page URLs or IDs (one per line)')
      .addTextArea((text) => {
        text
          .setPlaceholder('https://notion.so/My-Page-abc123...')
          .setValue(profile.notionPages.join('\n'))
          .onChange((value) => {
            profile.notionPages = value
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line.length > 0);
            ctx.debouncedSave();
          });
        text.inputEl.rows = 4;
        text.inputEl.setCssStyles({ width: '100%' });
      });
  }

  // Database filters & properties (inline, only when databases are selected)
  const selectedDatabases = profile.selectedItems.filter((i) => i.type === 'database');
  if (selectedDatabases.length > 0) {
    const dbSubsection = body.createDiv({ cls: 'n2o-settings-subsection' });
    dbSubsection.createDiv({
      text: 'Database Filters & Properties',
      cls: 'n2o-settings-group-desc',
    });

    for (const db of selectedDatabases) {
      const filterCount =
        profile.databaseFilters.find((f) => f.databaseId === db.id)?.conditions.length ?? 0;

      new Setting(dbSubsection)
        .setName(`\uD83D\uDDC4\uFE0F ${db.title}`)
        .setDesc(
          filterCount > 0
            ? `${filterCount} filter${filterCount !== 1 ? 's' : ''} active`
            : 'No filters',
        )
        .addButton((btn) =>
          btn.setButtonText('Filters').onClick(() => {
            const current = profile.databaseFilters.find((f) => f.databaseId === db.id);
            new FilterBuilderModal(
              ctx.app,
              ctx.plugin.getNotionClient(),
              db.id,
              db.title,
              current,
              (filter) => {
                void (async () => {
                  const idx = profile.databaseFilters.findIndex((f) => f.databaseId === db.id);
                  if (idx >= 0) {
                    profile.databaseFilters[idx] = filter;
                  } else {
                    profile.databaseFilters.push(filter);
                  }
                  await ctx.plugin.saveSettings();
                  ctx.display();
                })();
              },
            ).open();
          }),
        )
        .addButton((btn) =>
          btn.setButtonText('Properties').onClick(() => {
            const current = profile.propertyMappings.find((m) => m.databaseId === db.id);
            new PropertyMapperModal(
              ctx.app,
              ctx.plugin.getNotionClient(),
              db.id,
              db.title,
              current,
              (mapping) => {
                void (async () => {
                  const idx = profile.propertyMappings.findIndex((m) => m.databaseId === db.id);
                  if (idx >= 0) {
                    profile.propertyMappings[idx] = mapping;
                  } else {
                    profile.propertyMappings.push(mapping);
                  }
                  await ctx.plugin.saveSettings();
                  ctx.display();
                })();
              },
            ).open();
          }),
        );
    }
  }
}

// ── Section: Folders ──────────────────────

function renderFoldersSection(container: HTMLElement, ctx: SettingsTabContext): void {
  const body = createSection(
    ctx,
    container,
    'sync-folders',
    'Folders',
    'Where synced files live in your vault.',
  );

  const profile = getActiveProfile(ctx.plugin.settings);

  new Setting(body)
    .setName('Sync Folder')
    .setDesc('Root folder in your vault for synced Notion content')
    .addText((text) =>
      text
        .setPlaceholder('Notion')
        .setValue(profile.syncFolder)
        .onChange((value) => {
          const safe = normalizePath(value);
          if (safe.startsWith('..') || safe.includes('/..')) return;
          profile.syncFolder = safe;
          ctx.debouncedSave();
        }),
    );

  new Setting(body)
    .setName('Standalone Pages Folder')
    .setDesc('Place workspace-level pages (not in any database) into a separate subfolder')
    .addToggle((toggle) =>
      toggle.setValue(profile.useStandaloneFolder).onChange(async (value) => {
        profile.useStandaloneFolder = value;
        await ctx.plugin.saveSettings();
        ctx.display();
      }),
    );

  if (profile.useStandaloneFolder) {
    new Setting(body)
      .setName('Standalone Folder Name')
      .setDesc('Subfolder name relative to sync folder (e.g. "Pages" \u2192 "Notion/Pages/")')
      .addText((text) =>
        text
          .setPlaceholder('_Pages')
          .setValue(profile.standaloneFolder)
          .onChange((value) => {
            const safe = normalizePath(value);
            if (safe.startsWith('..') || safe.includes('/..')) return;
            profile.standaloneFolder = safe;
            ctx.debouncedSave();
          }),
      );
  }
}

// ── Section: Sync rules ───────────────────

function renderSyncRulesSection(container: HTMLElement, ctx: SettingsTabContext): void {
  const body = createSection(
    ctx,
    container,
    'sync-rules',
    'Sync rules',
    'Conflicts and deletions.',
  );

  const profile = getActiveProfile(ctx.plugin.settings);

  new Setting(body)
    .setName('Keep a backup of the discarded version')
    .setDesc(
      'When you overwrite a note from Notion, save the replaced local version in a readable .backup-<time>.md note next to it. Off still keeps a plain copy - N2O never overwrites a note without saving one.',
    )
    .addToggle((toggle) =>
      toggle.setValue(profile.createConflictNotes).onChange(async (value) => {
        profile.createConflictNotes = value;
        await ctx.plugin.saveSettings();
      }),
    );

  new Setting(body)
    .setName('Delete local notes removed from Notion')
    .setDesc('When a page is deleted in Notion, delete the matching note in your vault')
    .addToggle((toggle) =>
      toggle.setValue(profile.syncDeletedItems).onChange(async (value) => {
        profile.syncDeletedItems = value;
        await ctx.plugin.saveSettings();
      }),
    );
}

// ── Section: Media ────────────────────────

function renderMediaSection(container: HTMLElement, ctx: SettingsTabContext): void {
  const body = createSection(
    ctx,
    container,
    'sync-media',
    'Media',
    'Images, files, and attachments.',
  );

  const profile = getActiveProfile(ctx.plugin.settings);

  // Rehomed from the Notionify tab when Notionify was cut (#1917). This is a
  // real render setting that changes the markdown, not a display decoration, so
  // it never belonged with the cosmetic toggles.
  new Setting(body)
    .setName('Multi-column layout')
    .setDesc('Render Notion column layouts as side-by-side columns. Takes effect on the next sync.')
    .addToggle((toggle) =>
      toggle.setValue(profile.enableMultiColumnLayout !== false).onChange(async (value) => {
        profile.enableMultiColumnLayout = value;
        await ctx.plugin.saveSettings();
      }),
    );

  new Setting(body)
    .setName('Download Media')
    .setDesc('Download images, files, and videos into per-folder _files/ directories')
    .addToggle((toggle) =>
      toggle.setValue(profile.downloadMedia).onChange(async (value) => {
        profile.downloadMedia = value;
        await ctx.plugin.saveSettings();
        ctx.display();
      }),
    );

  if (profile.downloadMedia) {
    new Setting(body)
      .setName('Generate Cover Thumbnails')
      .setDesc(
        'Create smaller thumbnail versions of large cover images for faster .base card views',
      )
      .addToggle((toggle) =>
        toggle.setValue(profile.generateThumbnails).onChange(async (value) => {
          profile.generateThumbnails = value;
          await ctx.plugin.saveSettings();
        }),
      );
  }

  new Setting(body)
    .setName('File Property Images')
    .setDesc(
      'How images from Notion file properties appear in synced files. Inline renders them in the document body. Frontmatter stores paths in YAML only. Hidden excludes them entirely.',
    )
    .addDropdown((dropdown) => {
      dropdown
        .addOption('frontmatter', 'Frontmatter only (clean)')
        .addOption('inline', 'Inline embeds (visible)')
        .addOption('hidden', 'Hidden')
        .setValue(profile.filePropertyRenderMode ?? 'frontmatter')
        .onChange(async (value) => {
          profile.filePropertyRenderMode = value as 'inline' | 'frontmatter' | 'hidden';
          await ctx.plugin.saveSettings();
        });
    });
}

// ── Section: Maintenance ──────────────────

function renderMaintenanceSection(container: HTMLElement, ctx: SettingsTabContext): void {
  const cacheGroup = createSection(
    ctx,
    container,
    'sync-maintenance',
    'Maintenance',
    'Re-scan or clear the local cache.',
  );

  let cacheStatsText = '';
  const buildCacheStatsText = (): string => {
    try {
      const cache = ctx.plugin.getDatabase().getPageCacheStore();
      const total = cache.count();
      const dbs = cache.getAllDatabases().length;
      const pages = total - dbs;
      const lastDiscovery = cache.getLastDiscoveryTime();
      const age = lastDiscovery ? `updated ${formatTimeAgo(lastDiscovery)}` : 'never scanned';
      return `${total.toLocaleString()} items \u00B7 ${dbs} databases \u00B7 ${pages.toLocaleString()} pages \u00B7 ${age}`;
    } catch {
      return 'Cache not available';
    }
  };
  cacheStatsText = buildCacheStatsText();

  const cacheStatusEl = cacheGroup.createDiv({ cls: 'n2o-connection-status' });
  const updateCacheStatus = () => {
    try {
      const cache = ctx.plugin.getDatabase().getPageCacheStore();
      const total = cache.count();
      if (total === 0) {
        cacheStatusEl.setText(
          '\u26A0 No pages discovered yet - click Refresh to scan your workspace',
        );
        cacheStatusEl.setCssStyles({ color: 'var(--text-warning)' });
        return;
      }
      const lastDiscovery = cache.getLastDiscoveryTime();
      const ageMs = lastDiscovery ? Date.now() - new Date(lastDiscovery).getTime() : Infinity;
      const oneHour = 60 * 60 * 1000;
      if (ageMs < oneHour) {
        cacheStatusEl.setText(`\u2713 Connected - all shared pages discovered`);
        cacheStatusEl.setCssStyles({ color: 'var(--text-success)' });
      } else {
        // Non-null guaranteed: lastDiscovery is truthy (ageMs would be Infinity otherwise, skipping this branch)
        cacheStatusEl.setText(
          `Last scanned ${formatTimeAgo(lastDiscovery as string)} - click Refresh to update`,
        );
        cacheStatusEl.setCssStyles({ color: 'var(--text-muted)' });
      }
    } catch {
      cacheStatusEl.setText('\u26A0 Cache not available - database still loading');
      cacheStatusEl.setCssStyles({ color: 'var(--text-warning)' });
    }
  };
  updateCacheStatus();

  const updateCacheStats = () => {
    cacheStatsText = buildCacheStatsText();
    cacheSetting.setDesc(cacheStatsText);
    updateCacheStatus();
  };

  const cacheSetting = new Setting(cacheGroup)
    .setName('Known Notion pages')
    .setDesc(cacheStatsText)
    .addButton((btn) =>
      btn.setButtonText('Refresh').onClick(async () => {
        btn.setButtonText('Refreshing...');
        btn.setDisabled(true);
        cacheStatusEl.setText('\u21BB Scanning Notion for accessible pages\u2026');
        cacheStatusEl.setCssStyles({ color: 'var(--text-accent)' });
        try {
          const result = await ctx.plugin.discoverAccessibleContent((msg) => {
            cacheSetting.setDesc(msg);
          });
          if (!result) {
            cacheStatusEl.setText('\u2717 Discovery failed - check your connection');
            cacheStatusEl.setCssStyles({ color: 'var(--text-error)' });
          }
        } catch {
          cacheStatusEl.setText('\u2717 Discovery failed unexpectedly');
          cacheStatusEl.setCssStyles({ color: 'var(--text-error)' });
        } finally {
          btn.setButtonText('Refresh');
          btn.setDisabled(false);
          updateCacheStats();
        }
      }),
    )
    .addButton((btn) =>
      btn
        .setButtonText('Clear Cache')
        .setWarning()
        .onClick(async () => {
          try {
            ctx.plugin.getDatabase().getPageCacheStore().clear();
            cacheSetting.setDesc('0 items \u00B7 cache cleared');
            cacheStatusEl.setText('\u26A0 Cache cleared - click Refresh to re-scan');
            cacheStatusEl.setCssStyles({ color: 'var(--text-warning)' });
          } catch {
            cacheStatusEl.setText('\u2717 Failed to clear cache');
            cacheStatusEl.setCssStyles({ color: 'var(--text-error)' });
          }
        }),
    );
}
