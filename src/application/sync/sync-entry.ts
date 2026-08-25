/**
 * Pull sync: single entry dispatcher.
 *
 * Extracted from pull-apply-phase.ts. The syncOneEntry function is the
 * branching brain of pull-sync: it detects unchanged entries, handles a page
 * that changed on both sides, and ultimately dispatches to syncDatabase or
 * syncPage. Error handling lives here too.
 *
 * @module
 */

import type { NotionPage, NotionBlock } from '../../domain/models/notion-api-types';
import type { PageRegistryEntry } from '../discovery/page-registry';
import type { SyncConfig } from '../../domain/models/sync-config';
import type { N2ODocument } from '../../domain/models/document';
import type { ApplyPhaseDeps } from './apply-phase-deps';
import type { SyncResultCounts, SyncResultItem } from './orchestrator';
import { syncPage, renderWithTemplate } from './sync-page';
import { LITE_PAGE_LIMIT } from './page-budget';
import { syncDatabase } from './sync-database';
import { enrichBreadcrumbBlocks } from '../../domain/services/breadcrumb-path';
import { notionPageUrl } from '../../shared/sanitize';
import { getErrorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/logger';
import { withRetry } from '../../shared/retry';
import { hashContentForChange } from '../../shared/hash';
import { RENDERER_VERSION } from '../../shared/renderer-version';
import { hasUnexhaustedRetries } from '../media/media-retry';

const log = createLogger('PullSync');

/**
 * Content-hash-authoritative sync decision. Pure function.
 *
 * Replaces the minute-granularity timestamp dispatch that produced
 * F-004, F-034, and a long list of same-minute-edit bugs.
 *
 * The four states are exhaustive and mutually exclusive:
 *   - skip -> both sides unchanged since last sync
 *   - pull -> Notion changed, local didn't; run syncPage with fresh data
 *   - local-only -> local changed, Notion didn't; record as local-change
 *   - merge -> both changed; leave the local file alone and write Notion's
 *              version beside it as `<name>.conflict.md` (#1919)
 *
 * Undefined stored hashes are treated as "unknown, always changed" - * fresh records with any stored hash always get a real comparison.
 */
export type SyncOutcome = 'skip' | 'pull' | 'local-only' | 'merge';

export function decideSyncOutcome(
  storedNotionHash: string | undefined,
  freshNotionHash: string,
  storedLocalHash: string | undefined,
  freshLocalHash: string,
): SyncOutcome {
  const notionChanged = storedNotionHash !== freshNotionHash;
  const localChanged = storedLocalHash !== freshLocalHash;
  if (!notionChanged && !localChanged) return 'skip';
  if (notionChanged && !localChanged) return 'pull';
  if (!notionChanged && localChanged) return 'local-only';
  return 'merge';
}

/**
 * Sync a single entry (page or database). Handles skip logic, conflict detection, and error handling.
 *
 * `options.authoritative` (v0.9.36): when true, bypass the
 * minute-granularity timestamp skip + tiebreaker and run the 4-way
 * truth table directly. Used by manual "Sync current file" so users
 * never see same-minute edits silently lost. Automation paths leave
 * this false to keep the cheap-skip optimization (see
 */
/**
 * Get the local version onto disk somewhere before an overwrite replaces it.
 *
 * Three rungs, in order: the reader-friendly backup note, then a plain
 * timestamped copy, then failure. Returns false ONLY when nothing could be
 * saved, and a false MUST stop the overwrite - that is the difference between
 * "your note was replaced, here is the old one" and losing the user's work.
 *
 * `writeLocalBackup` is awaited inside its own try/catch even though it already
 * returns false rather than throwing. That is not defensive padding: a test
 * mocks it to REJECT, and without this the rejection escapes into syncOneEntry's
 * outer catch and reports as a page-level sync failure instead of falling to the
 * next rung. Pro hit exactly that (#1921).
 */
async function preserveLocalBeforeOverwrite(
  entry: PageRegistryEntry,
  localContent: string,
  notionMarkdown: string,
  createConflictNotes: boolean,
  deps: ApplyPhaseDeps,
): Promise<boolean> {
  try {
    const saved = await deps.conflictManager.writeLocalBackup(
      {
        title: entry.title,
        vaultPath: entry.vaultPath,
        localContent,
        notionContent: notionMarkdown,
      },
      createConflictNotes,
    );
    if (saved) return true;
  } catch (err) {
    log.warn(`Backup note failed for "${entry.title}": ${getErrorMessage(err)}`);
  }

  // Second rung: a plain copy, no formatting, nothing that can go wrong beyond
  // the write itself.
  try {
    const backupPath = `${entry.vaultPath.replace(/\.md$/, '')}.backup-${Date.now()}.md`;
    await deps.vaultAdapter.writeFile(backupPath, localContent);
    log.info(`Local version saved to ${backupPath}`);
    deps.notify(`N2O: Your version of "${entry.title}" was saved to ${backupPath}.`, 8000);
    return true;
  } catch (err) {
    log.error(
      `CRITICAL: could not save the local version of "${entry.title}" (hash=${hashContentForChange(localContent)}): ${getErrorMessage(err)}. Skipping the overwrite so the file is not lost.`,
    );
    try {
      deps.notify(
        `N2O: Could not save a copy of "${entry.title}", so it was NOT overwritten. Check disk space and permissions.`,
        15000,
      );
    } catch {
      // A failed Notice must not turn a handled refusal into a crash.
    }
    return false;
  }
}

export async function syncOneEntry(
  entry: PageRegistryEntry,
  settings: SyncConfig,
  counts: SyncResultCounts,
  items: SyncResultItem[],
  errors: string[],
  deps: ApplyPhaseDeps,
  options?: { dryRun?: boolean; authoritative?: boolean },
): Promise<void> {
  try {
    // Check if page is unchanged (incremental sync)
    const existing = deps.syncState.getByNotionId(entry.notionId);

    // After inventory reconciliation, paths should be correct.
    // Quick existence check as safety net (for single-page sync where inventory didn't run).
    if (existing && !deps.vaultAdapter.fileExists(existing.obsidianPath)) {
      const actualPath = deps.vaultAdapter.resolveFileByNotionId(
        entry.notionId,
        existing.obsidianPath,
        settings.syncFolder,
      );
      if (actualPath && actualPath !== existing.obsidianPath) {
        log.info(`Resolved "${entry.title}" at "${actualPath}" (was "${existing.obsidianPath}")`);
        deps.syncState.updatePathByNotionId(entry.notionId, actualPath);
        existing.obsidianPath = actualPath;
      }
    }

    // Track prefetched Notion data from content-hash tiebreaker (reused in BOTH_CHANGED block)
    let prefetchedNotion: {
      page: NotionPage;
      blocks: NotionBlock[];
      doc: N2ODocument;
      markdown: string;
    } | null = null;
    // Set by seeded-record branch to bypass the "truly unchanged" guard below
    let needsResync = false;

    /* Authoritative 4-way truth table (v0.9.36, ADR
     *
     * Opt-in via options.authoritative=true from callers that cannot
     * tolerate silent data loss - currently just engine.syncSingleEntry
     * which powers the user-visible "Sync current file" command. The
     * old timestamp-based skip + tiebreaker stays intact below for the
     * bulk-pull path, which prefers cheap-skip semantics and can
     * tolerate missing sub-minute edits.
     *
     * When this block fires:
     *   1. Fetch Notion once (authoritative).
     *   2. Hash local + notion.
     *   3. decideSyncOutcome -> skip/pull/push/merge.
     *   4. 'skip' returns. 'local-only' records local-change + returns.
     *      'pull'/'merge' thread prefetched data through to the
     *      existing BOTH_CHANGED + default-dispatch machinery below,
     *      so the merge + strategy logic is shared with the legacy
     *      path and doesn't duplicate. */
    if (
      options?.authoritative &&
      existing &&
      entry.type !== 'database' &&
      entry.type !== 'linked-view' &&
      existing.notionContentHash &&
      existing.obsidianContentHash &&
      deps.vaultAdapter.fileExists(existing.obsidianPath) &&
      !deps.forceRefreshIds.has(entry.notionId) &&
      !hasUnexhaustedRetries(existing.failedMedia)
    ) {
      const { page, blocks } = await deps.notionClient.fetchPageWithBlocks(
        entry.notionId,
        deps.discoveryBlockCache ?? undefined,
        deps.discoveryPageCache ?? undefined,
      );
      const doc = deps.parser.parsePage(page, blocks);
      // Stamp breadcrumb chains before hashing - the stored hash came from
      // the enriched pull output, so an unenriched build here would read
      // every breadcrumb page as forever-changed.
      enrichBreadcrumbBlocks(doc, deps.currentRegistry, deps.syncState);
      const notionMarkdown = deps.builder.build(doc);
      const freshNotionHash = hashContentForChange(notionMarkdown);

      const localContent = await deps.vaultAdapter.readFile(existing.obsidianPath);
      const freshLocalHash = localContent !== null ? hashContentForChange(localContent) : '';

      /* Media-bearing pages render with raw S3 URLs that expire; the
       * stored hash was computed against local media paths, so the
       * two never match. Force the "notion changed" verdict so the
       * merge/pull path re-downloads media and rewrites local paths. */
      const AUTH_MEDIA_TYPES = new Set(['image', 'video', 'audio', 'file', 'pdf']);
      const hasMediaBlocks = doc.blocks.some((b) => AUTH_MEDIA_TYPES.has(b.type));
      const effectiveStoredNotionHash = hasMediaBlocks
        ? '__media_always_changed__'
        : existing.notionContentHash;

      const outcome = decideSyncOutcome(
        effectiveStoredNotionHash,
        freshNotionHash,
        existing.obsidianContentHash,
        freshLocalHash,
      );
      log.info(
        `Authoritative sync decision for "${entry.title}": ${outcome} ` +
          `(notionChanged=${freshNotionHash !== existing.notionContentHash}` +
          `${hasMediaBlocks ? ',media' : ''}, ` +
          `localChanged=${freshLocalHash !== existing.obsidianContentHash})`,
      );

      if (outcome === 'skip') {
        /* Refresh lastFetchedAt so the record reflects "just verified
         * against Notion" - useful for diagnostics + future rapid-
         * re-sync short-circuit. */
        deps.syncState.upsertRecord({
          ...existing,
          lastFetchedAt: new Date().toISOString(),
        });
        log.debug(`Authoritative: skipping unchanged "${entry.title}"`);
        counts.unchanged++;
        items.push({
          notionId: entry.notionId,
          title: entry.title,
          vaultPath: entry.vaultPath,
          status: 'unchanged',
        });
        return;
      }

      if (outcome === 'local-only') {
        const lineCount = (localContent ?? '').split('\n').length;
        log.info(`Authoritative: local change detected for "${entry.title}" (${lineCount} lines)`);
        counts.localChanges++;
        items.push({
          notionId: entry.notionId,
          title: entry.title,
          vaultPath: entry.vaultPath,
          status: 'local-change',
          detail: `${lineCount} lines`,
        });
        return;
      }

      /* 'pull' and 'merge' share the existing dispatch machinery - * thread the already-fetched data through so the BOTH_CHANGED
       * body + default syncPage call don't re-fetch. */
      prefetchedNotion = { page, blocks, doc, markdown: notionMarkdown };
      /* For 'merge', prefetchedNotion + the timestamp-differs side of
       * the BOTH_CHANGED gate combine cleanly. For 'pull', the
       * BOTH_CHANGED body's inner guard (localHash !== existing
       * .obsidianContentHash) correctly short-circuits, falling
       * through to the default dispatch below which uses prefetched. */
    }

    if (existing && entry.lastEditedTime && existing.notionLastEdited === entry.lastEditedTime) {
      // Fast-poll override: if this page was detected as changed, bypass skip logic
      const isForced =
        deps.forceRefreshIds.has(entry.notionId) ||
        (entry.parentDatabaseId && deps.forceRefreshIds.has(entry.parentDatabaseId));
      if (isForced) {
        log.info(`Force-refreshing "${entry.title}" - detected by fast poll`);
        // Fall through to sync below (don't skip)
      } else if (hasUnexhaustedRetries(existing.failedMedia)) {
        log.info(
          `Re-syncing "${entry.title}" - ${existing.failedMedia?.length ?? 0} media downloads to retry`,
        );
      } else {
        // After resolution, check if the file exists on disk at the known path
        const fileExistsOnDisk = deps.vaultAdapter.fileExists(existing.obsidianPath);
        if (fileExistsOnDisk) {
          // Check if Obsidian file changed locally since last sync
          const currentContent = await deps.vaultAdapter.readFile(existing.obsidianPath);
          if (currentContent !== null) {
            const currentHash = hashContentForChange(currentContent);
            if (currentHash !== existing.obsidianContentHash) {
              // Local changed - but did Notion also change within the same minute?
              // Content-hash tiebreaker: fetch Notion once and compare hashes.
              // Skip for database entries (no content to diff) and records without a stored
              // Notion content hash (recovered records or legacy records before hash tracking).
              if (
                entry.type !== 'database' &&
                entry.type !== 'linked-view' &&
                existing.notionContentHash
              ) {
                const { page: tbPage, blocks: tbBlocks } =
                  await deps.notionClient.fetchPageWithBlocks(
                    entry.notionId,
                    deps.discoveryBlockCache ?? undefined,
                    deps.discoveryPageCache ?? undefined,
                  );
                const tbDoc = deps.parser.parsePage(tbPage, tbBlocks);
                // Same reason as the authoritative build above: the stored
                // hash was computed from breadcrumb-enriched markdown.
                enrichBreadcrumbBlocks(tbDoc, deps.currentRegistry, deps.syncState);
                const tbMarkdown = deps.builder.build(tbDoc);
                const tbHash = hashContentForChange(tbMarkdown);
                // Skip hash comparison for pages with media blocks - the builder
                // output contains S3 URLs but the stored hash used local paths,
                // so they never match. Treat as "changed" (safe default).
                const MEDIA_BLOCK_TYPES = new Set(['image', 'video', 'audio', 'file', 'pdf']);
                const hasMediaBlocks = tbDoc.blocks.some((b) => MEDIA_BLOCK_TYPES.has(b.type));
                if (hasMediaBlocks || tbHash !== existing.notionContentHash) {
                  // Notion DID change within the same minute (or media tiebreaker skip) - route to BOTH_CHANGED
                  if (hasMediaBlocks) {
                    log.info(
                      `Content-hash tiebreaker: "${entry.title}" - skipped (page has media blocks)`,
                    );
                  } else {
                    log.info(
                      `Content-hash tiebreaker: "${entry.title}" - Notion changed within same minute`,
                    );
                  }
                  prefetchedNotion = {
                    page: tbPage,
                    blocks: tbBlocks,
                    doc: tbDoc,
                    markdown: tbMarkdown,
                  };
                  // Fall through to BOTH_CHANGED block below
                } else {
                  // Notion unchanged - genuine LOCAL_ONLY
                  const lineCount = currentContent.split('\n').length;
                  log.info(`Local change detected: "${entry.title}" (${lineCount} lines)`);
                  counts.localChanges++;
                  items.push({
                    notionId: entry.notionId,
                    title: entry.title,
                    vaultPath: entry.vaultPath,
                    status: 'local-change',
                    detail: `${lineCount} lines`,
                  });
                  return;
                }
              } else if (!existing.notionContentHash && !existing.obsidianContentHash) {
                // Both hashes empty = seeded record (reconcileVault after SQLite wipe).
                // No baseline to determine if content is locally edited or just stale.
                // Force full re-sync from Notion to restore any missing media.
                log.info(
                  `Re-syncing "${entry.title}" - recovered record with no content hash baseline`,
                );
                needsResync = true;
                // Fall through to syncPage() below - do NOT return
              } else {
                // Database entry or record with partial history - local-only
                const lineCount = currentContent.split('\n').length;
                log.info(`Local change detected: "${entry.title}" (${lineCount} lines)`);
                counts.localChanges++;
                items.push({
                  notionId: entry.notionId,
                  title: entry.title,
                  vaultPath: entry.vaultPath,
                  status: 'local-change',
                  detail: `${lineCount} lines`,
                });
                return;
              }
            }
          }

          // Both sides unchanged - but was the note RENDERED by this build?
          // The timestamp gate above only sees Notion-side change; it is blind
          // to changes in the code that turns blocks into markdown, which is
          // how shipped renderer fixes never reached already-synced notes
          // (#1628, avoiding-drift rule 3). A missing fingerprint (pre-v11
          // record) counts as stale and re-renders once. Local-edit paths
          // returned above, so this can never clobber a user's edit; the
          // re-render writes only when the new output actually differs.
          if (!prefetchedNotion && !needsResync && existing.rendererVersion !== RENDERER_VERSION) {
            log.info(
              `Re-rendering "${entry.title}" - renderer changed since last sync (${existing.rendererVersion ?? 'pre-tracking'} -> ${RENDERER_VERSION})`,
            );
            needsResync = true;
          }

          // Truly unchanged on both sides (only if tiebreaker didn't trigger and not a seeded record)
          if (!prefetchedNotion && !needsResync) {
            // Backfill notionParentId and itemType in sync record if missing.
            // itemType may also be stale if previously corrupted to 'page' by an older bug.
            if (existing && !existing.notionParentId && entry.parentDatabaseId) {
              deps.syncState.upsertRecord({
                ...existing,
                notionParentId: entry.parentDatabaseId,
                itemType: entry.type === 'database' ? 'database' : entry.type,
              });
            }
            // Backfill n2o_parent_id in frontmatter for files synced before this field was introduced
            if (existing) {
              const parentIdForBackfill = entry.parentDatabaseId ?? existing.notionParentId;
              if (parentIdForBackfill) {
                const fm = deps.vaultAdapter.getFrontmatter(existing.obsidianPath);
                if (fm && (!fm.n2o_parent_id || fm.n2o_parent_id !== parentIdForBackfill)) {
                  const parentType = entry.parentDatabaseId
                    ? ('database' as const)
                    : existing.itemType === 'database-item'
                      ? ('database' as const)
                      : ('page' as const);
                  try {
                    await deps.vaultAdapter.updateFrontmatter(existing.obsidianPath, (fmData) => {
                      fmData.n2o_parent_id = parentIdForBackfill;
                      fmData.n2o_parent_type = parentType;
                    });
                    /* Re-hash after the rewrite (#1976). processFrontMatter hands
                     * the block to Obsidian's own YAML serializer, which re-emits
                     * the WHOLE frontmatter and drops the quoting N2O wrote. The
                     * file on disk then no longer matches obsidianContentHash, and
                     * because nothing re-reads it, every later sync sees a local
                     * edit that never happened - a permanent phantom conflict once
                     * #1919 stopped silently merging those away.
                     *
                     * Any future write that bypasses syncPage has the same duty:
                     * change the file, re-hash the file. */
                    const rewritten = await deps.vaultAdapter.readFile(existing.obsidianPath);
                    if (rewritten !== null) {
                      const rehashed = hashContentForChange(rewritten);
                      if (rehashed !== existing.obsidianContentHash) {
                        existing.obsidianContentHash = rehashed;
                        existing.obsidianLastModified = Date.now();
                        deps.syncState.upsertRecord(existing);
                      }
                    }
                    log.info(`Backfilled n2o_parent_id for "${entry.title}"`);
                  } catch {
                    /* best-effort - file may not exist */
                  }
                }
              }
            }
            log.debug(`Skipping unchanged: "${entry.title}"`);
            counts.unchanged++;
            items.push({
              notionId: entry.notionId,
              title: entry.title,
              vaultPath: entry.vaultPath,
              status: 'unchanged',
            });
            return;
          }
        } else {
          log.debug(`Re-syncing "${entry.title}" - file missing or path changed`);
        }
      }
    }

    const isNew = !existing;

    // Conflict detection: if Notion changed AND local also changed = CONFLICT
    // Guard: Only check when Notion timestamp actually changed (avoids false conflicts
    // on same-minute re-syncs where only the local side changed)
    if (
      existing &&
      entry.type !== 'database' &&
      (prefetchedNotion ||
        (entry.lastEditedTime && existing.notionLastEdited !== entry.lastEditedTime))
    ) {
      // Try entry.vaultPath first; fall back to existing.obsidianPath in case the file was renamed
      let localContent = await deps.vaultAdapter.readFile(entry.vaultPath);
      if (
        localContent === null &&
        existing.obsidianPath &&
        existing.obsidianPath !== entry.vaultPath
      ) {
        localContent = await deps.vaultAdapter.readFile(existing.obsidianPath);
      }
      if (localContent !== null) {
        const localHash = hashContentForChange(localContent);
        if (localHash !== existing.obsidianContentHash) {
          // BOTH sides changed since last sync = CONFLICT
          let conflictPage: NotionPage;
          let conflictBlocks: NotionBlock[];
          let conflictDoc: N2ODocument;
          let notionMarkdown: string;

          if (prefetchedNotion) {
            // Reuse data from content-hash tiebreaker (already fetched above)
            conflictPage = prefetchedNotion.page;
            conflictBlocks = prefetchedNotion.blocks;
            conflictDoc = prefetchedNotion.doc;
            notionMarkdown = prefetchedNotion.markdown;
          } else {
            // Fresh fetch (normal timestamp-based BOTH_CHANGED path)
            const fetched = await deps.notionClient.fetchPageWithBlocks(
              entry.notionId,
              deps.discoveryBlockCache ?? undefined,
              deps.discoveryPageCache ?? undefined,
            );
            conflictPage = fetched.page;
            conflictBlocks = fetched.blocks;
            conflictDoc = deps.parser.parsePage(conflictPage, conflictBlocks);
            // The merge compares this render against the enriched base/local
            // versions - stamp breadcrumb chains so they line up.
            enrichBreadcrumbBlocks(conflictDoc, deps.currentRegistry, deps.syncState);
            notionMarkdown = deps.builder.build(conflictDoc);
          }

          // If the Notion doc has media blocks, download them now and rebuild markdown
          // with local paths. The initial build above uses raw S3 URLs that expire after
          // ~1 hour. Using those URLs in three-way merge would write broken image links
          // into the merged file permanently.
          const CONFLICT_MEDIA_TYPES = new Set(['image', 'video', 'audio', 'file', 'pdf']);
          const conflictDocHasMedia = conflictDoc.blocks.some((b) =>
            CONFLICT_MEDIA_TYPES.has(b.type),
          );
          if (conflictDocHasMedia && settings.downloadMedia) {
            const standaloneBase =
              settings.useStandaloneFolder && settings.standaloneFolder
                ? `${settings.syncFolder}/${settings.standaloneFolder}`
                : settings.syncFolder;
            const attachmentFolder = `${entry.type === 'page' ? standaloneBase : entry.folder}/_files`;
            await deps.mediaHandler.downloadBlockMedia(conflictDoc.blocks, attachmentFolder);
            await deps.mediaHandler.downloadDocMedia(conflictDoc, attachmentFolder);
            notionMarkdown = renderWithTemplate(conflictDoc, entry, deps);
            log.debug(`Conflict path: rebuilt markdown with local media for "${entry.title}"`);
          }

          // Cache blocks for future push optimization
          const conflictLastEdited = conflictPage.last_edited_time;
          if (conflictLastEdited) {
            deps.blockCache?.set(entry.notionId, conflictBlocks, conflictLastEdited);
          }

          // ── Pull mode: Notion wins - skip merge and conflict resolution ──
          if (deps.mode === 'pull') {
            log.info(
              `Pull mode: overwriting "${entry.title}" with Notion version (local changes discarded)`,
            );
            // Nothing may overwrite the local file until a copy of it is safe on
            // disk. Ungated by createConflictNotes on purpose: that setting reads
            // as a tidiness preference, and it used to switch off the only copy
            // of the user's work (#1926).
            const preserved = await preserveLocalBeforeOverwrite(
              entry,
              localContent,
              notionMarkdown,
              settings.createConflictNotes,
              deps,
            );
            if (!preserved) {
              counts.failed++;
              return;
            }
            await withRetry(() =>
              syncPage(entry, settings, deps, {
                page: conflictPage,
                blocks: conflictBlocks,
                doc: conflictDoc,
                markdown: notionMarkdown,
              }),
            );
            if (deps.conflictAudit) {
              deps.conflictAudit.log({
                id: `merge-${Date.now()}`,
                timestamp: new Date().toISOString(),
                notionId: entry.notionId,
                title: entry.title,
                decision: 'conflict-notion-wins',
                details: {
                  conflictCount: 1,
                  unchangedCount: 0,
                  notionHash: hashContentForChange(notionMarkdown),
                  obsidianHash: hashContentForChange(localContent),
                },
              });
            }
            if (isNew) {
              counts.created++;
              items.push({
                notionId: entry.notionId,
                title: entry.title,
                vaultPath: entry.vaultPath,
                status: 'created',
                direction: 'pull',
                detail: 'overwritten (pull)',
              });
            } else {
              counts.updated++;
              items.push({
                notionId: entry.notionId,
                title: entry.title,
                vaultPath: entry.vaultPath,
                status: 'updated',
                direction: 'pull',
                detail: 'overwritten (pull)',
              });
            }
            return;
          }

          // ── Sync mode: both sides changed - the local file is never touched ──
          // Lite does not merge (#1919). Notion's version is written beside the
          // file and the user decides what to keep. The sync record is left
          // deliberately unchanged: the conflict is unresolved, so the next sync
          // should detect it again and rewrite the same conflict file. Stamping
          // the record here would make an unresolved conflict look settled.
          // A dry run previews and never writes, so it reports the conflict
          // without producing the file.
          const conflictFilePath = options?.dryRun
            ? null
            : await deps.conflictManager.writeConflictFile({
                title: entry.title,
                vaultPath: entry.vaultPath,
                notionContent: notionMarkdown,
              });

          if (options?.dryRun) {
            counts.localChanges++;
            counts.conflicts = (counts.conflicts ?? 0) + 1;
            items.push({
              notionId: entry.notionId,
              title: entry.title,
              vaultPath: entry.vaultPath,
              status: 'local-change',
              detail: "conflict: would leave your file alone and save Notion's version beside it",
            });
            return;
          }

          if (deps.conflictAudit) {
            deps.conflictAudit.log({
              id: `merge-${Date.now()}`,
              timestamp: new Date().toISOString(),
              notionId: entry.notionId,
              title: entry.title,
              decision: 'conflict-file-written',
              details: {
                conflictCount: 1,
                unchangedCount: 0,
                notionHash: hashContentForChange(notionMarkdown),
                obsidianHash: hashContentForChange(localContent),
              },
            });
          }

          counts.localChanges++;
          // The dashboard's conflict surface gates on this count, not on
          // localChanges. Leaving it at 0 made "Resolve conflicts (N)"
          // unreachable while conflicts were actually happening.
          counts.conflicts = (counts.conflicts ?? 0) + 1;
          if (conflictFilePath === null) {
            // The local file is safe either way, but the user now has no copy of
            // Notion's version, so this must not pass as a clean run.
            const msg = `Both sides changed and the conflict file could not be written. Your local file is untouched; Notion's version was not saved.`;
            log.error(`"${entry.title}": ${msg}`);
            errors.push(`"${entry.title}": ${msg}`);
            items.push({
              notionId: entry.notionId,
              title: entry.title,
              vaultPath: entry.vaultPath,
              status: 'local-change',
              detail: 'conflict: could not write the conflict file',
            });
          } else {
            items.push({
              notionId: entry.notionId,
              title: entry.title,
              vaultPath: entry.vaultPath,
              status: 'local-change',
              detail: `conflict: Notion's version saved to ${conflictFilePath}`,
            });
          }
          return;
        }
      }
    }

    if (options?.dryRun) {
      if (entry.type === 'database') return; // Database folders aren't content items
      if (isNew) {
        counts.created++;
        items.push({
          notionId: entry.notionId,
          title: entry.title,
          vaultPath: entry.vaultPath,
          status: 'created',
          direction: 'pull',
        });
      } else {
        counts.updated++;
        items.push({
          notionId: entry.notionId,
          title: entry.title,
          vaultPath: entry.vaultPath,
          status: 'updated',
          direction: 'pull',
        });
      }
    } else {
      if (entry.type === 'database') {
        await withRetry(() => syncDatabase(entry, settings, errors, deps));
        // Database folders are infrastructure - don't count as synced items
        return;
      }
      if (entry.type === 'linked-view') {
        // Linked-view entries are registry infrastructure - don't count as synced items
        return;
      } else {
        const outcome = await withRetry(() => syncPage(entry, settings, deps));
        /* Refused by the page budget (#1918). Recorded as skipped, never as
         * created: a page that was not written must not be counted as one, or
         * the run reports a clean success while silently dropping pages. */
        if (outcome.skippedReason === 'page-limit') {
          counts.skipped = (counts.skipped ?? 0) + 1;
          items.push({
            notionId: entry.notionId,
            title: entry.title,
            vaultPath: entry.vaultPath,
            status: 'skipped',
            detail: `not synced: Lite's ${LITE_PAGE_LIMIT}-page limit reached`,
          });
          return;
        }
      }

      if (isNew) {
        counts.created++;
        items.push({
          notionId: entry.notionId,
          title: entry.title,
          vaultPath: entry.vaultPath,
          status: 'created',
          direction: 'pull',
        });
      } else {
        counts.updated++;
        items.push({
          notionId: entry.notionId,
          title: entry.title,
          vaultPath: entry.vaultPath,
          status: 'updated',
          direction: 'pull',
        });
      }
    }
  } catch (error) {
    const msg = getErrorMessage(error);
    const notionUrl = notionPageUrl(entry.notionId);
    log.error(`Failed to sync "${entry.title}" (${notionUrl}): ${msg}`);
    errors.push(`"${entry.title}": ${msg} (${notionUrl})`);
    counts.failed++;
    items.push({
      notionId: entry.notionId,
      title: entry.title,
      vaultPath: entry.vaultPath,
      status: 'failed',
      error: msg,
    });
    deps.emitError(entry.title, msg);

    // Persist lastError on sync record
    const errorRecord = deps.syncState.getByNotionId(entry.notionId);
    if (errorRecord) {
      errorRecord.lastError = msg;
      deps.syncState.upsertRecord(errorRecord);
    }
  }
}
