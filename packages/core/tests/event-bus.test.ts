import { describe, expect, it, vi } from 'vitest';
import { TypedEventBus } from '../src/event-bus.ts';
import type { EventMap } from '../src/event-bus.ts';

// ——— Typed events ———
// TypeScript compile-time test: uncommenting any of the following should fail to compile
// because the data payload does not match the EventMap type for that event key.
//
//   const bus = new TypedEventBus();
//   bus.emit('pipeline:render:before', { eventId: 42 });           // TS error: number != string
//   bus.emit('cache:hit', { eventId: 'e1' });                      // TS error: missing cacheKey
//   bus.emit('pipeline:render:after', { eventId: 'e1' });          // TS error: missing durationMs
//   bus.emit('pipeline:render:after', { eventId: 'e1', durationMs: 'slow' }); // TS error: string != number
//   bus.emit('unknown:event', {});                                  // TS error: not in EventMap
//   const fn = (data: { wrong: string }) => {};
//   bus.on('cache:miss', fn);                                       // TS error: data type mismatch
//
// These compile-time assertions are guaranteed by the EventMap + generic constraints.

describe('TypedEventBus', () => {
  // ——— Basic emit / subscribe ———

  it('calls subscribed handler on emit', () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    bus.on('pipeline:render:before', handler);
    bus.emit('pipeline:render:before', { eventId: 'E1' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ eventId: 'E1' });
  });

  it('passes correct data shape for cache:hit event', () => {
    const bus = new TypedEventBus();
    const handler = vi.fn<(data: EventMap['cache:hit']) => void>();

    bus.on('cache:hit', handler);
    bus.emit('cache:hit', { eventId: 'E2', cacheKey: 'abc123' });

    expect(handler).toHaveBeenCalledWith({ eventId: 'E2', cacheKey: 'abc123' });
  });

  it('passes correct data shape for pipeline:render:after event', () => {
    const bus = new TypedEventBus();
    const handler = vi.fn<(data: EventMap['pipeline:render:after']) => void>();

    bus.on('pipeline:render:after', handler);
    bus.emit('pipeline:render:after', { eventId: 'E3', durationMs: 150 });

    expect(handler).toHaveBeenCalledWith({ eventId: 'E3', durationMs: 150 });
  });

  // ——— No-op when no subscribers ———

  it('does not throw when emitting to an event with no subscribers', () => {
    const bus = new TypedEventBus();

    expect(() => {
      bus.emit('pipeline:render:before', { eventId: 'E4' });
    }).not.toThrow();
  });

  it('does nothing when emitting to an event that had subscribers that were removed', () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    bus.on('cache:miss', handler);
    bus.off('cache:miss', handler);
    bus.emit('cache:miss', { eventId: 'E5' });

    expect(handler).not.toHaveBeenCalled();
  });

  // ——— Multiple subscribers ———

  it('notifies all subscribers for the same event', () => {
    const bus = new TypedEventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on('pipeline:validation:complete', handler1);
    bus.on('pipeline:validation:complete', handler2);
    bus.emit('pipeline:validation:complete', { eventId: 'E6', issueCount: 3 });

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
    expect(handler1).toHaveBeenCalledWith({ eventId: 'E6', issueCount: 3 });
    expect(handler2).toHaveBeenCalledWith({ eventId: 'E6', issueCount: 3 });
  });

  it('notifies all subscribers with the same data reference', () => {
    const bus = new TypedEventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on('config:changed', handler1);
    bus.on('config:changed', handler2);

    const data: EventMap['config:changed'] = { key: 'model' };
    bus.emit('config:changed', data);

    expect(handler1).toHaveBeenCalledWith(data);
    expect(handler2).toHaveBeenCalledWith(data);
  });

  // ——— Unsubscribe ———

  it('stops notifying a handler after off() is called', () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    bus.on('state:entity:changed', handler);
    bus.emit('state:entity:changed', { entityId: 'char_1', attribute: 'age' });
    expect(handler).toHaveBeenCalledTimes(1);

    bus.off('state:entity:changed', handler);
    bus.emit('state:entity:changed', { entityId: 'char_1', attribute: 'status' });
    expect(handler).toHaveBeenCalledTimes(1); // still 1, not 2
  });

  it('does not affect other subscribers when removing one', () => {
    const bus = new TypedEventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on('cache:hit', handler1);
    bus.on('cache:hit', handler2);

    bus.off('cache:hit', handler1);
    bus.emit('cache:hit', { eventId: 'E7', cacheKey: 'key' });

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('removing a handler that was never registered is a no-op', () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    expect(() => {
      bus.off('cache:miss', handler);
    }).not.toThrow();
  });

  // ——— Multiple events ———

  it('handles multiple different event types independently', () => {
    const bus = new TypedEventBus();
    const beforeHandler = vi.fn();
    const afterHandler = vi.fn();

    bus.on('pipeline:render:before', beforeHandler);
    bus.on('pipeline:render:after', afterHandler);

    bus.emit('pipeline:render:before', { eventId: 'E8' });
    expect(beforeHandler).toHaveBeenCalledTimes(1);
    expect(afterHandler).not.toHaveBeenCalled();

    bus.emit('pipeline:render:after', { eventId: 'E8', durationMs: 200 });
    expect(beforeHandler).toHaveBeenCalledTimes(1);
    expect(afterHandler).toHaveBeenCalledTimes(1);
  });

  // ——— listenerCount ———

  it('reports correct listener count', () => {
    const bus = new TypedEventBus();
    expect(bus.listenerCount).toBe(0);

    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('cache:hit', h1);
    expect(bus.listenerCount).toBe(1);

    bus.on('cache:miss', h2);
    expect(bus.listenerCount).toBe(2);

    bus.off('cache:hit', h1);
    expect(bus.listenerCount).toBe(1);

    bus.off('cache:miss', h2);
    expect(bus.listenerCount).toBe(0);
  });

  // ——— clear ———

  it('removes all listeners after clear()', () => {
    const bus = new TypedEventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();

    bus.on('pipeline:render:before', h1);
    bus.on('cache:hit', h2);
    bus.clear();

    bus.emit('pipeline:render:before', { eventId: 'E9' });
    bus.emit('cache:hit', { eventId: 'E10', cacheKey: 'k' });

    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
    expect(bus.listenerCount).toBe(0);
  });

  // ——— Same handler registered once ———

  it('does not double-call a handler registered twice for the same event', () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    bus.on('cache:miss', handler);
    bus.on('cache:miss', handler); // second registration is a no-op (Set dedup)
    bus.emit('cache:miss', { eventId: 'E11' });

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
