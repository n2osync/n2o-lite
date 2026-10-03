/**
 * ConflictManager - what N2O writes when Notion and Obsidian disagree.
 *
 * Two surfaces, for two different moments:
 * - `writeConflictFile` is the sync path. Both sides changed, so the local file
 *   is left alone and Notion's version is written beside it (#1919).
 * - `createConflictNote` is the explicit-overwrite path. The user asked to
 *   replace local with Notion, so the discarded local version is preserved.
 */

import type { VaultAdapter } from '../../infrastructure/obsidian/vault';
import { getErrorMessage } from '../../shared/errors';
import { hashContentForChange } from '../../shared/hash';
import { createLogger } from '../../shared/logger';

const log = createLogger('ConflictManager');

export interface LocalBackupParams {
  title: string;
  vaultPath: string;
  /** The local version that is about to be replaced. This is what gets saved. */
  localContent: string;
  /** Notion's version. Used only to skip the backup when the two are identical. */
  notionContent: string;
}

export interface ConflictFileParams {
  title: string;
  vaultPath: string;
  /** Notion's rendered markdown, frontmatter included - it is stripped here. */
  notionContent: string;
}

/**
 * Same shape as the parser's frontmatter matcher, kept separate on purpose.
 *
 * `ObsidianParser.splitFrontmatter` PARSES the YAML and throws on corruption by
 * design (#1507), which is right for the push pipeline and wrong here: writing
 * the conflict file is the one thing standing between a user and a lost edit, so
 * it must not be able to fail on a malformed key it does not even read.
 */
const LEADING_FRONTMATTER = /^---\n[\s\S]*?\n---(?:\n|$)/;

/**
 * Drop the leading frontmatter block from Notion's rendered markdown.
 *
 * Not cosmetic. `VaultAdapter.resolveFileByNotionId` indexes every markdown file
 * carrying a `notion_id` key, and `vault-scanner` adopts files the same way. A
 * conflict file that kept its frontmatter would put a second file with the same
 * notion_id in the vault, and either could then resolve as the page's real file.
 */
function stripFrontmatter(markdown: string): string {
  return markdown.replace(LEADING_FRONTMATTER, '').trimStart();
}

export class ConflictManager {
  constructor(private vaultAdapter: VaultAdapter) {}

  /**
   * Write Notion's version beside a file that changed on both sides, and leave
   * the local file alone.
   *
   * Lite does not merge (#1919). When a sync finds a page edited in Notion AND in
   * Obsidian, the local file is never written; Notion's version lands at
   * `<name>.conflict.md` and the user decides what to keep.
   *
   * The filename carries no timestamp. An unresolved conflict is re-detected on
   * every sync, and a timestamp would drop a fresh copy into the vault each run;
   * a fixed name means repeated syncs keep overwriting the same file.
   *
   * @returns the path written, or null if the write failed. A failure is safe -
   *   the local file is untouched either way - but the caller must report it,
   *   because the user is then left with no copy of Notion's version.
   */
  async writeConflictFile(params: ConflictFileParams): Promise<string | null> {
    const conflictPath = `${params.vaultPath.replace(/\.md$/, '')}.conflict.md`;
    const today = new Date().toISOString().split('T')[0];

    const content = [
      '> [!warning] Conflict - N2O Sync Lite did not touch your file',
      `> "${params.title}" changed in Notion and in Obsidian since the last sync.`,
      `> Your version at \`${params.vaultPath}\` was left exactly as it was.`,
      `> Below is Notion's version as of ${today}. Copy across whatever you want,`,
      '> then delete this file. Syncing again while the conflict stands rewrites it.',
      '',
      stripFrontmatter(params.notionContent),
      '',
    ].join('\n');

    try {
      await this.vaultAdapter.ensureFolder(conflictPath);
      await this.vaultAdapter.writeFile(conflictPath, content);
      log.info(`Conflict: wrote Notion's version to ${conflictPath}`);
      return conflictPath;
    } catch (error) {
      log.error(
        `Failed to write conflict file for "${params.title}" at ${conflictPath}: ${getErrorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * Save the local version that "Overwrite from Notion" is about to replace.
   *
   * Named `.backup-<time>.md`, NOT `.conflict-*.md`. The sync path writes
   * `<name>.conflict.md` and means "your file is untouched, here is Notion's";
   * this means the opposite, "your file was replaced, here is what it said".
   * Two near-identical names for opposite outcomes is a trap for someone trying
   * to work out which file is theirs (#1926).
   *
   * @returns whether the local content is now safe on disk. TRUE means saved, or
   *   there was nothing to save because the two sides are identical. FALSE means
   *   nothing was written and the caller MUST NOT overwrite.
   *
   *   The return value is the whole point. This used to return void and swallow
   *   its own failure, so the caller's backup-then-skip ladder was unreachable
   *   for the exact failure it was written for and the file was overwritten
   *   anyway. Do not re-swallow it.
   */
  async writeLocalBackup(params: LocalBackupParams, enabled: boolean): Promise<boolean> {
    // The caller falls back to a plain timestamped copy, so "off" is not "no
    // backup" - it just means the reader-friendly note is not wanted.
    if (!enabled) return false;

    // Identical content: nothing is being discarded, so the caller is safe.
    if (hashContentForChange(params.notionContent) === hashContentForChange(params.localContent)) {
      return true;
    }

    try {
      // Build the path by appending the suffix. replace(/\.md$/) would be a no-op
      // (and overwrite the ORIGINAL file) for a path that did not end in .md, so
      // construct it explicitly - the result always differs (#1469).
      const backupPath = `${params.vaultPath.replace(/\.md$/, '')}.backup-${Date.now()}.md`;
      const now = new Date().toISOString();

      const content = [
        '---',
        `backup_date: "${now}"`,
        `original_file: "${params.vaultPath}"`,
        '---',
        '',
        `# Backup: ${params.title}`,
        '',
        `> You ran "Overwrite from Notion" on ${now.split('T')[0]}, which replaced this`,
        `> note with Notion's version. Below is what your copy said beforehand.`,
        '',
        '## Your version',
        '',
        '````markdown',
        params.localContent,
        '````',
        '',
      ].join('\n');

      await this.vaultAdapter.ensureFolder(backupPath);
      await this.vaultAdapter.writeFile(backupPath, content);
      log.info(`Saved local version before overwrite: ${backupPath}`);
      return true;
    } catch (error) {
      const msg = getErrorMessage(error);
      log.warn(`Could not save the local version of "${params.title}": ${msg}`);
      return false;
    }
  }
}
