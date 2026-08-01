/**
 * The welcome note written into the sync folder on the first successful sync
 * (#1973).
 *
 * A note rather than a modal, deliberately. It survives, it is searchable, the
 * user can keep or delete it, and it costs no attention if they are busy. The
 * first sync is the point of highest interest and it used to end in silence: a
 * folder of Markdown appeared and nothing said what it was, what Lite does not
 * do, or that a paid edition exists.
 *
 * Three rules it must not break:
 *
 * - **First sync only.** The README promises Lite does not nag. Rewriting this
 *   every sync would make that false.
 * - **Never overwrite.** If the file exists, leave it. Someone who deleted it or
 *   wrote their own note in that spot keeps what they have.
 * - **It costs no page budget.** It is not a Notion page and must never be
 *   counted against the 100-page limit (#1918), which it cannot be, because it
 *   never goes near syncPage.
 *
 * The paid-edition copy comes from shared/pro-features.ts, so this, the settings
 * section and the upgrade modal cannot disagree with each other or the README.
 *
 * @module
 */

import type { VaultAdapter } from '../../infrastructure/obsidian/vault';
import { PRO_FEATURES } from '../../shared/pro-features';
import { LITE_PAGE_LIMIT } from './page-budget';
import { getErrorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/logger';

const log = createLogger('WelcomeNote');

export const WELCOME_NOTE_NAME = 'Welcome to N2O Sync Lite.md';

/**
 * The note's body. Pure function of the shared feature list, so it is testable
 * without a vault and cannot drift from the other surfaces.
 */
export function buildWelcomeNote(syncFolder: string, pagesSynced: number): string {
  const proLines = PRO_FEATURES.map((f) => `- **${f.title}.** ${f.detail}`).join('\n');

  return [
    '# Welcome, and thank you',
    '',
    'You just pulled your first pages out of Notion. They are plain Markdown in',
    `\`${syncFolder}\`, they are yours, and they work with or without this plugin.`,
    '',
    `This sync brought across ${pagesSynced} ${pagesSynced === 1 ? 'page' : 'pages'}.`,
    '',
    '## What you are looking at',
    '',
    'Every synced note keeps a small block of frontmatter at the top. That is how',
    'N2O recognises the note next time, so it can update it instead of making a',
    'duplicate. Database properties become frontmatter fields you can search and',
    'sort on. Images, PDFs and attachments are downloaded into `_files/` next to',
    "the note, because Notion's own file links expire after about an hour.",
    '',
    'Re-run the sync whenever you want. Nothing runs on its own.',
    '',
    '## What this free edition does not do',
    '',
    'Said plainly, so none of it surprises you later:',
    '',
    '- **One direction.** Notion to Obsidian. Edits you make in Obsidian stay in',
    '  Obsidian and are never written back to Notion.',
    `- **Up to ${LITE_PAGE_LIMIT} notes per vault.** Every note counts, including the`,
    '  rows of a database. Notes you have already synced keep syncing even if you',
    '  are above the limit.',
    '- **No colours, covers or page icons.** Notes take your Obsidian theme instead.',
    '- **Nothing is merged for you.** If you edit a note here and the same page',
    "  changes in Notion, your file is left exactly as it is and Notion's version is",
    '  saved beside it as `<name>.conflict.md`, so you can compare and keep what you',
    '  want. Your work is never overwritten without a copy being saved first.',
    '',
    '## What the full edition adds',
    '',
    proLines,
    '',
    'There is a 14-day trial, no card needed, and you can start it from the N2O',
    'panel or from Settings. Lite keeps working either way.',
    '',
    '---',
    '',
    'You can delete this note. It is written once, on your first sync, and never',
    'again.',
    '',
  ].join('\n');
}

/**
 * Write the welcome note, once, if it is not already there.
 *
 * Never throws: failing to write a welcome note must not turn a successful sync
 * into a failed one. Returns whether it was written, so the caller can record
 * that it happened and not try again.
 */
export async function writeWelcomeNote(
  vaultAdapter: VaultAdapter,
  syncFolder: string,
  pagesSynced: number,
): Promise<boolean> {
  const path = `${syncFolder}/${WELCOME_NOTE_NAME}`;
  try {
    // Never clobber. Someone who deleted this, or wrote their own note at this
    // path, keeps what they have.
    if ((await vaultAdapter.readFile(path)) !== null) {
      log.info(`Welcome note already present at ${path}, leaving it alone`);
      return false;
    }
    await vaultAdapter.ensureFolder(path);
    await vaultAdapter.writeFile(path, buildWelcomeNote(syncFolder, pagesSynced));
    log.info(`Wrote welcome note to ${path}`);
    return true;
  } catch (err) {
    log.warn(`Could not write the welcome note at ${path}: ${getErrorMessage(err)}`);
    return false;
  }
}
