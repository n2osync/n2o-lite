/**
 * Pull sync: database entry handlers.
 *
 * Extracted from pull-apply-phase.ts. Exports syncDatabase (public).
 *
 * @module
 */

import type { PageRegistryEntry } from '../discovery/page-registry';
import type { SyncConfig } from '../../domain/models/sync-config';
import type { SyncRecord } from '../../domain/models/sync-record';
import type { ApplyPhaseDeps } from './apply-phase-deps';
import { getSyncRecordDirection } from './orchestrator';
import { createLogger } from '../../shared/logger';
import { RENDERER_VERSION } from '../../shared/renderer-version';

const log = createLogger('PullSync');

/**
 * Sync a database - create folder and track in sync state.
 */
export async function syncDatabase(
  entry: PageRegistryEntry,
  settings: SyncConfig,
  _errors: string[],
  deps: ApplyPhaseDeps,
): Promise<void> {
  log.info(`Syncing database folder: "${entry.title}" -> ${entry.vaultPath}/`);

  await deps.vaultAdapter.ensureFolder(`${entry.vaultPath}/_`);

  const now = new Date().toISOString();
  const existing = deps.syncState.getByNotionId(entry.notionId);
  const record: SyncRecord = {
    id: existing?.id ?? `n2o-${entry.notionId}`,
    notionId: entry.notionId,
    obsidianPath: entry.vaultPath,
    itemType: 'database',
    notionLastEdited: entry.lastEditedTime ?? now,
    obsidianLastModified: Date.now(),
    notionContentHash: '',
    obsidianContentHash: '',
    status: 'synced',
    syncDirection: getSyncRecordDirection(),
    lastSyncTime: now,
    attachments: [],
    dataSourceId: entry.dataSourceId,
    rendererVersion: RENDERER_VERSION,
  };
  deps.syncState.upsertRecord(record);
}
