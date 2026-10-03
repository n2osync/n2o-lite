/**
 * Open a URL in the system default browser (not Obsidian's Web Viewer).
 *
 * Uses electron.shell.openExternal, which bypasses Obsidian's window.open
 * interception. The Electron access is an undocumented internal, so every path
 * is wrapped to fall back to window.open rather than throw if it changes.
 */

export function openExternalUrl(url: string): void {
  try {
    const electron = (window as unknown as Record<string, unknown>).electron as
      Record<string, unknown> | undefined;
    const shell = electron?.shell as { openExternal?: (url: string) => void } | undefined;
    if (shell?.openExternal) {
      shell.openExternal(url);
      return;
    }
  } catch {
    /* fall through to the browser default */
  }
  window.open(url, '_blank');
}
