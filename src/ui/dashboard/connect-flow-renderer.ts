/**
 * ConnectFlowRenderer - extracted from DashboardView (P1 #18).
 *
 * Owns the entire "not connected" sub-state machine: hero / OAuth
 * preflight / OAuth waiting / manual token / success celebration.
 * All connect-related state (11 fields), polling timers, and render
 * methods live here so dashboard.ts can stop being a 2300-line god
 * view.
 *
 * The host interface (ConnectFlowHost) is intentionally narrow: just
 * the dashboard callbacks bridge, an `expandedSections` set shared
 * for collapsible-state persistence, and two render hooks (refresh
 * for a full data fetch + re-render, render for a re-render with
 * existing data). Anything else stays inside this class.
 */

import { setIcon } from 'obsidian';
import type { DashboardData, DashboardCallbacks } from '../dashboard-types';
import { getErrorMessage } from '../../shared/errors';
import { openExternalUrl } from '../../shared/electron-cookies';

export type ConnectStep = 'hero' | 'oauth-waiting' | 'manual-token' | 'success';

/**
 * How long the waiting screen stays up before it gives up on the browser.
 *
 * Ten minutes, matching the server's parked-token TTL exactly. It used to be
 * two, which was sized for a hand-off that took a second: the browser fired an
 * `obsidian://` URL and the plugin redeemed it immediately. The paste-a-code
 * flow puts a PERSON in that window (#2040), reading ten characters, switching
 * applications and typing them, and two minutes is enough for that only if
 * nothing interrupts them. Bouncing somebody back to the start while they are
 * mid-paste, with a code that is still perfectly valid server-side, is a
 * countdown inventing a failure that had not happened.
 *
 * Longer than the server allows would be the opposite mistake: a screen still
 * hopefully counting down over a code the server threw away minutes ago. The
 * two numbers are the same number for that reason, and changing one means
 * changing `TOKEN_TTL_SECONDS` in the portal's `lib/oauth/sessions.ts`.
 */
const OAUTH_WINDOW_SECONDS = 600;

/**
 * Minimal contract the connect-flow renderer needs from its host
 * (DashboardView). Keep this surface small - every method here is a
 * coupling point that has to be honored on every render path.
 */
export interface ConnectFlowHost {
  /**
   * Persisted across re-renders so the manual-token "How do I get a
   * token?" details element remembers its open state. Shared with
   * other dashboard renderers (e.g. hybrid scope-items details).
   */
  expandedSections: Set<string>;
  /** Plugin callbacks - null until plugin is attached in onOpen. */
  getCallbacks(): DashboardCallbacks | null;
  /** Trigger a full dashboard data refresh + re-render. */
  refresh(): Promise<void>;
  /** Trigger a dashboard re-render against existing data. */
  render(): void;
}

export class ConnectFlowRenderer {
  // ── Inline connect flow state (formerly on DashboardView) ──
  private connectStep: ConnectStep = 'hero';
  private oauthPollInterval: number | null = null;
  private oauthSuccessTimer: number | null = null;
  /**
   * Pre-flight timer for the OAuth browser launch. We render the
   * "Approve in Notion" waiting screen FIRST and only open the
   * browser ~3.5s later, so the user reads the explanation before
   * the browser steals focus. Cancel clears this timer to abort.
   */
  private oauthPreflightTimer: number | null = null;
  private oauthPreflightActive = false;
  private oauthSecondsLeft = OAUTH_WINDOW_SECONDS;
  private oauthCountdownEl: HTMLElement | null = null;
  private tokenInputValue = '';
  private tokenErrorText: string | null = null;
  private tokenSubmitting = false;
  /** The code from the browser page, as typed (#2040). Canonicalised on submit. */
  private codeInputValue = '';
  private codeErrorText: string | null = null;
  private codeSubmitting = false;
  /** Error banner shown on hero (e.g. after OAuth timeout). Reset on re-entry from hero CTA. */
  private connectBannerText: string | null = null;

  constructor(private host: ConnectFlowHost) {}

  /** Current sub-state. The dashboard's render() reads this to decide whether to show the connect flow vs the hybrid view. */
  get step(): ConnectStep {
    return this.connectStep;
  }

  /** Stop all timers + null DOM refs. Called from DashboardView.onClose. */
  cleanup(): void {
    this.stopOAuthPoll();
    if (this.oauthSuccessTimer) {
      window.clearTimeout(this.oauthSuccessTimer);
      this.oauthSuccessTimer = null;
    }
    if (this.oauthPreflightTimer) {
      window.clearTimeout(this.oauthPreflightTimer);
      this.oauthPreflightTimer = null;
    }
    this.oauthPreflightActive = false;
    this.oauthCountdownEl = null;
  }

  /**
   * Show an OAuth/connection error on the connect flow's hero. Called
   * directly by the plugin's protocol handler so the user sees the
   * failure reason immediately - no waiting for the 1s poll tick.
   */
  showError(message: string): void {
    this.stopOAuthPoll();
    if (this.oauthSuccessTimer) {
      window.clearTimeout(this.oauthSuccessTimer);
      this.oauthSuccessTimer = null;
    }
    this.connectBannerText = `Connection failed: ${message} Try again or use a manual token.`;
    // Short-circuit any in-flight success state too.
    if (this.connectStep === 'success') {
      this.connectStep = 'hero';
    }
    this.setStep('hero');
    // setStep is a no-op if we were already on 'hero'; force a render.
    if (this.connectStep === 'hero') {
      this.host.render();
    }
  }

  /**
   * Top-level render. The dashboard calls this when shouldShowOnboarding
   * returns true. Hero / waiting / success share renderConnectHero and
   * only the CTA area morphs; manual-token is a dedicated form sub-screen.
   */
  render(container: HTMLElement, d: DashboardData): void {
    const root = container.createDiv({ cls: `n2o-dash-notconn is-step-${this.connectStep}` });
    if (this.connectStep === 'manual-token') {
      this.renderManualToken(root);
    } else {
      this.renderHero(root, d);
    }
  }

  // ── Internals ──────────────────────────────────────────────

  /** Transition to a new sub-state. Clears timers/transient errors as appropriate. Re-renders. */
  private setStep(step: ConnectStep): void {
    if (this.connectStep === step) return;
    // Leaving oauth-waiting: stop polling/countdown AND cancel any
    // pending pre-flight browser launch. If the user clicks Cancel
    // during the 3.5s pre-flight window, we never open the browser.
    if (this.connectStep === 'oauth-waiting' && step !== 'oauth-waiting') {
      this.stopOAuthPoll();
      if (this.oauthPreflightTimer) {
        window.clearTimeout(this.oauthPreflightTimer);
        this.oauthPreflightTimer = null;
      }
      this.oauthPreflightActive = false;
      // The code and any complaint about it belong to this attempt only.
      this.codeErrorText = null;
      this.codeInputValue = '';
    }
    // Leaving manual-token: clear transient error
    if (this.connectStep === 'manual-token' && step !== 'manual-token') {
      this.tokenErrorText = null;
    }
    this.connectStep = step;
    this.host.render();
  }

  /**
   * Unified connect hero. The hero panel (pill + display title + body
   * + WhatYouGet + trial note) stays visible across hero /
   * oauth-waiting / success; only the CTA area morphs.
   */
  private renderHero(root: HTMLElement, d: DashboardData): void {
    const step = this.connectStep === 'manual-token' ? 'hero' : this.connectStep;
    this.renderStatePill(root, step);

    if (this.connectStep === 'oauth-waiting') {
      this.renderWaitingTitle(root);
      this.renderAction(root, d);
      return;
    }

    this.renderDisplayTitle(root);

    root.createDiv({
      cls: 'n2o-dash-notconn-body',
      text: 'Pull your Notion pages into this vault as markdown, with media and database pages.',
    });

    if (this.connectBannerText) {
      root.createDiv({ cls: 'n2o-dash-connect-banner', text: this.connectBannerText });
    }

    this.renderAction(root, d);
    this.renderOfferCard(root);
    this.renderTrialNote(root);
  }

  /**
   * Headline + body shown during oauth-waiting. Body copy switches
   * between pre-flight ("Opening Notion in your browser in a moment...")
   * and post-launch ("Notion is open in your browser...") so the
   * OAuth tab doesn't pop up unannounced.
   */
  private renderWaitingTitle(root: HTMLElement): void {
    const title = root.createDiv({ cls: 'n2o-dash-display-title n2o-dash-waiting-title' });
    title.createSpan({ text: 'Approve in ' });
    title.createEl('em', { cls: 'n2o-dash-display-accent', text: 'Notion' });
    title.createSpan({ text: '.' });

    const body = this.oauthPreflightActive
      ? "Opening Notion in your browser in a moment. Approve the connection there and you'll come back here automatically."
      : "Notion is open in your browser. Approve the connection there and you'll come back here automatically.";
    root.createDiv({ cls: 'n2o-dash-notconn-body', text: body });
  }

  /**
   * Morphing CTA. Three shapes share one slot:
   *   hero:          primary "Connect to Notion" + ghost token link
   *   oauth-waiting: disabled spinner button + cancel/timeout below
   *   success:       disabled checkmark button + auto-advance bar
   */
  private renderAction(root: HTMLElement, d: DashboardData): void {
    const cb = this.host.getCallbacks();
    if (!cb) return;

    if (this.connectStep === 'oauth-waiting') {
      const btn = root.createEl('button', {
        cls: 'n2o-dash-btn-primary mod-cta n2o-dash-notconn-cta is-loading',
      });
      btn.disabled = true;
      const spinner = btn.createDiv({ cls: 'n2o-spinner n2o-dash-connect-cta-spinner' });
      spinner.createSpan({ cls: 'n2o-spinner-dot' });
      spinner.createSpan({ cls: 'n2o-spinner-dot' });
      spinner.createSpan({ cls: 'n2o-spinner-dot' });
      btn.createSpan({ text: 'Connecting\u2026' });

      this.renderCodeEntry(root);

      // Cancel link on top, timeout below.
      const cancelRow = root.createDiv({ cls: 'n2o-dash-notconn-action-meta' });
      const cancelLink = cancelRow.createEl('a', {
        cls: 'n2o-dash-notconn-cancel-link',
        text: 'Cancel and go back',
        href: '#',
      });
      cancelLink.setAttribute('aria-label', 'Cancel Notion connection and return to the start');
      cancelLink.addEventListener('click', (e) => {
        e.preventDefault();
        this.setStep('hero');
      });

      const timeoutRow = root.createDiv({
        cls: 'n2o-dash-notconn-action-meta n2o-dash-notconn-timeout-row',
      });
      const countdown = timeoutRow.createSpan({ cls: 'n2o-dash-connect-countdown' });
      this.oauthCountdownEl = countdown;
      this.updateCountdownText();

      if (!this.oauthPollInterval) {
        this.startOAuthPoll();
      }
      return;
    }

    if (this.connectStep === 'success') {
      const btn = root.createEl('button', {
        cls: 'n2o-dash-btn-primary mod-cta n2o-dash-notconn-cta is-success',
      });
      btn.disabled = true;
      const check = btn.createSpan({ cls: 'n2o-dash-notconn-cta-check' });
      setIcon(check, 'check');
      btn.createSpan({
        text: d.workspaceName ? `Connected to ${d.workspaceName}` : 'Connected',
      });

      const bar = root.createDiv({ cls: 'n2o-dash-connect-advance' });
      bar.createDiv({ cls: 'n2o-dash-connect-advance-fill' });
      return;
    }

    // Default hero CTA
    const connectBtn = root.createEl('button', {
      cls: 'n2o-dash-btn-primary mod-cta n2o-dash-btn-icon n2o-dash-notconn-cta',
    });
    setIcon(connectBtn.createSpan(), 'link');
    connectBtn.createSpan({ text: 'Connect to Notion' });
    connectBtn.addEventListener('click', () => {
      this.connectBannerText = null;
      // Show "Approve in Notion" waiting screen FIRST, then open the
      // browser ~3.5s later so the OAuth tab doesn't pop up
      // unannounced. Cancel during the 3.5s window aborts the launch.
      this.oauthPreflightActive = true;
      this.setStep('oauth-waiting');
      this.oauthPreflightTimer = window.setTimeout(() => {
        this.oauthPreflightTimer = null;
        this.oauthPreflightActive = false;
        cb.onStartOAuth();
        this.host.render();
      }, 3500);
    });

    // Newsletter opt-in: unchecked by default, persisted immediately, and
    // sent to the server with the OAuth token exchange. The server
    // subscribes the account's email only when this is true.
    const optInRow = root.createDiv({ cls: 'n2o-dash-notconn-optin' });
    const optInLabel = optInRow.createEl('label', { cls: 'n2o-dash-notconn-optin-label' });
    const optInBox = optInLabel.createEl('input', { type: 'checkbox' });
    optInBox.checked = cb.getNewsletterOptIn();
    optInLabel.createSpan({ text: 'Email me occasional product updates (optional)' });
    optInBox.addEventListener('change', () => {
      cb.onSetNewsletterOptIn(optInBox.checked);
    });

    const ghost = root.createDiv({ cls: 'n2o-dash-notconn-ghost' });
    const ghostLink = ghost.createEl('a', {
      text: 'Use an internal integration token',
      href: '#',
    });
    ghostLink.addEventListener('click', (e) => {
      e.preventDefault();
      this.connectBannerText = null;
      this.setStep('manual-token');
    });
  }

  /**
   * The code from the browser page, and the field to put it in (#2040).
   *
   * The scenario: somebody on Obsidian 1.13 or later approves N2O at Notion and
   * the browser tries to hand off through `obsidian://`. Obsidian asks whether
   * they really want to open an external application, they decline a dialog they
   * did not expect in the middle of a login, and nothing else ever happens. The
   * plugin sits on this waiting screen forever, they see no error, and the
   * server holds tokens nobody collects.
   *
   * So the browser page now shows ten characters, and this is where they go. It
   * lives INSIDE the waiting screen rather than behind a link, because the
   * moment it is needed is the moment the person is looking at this screen with
   * the code already on their other monitor. The automatic hand-off still works
   * and still wins when it works; this is what is there when it does not.
   *
   * Same widgets as the manual-token form below, on purpose: one input, one
   * error line, one button, Enter submits.
   */
  private renderCodeEntry(root: HTMLElement): void {
    const wrap = root.createDiv({ cls: 'n2o-dash-connect-code' });
    wrap.createDiv({
      cls: 'n2o-dash-connect-sub',
      text: 'Did your browser show a code instead? Paste it here.',
    });

    /**
     * Declared before the input listener that enables it, because the listener
     * has to run on every keystroke and the button is created further down the
     * card. A re-render on each character would fight the caret.
     */
    let submitEl: HTMLButtonElement | null = null;

    const input = wrap.createEl('input', {
      cls: 'n2o-dash-token-input n2o-dash-code-input',
      attr: { type: 'text', placeholder: 'ABCDE-FGHJK', spellcheck: 'false' },
    });
    input.value = this.codeInputValue;
    input.addEventListener('input', () => {
      this.codeInputValue = input.value;
      if (submitEl) submitEl.disabled = this.codeSubmitting || !this.codeInputValue.trim();
      if (this.codeErrorText) {
        this.codeErrorText = null;
        const err = wrap.querySelector('.n2o-dash-token-error');
        if (err) err.remove();
      }
    });

    if (this.codeErrorText) {
      wrap.createDiv({ cls: 'n2o-dash-token-error', text: this.codeErrorText });
    }

    const submit = wrap.createEl('button', {
      cls: 'n2o-dash-btn-primary n2o-dash-token-submit',
    });
    submitEl = submit;
    submit.createSpan({ text: this.codeSubmitting ? 'Connecting\u2026' : 'Connect' });
    submit.disabled = this.codeSubmitting || !this.codeInputValue.trim();
    submit.addEventListener('click', () => void this.submitConnectCode());

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !submit.disabled) {
        e.preventDefault();
        void this.submitConnectCode();
      }
    });
  }

  /** Manual integration token paste form. */
  private renderManualToken(root: HTMLElement): void {
    this.renderBackLink(root, () => this.setStep('hero'), '\u2190 Back');

    root.createDiv({ cls: 'n2o-dash-connect-heading', text: 'Connect with a token' });
    root.createDiv({
      cls: 'n2o-dash-connect-sub',
      text: 'Paste your Internal Integration token below.',
    });

    const input = root.createEl('input', {
      cls: 'n2o-dash-token-input',
      attr: { type: 'password', placeholder: 'ntn_\u2026', spellcheck: 'false' },
    });
    input.value = this.tokenInputValue;
    input.addEventListener('input', () => {
      this.tokenInputValue = input.value;
      if (this.tokenErrorText) {
        this.tokenErrorText = null;
        const err = root.querySelector('.n2o-dash-token-error');
        if (err) err.remove();
      }
    });

    if (this.tokenErrorText) {
      root.createDiv({ cls: 'n2o-dash-token-error', text: this.tokenErrorText });
    }

    // Collapsible help
    const help = root.createEl('details', { cls: 'n2o-dash-token-help' });
    if (this.host.expandedSections.has('token-help')) help.setAttribute('open', '');
    help.addEventListener('toggle', () => {
      if (help.open) this.host.expandedSections.add('token-help');
      else this.host.expandedSections.delete('token-help');
    });
    help.createEl('summary', { text: 'How do I get a token?' });
    const steps = help.createDiv({ cls: 'n2o-dash-token-help-body' });
    const step1 = steps.createEl('p');
    step1.appendText('1. Go to ');
    const lnk = step1.createEl('a', { text: 'notion.so/my-integrations' });
    lnk.setAttribute('href', 'https://www.notion.so/my-integrations');
    lnk.setAttribute('target', '_blank');
    lnk.setAttribute('rel', 'noopener');
    step1.appendText(' and create a new integration.');
    steps.createEl('p', { text: '2. Copy the "Internal Integration Secret" (starts with ntn_).' });
    steps.createEl('p', { text: '3. In Notion, share your pages with the integration.' });

    // Connect button
    const submit = root.createEl('button', {
      cls: 'n2o-dash-btn-primary mod-cta n2o-dash-btn-icon n2o-dash-token-submit',
    });
    submit.createSpan({ text: this.tokenSubmitting ? 'Connecting\u2026' : 'Connect' });
    submit.disabled = this.tokenSubmitting || !this.tokenInputValue.trim();
    submit.addEventListener('click', () => void this.submitManualToken());

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !submit.disabled) {
        e.preventDefault();
        void this.submitManualToken();
      }
    });
  }

  // ── Shared connect-flow atoms ──────────────────────────────

  /** Status pill at the top of every connect step. */
  private renderStatePill(root: HTMLElement, step: 'hero' | 'oauth-waiting' | 'success'): void {
    const labels: Record<typeof step, string> = {
      hero: 'Not connected',
      'oauth-waiting': 'Connecting\u2026',
      success: 'Connected',
    };
    const pill = root.createDiv({ cls: `n2o-dash-notconn-pill is-${step}` });
    pill.createSpan({ cls: 'n2o-dash-notconn-pill-dot' });
    pill.createSpan({ text: labels[step] });
  }

  /** "Notion in, Obsidian out." display title. */
  private renderDisplayTitle(root: HTMLElement): void {
    const title = root.createDiv({ cls: 'n2o-dash-display-title' });
    title.createSpan({ text: 'Notion ' });
    title.createEl('em', { cls: 'n2o-dash-display-accent', text: 'in' });
    title.createSpan({ text: ',' });
    title.createEl('br');
    title.createSpan({ text: 'Obsidian ' });
    title.createEl('em', { cls: 'n2o-dash-display-accent', text: 'out' });
    title.createSpan({ text: '.' });
  }

  /**
   * The numbered card, carrying the offer rather than a description of Lite.
   * Three rows because the question people actually have is what happens on
   * day 15, and it answers it in the order it happens: trial, then free, then
   * what paying buys.
   */
  private renderOfferCard(root: HTMLElement): void {
    const card = root.createDiv({ cls: 'n2o-dash-whatyouget' });
    card.createDiv({ cls: 'n2o-dash-whatyouget-label', text: 'What you get with Pro' });
    const rows: Array<{ n: string; t: string; s: string }> = [
      { n: '01', t: 'Free for 14 days', s: 'The whole of N2O Sync Pro, 300 pages, no card.' },
      {
        n: '02',
        t: 'Then free, not locked',
        s: '100 pages, pull only. The same free you have here, on the edition we maintain.',
      },
      { n: '03', t: 'Or $8 a month', s: 'Everything, both ways, no page limit.' },
    ];
    for (const f of rows) {
      const row = card.createDiv({ cls: 'n2o-dash-feat-row' });
      row.createSpan({ cls: 'n2o-dash-feat-num', text: f.n });
      const body = row.createDiv({ cls: 'n2o-dash-feat-body' });
      body.createDiv({ cls: 'n2o-dash-feat-title', text: f.t });
      const sub = body.createDiv({ cls: 'n2o-dash-feat-sub', text: f.s });
      if (f.n !== '03') continue;
      sub.appendText(' ');
      const link = sub.createEl('a', {
        text: 'See the plans',
        href: 'https://n2osync.com/pricing',
      });
      link.addEventListener('click', (e) => {
        e.preventDefault();
        openExternalUrl('https://n2osync.com/pricing');
      });
    }
  }

  private renderTrialNote(root: HTMLElement): void {
    const footer = root.createDiv({ cls: 'n2o-dash-notconn-footer' });
    const info = footer.createSpan({ cls: 'n2o-dash-notconn-info' });
    setIcon(info.createSpan(), 'info');
    info.createSpan({
      text:
        'Lite is no longer developed. N2O Sync Pro does all of this free too, and it is ' +
        'the one that gets the fixes.',
    });
  }

  private renderBackLink(root: HTMLElement, onClick: () => void, label: string): void {
    const wrap = root.createDiv({ cls: 'n2o-dash-connect-back' });
    const link = wrap.createEl('a', { text: label, href: '#' });
    link.addEventListener('click', (e) => {
      e.preventDefault();
      onClick();
    });
  }

  // ── OAuth polling + success timer ──────────────────────────

  private startOAuthPoll(): void {
    this.oauthSecondsLeft = OAUTH_WINDOW_SECONDS;
    this.updateCountdownText();
    this.oauthPollInterval = window.setInterval(() => {
      this.oauthSecondsLeft--;
      this.updateCountdownText();
      if (this.oauthSecondsLeft <= 0) {
        this.stopOAuthPoll();
        this.connectBannerText =
          'The connection window closed before Notion came back. Start again, or use an internal integration token.';
        this.setStep('hero');
        return;
      }
      const state = this.host.getCallbacks()?.onPollConnectionState();
      if (state?.error) {
        this.stopOAuthPoll();
        this.connectBannerText = `Connection failed: ${state.error} Try again or use a manual token.`;
        this.setStep('hero');
        return;
      }
      if (state?.hasToken) {
        this.stopOAuthPoll();
        void this.handleSuccess();
      }
    }, 1000);
  }

  private stopOAuthPoll(): void {
    if (this.oauthPollInterval) {
      window.clearInterval(this.oauthPollInterval);
      this.oauthPollInterval = null;
    }
    this.oauthCountdownEl = null;
  }

  private updateCountdownText(): void {
    if (!this.oauthCountdownEl) return;
    const s = Math.max(0, this.oauthSecondsLeft);
    const min = Math.floor(s / 60);
    const sec = s % 60;
    this.oauthCountdownEl.textContent = `This code expires in ${min}:${sec.toString().padStart(2, '0')}`;
  }

  /** Called when a token has been accepted (OAuth poll OR manual validation). */
  private async handleSuccess(): Promise<void> {
    // Lock success step BEFORE refresh so the render dispatch guard keeps
    // us in success (not State 2) even though workspaceName is now populated.
    this.connectStep = 'success';
    this.connectBannerText = null;
    try {
      await this.host.refresh();
    } catch {
      /* refresh will have rendered error state if it failed */
    }

    // Auto-advance to State 2 after 2s celebration.
    if (this.oauthSuccessTimer) window.clearTimeout(this.oauthSuccessTimer);
    this.oauthSuccessTimer = window.setTimeout(() => {
      this.oauthSuccessTimer = null;
      this.connectStep = 'hero'; // reset for next time
      void this.host.refresh(); // falls through to State 2 (workspaceName is set)
    }, 2000);
  }

  /**
   * Exchange the pasted code, and say what went wrong if it did not work.
   *
   * The countdown keeps running underneath. A person can paste a code, get it
   * wrong by one character, and try again inside the same window without being
   * thrown back to the start, which is the whole reason the window is now as
   * long as the server's TTL.
   *
   * On success this walks the SAME celebration path the `obsidian://` callback
   * does, because by that point the two flows are the same connect.
   */
  private async submitConnectCode(): Promise<void> {
    if (this.codeSubmitting) return;
    const cb = this.host.getCallbacks();
    const raw = this.codeInputValue.trim();
    if (!raw || !cb) return;
    this.codeSubmitting = true;
    this.codeErrorText = null;
    this.host.render();
    try {
      const result = await cb.onSubmitConnectCode(raw);
      this.codeSubmitting = false;
      if (result.success) {
        this.stopOAuthPoll();
        this.codeInputValue = '';
        await this.handleSuccess();
      } else {
        this.codeErrorText = result.detail || 'That code was not accepted.';
        this.host.render();
      }
    } catch (e) {
      this.codeSubmitting = false;
      this.codeErrorText = getErrorMessage(e);
      this.host.render();
    }
  }

  private async submitManualToken(): Promise<void> {
    if (this.tokenSubmitting) return;
    const cb = this.host.getCallbacks();
    const raw = this.tokenInputValue.trim();
    if (!raw || !cb) return;
    this.tokenSubmitting = true;
    this.tokenErrorText = null;
    this.host.render();
    try {
      const result = await cb.onValidateManualToken(raw);
      if (result.success) {
        this.tokenSubmitting = false;
        await this.handleSuccess();
      } else {
        this.tokenSubmitting = false;
        this.tokenErrorText = result.detail || 'Token rejected.';
        this.host.render();
      }
    } catch (e) {
      this.tokenSubmitting = false;
      this.tokenErrorText = getErrorMessage(e);
      this.host.render();
    }
  }
}
