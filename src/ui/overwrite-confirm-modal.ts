/**
 * OverwriteConfirmModal - confirmation before "Overwrite from Notion", which
 * replaces local files with Notion's current version (no merge, no backup).
 * Thin wrapper over the shared confirm renderer.
 */

import type { App } from 'obsidian';
import { BaseN2OModal } from './base-modal';
import { renderConfirm } from './confirm-modal';

export class OverwriteConfirmModal extends BaseN2OModal {
  constructor(
    app: App,
    private readonly onConfirm: () => void,
    /** What gets replaced, e.g. "all synced notes" or a single note name. */
    private readonly targetLabel: string = 'all synced notes',
  ) {
    super(app);
  }

  override onOpen(): void {
    this.contentEl.empty();
    renderConfirm(
      this.contentEl,
      {
        title: 'Overwrite from Notion?',
        lead: `This replaces ${this.targetLabel} with Notion's current version.`,
        warning: (el) => {
          el.appendText(
            'Any local edits you have not sent to Notion yet will be lost. There is no merge and no backup. Use ',
          );
          el.createEl('strong', { text: 'Sync' });
          el.appendText(' instead if you want to keep changes from both sides.');
        },
        confirmText: 'Overwrite from Notion',
      },
      { close: () => this.close(), onConfirm: this.onConfirm },
    );
  }
}
