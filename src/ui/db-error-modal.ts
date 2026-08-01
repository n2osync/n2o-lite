/**
 * DbErrorModal - Recovery wizard shown when the SQLite database fails to open.
 *
 * Provides three recovery actions:
 * - Retry: re-attempts dbManager.open() without any cleanup
 * - Delete Database & Retry: removes n2o-core.db + n2o-history.db then retries
 * - Open Plugin Folder: reveals the plugin folder in the system file manager
 *
 * On successful retry the caller's onSuccess callback is invoked so the
 * layout-ready-handler can continue normal initialization.
 */

import { App, Notice } from 'obsidian';
import type { DatabaseManager } from '../infrastructure/storage/database-manager';
import { getErrorMessage } from '../shared/errors';
import { NOTICE_MEDIUM, NOTICE_ERROR } from '../shared/constants';
import { createLogger } from '../shared/logger';
import { PLUGIN_ID } from '../shared/plugin-metadata';
import { openExternalUrl } from '../shared/electron-cookies';
import { BaseN2OModal } from './base-modal';

const log = createLogger('DbErrorModal');

/** Brief pause (ms) so the user can read the success message before modal closes. */
const SUCCESS_MESSAGE_DELAY_MS = 800;

export class DbErrorModal extends BaseN2OModal {
  private isRetrying = false;

  /** Plugin folder under the vault's config dir (not always ".obsidian"). */
  private get pluginDir(): string {
    return `${this.app.vault.configDir}/plugins/${PLUGIN_ID}`;
  }

  constructor(
    app: App,
    private readonly dbManager: DatabaseManager,
    private readonly errorMessage: string,
    private readonly onSuccess: () => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('n2o-db-error-modal');

    contentEl.createEl('h2', { text: 'N2O - Database Error' });

    contentEl.createEl('p', {
      text: 'N2O could not open its local database. Sync is unavailable until this is resolved.',
    });

    const errorBox = contentEl.createDiv({ cls: 'n2o-db-error-detail' });
    errorBox.createEl('strong', { text: 'Error: ' });
    errorBox.createSpan({ text: this.errorMessage });

    contentEl.createEl('p', {
      text: 'Common causes: database corruption or a permissions issue on the plugin folder. You can retry, wipe the database files and start fresh, or inspect the plugin folder manually.',
      cls: 'setting-item-description',
    });

    // Status area for inline feedback during retry
    const statusEl = contentEl.createDiv({ cls: 'n2o-db-error-status' });
    statusEl.setCssStyles({ display: 'none' });

    // Button row
    const actionsEl = contentEl.createDiv({ cls: 'n2o-db-error-actions' });

    const retryBtn = actionsEl.createEl('button', { text: 'Retry', cls: 'mod-cta' });
    retryBtn.setAttribute('aria-label', 'Retry opening the database');
    retryBtn.addEventListener('click', () => void this.handleRetry(statusEl, false));

    const deleteBtn = actionsEl.createEl('button', { text: 'Delete Database & Retry' });
    deleteBtn.setAttribute('aria-label', 'Delete database files and retry');
    deleteBtn.addEventListener('click', () => void this.handleRetry(statusEl, true));

    const openFolderBtn = actionsEl.createEl('button', { text: 'Open Plugin Folder' });
    openFolderBtn.setAttribute(
      'aria-label',
      'Open the N2O plugin folder in the system file manager',
    );
    openFolderBtn.addEventListener('click', () => this.handleOpenFolder());

    // Help link
    const helpEl = contentEl.createDiv({ cls: 'n2o-db-error-help' });
    const helpText = helpEl.createSpan({ text: 'Need help? Visit our ' });
    const link = helpText.createEl('a', { text: 'troubleshooting guide' });
    link.href = 'https://n2osync.com/docs/guides/troubleshooting/';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openExternalUrl('https://n2osync.com/docs/guides/troubleshooting/');
    });
    helpEl.appendText('.');
  }

  private async handleRetry(statusEl: HTMLElement, deleteFirst: boolean): Promise<void> {
    if (this.isRetrying) return;
    this.isRetrying = true;

    this.setStatus(
      statusEl,
      deleteFirst ? 'Deleting database files\u2026' : 'Retrying\u2026',
      'info',
    );

    try {
      if (deleteFirst) {
        await this.deleteDbFiles();
        this.setStatus(statusEl, 'Database files deleted. Opening storage\u2026', 'info');
      }

      await this.dbManager.open(this.app);

      this.setStatus(statusEl, 'Database opened successfully. Continuing\u2026', 'success');
      log.info('Database opened successfully after recovery');
      new Notice('N2O: Database opened successfully.', NOTICE_MEDIUM);

      // Brief pause so the user can read the success message before modal closes
      await new Promise<void>((resolve) => window.setTimeout(resolve, SUCCESS_MESSAGE_DELAY_MS));

      this.close();
      await this.onSuccess();
    } catch (err) {
      const msg = getErrorMessage(err);
      log.error('Database retry failed', err);
      this.setStatus(statusEl, `Retry failed: ${msg}`, 'error');
    } finally {
      this.isRetrying = false;
    }
  }

  private async deleteDbFiles(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const dbFiles = [`${this.pluginDir}/n2o-core.db`, `${this.pluginDir}/n2o-history.db`];
    for (const path of dbFiles) {
      try {
        if (await adapter.exists(path)) {
          await adapter.remove(path);
          log.info(`Deleted: ${path}`);
        }
      } catch (err) {
        log.warn(`Could not delete ${path}: ${getErrorMessage(err)}`);
      }
    }
  }

  private handleOpenFolder(): void {
    try {
      // Resolve the absolute path to the plugin directory via Obsidian's internal API.
      // (app as any).openWithDefaultApp() opens a path in the system file manager.
      const appAny = this.app as unknown as Record<string, unknown>;
      const pluginAbsPath = (
        this.app.vault.adapter as unknown as { getFullPath?: (p: string) => string }
      ).getFullPath?.(this.pluginDir);

      if (pluginAbsPath && typeof appAny.openWithDefaultApp === 'function') {
        (appAny.openWithDefaultApp as (path: string) => void)(pluginAbsPath);
      } else {
        // Fallback: open via file:// URL using electron shell
        const basePath = pluginAbsPath ?? this.pluginDir;
        openExternalUrl(`file://${basePath.replace(/\\/g, '/')}`);
      }
    } catch (err) {
      log.warn(`Could not open plugin folder: ${getErrorMessage(err)}`);
      new Notice(
        `N2O: Could not open plugin folder automatically. Navigate to ${this.pluginDir}/ in your vault.`,
        NOTICE_ERROR,
      );
    }
  }

  private setStatus(el: HTMLElement, text: string, kind: 'info' | 'success' | 'error'): void {
    el.setCssStyles({ display: 'block' });
    el.setText(text);
    el.style.color =
      kind === 'success'
        ? 'var(--text-success)'
        : kind === 'error'
          ? 'var(--text-error)'
          : 'var(--text-muted)';
  }
}
