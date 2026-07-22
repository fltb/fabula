import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../../src/storage/memory-storage.ts';
import { TraceCollector } from '../../src/observability/trace.ts';

describe('TraceCollector', () => {
  it('writes safe JSONL traces with job and event correlation', () => {
    const traces = new TraceCollector('run-1');
    traces.record({ spanId: 'pass1-E0', eventId: 'E0', phase: 'pass1', state: 'start' });
    traces.record({ spanId: 'pass1-E0', eventId: 'E0', phase: 'pass1', state: 'end', durationMs: 9 });
    const storage = new MemoryStorage();
    traces.write(storage, '/project');

    const lines = storage.read('/project/.nova/traces/run-1.jsonl').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ jobId: 'run-1', traceId: 'run-1', eventId: 'E0', phase: 'pass1' });
    expect(lines[1].durationMs).toBe(9);
  });

  it('produces valid span nesting with matching start/end spanIds', () => {
    const traces = new TraceCollector('job-1', 'trace-1');
    // Pipeline span
    traces.record({ spanId: 'E0', eventId: 'E0', phase: 'pipeline', state: 'start' });
    // Cache span (nested)
    traces.record({ spanId: 'E0:cache', eventId: 'E0', phase: 'cache', state: 'start' });
    traces.record({ spanId: 'E0:cache', eventId: 'E0', phase: 'cache', state: 'end', durationMs: 2 });
    // Pass 1 span (nested)
    traces.record({ spanId: 'E0:pass1', eventId: 'E0', phase: 'pass1', state: 'start' });
    traces.record({ spanId: 'E0:pass1', eventId: 'E0', phase: 'pass1', state: 'end', durationMs: 150 });
    // Pass 2 span (nested)
    traces.record({ spanId: 'E0:pass2', eventId: 'E0', phase: 'pass2', state: 'start' });
    traces.record({ spanId: 'E0:pass2', eventId: 'E0', phase: 'pass2', state: 'end', durationMs: 200 });
    // Pipeline end
    traces.record({ spanId: 'E0', eventId: 'E0', phase: 'pipeline', state: 'end', durationMs: 400 });

    const events = traces.snapshot();
    expect(events).toHaveLength(8);
    // Verify start/end pairs have matching spanIds
    const startEvents = events.filter((e) => e.state === 'start');
    const endEvents = events.filter((e) => e.state === 'end');
    expect(startEvents.map((e) => e.spanId).sort()).toEqual(endEvents.map((e) => e.spanId).sort());
    // Verify pipeline start is first and end is last
    expect(events[0].phase).toBe('pipeline');
    expect(events[0].state).toBe('start');
    expect(events[events.length - 1].phase).toBe('pipeline');
    expect(events[events.length - 1].state).toBe('end');
    // Verify traceId is propagated
    expect(events[0].traceId).toBe('trace-1');
    expect(events.every((e) => e.traceId === 'trace-1')).toBe(true);
  });

  it('covers all trace phase event types', () => {
    const traces = new TraceCollector('job-types');
    const phases = ['pipeline', 'context', 'cache', 'pass1', 'pass2', 'validator', 'circuit', 'output'] as const;
    for (const phase of phases) {
      traces.record({ spanId: phase, eventId: 'E0', phase, state: 'start' });
      traces.record({ spanId: phase, eventId: 'E0', phase, state: 'end', durationMs: 10 });
    }
    const events = traces.snapshot();
    expect(events).toHaveLength(16);
    for (const phase of phases) {
      const phaseEvents = events.filter((e) => e.phase === phase);
      expect(phaseEvents).toHaveLength(2);
      expect(phaseEvents[0].state).toBe('start');
      expect(phaseEvents[1].state).toBe('end');
      expect(phaseEvents[1].durationMs).toBe(10);
    }
  });

  it('flush output produces valid JSONL with empty trailing newline', () => {
    const traces = new TraceCollector('run-flush');
    traces.record({ spanId: 'E1', eventId: 'E1', phase: 'pipeline', state: 'start' });
    traces.record({ spanId: 'E1', eventId: 'E1', phase: 'pipeline', state: 'end', durationMs: 5 });
    const storage = new MemoryStorage();
    traces.write(storage, '/project');

    const raw = storage.read('/project/.nova/traces/run-flush.jsonl');
    expect(raw).toBeTruthy();
    // Must end with newline
    expect(raw.endsWith('\n')).toBe(true);
    // Each line is valid JSON
    const lines = raw.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('timestamp');
      expect(parsed).toHaveProperty('traceId');
      expect(parsed).toHaveProperty('jobId');
      expect(parsed).toHaveProperty('spanId');
      expect(parsed).toHaveProperty('phase');
      expect(parsed).toHaveProperty('state');
    }
  });

  it('handles empty trace gracefully', () => {
    const traces = new TraceCollector('empty-job');
    const events = traces.snapshot();
    expect(events).toHaveLength(0);

    const storage = new MemoryStorage();
    traces.write(storage, '/project');
    const raw = storage.read('/project/.nova/traces/empty-job.jsonl');
    // Empty traces may write empty file or just newline
    expect(raw).toBeDefined();
  });

  it('records error events with code', () => {
    const traces = new TraceCollector('err-job');
    traces.record({ spanId: 'E0:cache', eventId: 'E0', phase: 'cache', state: 'error', code: 'CORRUPTED' });
    const events = traces.snapshot();
    expect(events).toHaveLength(1);
    expect(events[0].code).toBe('CORRUPTED');
    expect(events[0].state).toBe('error');
  });

  it('supports multiple events in the same job', () => {
    const traces = new TraceCollector('multi-event');
    traces.record({ spanId: 'E0', eventId: 'E0', phase: 'pipeline', state: 'start' });
    traces.record({ spanId: 'E0', eventId: 'E0', phase: 'pipeline', state: 'end', durationMs: 100 });
    traces.record({ spanId: 'E1', eventId: 'E1', phase: 'pipeline', state: 'start' });
    traces.record({ spanId: 'E1', eventId: 'E1', phase: 'pipeline', state: 'end', durationMs: 200 });
    const events = traces.snapshot();
    expect(events).toHaveLength(4);
    const e0Events = events.filter((e) => e.eventId === 'E0');
    const e1Events = events.filter((e) => e.eventId === 'E1');
    expect(e0Events).toHaveLength(2);
    expect(e1Events).toHaveLength(2);
  });
});
