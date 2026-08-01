/**
 * Shared confirmation dialog. One consistent look for every "are you sure?"
 * prompt: a warning icon + title, a lead line, an optional custom body (lists,
 * notes), an optional emphasized warning callout, and a right-aligned
 * Cancel / confirm button row.
 *
 * Call `renderConfirm` from a modal so every prompt gets the same chrome + CSS.
 */

import { setIcon } from 'obsidian';

export interface ConfirmContent {
  title: string;
  /** One-line description under the title. */
  lead?: string;
  /** Optional custom content (bullet lists, notes) between the lead and warning. */
  body?: (el: HTMLElement) => void;
  /** Emphasized callout for a data-loss / irreversible notice. */
  warning?: string | ((el: HTMLElement) => void);
  confirmText: string;
  cancelText?: string;
  /** Red destructive styling on the confirm button + icon. Default true. */
  destructive?: boolean;
  /** Lucide icon name for the header. Default 'alert-triangle'. */
  icon?: string;
}

/** Render the shared confirm layout into a modal's contentEl. */
export function renderConfirm(
  contentEl: HTMLElement,
  content: ConfirmContent,
  handlers: { close: () => void; onConfirm: () => void | Promise<void>; onCancel?: () => void },
): void {
  contentEl.addClass('n2o-confirm');
  const destructive = content.destructive !== false;

  const header = contentEl.createDiv({ cls: 'n2o-confirm-header' });
  const icon = header.createSpan({ cls: 'n2o-confirm-icon' });
  if (destructive) icon.addClass('is-destructive');
  setIcon(icon, content.icon ?? 'alert-triangle');
  header.createEl('h3', { text: content.title });

  if (content.lead) {
    contentEl.createEl('p', { cls: 'n2o-confirm-lead', text: content.lead });
  }
  if (content.body) {
    content.body(contentEl.createDiv({ cls: 'n2o-confirm-body' }));
  }
  if (content.warning) {
    const warn = contentEl.createDiv({ cls: 'n2o-confirm-warn' });
    if (typeof content.warning === 'string') warn.appendText(content.warning);
    else content.warning(warn);
  }

  const row = contentEl.createDiv({ cls: 'n2o-modal-button-row' });

  const cancel = row.createEl('button', { text: content.cancelText ?? 'Cancel' });
  cancel.addEventListener('click', () => {
    handlers.onCancel?.();
    handlers.close();
  });

  const ok = row.createEl('button', {
    text: content.confirmText,
    cls: destructive ? 'mod-warning' : 'mod-cta',
  });
  ok.addEventListener('click', () => {
    handlers.close();
    // onConfirm may be async (e.g. a Notion delete); fire-and-forget after the
    // modal closes. The handler owns its own error reporting (#1578).
    void handlers.onConfirm();
  });
}
