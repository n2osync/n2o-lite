/**
 * BaseN2OModal - shared base for all N2O modal dialogs.
 *
 * Centralizes three patterns that were duplicated across ~10 modal classes:
 *   1. Singleton guard (only one instance of a given modal class open at a time)
 *   2. Focus restoration (return focus to the element that was focused before open)
 *   3. contentEl cleanup on close
 *
 * Subclasses that need additional cleanup (timers, flags) should override
 * onClose(), do their work, and call super.onClose() last.
 */

import { Modal } from 'obsidian';

export abstract class BaseN2OModal extends Modal {
  /** One active instance per concrete modal class, keyed by constructor. */
  private static activeInstances = new Map<object, BaseN2OModal>();

  private previousActiveElement: HTMLElement | null = null;

  override open(): void {
    const ctor = this.constructor;
    if (BaseN2OModal.activeInstances.has(ctor)) return;
    BaseN2OModal.activeInstances.set(ctor, this);
    this.previousActiveElement = document.activeElement as HTMLElement | null;
    super.open();
  }

  override close(): void {
    // Release the singleton entry here rather than only in onClose(). close() is
    // the Obsidian lifecycle method that always runs on dismissal, so a subclass
    // that overrides onClose() and forgets super.onClose() can no longer leave a
    // stuck entry that silently swallows every future open() of the class (#1542).
    BaseN2OModal.activeInstances.delete(this.constructor);
    super.close();
  }

  override onClose(): void {
    // Idempotent with close() above - kept so a direct onClose() path also clears.
    BaseN2OModal.activeInstances.delete(this.constructor);
    this.contentEl.empty();
    this.previousActiveElement?.focus();
  }
}
