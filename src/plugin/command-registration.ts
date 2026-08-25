/**
 * CommandRegistration - registers all N2O commands and ribbon icon.
 *
 * Extracted from main.ts to keep the plugin class slim.
 *
 * Commands are defined as data in COMMANDS and FILE_COMMANDS, then wired
 * via registerCommands() at the bottom. FILE_COMMANDS always gate on an
 * active file; their optional `gate` narrows further. Plain COMMANDS use
 * a callback unless a `gate` is present, in which case checkCallback is
 * used so the palette hides disabled entries.
 */

import { Notice, TFile } from 'obsidian';
import type { CommandHost } from './plugin-host';
import type { SyncState } from '../infrastructure/storage/sync-state';
import { openSyncSettings } from '../ui/sync-config-modal';
import { getErrorMessage } from '../shared/errors';
import { NOTICE_ERROR } from '../shared/constants';
import { createLogger } from '../shared/logger';

const log = createLogger('Commands');

interface CommandDef {
  id: string;
  name: string;
  /** If set, the command is only enabled when this returns true. */
  gate?: (plugin: CommandHost) => boolean;
  run: (plugin: CommandHost) => void | Promise<unknown>;
}

interface FileCommandDef {
  id: string;
  name: string;
  /** Extra gate beyond "an active file exists". */
  gate?: (plugin: CommandHost, file: TFile) => boolean;
  run: (plugin: CommandHost, file: TFile) => void | Promise<unknown>;
}

const COMMANDS: CommandDef[] = [
  {
    id: 'pull-from-notion',
    name: 'Overwrite from Notion (replace local with Notion)',
    run: async (p) => {
      const { OverwriteConfirmModal } = await import('../ui/overwrite-confirm-modal');
      new OverwriteConfirmModal(p.app, () => void p.pullFromNotion()).open();
    },
  },
  {
    id: 'sync-now',
    name: 'Sync with Notion',
    run: (p) => p.syncNow(),
  },
  {
    id: 'preview-sync',
    name: 'Preview sync',
    run: (p) => p.previewSync(),
  },
  {
    id: 'open-dashboard',
    name: 'Open Dashboard',
    run: (p) => p.getDashboardManager().openDashboard(),
  },
  {
    id: 'open-sync-config',
    name: 'Sync Configuration',
    run: (p) => openSyncSettings(p.app, p.getSettingTab()),
  },
  {
    id: 'n2o-open-setup-wizard',
    name: 'Open N2O panel',
    run: (p) => {
      void p.getDashboardManager().openDashboard();
    },
  },
  {
    id: 'export-sync-state',
    name: 'Export sync state to JSON',
    gate: (p) => !p.dbInitFailed && !!p.getSyncState(),
    run: async (p) => {
      // Guard the export path: without a sync folder the file would land at the
      // vault root (or an invalid "/...") (#1543).
      const syncFolder = p.profile.syncFolder;
      if (!syncFolder) {
        new Notice('N2O: Set a sync folder in settings before exporting sync state.');
        return;
      }
      const state = p.getSyncState().exportState();
      const json = JSON.stringify(state, null, 2);
      const path = `${syncFolder}/_n2o-state-export.json`;
      await p.app.vault.adapter.write(path, json);
      new Notice(`N2O: Sync state exported to ${path}`);
    },
  },
  {
    id: 'import-sync-state',
    name: 'Import sync state from JSON',
    gate: (p) => !p.dbInitFailed && !!p.getSyncState(),
    run: async (p) => {
      const path = `${p.profile.syncFolder}/_n2o-state-export.json`;
      try {
        const json = await p.app.vault.adapter.read(path);
        if (json.length > 50 * 1024 * 1024) {
          new Notice('N2O: State file too large (>50 MB). Aborting import.');
          return;
        }
        const state = JSON.parse(json) as SyncState;
        if (!state.version || !state.records) {
          new Notice('N2O: Invalid state file (missing version or records).');
          return;
        }
        const result = p.getSyncState().importState(state);
        new Notice(`N2O: Imported ${result.imported} records (${result.skipped} skipped)`);
      } catch (e) {
        new Notice(`N2O: Import failed (${getErrorMessage(e)})`, NOTICE_ERROR);
      }
    },
  },
  {
    id: 'scan-vault',
    name: 'Scan vault for Notion files',
    run: (p) => p.scanVault(),
  },
];

const FILE_COMMANDS: FileCommandDef[] = [
  {
    id: 'pull-current-file',
    name: 'Overwrite this note from Notion (replace local)',
    run: async (p, file) => {
      const { OverwriteConfirmModal } = await import('../ui/overwrite-confirm-modal');
      new OverwriteConfirmModal(
        p.app,
        () => void p.pullFile(file.path),
        `"${file.basename}"`,
      ).open();
    },
  },
  {
    id: 'sync-current-file',
    name: 'Sync this note with Notion',
    run: (p, file) => p.syncFile(file.path),
  },
  {
    id: 'open-in-notion',
    name: 'Open this note in Notion',
    run: (p, file) => p.openInNotion(file.path),
  },
];

function reportCommandError(name: string, err: unknown): void {
  log.error(`Command "${name}" failed`, err);
  new Notice(`N2O: ${name} failed - ${getErrorMessage(err)}`, NOTICE_ERROR);
}

/**
 * Error boundary for palette commands. Most run functions handle their own
 * errors, but the ones that reject (a failed export write) used to die as
 * unhandled rejections - console noise for us, dead silence for the user.
 * Sync throws and async rejections both land here as a Notice + log entry.
 */
function runCommand(name: string, fn: () => void | Promise<unknown>): void {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        reportCommandError(name, err);
      });
    }
  } catch (err) {
    reportCommandError(name, err);
  }
}

/**
 * Register all N2O commands with the Obsidian command palette.
 */
export function registerCommands(plugin: CommandHost): void {
  for (const cmd of COMMANDS) {
    if (cmd.gate) {
      const gate = cmd.gate;
      plugin.addCommand({
        id: cmd.id,
        name: cmd.name,
        checkCallback: (checking) => {
          if (!gate(plugin)) return false;
          if (checking) return true;
          runCommand(cmd.name, () => cmd.run(plugin));
        },
      });
    } else {
      plugin.addCommand({
        id: cmd.id,
        name: cmd.name,
        callback: () => {
          runCommand(cmd.name, () => cmd.run(plugin));
        },
      });
    }
  }

  for (const cmd of FILE_COMMANDS) {
    plugin.addCommand({
      id: cmd.id,
      name: cmd.name,
      checkCallback: (checking) => {
        const file = plugin.app.workspace.getActiveFile();
        if (!file) return false;
        if (cmd.gate && !cmd.gate(plugin, file)) return false;
        if (checking) return true;
        runCommand(cmd.name, () => cmd.run(plugin, file));
      },
    });
  }
}
