/**
 * UpgradeModal - the "Try N2O Sync" dialog behind every upgrade CTA.
 *
 * Explains what the full edition adds, discloses exactly what the Install
 * button does (a user-initiated download from the full edition's public
 * GitHub releases), and drives the install with live progress. Failures
 * render inline in the modal (persistent, with a Retry) - never only as a
 * transient toast.
 *
 * The install engine lives in the plugin layer (pro-installer.ts); the
 * composition root injects it through the narrow UpgradeModalDeps interface
 * so this ui/ module never runtime-imports plugin/ (layer gate).
 */

import { setIcon, type App } from 'obsidian';
import { openExternalUrl } from '../shared/electron-cookies';
import { getErrorMessage } from '../shared/errors';
import { BaseN2OModal } from './base-modal';
import n2oLogo from '../assets/n2o-logo.png';
import { PRO_FEATURES } from '../shared/pro-features';

/** What the composition root hands the modal - install engine + status probe. */
export interface UpgradeModalDeps {
  /** Run the full install; reports per-step progress. Rejects with a user-ready message. */
  install(onProgress: (message: string) => void): Promise<{ enabled: boolean }>;
  /** Live status of the full plugin in this vault. */
  getStatus(): 'enabled' | 'installed' | 'absent';
}

/**
 * The Pro pitch, framed by the pain each feature removes (title) and how
 * (detail). Icons are lucide names rendered through setIcon. Only shipped,
 * tested features live here - templates, conflict-review UI and multi-workspace
 * stay out until they are proven.
 */
export class UpgradeModal extends BaseN2OModal {
  private installing = false;

  constructor(
    app: App,
    private readonly deps: UpgradeModalDeps,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('n2o-upgrade-modal');

    const header = contentEl.createDiv({ cls: 'n2o-um-header' });
    header.createEl('img', { cls: 'n2o-um-logo', attr: { src: n2oLogo, alt: 'N2O Sync' } });
    header.createDiv({ cls: 'n2o-um-badge', text: 'Pro' });
    header.createEl('h2', { cls: 'n2o-um-title', text: 'Try N2O Sync Pro free for 14 days' });

    // Already installed: say so instead of offering the install.
    const status = this.deps.getStatus();
    if (status !== 'absent') {
      header.createEl('p', {
        cls: 'n2o-um-subtitle',
        text:
          status === 'enabled'
            ? 'N2O Sync is already installed and enabled in this vault. N2O Sync Lite pauses its own sync while the full edition is active.'
            : 'N2O Sync is already installed in this vault but not enabled. Enable "N2O Sync" under Settings, then Community plugins.',
      });
      this.renderLearnMore(contentEl);
      return;
    }

    header.createEl('p', {
      cls: 'n2o-um-subtitle',
      text: 'Make Notion and Obsidian one workspace. Edit either side, both stay in sync, and nothing gets lost.',
    });

    const features = contentEl.createDiv({ cls: 'n2o-um-features' });
    for (const f of PRO_FEATURES) {
      const row = features.createDiv({ cls: 'n2o-um-feature' });
      setIcon(row.createDiv({ cls: 'n2o-um-feature-icon' }), f.icon);
      const text = row.createDiv({ cls: 'n2o-um-feature-text' });
      text.createDiv({ cls: 'n2o-um-feature-title', text: f.title });
      text.createDiv({ cls: 'n2o-um-feature-detail', text: f.detail });
    }

    const trial = contentEl.createDiv({ cls: 'n2o-um-trial' });
    trial.createEl('p', {
      cls: 'n2o-um-trial-lead',
      text: 'The free 14-day trial is the full app, up to 300 pages, and needs no credit card.',
    });
    trial.createEl('p', {
      cls: 'n2o-um-trial-after',
      text: 'Pro ($8/mo) and Lifetime ($249 once) sync unlimited pages - the 300-page cap is only on the trial.',
    });

    contentEl.createEl('p', {
      cls: 'n2o-um-note',
      text:
        'This downloads the N2O Sync plugin (about 2 MB) from its GitHub releases ' +
        '(github.com/n2osync/n2o) and enables it. Your Lite settings and vault are untouched.',
    });

    // Inline status area: progress while running, persistent error on failure.
    const statusEl = contentEl.createDiv({ cls: 'n2o-upgrade-status' });
    statusEl.setCssStyles({ display: 'none' });

    const actions = contentEl.createDiv({ cls: 'n2o-upgrade-actions' });
    const installBtn = actions.createEl('button', { text: 'Install N2O Sync', cls: 'mod-cta' });
    installBtn.addEventListener('click', () => void this.runInstall(installBtn, statusEl));

    this.renderLearnMore(contentEl);
  }

  private renderLearnMore(container: HTMLElement): void {
    const row = container.createDiv({ cls: 'n2o-upgrade-learnmore' });
    const link = row.createEl('a', {
      text: 'Learn more at n2osync.com',
      href: 'https://n2osync.com',
    });
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openExternalUrl('https://n2osync.com');
    });
  }

  private async runInstall(installBtn: HTMLButtonElement, statusEl: HTMLElement): Promise<void> {
    if (this.installing) return;
    this.installing = true;
    installBtn.disabled = true;
    installBtn.textContent = 'Installing...';
    statusEl.setCssStyles({ display: 'block' });
    statusEl.setCssStyles({ color: 'var(--text-muted)' });

    try {
      const result = await this.deps.install((message) => {
        statusEl.setText(message);
      });
      statusEl.setCssStyles({ color: 'var(--text-success)' });
      statusEl.setText(
        result.enabled
          ? 'N2O Sync installed and enabled.'
          : 'N2O Sync installed. Enable "N2O Sync" under Settings, then Community plugins.',
      );
      installBtn.textContent = 'Installed';
    } catch (err) {
      // Persistent inline failure with the real reason + a Retry.
      statusEl.setCssStyles({ color: 'var(--text-error)' });
      statusEl.setText(getErrorMessage(err));
      installBtn.disabled = false;
      installBtn.textContent = 'Retry install';
    } finally {
      this.installing = false;
    }
  }
}
