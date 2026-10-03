/**
 * ContextMenus - registers file menu and editor menu event handlers.
 *
 * Extracted from main.ts to keep the plugin class slim.
 * Lite surface: pull, merge-sync, view in Notion, unlink. No push,
 * no create, no delete-in-Notion (Lite never writes to Notion).
 */

import { TFile } from 'obsidian';
import type { FileActionHost } from './plugin-host';

/**
 * Register right-click context menus for files and the editor.
 */
export function registerContextMenus(plugin: FileActionHost): void {
  // Add N2O actions to right-click file menu
  plugin.registerEvent(
    plugin.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'md') {
        menu.addItem((item) => {
          item
            .setTitle('N2O: Pull from Notion')
            .setIcon('download')
            .onClick(async () => {
              // Pull overwrites local content with Notion. Gate it behind the
              // same confirm modal the command-palette Pull uses so the context
              // menu can't silently clobber local edits.
              const { OverwriteConfirmModal } = await import('../ui/overwrite-confirm-modal');
              new OverwriteConfirmModal(
                plugin.app,
                () => void plugin.pullFile(file.path),
                `"${file.basename}"`,
              ).open();
            });
        });
        menu.addItem((item) => {
          item
            .setTitle('N2O: Sync with Notion (merge)')
            .setIcon('refresh-cw')
            .onClick(async () => {
              await plugin.syncFile(file.path);
            });
        });
        const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
        menu.addItem((item) => {
          item
            .setTitle('N2O: View in Notion')
            .setIcon('external-link')
            .onClick(() => plugin.viewInNotionFromFrontmatter(file.path));
        });

        // "Unlink from Notion" - strip N2O frontmatter and remove sync record
        if (fm?.notion_id) {
          menu.addItem((item) => {
            item
              .setTitle('N2O: Unlink from Notion')
              .setIcon('unlink')
              .onClick(async () => {
                await plugin.unlinkFromNotion(file.path);
              });
          });
        }
      }
    }),
  );

  // Add N2O actions to editor context menu
  plugin.registerEvent(
    plugin.app.workspace.on('editor-menu', (menu) => {
      const file = plugin.app.workspace.getActiveFile();
      if (file) {
        menu.addItem((item) => {
          item
            .setTitle('N2O: Pull from Notion')
            .setIcon('download')
            .onClick(async () => {
              // Pull overwrites local content with Notion. Gate it behind the
              // same confirm modal the command-palette Pull uses so the context
              // menu can't silently clobber local edits.
              const { OverwriteConfirmModal } = await import('../ui/overwrite-confirm-modal');
              new OverwriteConfirmModal(
                plugin.app,
                () => void plugin.pullFile(file.path),
                `"${file.basename}"`,
              ).open();
            });
        });
        menu.addItem((item) => {
          item
            .setTitle('N2O: Sync with Notion (merge)')
            .setIcon('refresh-cw')
            .onClick(async () => {
              await plugin.syncFile(file.path);
            });
        });
        menu.addItem((item) => {
          item
            .setTitle('N2O: View in Notion')
            .setIcon('external-link')
            .onClick(() => plugin.viewInNotionFromFrontmatter(file.path));
        });

        // "Unlink from Notion" - strip N2O frontmatter and remove sync record
        const editorFm = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
        if (editorFm?.notion_id) {
          menu.addItem((item) => {
            item
              .setTitle('N2O: Unlink from Notion')
              .setIcon('unlink')
              .onClick(async () => {
                await plugin.unlinkFromNotion(file.path);
              });
          });
        }
      }
    }),
  );
}
