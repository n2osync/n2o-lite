/**
 * DryRunPreviewModal - Shows what a sync WOULD do without writing anything.
 *
 * Displays a summary header with counts and a scrollable list of items
 * grouped by status (created, updated, unchanged, orphaned, conflict).
 */

import type { App } from 'obsidian';
import type { SyncResult } from '../application/sync/orchestrator';
import { BaseN2OModal } from './base-modal';

export class DryRunPreviewModal extends BaseN2OModal {
  constructor(
    app: App,
    private result: SyncResult,
    private onApply?: () => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('n2o-dry-run-modal');

    // Header
    contentEl.createEl('h2', { text: 'Sync preview (dry run)' });

    const { counts } = this.result;

    // Summary stats
    const summary = contentEl.createDiv({ cls: 'n2o-dry-run-summary' });
    summary.setAttribute('aria-live', 'polite');
    const stats: string[] = [];
    if (counts.created > 0) stats.push(`${counts.created} would be created`);
    if (counts.updated > 0) stats.push(`${counts.updated} would be updated`);
    if (counts.unchanged > 0) stats.push(`${counts.unchanged} unchanged`);
    if (counts.orphaned > 0) stats.push(`${counts.orphaned} would be removed`);
    if (counts.conflicts && counts.conflicts > 0) stats.push(`${counts.conflicts} conflicts`);
    if (counts.localChanges > 0) stats.push(`${counts.localChanges} local edits`);

    if (stats.length === 0) {
      summary.createEl('p', { text: 'Nothing to sync.' });
    } else {
      summary.createEl('p', { text: stats.join(' \u00B7 ') });
    }

    const duration = (this.result.duration / 1000).toFixed(1);
    summary.createEl('p', {
      text: `Preview completed in ${duration}s`,
      cls: 'n2o-dry-run-duration',
    });

    // Item list grouped by status
    const groups: { label: string; status: string; cls: string }[] = [
      { label: 'Would be created', status: 'created', cls: 'n2o-dry-run-badge--created' },
      { label: 'Would be updated', status: 'updated', cls: 'n2o-dry-run-badge--updated' },
      {
        label: 'No longer in Notion (would be removed)',
        status: 'orphaned',
        cls: 'n2o-dry-run-badge--orphaned',
      },
      { label: 'Conflicts', status: 'local-change', cls: 'n2o-dry-run-badge--conflict' },
      { label: 'Unchanged', status: 'unchanged', cls: 'n2o-dry-run-badge--unchanged' },
    ];

    const list = contentEl.createDiv({ cls: 'n2o-dry-run-list' });

    for (const group of groups) {
      const groupItems = this.result.items.filter((i) => i.status === group.status);
      if (groupItems.length === 0) continue;

      const section = list.createDiv({ cls: 'n2o-dry-run-group' });
      section.createEl('h4', { text: `${group.label} (${groupItems.length})` });

      const itemList = section.createDiv({ cls: 'n2o-dry-run-items' });
      for (const item of groupItems) {
        const row = itemList.createDiv({ cls: 'n2o-dry-run-item' });
        row.createSpan({ text: item.status.toUpperCase(), cls: `n2o-dry-run-badge ${group.cls}` });
        row.createSpan({ text: item.title, cls: 'n2o-dry-run-item-title' });
        row.createSpan({ text: item.vaultPath, cls: 'n2o-dry-run-item-path' });
      }
    }

    // Footer with Apply + Close buttons
    const footer = contentEl.createDiv({ cls: 'n2o-dry-run-footer' });

    const hasChanges = counts.created > 0 || counts.updated > 0 || counts.orphaned > 0;
    if (hasChanges && this.onApply) {
      const applyCallback = this.onApply;
      const applyBtn = footer.createEl('button', { text: 'Apply changes', cls: 'mod-cta' });
      applyBtn.addEventListener('click', () => {
        void (async () => {
          if (applyBtn.disabled) return;
          applyBtn.disabled = true;
          applyBtn.textContent = 'Applying...';
          try {
            await applyCallback();
          } catch {
            applyBtn.disabled = false;
            applyBtn.textContent = 'Apply changes';
            return;
          }
          this.close();
        })();
      });
    }

    const closeBtn = footer.createEl('button', { text: 'Close' });
    closeBtn.addEventListener('click', () => this.close());
  }
}
