// ============================================================================
// TypedEventBus — Process-internal typed pub/sub for pipeline lifecycle events
// ============================================================================
//
// Design:
//   - Fully synchronous, in-process, no serialization
//   - Type-safe: emit/on/off are keyed to the EventMap discriminated union
//   - No-op emit when no subscribers (zero allocation for the no-listener case)
//   - Plugin lifecycle hooks (6C) subscribe via on() to observe pipeline events
// ============================================================================

export type EventMap = {
  'pipeline:render:before': { eventId: string };
  'pipeline:render:after': { eventId: string; durationMs: number };
  'pipeline:validation:complete': { eventId: string; issueCount: number };
  'cache:hit': { eventId: string; cacheKey: string };
  'cache:miss': { eventId: string };
  'state:entity:changed': { entityId: string; attribute: string };
  'config:changed': { key: string };
};

// Internal type erased to a single function signature for storage in a homogeneous Set.
// Public API surfaces the correct per-event typing via generics.
type ListenerFn = (data: unknown) => void;

export class TypedEventBus {
  private listeners = new Map<string, Set<ListenerFn>>();

  on<K extends keyof EventMap>(event: K, fn: (data: EventMap[K]) => void): void {
    const set = this.listeners.get(event as string);
    const wrapped = fn as ListenerFn;
    if (set) {
      set.add(wrapped);
    } else {
      this.listeners.set(event as string, new Set([wrapped]));
    }
  }

  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    const set = this.listeners.get(event as string);
    if (!set) return;
    for (const fn of set) {
      fn(data);
    }
  }

  off<K extends keyof EventMap>(event: K, fn: (data: EventMap[K]) => void): void {
    const set = this.listeners.get(event as string);
    if (!set) return;
    const wrapped = fn as ListenerFn;
    set.delete(wrapped);
    if (set.size === 0) {
      this.listeners.delete(event as string);
    }
  }

  /** Remove all listeners for all events */
  clear(): void {
    this.listeners.clear();
  }

  /** Number of registered listeners (for testing/diagnostics) */
  get listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) {
      count += set.size;
    }
    return count;
  }
}
