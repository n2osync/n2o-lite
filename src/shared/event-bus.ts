/**
 * EventBus - Lightweight typed pub/sub for decoupled component communication.
 *
 * Replaces manual refreshDashboards() calls scattered across sync code.
 * Components subscribe to events they care about; orchestrator/commands emit.
 */

export type N2OEventMap = {
  'sync:start': { mode: 'pull' | 'sync' };
  'sync:end': { mode: 'pull' | 'sync'; success: boolean; duration: number };
  'sync:progress': { message: string; current?: number; total?: number };
  'state:changed': undefined;
};

export type N2OEventName = keyof N2OEventMap;

import { createLogger } from './logger';

const log = createLogger('EventBus');

type Listener<T> = (data: T) => void;

export class EventBus {
  private listeners = new Map<string, Set<Listener<unknown>>>();

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends N2OEventName>(event: K, listener: Listener<N2OEventMap[K]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    // Non-null guaranteed: listeners.set(event, ...) above ensures entry exists
    const set = this.listeners.get(event) as Set<Listener<unknown>>;
    set.add(listener as Listener<unknown>);
    return () => {
      set.delete(listener as Listener<unknown>);
    };
  }

  /** Emit an event to all subscribers. */
  emit<K extends N2OEventName>(event: K, data: N2OEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Snapshot the listener set: a listener that subscribes or unsubscribes
    // during this emit must not change which listeners this emit visits, and
    // iterating a live Set while it mutates is undefined (#1569).
    for (const listener of [...set]) {
      try {
        listener(data);
      } catch (err) {
        // One listener's error must not break the emitter, but it must not
        // vanish silently either.
        log.warn(`Listener for "${String(event)}" threw`, err);
      }
    }
  }

  /** Remove all listeners (for plugin unload). */
  clear(): void {
    this.listeners.clear();
  }
}

/** Singleton event bus instance for the plugin. */
export const eventBus = new EventBus();
