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
import { PRO_FEATURES, LITE_DOES, PRO_INSTALL_DISCLOSURE } from '../shared/pro-features';
import { LITE_PAGE_LIMIT } from '../application/sync/page-budget';

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
    /**
     * Start the install as soon as the dialog opens. The dashboard's Install
     * button uses this: one click installs, and the dialog is what shows the
     * download disclosure, the progress and any failure. Doing the install
     * from the banner instead would need a second install path and would act
     * with the disclosure nowhere on screen.
     */
    private readonly autoInstall = false,
    /**
     * Hold the dialog open for this long. Used only when it opens by itself on
     * first launch, so the reader meets the message once before dismissing it.
     * Zero everywhere else: a dialog the user asked for closes when they say.
     */
    private readonly holdMs = 0,
  ) {
    super(app);
  }

  /** Cleared when the hold expires; until then close() refuses. */
  private heldUntil = 0;
  private holdTimer: number | null = null;
  private holdNoteEl: HTMLElement | null = null;

  override close(): void {
    if (this.heldUntil && Date.now() < this.heldUntil) return;
    if (this.holdTimer !== null) window.clearInterval(this.holdTimer);
    this.holdTimer = null;
    super.close();
  }

  override onOpen(): void {
    this.render();
    if (this.holdMs > 0) this.startHold();
  }

  /**
   * Refuse to close for holdMs, and say so with a live countdown rather than
   * silently swallowing the click, which reads as a broken dialog.
   */
  private startHold(): void {
    this.heldUntil = Date.now() + this.holdMs;
    // Obsidian 1.13 renders the dismiss control as .modal-header-button; older
    // builds used .modal-close-button. Match both, and tolerate neither: the
    // hold is enforced by close() below, this only makes it LOOK deliberate.
    const closeBtn = this.modalEl.querySelector<HTMLElement>(
      '.modal-header-button, .modal-close-button',
    );
    closeBtn?.addClass('is-held');
    this.holdNoteEl = this.contentEl.createDiv({ cls: 'n2o-um-hold' });

    const tick = (): void => {
      const left = Math.ceil((this.heldUntil - Date.now()) / 1000);
      if (left > 0) {
        this.holdNoteEl?.setText(`You can close this in ${left}s`);
        return;
      }
      if (this.holdTimer !== null) window.clearInterval(this.holdTimer);
      this.holdTimer = null;
      this.heldUntil = 0;
      closeBtn?.removeClass('is-held');
      this.holdNoteEl?.remove();
      this.holdNoteEl = null;
    };
    tick();
    this.holdTimer = window.setInterval(tick, 250);
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('n2o-upgrade-modal');

    const status = this.deps.getStatus();

    const header = contentEl.createDiv({ cls: 'n2o-um-header' });
    // Mark and headline on one row, left aligned, because everything below is a
    // left-aligned grid and a centred header fought with it.
    const titleRow = header.createDiv({ cls: 'n2o-um-titlerow' });
    titleRow.createEl('img', { cls: 'n2o-um-logo', attr: { src: n2oLogo, alt: 'N2O Sync' } });
    titleRow.createEl('h2', {
      cls: 'n2o-um-title',
      text: 'Move to N2O Sync Pro before Lite stops working',
    });

    // Already installed: say so instead of offering the install.
    if (status !== 'absent') {
      header.createEl('p', {
        cls: 'n2o-um-subtitle',
        text:
          status === 'enabled'
            ? 'N2O Sync Pro is already installed and enabled in this vault. N2O Sync Lite pauses its own sync while it is active.'
            : 'N2O Sync Pro is already installed in this vault but not enabled. Enable "N2O Sync" under Settings, then Community plugins.',
      });
      this.renderLearnMore(contentEl);
      return;
    }

    header.createEl('p', {
      cls: 'n2o-um-subtitle',
      text:
        'Lite only pulls, so whatever you write in Obsidian never reaches Notion and ' +
        'lives on this disk alone. It is also the copy of our sync engine that does not ' +
        'get the fixes, and when Notion changes and breaks it, we cannot say when.',
    });

    // The one number that decides it for most people, shown rather than described.
    const compare = contentEl.createDiv({ cls: 'n2o-um-compare' });

    const lite = compare.createEl('button', { cls: 'n2o-um-compare-cell' });
    lite.createDiv({ cls: 'n2o-um-compare-label', text: 'N2O Sync Lite, what you have' });
    lite.createDiv({ cls: 'n2o-um-compare-figure', text: `${LITE_PAGE_LIMIT} pages` });
    lite.createDiv({
      cls: 'n2o-um-compare-note',
      text: 'Pull only. Your edits never leave this vault.',
    });

    const pro = compare.createEl('button', { cls: 'n2o-um-compare-cell is-pro is-selected' });
    pro.createDiv({ cls: 'n2o-um-compare-label', text: 'N2O Sync Pro trial' });
    pro.createDiv({ cls: 'n2o-um-compare-figure', text: '300 pages' });
    pro.createDiv({
      cls: 'n2o-um-compare-note',
      text: 'Both ways, merged, free for 14 days. Free at 100 after, never locked.',
    });

    const features = contentEl.createDiv({ cls: 'n2o-um-features' });

    const trial = contentEl.createDiv({ cls: 'n2o-um-trial' });
    trial.createEl('p', {
      cls: 'n2o-um-trial-lead',
      text: 'Free for 14 days. The whole of N2O Sync Pro, 300 pages, no card.',
    });
    const after = trial.createEl('p', { cls: 'n2o-um-trial-after' });
    after.appendText(
      'When the trial ends you are not locked out. Pay $8 a month to keep everything, ' +
        'or stay on the free tier: 100 pages, pull only, for as long as you like. That ' +
        'is the same free you have in Lite today, on the edition we actually maintain, ' +
        'and nothing is ever removed from your vault. ',
    );
    const plansLink = after.createEl('a', {
      text: 'See the plans',
      href: 'https://n2osync.com/pricing',
    });
    plansLink.addEventListener('click', (e) => {
      e.preventDefault();
      openExternalUrl('https://n2osync.com/pricing');
    });

    // The download disclosure describes what the Pro button does, so it belongs
    // to that choice. It is required by Obsidian's developer policies and its
    // wording does not change, only whether the button it describes is showing.
    const note = contentEl.createEl('p', { cls: 'n2o-um-note', text: PRO_INSTALL_DISCLOSURE });

    // Inline status area: progress while running, persistent error on failure.
    const statusEl = contentEl.createDiv({ cls: 'n2o-upgrade-status' });
    statusEl.setCssStyles({ display: 'none' });

    const actions = contentEl.createDiv({ cls: 'n2o-upgrade-actions' });
    const installBtn = actions.createEl('button', { cls: 'mod-cta n2o-cta-glow' });
    const btnIcon = installBtn.createSpan({ cls: 'n2o-cta-icon' });
    const btnLabel = installBtn.createSpan({ cls: 'n2o-cta-label' });

    // Selecting an edition changes the list, the button and the disclosure
    // together. Staying on Lite is a real, named choice rather than the absence
    // of one: a dialog with a single way out reads as a trap, and somebody who
    // feels cornered does not buy.
    let choice: 'lite' | 'pro' = 'pro';
    const select = (which: 'lite' | 'pro'): void => {
      choice = which;
      lite.toggleClass('is-selected', which === 'lite');
      pro.toggleClass('is-selected', which === 'pro');
      this.renderFeatureList(features, which);
      btnLabel.setText(
        which === 'pro' ? 'Install N2O Sync Pro, free for 14 days' : 'Keep using Lite',
      );
      setIcon(btnIcon, which === 'pro' ? 'download' : 'x');
      installBtn.toggleClass('mod-cta', which === 'pro');
      installBtn.toggleClass('n2o-cta-glow', which === 'pro');
      note.toggleClass('is-hidden', which !== 'pro');
    };
    lite.addEventListener('click', () => select('lite'));
    pro.addEventListener('click', () => select('pro'));
    installBtn.addEventListener('click', () => {
      if (choice === 'lite') {
        this.close();
        return;
      }
      void this.runInstall(installBtn, btnLabel, statusEl);
    });

    // Pro is the answer we want read first, so it opens selected.
    select('pro');

    if (this.autoInstall) void this.runInstall(installBtn, btnLabel, statusEl);

    this.renderLearnMore(contentEl);
  }

  /**
   * The list under the two cells. Pro shows PRO_FEATURES, each tagged
   * (Paid) so the boundary is unmissable; Lite shows what it genuinely does,
   * untagged, because all of that is free.
   */
  private renderFeatureList(container: HTMLElement, which: 'lite' | 'pro'): void {
    container.empty();
    if (which === 'lite') {
      for (const line of LITE_DOES) {
        const row = container.createDiv({ cls: 'n2o-um-feature' });
        setIcon(row.createDiv({ cls: 'n2o-um-feature-icon' }), 'check');
        const text = row.createDiv({ cls: 'n2o-um-feature-text' });
        text.createDiv({
          cls: 'n2o-um-feature-detail',
          text: line.replace('{pages}', String(LITE_PAGE_LIMIT)),
        });
      }
      return;
    }
    // Four, not six. Six is more than anybody reads before a decision; the two
    // left out are colours/covers and Bases, which sell least on their own.
    for (const f of PRO_FEATURES) {
      const row = container.createDiv({ cls: 'n2o-um-feature' });
      setIcon(row.createDiv({ cls: 'n2o-um-feature-icon' }), f.icon);
      const text = row.createDiv({ cls: 'n2o-um-feature-text' });
      const title = text.createDiv({ cls: 'n2o-um-feature-title', text: f.title });
      if (f.paidOnly) title.createSpan({ cls: 'n2o-um-feature-paid', text: '(Paid)' });
      text.createDiv({ cls: 'n2o-um-feature-detail', text: f.detail });
    }
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

  private async runInstall(
    installBtn: HTMLButtonElement,
    // The button holds an icon span beside the words, so progress writes to the
    // LABEL. Writing to the button would replace the icon with the text.
    label: HTMLElement,
    statusEl: HTMLElement,
  ): Promise<void> {
    if (this.installing) return;
    this.installing = true;
    installBtn.disabled = true;
    label.textContent = 'Installing...';
    statusEl.setCssStyles({ display: 'block' });
    statusEl.setCssStyles({ color: 'var(--text-muted)' });

    try {
      const result = await this.deps.install((message) => {
        statusEl.setText(message);
      });
      statusEl.setCssStyles({ color: 'var(--text-success)' });
      statusEl.setText(
        result.enabled
          ? 'N2O Sync Pro installed and enabled.'
          : 'N2O Sync Pro installed. Enable "N2O Sync" under Settings, then Community plugins.',
      );
      label.textContent = 'Installed';
    } catch (err) {
      // Persistent inline failure with the real reason + a Retry.
      statusEl.setCssStyles({ color: 'var(--text-error)' });
      statusEl.setText(getErrorMessage(err));
      installBtn.disabled = false;
      label.textContent = 'Retry install';
    } finally {
      this.installing = false;
    }
  }
}
