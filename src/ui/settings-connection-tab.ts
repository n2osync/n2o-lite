/**
 * Settings Tab - Connection tab renderer.
 *
 * Handles OAuth connection, manual token, and the setup wizard.
 */

import { Setting, Notice } from 'obsidian';
import type { SettingsTabContext } from './settings-helpers';
import { getActiveProfile } from '../domain/models/config-schema';
import { NOTICE_MEDIUM, NOTICE_ERROR } from '../shared/constants';

/** Render the Connection tab into the given container. */
export function renderConnectionTab(container: HTMLElement, ctx: SettingsTabContext): void {
  const profile = getActiveProfile(ctx.plugin.settings);
  const hasToken = !!profile.notionToken;
  const isOAuth = profile.authType === 'oauth';

  // ── Connection Cockpit ──
  const cockpit = container.createDiv({ cls: 'n2o-connection-hub' });

  // Top row: status dot + workspace name
  const cockpitHeader = cockpit.createDiv({ cls: 'n2o-connection-hub-header' });
  const cockpitLeft = cockpitHeader.createDiv({ cls: 'n2o-connection-hub-left' });
  cockpitLeft.createSpan({
    cls: `n2o-connection-hub-dot ${hasToken ? 'is-connected' : 'is-disconnected'}`,
  });
  const workspaceName = hasToken
    ? (profile.workspaceName ?? ctx.plugin.cachedWorkspaceName ?? 'Notion Workspace')
    : 'Not Connected';
  cockpitLeft.createSpan({ cls: 'n2o-connection-hub-workspace', text: workspaceName });

  // Subtitle: auth method + stats
  if (hasToken) {
    const authLabel = isOAuth ? 'OAuth' : 'API Token';
    let statsLine = `Connected via ${authLabel}`;
    try {
      const cache = ctx.plugin.getDatabase().getPageCacheStore();
      const total = cache.count();
      const dbs = cache.getAllDatabases().length;
      if (total > 0) {
        statsLine += ` \u00B7 ${total.toLocaleString()} pages \u00B7 ${dbs} databases`;
      }
    } catch {
      /* DB not ready */
    }
    cockpit.createDiv({ cls: 'n2o-connection-hub-subtitle', text: statsLine });
  } else {
    cockpit.createDiv({
      cls: 'n2o-connection-hub-subtitle',
      text: 'Connect below using OAuth or an API token',
    });
  }

  // Profile bar (separated by dashed line)
  const profileBar = cockpit.createDiv({ cls: 'n2o-connection-hub-profile' });
  profileBar.createSpan({
    cls: 'n2o-connection-hub-profile-label',
    text: `Profile: ${profile.name}`,
  });
  const profileActions = profileBar.createDiv({ cls: 'n2o-connection-hub-profile-actions' });
  // Switch / New profile buttons are hidden until multi-workspace profiles ship.
  // Both only fired a "coming soon" Notice, which is a dead-end affordance in the
  // live product (#1541). Re-add them when the profile feature lands (epic #1455).
  if (hasToken) {
    const disconnectLink = profileActions.createEl('button', {
      text: 'Disconnect',
      cls: 'n2o-connection-hub-btn n2o-connection-hub-disconnect',
    });
    disconnectLink.addEventListener('click', () => {
      void (async () => {
        if (isOAuth) {
          const { disconnectOAuth } = await import('../plugin/connection-manager');
          await disconnectOAuth(ctx.plugin);
        } else {
          profile.notionToken = '';
          await ctx.plugin.saveSettings();
          ctx.plugin.getNotionClient().setToken('');
          new Notice('N2O: Disconnected.');
        }
        ctx.display();
      })();
    });
  }

  if (isOAuth && hasToken) {
    // ── OAuth Connection (group card) ──
    const oauthGroup = container.createDiv({ cls: 'n2o-settings-group' });
    oauthGroup.createDiv({ cls: 'n2o-settings-group-title', text: 'OAuth Connection' });
    oauthGroup.createDiv({
      cls: 'n2o-settings-group-desc',
      text: 'Sign in via your browser - N2O manages your token automatically. No manual copying needed.',
    });

    oauthGroup.createDiv({ cls: 'n2o-connection-status' });

    new Setting(oauthGroup)
      .setName('Notion connection')
      .setDesc('Connected via OAuth')
      .addButton((btn) =>
        btn
          .setButtonText('Disconnect')
          .setWarning()
          .onClick(async () => {
            await ctx.plugin.disconnectOAuth();
            ctx.display();
          }),
      );
  }

  if (!isOAuth || !hasToken) {
    // ── OAuth Quick Connect (when not on OAuth) ──
    const oauthAltGroup = container.createDiv({ cls: 'n2o-settings-group' });
    oauthAltGroup.createDiv({ cls: 'n2o-settings-group-title', text: 'OAuth Connection' });
    oauthAltGroup.createDiv({
      cls: 'n2o-settings-group-desc',
      text: 'Sign in via your browser - N2O manages your token automatically. No manual copying needed.',
    });

    /**
     * Starts in the panel, not here (#2040).
     *
     * This button used to call `startOAuthFlow` directly, which opens the
     * browser and then leaves the person on a settings page with nowhere to
     * come back to. That was survivable while the browser handed off through
     * `obsidian://` on its own; on Obsidian 1.13 that hand-off raises a
     * confirmation dialog people decline, and the fallback is a code they have
     * to paste somewhere. There is exactly one place with a field for it, the
     * connect panel, so this sends them there rather than growing a second
     * paste field on a screen that would then have to be kept in step with the
     * first (`avoiding-drift.md` #1).
     */
    new Setting(oauthAltGroup)
      .setName('Connect via OAuth')
      .setDesc('Opens the N2O panel, where you sign in through your browser')
      .addButton((btn) =>
        btn
          .setButtonText('Connect to Notion')
          .setCta()
          .onClick(() => {
            void ctx.plugin.getDashboardManager().openDashboard();
          }),
      );
  }

  // ── Manual Token (always visible) ──
  const manualGroup = container.createDiv({ cls: 'n2o-settings-group' });
  manualGroup.createDiv({ cls: 'n2o-settings-group-title', text: 'Manual Connection' });
  manualGroup.createDiv({
    cls: 'n2o-settings-group-desc',
    text: 'Connect with a Notion Internal Integration Token. Create an integration at notion.so/my-integrations, copy the token (starts with ntn_), and paste it below. You also need to share your Notion pages with the integration.',
  });

  const tokenWarningEl = manualGroup.createDiv({ cls: 'n2o-token-warning' });
  tokenWarningEl.setCssStyles({ color: 'var(--text-error)' });
  tokenWarningEl.setCssStyles({ fontSize: '12px' });
  tokenWarningEl.setCssStyles({ marginBottom: '8px' });

  const showTokenWarning = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed && !trimmed.startsWith('ntn_')) {
      tokenWarningEl.setText(
        'Token should start with "ntn_". Check that you copied the full token from notion.so/my-integrations.',
      );
    } else {
      tokenWarningEl.empty();
    }
  };

  let manualTokenValue = isOAuth ? '' : profile.notionToken;
  showTokenWarning(manualTokenValue);

  const manualStatusEl = manualGroup.createDiv({ cls: 'n2o-connection-status' });

  const isManualConnected = !isOAuth && hasToken;

  new Setting(manualGroup)
    .setName('Notion API token')
    .setDesc('From notion.so/my-integrations')
    .addText((text) => {
      text
        .setPlaceholder('ntn_...')
        .setValue(manualTokenValue)
        .onChange((value) => {
          manualTokenValue = value;
          showTokenWarning(value);
        });
      text.inputEl.type = 'password';
      text.inputEl.setCssStyles({ width: '300px' });
    })
    .addButton((btn) => {
      if (isManualConnected) {
        // Connected: show Disconnect, hide Connect
        btn
          .setButtonText('Disconnect')
          .setWarning()
          .onClick(async () => {
            profile.notionToken = '';
            await ctx.plugin.saveSettings();
            ctx.plugin.getNotionClient().setToken('');
            new Notice('N2O: Disconnected.');
            ctx.display();
          });
      } else {
        // Not connected: show Connect
        btn
          .setButtonText('Connect to Notion')
          .setCta()
          .onClick(async () => {
            if (!manualTokenValue.trim()) {
              manualStatusEl.setText('Please enter a token first.');
              manualStatusEl.setCssStyles({ color: 'var(--text-error)' });
              return;
            }
            btn.setButtonText('Connecting...');
            btn.setDisabled(true);
            manualStatusEl.empty();
            const originalToken = profile.notionToken;
            const originalAuth = profile.authType;
            try {
              profile.notionToken = manualTokenValue;
              profile.authType = 'internal';
              const result = await ctx.plugin.testConnection();
              if (result.success) {
                await ctx.plugin.saveSettings();
                manualStatusEl.setText(result.detail);
                manualStatusEl.setCssStyles({ color: 'var(--text-success)' });
                new Notice(`N2O: ${result.detail}`, NOTICE_MEDIUM);
                ctx.display();
              } else {
                profile.notionToken = originalToken;
                profile.authType = originalAuth;
                manualStatusEl.setText(result.detail);
                manualStatusEl.setCssStyles({ color: 'var(--text-error)' });
                new Notice(`N2O: ${result.detail}`, NOTICE_ERROR);
              }
            } catch {
              profile.notionToken = originalToken;
              profile.authType = originalAuth;
              manualStatusEl.setText('Connection failed unexpectedly.');
              manualStatusEl.setCssStyles({ color: 'var(--text-error)' });
            } finally {
              btn.setButtonText('Connect');
              btn.setDisabled(false);
            }
          });
      }
    });

  // ── About N2O Sync Lite ──
  const aboutGroup = container.createDiv({ cls: 'n2o-settings-group' });
  aboutGroup.createDiv({ cls: 'n2o-settings-group-title', text: 'About N2O Sync Lite' });
  const aboutText = aboutGroup.createDiv({ cls: 'setting-item-description' });
  aboutText.appendText(
    'N2O Sync Lite syncs one way, Notion to Obsidian, up to 100 pages. It is no longer ' +
      'being developed and has no date for its next update, so N2O Sync Pro is the one to ' +
      'install. ',
  );
  const aboutLink = aboutText.createEl('a', { text: 'n2osync.com', href: 'https://n2osync.com' });
  aboutLink.setAttribute('target', '_blank');
}
