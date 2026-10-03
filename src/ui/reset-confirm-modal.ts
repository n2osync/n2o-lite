/**
 * ResetConfirmModal - Confirmation dialog for "Reset N2O" or
 * "Factory Reset". The two variants have very different blast
 * radii (one preserves license + token, the other wipes
 * everything), so the modal copy and button label must change
 * per variant - otherwise the user clicks "Factory Reset"
 * expecting everything gone and sees copy that says the token
 * will be preserved, which is misleading.
 */

import type { App } from 'obsidian';
import { BaseN2OModal } from './base-modal';
import { renderConfirm } from './confirm-modal';

export type ResetConfirmVariant = 'reset' | 'factory';

export class ResetConfirmModal extends BaseN2OModal {
  constructor(
    app: App,
    private readonly onConfirm: () => void | Promise<void>,
    private readonly variant: ResetConfirmVariant = 'reset',
  ) {
    super(app);
  }

  override onOpen(): void {
    this.contentEl.empty();
    const isFactory = this.variant === 'factory';
    const items = isFactory
      ? [
          'Notion token & workspace link (license slot released)',
          'License key & entitlements (local copy)',
          'All plugin settings (back to shipping defaults)',
          'Sync records, history, caches, page selections',
        ]
      : [
          'Sync records & history',
          'Block cache & base versions',
          'Page selections & linked view mappings',
          'Retry queue & property schema cache',
        ];

    renderConfirm(
      this.contentEl,
      {
        title: isFactory ? 'Factory Reset?' : 'Reset N2O?',
        lead: isFactory
          ? 'Wipe everything and return the plugin to its first-install state. Your Notion connection and license will be removed from this device.'
          : 'Clear all sync data, caches, and page selections. Your files, license, and Notion connection are not affected.',
        body: (el) => {
          el.createEl('strong', { text: 'Will be cleared:' });
          const list = el.createEl('ul');
          for (const item of items) list.createEl('li', { text: item });
          if (isFactory) {
            const note = el.createEl('p');
            note.createEl('strong', { text: 'Your vault files are not touched. ' });
            note.appendText('Anything N2O already pulled into Obsidian stays put.');
          }
        },
        confirmText: isFactory ? 'Factory Reset' : 'Reset',
      },
      { close: () => this.close(), onConfirm: this.onConfirm },
    );
  }
}
