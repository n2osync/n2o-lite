/**
 * Pull sync Phase 2: Diff and resolve.
 *
 * Fetches pages, renders content, handles conflicts with configured concurrency.
 *
 * @module
 */

import type { SyncConfig } from '../../domain/models/sync-config';
import type { SyncResultItem, SyncResultCounts } from './orchestrator';
import type { PageRegistryEntry } from '../discovery/page-registry';
import type { PageRegistry } from '../discovery/page-registry';
import type { ObsidianBuilder } from '../../infrastructure/obsidian/builder';
import { Semaphore } from '../../shared/semaphore';
import { getErrorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/logger';

/** Pages fetched in parallel. Tuned to sit under Notion's rate limit. */
const SYNC_CONCURRENCY = 5;

const log = createLogger('PullSync');

export interface DiffPhaseDeps {
  builder: ObsidianBuilder;
  syncOneEntry: (
    entry: PageRegistryEntry,
    settings: SyncConfig,
    counts: SyncResultCounts,
    items: SyncResultItem[],
    errors: string[],
    options?: { dryRun?: boolean },
  ) => Promise<void>;
  emitProgress: (message: string, current?: number, total?: number) => void;
  isCancelled: () => boolean;
  /** Optional per-item callback fired after each entry's syncOneEntry returns. */
  emitItem?: (item: SyncResultItem) => void;
}

/**
 * Phase 2: Diff and resolve - fetch pages, render content, handle conflicts.
 * Processes all registry entries with configured concurrency.
 */
export async function diffAndResolve(
  registryEntries: PageRegistryEntry[],
  registry: PageRegistry,
  settings: SyncConfig,
  counts: SyncResultCounts,
  items: SyncResultItem[],
  errors: string[],
  deps: DiffPhaseDeps,
  options?: { dryRun?: boolean },
): Promise<void> {
  // Give registry to builder for [[wikilink]] resolution
  deps.builder.setPageRegistry(registry);
  // Give property mappings to builder for frontmatter customization
  deps.builder.setPropertyMappings(settings.propertyMappings ?? []);
  // Set file-property rendering mode
  deps.builder.setFilePropertyRenderMode(settings.filePropertyRenderMode ?? 'frontmatter');
  // Multi-column layout: undefined reads as enabled (original behavior)
  deps.builder.setEnableMultiColumnLayout(settings.enableMultiColumnLayout !== false);

  const pageCount = registryEntries.filter((e) => e.type !== 'database').length;
  const dbCount = registryEntries.filter((e) => e.type === 'database').length;
  deps.emitProgress(`Found ${pageCount} pages, ${dbCount} databases`);
  log.info(`Registry built: ${registry.size} entries. Starting Pass 2...`);

  counts.total = registryEntries.length;
  const total = registryEntries.length;
  /* Fixed, not a setting (#1917). It was a slider offering 1-10 while this line
   * clamped to 1-20, so the advertised range was wrong as well as pointless: 5
   * keeps us inside Notion's 3 req/s budget, and turning it up mostly buys rate
   * limit errors. Lite syncs at most 100 pages, so there is nothing to tune. */
  const concurrency = SYNC_CONCURRENCY;

  if (concurrency > 1 && total > 1) {
    // Parallel sync with semaphore - each task collects isolated results
    // to avoid shared mutation across concurrent promises
    const semaphore = new Semaphore(concurrency);
    let completed = 0;

    // Pre-assign indices sequentially so progress numbers are stable
    // regardless of which parallel task starts first
    const entryIndices = new Map<string, number>();
    registryEntries.forEach((entry, idx) => entryIndices.set(entry.notionId, idx));

    const results = await Promise.allSettled(
      registryEntries.map((entry) =>
        semaphore.run(async () => {
          if (deps.isCancelled())
            return {
              counts: {
                total: 0,
                created: 0,
                updated: 0,
                unchanged: 0,
                failed: 0,
                orphaned: 0,
                localChanges: 0,
                conflicts: 0,
                skipped: 0,
              },
              items: [] as SyncResultItem[],
              errors: [] as string[],
            };
          const myIndex = entryIndices.get(entry.notionId) ?? completed++;
          deps.emitProgress(`Syncing ${myIndex + 1}/${total}: ${entry.title}`, myIndex, total);
          const localCounts: SyncResultCounts = {
            total: 0,
            created: 0,
            updated: 0,
            unchanged: 0,
            failed: 0,
            orphaned: 0,
            localChanges: 0,
            conflicts: 0,
            skipped: 0,
          };
          const localItems: SyncResultItem[] = [];
          const localErrors: string[] = [];
          await deps.syncOneEntry(entry, settings, localCounts, localItems, localErrors, options);
          if (deps.emitItem) {
            for (const item of localItems) deps.emitItem(item);
          }
          return {
            counts: localCounts,
            items: localItems,
            errors: localErrors,
          };
        }),
      ),
    );

    // Merge isolated results into shared accumulators
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const r = result.value;
        counts.created += r.counts.created;
        counts.updated += r.counts.updated;
        counts.unchanged += r.counts.unchanged;
        counts.failed += r.counts.failed;
        counts.localChanges += r.counts.localChanges;
        counts.conflicts = (counts.conflicts ?? 0) + (r.counts.conflicts ?? 0);
        counts.skipped = (counts.skipped ?? 0) + (r.counts.skipped ?? 0);
        items.push(...r.items);
        errors.push(...r.errors);
      } else {
        // Promise rejected unexpectedly - count as failed
        const reason = getErrorMessage(result.reason);
        log.error(`Parallel sync task rejected: ${reason}`);
        counts.failed++;
        errors.push(`Unexpected error: ${reason}`);
      }
    }
  } else {
    // Sequential sync (concurrency === 1 or single item)
    for (let i = 0; i < registryEntries.length; i++) {
      if (deps.isCancelled()) break;
      const entry = registryEntries[i];
      if (!entry) continue;
      deps.emitProgress(`Syncing ${i + 1}/${total}: ${entry.title}`, i + 1, total);
      const before = items.length;
      await deps.syncOneEntry(entry, settings, counts, items, errors, options);
      if (deps.emitItem) {
        for (let j = before; j < items.length; j++) {
          const it = items[j];
          if (it) deps.emitItem(it);
        }
      }
    }
  }
}
