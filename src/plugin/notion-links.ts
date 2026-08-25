/**
 * Notion link opening - resolve a note's Notion URL from its frontmatter or
 * its sync record and open it in the external browser.
 *
 * Extracted from main.ts to keep the plugin class a composition root.
 */

import { Notice } from 'obsidian';
import { openExternalUrl } from '../shared/electron-cookies';
import { notionPageUrl } from '../shared/sanitize';
import type { VaultAdapter } from '../infrastructure/obsidian/vault';
import type { SyncStateDB } from '../infrastructure/storage/sync-state';

/** The slice of the plugin these helpers need. Both getters may return
 *  undefined before the corresponding components are wired. */
export interface NotionLinkHost {
  getVaultAdapter(): VaultAdapter | undefined;
  getSyncState(): SyncStateDB | undefined;
}

/** Open Notion page URL from a file's frontmatter `notion_url` field. */
export function viewInNotionFromFrontmatter(host: NotionLinkHost, path: string): void {
  const fm = host.getVaultAdapter()?.getFrontmatter(path);
  const notionUrl = typeof fm?.notion_url === 'string' ? fm.notion_url : '';
  if (notionUrl && /^https?:\/\//i.test(notionUrl)) {
    openExternalUrl(notionUrl);
  } else {
    new Notice("N2O: No valid Notion URL found in this file's frontmatter.");
  }
}

/** Open the Notion page linked to a file via its sync record. */
export async function openInNotion(host: NotionLinkHost, path: string): Promise<void> {
  const syncState = host.getSyncState();
  if (!syncState) return;
  const record = syncState.getByObsidianPath(path);
  if (record) {
    const url = notionPageUrl(record.notionId);
    openExternalUrl(url);
  } else {
    new Notice('N2O: This file is not synced with Notion');
  }
}
